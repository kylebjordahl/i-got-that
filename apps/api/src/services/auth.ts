import {
  and,
  authTokens,
  type Db,
  eq,
  identities,
  sessions,
  users,
} from '@igt/db';
import { randomToken, sha256hex } from '../lib/crypto.js';

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type SessionUser = typeof users.$inferSelect;

/** Issue a one-time magic-link token for `email`; returns the raw token. */
export async function requestMagicLink(db: Db, email: string): Promise<string> {
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
