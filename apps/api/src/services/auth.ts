import {
  and,
  appleNotificationReceipts,
  authTokens,
  type Db,
  eq,
  externalAccounts,
  familyMembers,
  gt,
  identities,
  inArray,
  isNull,
  secrets,
  sessions,
  users,
} from '@igt/db';
import type { IdentityProvider } from '@igt/domain';
import type { AppleNotificationEvent } from '../lib/apple.js';
import { randomToken, sha256hex } from '../lib/crypto.js';
import { loadSecret } from '../lib/secrets.js';
import { wouldOrphanFamily } from './families.js';

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/**
 * Max unconsumed, unexpired magic-link tokens a single email may have
 * outstanding at once — caps issuance (email-bombing a third party, sender
 * reputation burn, `auth_tokens` row growth) without touching a legitimate
 * user who fat-fingers "resend" a couple times.
 */
const MAGIC_LINK_MAX_OUTSTANDING = 3;

export type SessionUser = typeof users.$inferSelect;

/** Thrown by `requestMagicLink` when `email` already has too many live tokens. */
export class MagicLinkCapExceededError extends Error {
  constructor(readonly email: string) {
    super(`too many outstanding magic-link tokens for ${email}`);
    this.name = 'MagicLinkCapExceededError';
  }
}

/**
 * Issue a one-time magic-link token for `email`; returns the raw token.
 * Throws `MagicLinkCapExceededError` if `email` already has
 * `MAGIC_LINK_MAX_OUTSTANDING` unconsumed, unexpired tokens outstanding.
 */
export async function requestMagicLink(db: Db, email: string): Promise<string> {
  const outstanding = await db
    .select({ id: authTokens.id })
    .from(authTokens)
    .where(
      and(
        eq(authTokens.email, email),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .limit(MAGIC_LINK_MAX_OUTSTANDING);
  if (outstanding.length >= MAGIC_LINK_MAX_OUTSTANDING) {
    throw new MagicLinkCapExceededError(email);
  }

  const rawToken = randomToken();
  const tokenHash = await sha256hex(rawToken);
  await db.insert(authTokens).values({
    email,
    tokenHash,
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  });
  return rawToken;
}

async function findOrCreateUserByEmail(
  db: Db,
  email: string,
): Promise<SessionUser> {
  const existing = await db
    .select({ user: users })
    .from(identities)
    .innerJoin(users, eq(users.id, identities.userId))
    .where(
      and(
        eq(identities.provider, 'magic_link'),
        eq(identities.providerRef, email),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].user;

  // NOTE: open signup here is fine for the prototype; v1.1 gates this behind
  // the `invite` table (no public signup).
  const inserted = await db
    .insert(users)
    .values({ username: email, displayName: email.split('@')[0] ?? email })
    .returning();
  const user = inserted[0]!;
  await db
    .insert(identities)
    .values({ userId: user.id, provider: 'magic_link', providerRef: email });
  return user;
}

/** Find or create the user behind an Apple `sub` (provider_ref). */
export async function findOrCreateUserByApple(
  db: Db,
  sub: string,
  email?: string,
): Promise<SessionUser> {
  const existing = await db
    .select({ user: users })
    .from(identities)
    .innerJoin(users, eq(users.id, identities.userId))
    .where(and(eq(identities.provider, 'apple'), eq(identities.providerRef, sub)))
    .limit(1);
  if (existing[0]) return existing[0].user;

  const username = email ?? `apple:${sub}`;
  const inserted = await db
    .insert(users)
    .values({ username, displayName: email?.split('@')[0] ?? 'Apple user' })
    .returning();
  const user = inserted[0]!;
  await db
    .insert(identities)
    .values({ userId: user.id, provider: 'apple', providerRef: sub });
  return user;
}

/** Find or create the user behind a Google `sub` (provider_ref). */
export async function findOrCreateUserByGoogle(
  db: Db,
  sub: string,
  email?: string,
): Promise<SessionUser> {
  const existing = await db
    .select({ user: users })
    .from(identities)
    .innerJoin(users, eq(users.id, identities.userId))
    .where(and(eq(identities.provider, 'google'), eq(identities.providerRef, sub)))
    .limit(1);
  if (existing[0]) return existing[0].user;

  const username = email ?? `google:${sub}`;
  const inserted = await db
    .insert(users)
    .values({ username, displayName: email?.split('@')[0] ?? 'Google user' })
    .returning();
  const user = inserted[0]!;
  await db
    .insert(identities)
    .values({ userId: user.id, provider: 'google', providerRef: sub });
  return user;
}

/**
 * Cleanup paired with deleting a user account: revoke any connected Google
 * external account's refresh token upstream (best-effort, never blocking —
 * logged and swallowed on failure), then delete the `secrets` rows their
 * external accounts pointed at.
 *
 * `external_accounts.credentials_ref → secrets.id` is `ON DELETE SET NULL`,
 * and a user-owned secret's `family_id` is null (no family to cascade it
 * away) — so deleting the user (which *does* cascade-delete their
 * `external_accounts` rows) leaves those `secrets` rows referenced by
 * nothing. D1 has no multi-statement transactions, so the best we can do is
 * order this carefully: read the credentials while they're still reachable,
 * revoke, delete the user, then delete the now-orphaned secrets. A crash
 * between steps leaves a small window; {@link sweepOrphanedSecrets} is the
 * periodic backstop that closes it.
 */
export type AccountCleanupOptions = {
  /** KEK for decrypting stored external-account credentials before revoke. */
  kek?: string;
  /** Best-effort upstream revoke for a Google account's stored refresh token. */
  revokeGoogleToken?: (refreshToken: string) => Promise<void>;
};

async function deleteUserAndCleanupCredentials(
  db: Db,
  userId: string,
  opts: AccountCleanupOptions,
): Promise<void> {
  const accounts = await db
    .select({
      id: externalAccounts.id,
      kind: externalAccounts.kind,
      credentialsRef: externalAccounts.credentialsRef,
    })
    .from(externalAccounts)
    .where(eq(externalAccounts.userId, userId));

  if (opts.revokeGoogleToken && opts.kek) {
    for (const account of accounts) {
      if (account.kind !== 'google' || !account.credentialsRef) continue;
      try {
        const raw = await loadSecret(db, opts.kek, account.credentialsRef);
        const credential = raw
          ? (JSON.parse(raw) as { kind?: string; refreshToken?: string })
          : undefined;
        if (credential?.kind === 'oauth' && credential.refreshToken) {
          await opts.revokeGoogleToken(credential.refreshToken);
        }
      } catch (err) {
        console.error(`google token revoke failed for account ${account.id}`, err);
      }
    }
  }

  await db.delete(users).where(eq(users.id, userId));

  const secretIds = accounts
    .map((a) => a.credentialsRef)
    .filter((id): id is string => Boolean(id));
  if (secretIds.length > 0) {
    await db.delete(secrets).where(inArray(secrets.id, secretIds));
  }
}

/**
 * Periodic sweep for `secrets` rows a crash mid-{@link deleteUserAndCleanupCredentials}
 * (or the equivalent account-disconnect path) could leave behind: user-owned
 * (`family_id IS NULL`) rows no longer referenced by any
 * `external_accounts.credentials_ref`. Family-owned secrets aren't swept —
 * their family's own delete cascade already reaches them. Returns the number
 * of rows deleted (for logging).
 */
export async function sweepOrphanedSecrets(db: Db): Promise<number> {
  const [candidates, accounts] = await Promise.all([
    db.select({ id: secrets.id }).from(secrets).where(isNull(secrets.familyId)),
    db.select({ credentialsRef: externalAccounts.credentialsRef }).from(externalAccounts),
  ]);
  const referenced = new Set(
    accounts.map((a) => a.credentialsRef).filter((id): id is string => Boolean(id)),
  );
  const orphanIds = candidates.map((c) => c.id).filter((id) => !referenced.has(id));
  if (orphanIds.length === 0) return 0;
  await db.delete(secrets).where(inArray(secrets.id, orphanIds));
  return orphanIds.length;
}

/** How long an applied-notification digest is kept — comfortably longer than
 *  `verifyAppleNotificationToken`'s freshness window, so a digest never needs
 *  to outlive the window that could accept a matching replay anyway. */
const NOTIFICATION_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Replay-dedupe for Apple S2S notifications. Records a digest of the raw,
 * verified JWS the first time it's seen; returns `true` the first time (the
 * caller should apply the event) and `false` on a repeat (the caller no-ops
 * but should still answer 200 — Apple retries redelivery on anything else).
 */
export async function recordAppleNotificationOnce(
  db: Db,
  digest: string,
  now: number = Date.now(),
): Promise<boolean> {
  const inserted = await db
    .insert(appleNotificationReceipts)
    .values({ digest, expiresAt: new Date(now + NOTIFICATION_RECEIPT_TTL_MS) })
    .onConflictDoNothing()
    .returning({ id: appleNotificationReceipts.id });
  return inserted.length > 0;
}

/**
 * Apply an Apple server-to-server account event. Idempotent and safe for unknown
 * subjects (Apple may notify about accounts we've never seen — we just no-op):
 *   - `consent-revoked` → sign the user out everywhere and drop the Apple
 *     identity (they must re-authorize to link again).
 *   - `account-delete`  → delete the user (plus the credential cleanup in
 *     {@link deleteUserAndCleanupCredentials}); the FK cascade removes their
 *     identities + sessions and nulls their family_member links.
 *   - `email-*`         → a relay-address toggle; nothing we persist depends on
 *     it today, so it's a no-op (logged by the caller if desired).
 */
export async function handleAppleAccountEvent(
  db: Db,
  event: AppleNotificationEvent,
  opts: AccountCleanupOptions = {},
): Promise<void> {
  const rows = await db
    .select({ userId: identities.userId, id: identities.id })
    .from(identities)
    .where(and(eq(identities.provider, 'apple'), eq(identities.providerRef, event.sub)))
    .limit(1);
  const identity = rows[0];
  if (!identity) return;

  switch (event.type) {
    case 'consent-revoked':
      await db.delete(sessions).where(eq(sessions.userId, identity.userId));
      await db.delete(identities).where(eq(identities.id, identity.id));
      break;
    case 'account-delete':
      await deleteUserAndCleanupCredentials(db, identity.userId, opts);
      break;
    case 'email-disabled':
    case 'email-enabled':
      break;
  }
}

// --- Identity linking (thread multiple login methods into one user) -------

/** A login method attached to a user, as returned by the account UI. */
export type IdentitySummary = {
  id: string;
  provider: IdentityProvider;
  // Apple's opaque subject, or the magic-link email — a label for the UI.
  providerRef: string;
  createdAt: number;
};

/** Every login method threaded to `userId`, newest last. */
export async function listIdentities(
  db: Db,
  userId: string,
): Promise<IdentitySummary[]> {
  const rows = await db
    .select()
    .from(identities)
    .where(eq(identities.userId, userId));
  return rows
    .map((r) => ({
      id: r.id,
      provider: r.provider,
      providerRef: r.providerRef,
      createdAt: r.createdAt.getTime(),
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Attach a verified `(provider, providerRef)` to `userId`. Idempotent for that
 * user; refuses to steal an identity already threaded to someone else (the
 * caller surfaces that as a conflict).
 */
async function attachIdentity(
  db: Db,
  userId: string,
  provider: IdentityProvider,
  providerRef: string,
): Promise<'linked' | 'already_linked' | 'conflict'> {
  const existing = await db
    .select()
    .from(identities)
    .where(
      and(
        eq(identities.provider, provider),
        eq(identities.providerRef, providerRef),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (row) return row.userId === userId ? 'already_linked' : 'conflict';

  await db.insert(identities).values({ userId, provider, providerRef });
  return 'linked';
}

export type LinkResult =
  | { ok: true; status: 'linked' | 'already_linked' }
  | { ok: false; error: 'invalid_token' | 'identity_linked_to_other_user' };

/**
 * Consume a magic-link token and thread its email onto `userId` as a
 * `magic_link` identity — the same token flow as login, but attaching to the
 * already-signed-in user instead of finding/creating one.
 */
export async function linkMagicLinkIdentity(
  db: Db,
  userId: string,
  rawToken: string,
): Promise<LinkResult> {
  const tokenHash = await sha256hex(rawToken);
  const rows = await db
    .select()
    .from(authTokens)
    .where(eq(authTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'invalid_token' };
  }
  await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(eq(authTokens.id, row.id));

  const status = await attachIdentity(db, userId, 'magic_link', row.email);
  if (status === 'conflict') {
    return { ok: false, error: 'identity_linked_to_other_user' };
  }
  return { ok: true, status };
}

/**
 * Thread a verified Apple `sub` onto `userId` as an `apple` identity. The caller
 * verifies the identity token first (native `/auth/link/apple` or the web
 * link-redirect callback).
 */
export async function linkAppleIdentity(
  db: Db,
  userId: string,
  sub: string,
): Promise<LinkResult> {
  const status = await attachIdentity(db, userId, 'apple', sub);
  if (status === 'conflict') {
    return { ok: false, error: 'identity_linked_to_other_user' };
  }
  return { ok: true, status };
}

/**
 * Thread a verified Google `sub` onto `userId` as a `google` identity. The caller
 * verifies the token (the OAuth code exchange yields the id_token straight from
 * Google over TLS) before calling. Returns `already_linked` for the caller's own
 * identity; the caller decides whether a `conflict` (the Google account is
 * already someone else's login) is fatal — connecting a *calendar* still
 * succeeds even when identity threading is skipped.
 */
export async function linkGoogleIdentity(
  db: Db,
  userId: string,
  sub: string,
): Promise<LinkResult> {
  const status = await attachIdentity(db, userId, 'google', sub);
  if (status === 'conflict') {
    return { ok: false, error: 'identity_linked_to_other_user' };
  }
  return { ok: true, status };
}

/**
 * Detach a login method from `userId`. Guards against removing the last one
 * (which would orphan the account, leaving no way back in).
 */
export async function unlinkIdentity(
  db: Db,
  userId: string,
  identityId: string,
): Promise<'ok' | 'not_found' | 'last_identity'> {
  const rows = await db
    .select()
    .from(identities)
    .where(eq(identities.userId, userId));
  if (!rows.some((r) => r.id === identityId)) return 'not_found';
  if (rows.length <= 1) return 'last_identity';

  await db
    .delete(identities)
    .where(
      and(eq(identities.id, identityId), eq(identities.userId, userId)),
    );
  return 'ok';
}

export type DeleteAccountResult = 'ok' | 'last_admin';

/**
 * True if deleting `userId`'s account right now would orphan a family — they
 * are the sole admin of at least one family that still has other members.
 * Shared by [deleteUserAccount] (to actually block it) and the `/auth/me/
 * deletable` route (so the client can warn *before* the user tries to slide
 * to confirm, rather than surfacing the block as a failed-action toast).
 */
export async function accountDeletionBlocked(db: Db, userId: string): Promise<boolean> {
  const memberships = await db
    .select()
    .from(familyMembers)
    .where(eq(familyMembers.userId, userId));

  for (const m of memberships) {
    if (!m.isAdmin) continue;
    if (await wouldOrphanFamily(db, m.familyId, m.id)) return true;
  }
  return false;
}

/**
 * Delete the user's own account. FK cascades drop their sessions, identities,
 * and external accounts; each `family_members` row they held is kept but
 * unlinked (`userId` → null, same outcome as `handleAppleAccountEvent`'s
 * `account-delete` case) rather than removed — the person stays in the
 * family, just loses login capability.
 *
 * Blocked (`last_admin`) if the user is the sole admin of a family that still
 * has other members — deleting the account would leave that family with no
 * one able to manage it. The caller must promote another admin, or delete the
 * family outright, first.
 */
export async function deleteUserAccount(
  db: Db,
  userId: string,
  opts: AccountCleanupOptions = {},
): Promise<DeleteAccountResult> {
  if (await accountDeletionBlocked(db, userId)) return 'last_admin';
  await deleteUserAndCleanupCredentials(db, userId, opts);
  return 'ok';
}

/** Create a session for a user; returns the raw session token. */
export async function createSession(db: Db, userId: string): Promise<string> {
  const rawToken = randomToken();
  const tokenHash = await sha256hex(rawToken);
  await db.insert(sessions).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return rawToken;
}

/** Consume a magic-link token and start a session. Null if invalid/expired/used. */
export async function verifyMagicLink(
  db: Db,
  rawToken: string,
): Promise<{ sessionToken: string; user: SessionUser } | null> {
  const tokenHash = await sha256hex(rawToken);
  const rows = await db
    .select()
    .from(authTokens)
    .where(eq(authTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) {
    return null;
  }
  await db
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(eq(authTokens.id, row.id));

  const user = await findOrCreateUserByEmail(db, row.email);
  const sessionToken = await createSession(db, user.id);
  return { sessionToken, user };
}

/** Resolve the user behind a raw session token, or null if missing/expired. */
export async function getUserBySessionToken(
  db: Db,
  rawToken: string,
): Promise<SessionUser | null> {
  const tokenHash = await sha256hex(rawToken);
  const rows = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row || row.session.expiresAt.getTime() < Date.now()) return null;
  return row.user;
}

/** Invalidate a session (logout). No-op if the token is already gone/invalid. */
export async function deleteSession(db: Db, rawToken: string): Promise<void> {
  const tokenHash = await sha256hex(rawToken);
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}
