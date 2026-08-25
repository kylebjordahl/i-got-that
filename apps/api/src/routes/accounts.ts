import {
  and,
  type Db,
  eq,
  externalAccounts,
  feeds,
  getDb,
  memberCalendars,
  secrets,
} from '@igt/db';
import {
  CreateExternalAccountInput,
  GoogleAuthorizeUrlInput,
} from '@igt/domain';
import { createCalDavClient, fetchGoogleCalendars } from '@igt/ical';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { resolveAccountCredential } from '../lib/account-credentials.js';
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  googleOAuthConfigured,
  googleRefresherFor,
  revokeGoogleToken,
} from '../lib/google-oauth.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  assertSafeOutboundUrl,
  createGuardedFetch,
  outboundPolicy,
  UnsafeOutboundUrlError,
} from '../lib/outbound-url.js';
import { buildKekKeySet, kekStatus, storeSecret } from '../lib/secrets.js';

/** iCloud's well-known CalDAV endpoint (used when no serverUrl is given). */
const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com';

/**
 * External calendar accounts — connected by (and private to) a single user, and
 * reusable across every family they belong to. Mounted at `/accounts` under a
 * bare session (NOT family-scoped): an account is owned by the user, and only its
 * owner may draw its calendars into a family's input/output feeds.
 */
export const accountRoutes = new Hono<HonoEnv>();
accountRoutes.use('*', authMiddleware);

/** Load an account scoped to the current user (ownership guard). */
async function loadOwnAccount(db: Db, userId: string, accountId: string) {
  return (
    await db
      .select()
      .from(externalAccounts)
      .where(and(eq(externalAccounts.id, accountId), eq(externalAccounts.userId, userId)))
      .limit(1)
  )[0];
}

function safeAccount(row: typeof externalAccounts.$inferSelect) {
  const { credentialsRef: _omit, ...safe } = row;
  return safe;
}

/** Build a Google OAuth consent URL (the client opens it, then posts back the code). */
accountRoutes.post('/google/authorize-url', async (c) => {
  if (!googleOAuthConfigured(c.env)) {
    return c.json({ error: 'google_oauth_not_configured' }, 501);
  }
  const parsed = GoogleAuthorizeUrlInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  return c.json({ url: buildGoogleAuthorizeUrl(c.env, { redirectUri: parsed.data.redirectUri }) });
});

/**
 * Connect an external calendar account. Google exchanges the consent `authCode`
 * for a stored refresh token; iCloud/CalDAV store the basic credential. The
 * credential is envelope-encrypted into a user-owned `secret` (familyId=null).
 */
accountRoutes.post('/', async (c) => {
  const parsed = CreateExternalAccountInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  // No usable KEK ⇒ we can't store the credential. That's a deployment gap, not
  // a bad request, and every other KEK call site degrades silently — so answer
  // 503 with the reason rather than letting it read as a broken endpoint. Runs
  // before the OAuth code exchange so a doomed connect doesn't burn the
  // single-use `authCode` (the user can retry once the env is fixed).
  const kek = kekStatus(c.env);
  if (kek !== 'ok') {
    console.error(
      `POST /accounts: envelope-encryption KEK is ${kek} — set KEK_V<n> (see docs/DEPLOYMENT.md § KEK); refusing to connect an account`,
    );
    return c.json({ error: 'kek_unconfigured', reason: kek }, 503);
  }
  const keys = buildKekKeySet(c.env)!;

  const db = getDb(c.env.DB);
  const user = c.get('user');
  const d = parsed.data;

  let payload: string;
  let serverUrl: string | null = null;
  let username: string | null = null;

  if (d.kind === 'google') {
    if (!googleOAuthConfigured(c.env)) return c.json({ error: 'google_oauth_not_configured' }, 501);
    try {
      const tokens = await exchangeGoogleCode(c.env, {
        code: d.authCode!,
        redirectUri: d.redirectUri!,
      });
      if (!tokens.refreshToken) return c.json({ error: 'google_no_refresh_token' }, 400);
      payload = JSON.stringify({ kind: 'oauth', refreshToken: tokens.refreshToken });
    } catch (err) {
      console.error('google code exchange failed', err);
      return c.json({ error: 'google_exchange_failed' }, 400);
    }
  } else {
    serverUrl = d.kind === 'icloud' ? d.serverUrl ?? ICLOUD_CALDAV_URL : d.serverUrl!;
    // We do authenticated discovery against this URL — and send the stored
    // basic credential with it — so it has to clear the outbound policy before
    // the account row (and its secret) exist.
    try {
      assertSafeOutboundUrl(serverUrl, outboundPolicy(c.env));
    } catch (err) {
      if (err instanceof UnsafeOutboundUrlError) {
        return c.json({ error: 'unsafe_url', reason: err.reason, path: 'serverUrl' }, 400);
      }
      throw err;
    }
    username = d.username!;
    payload = JSON.stringify({ kind: 'basic', username: d.username, password: d.password });
  }

  const credentialsRef = await storeSecret(db, keys, null, payload);
  const row = (
    await db
      .insert(externalAccounts)
      .values({
        userId: user.id,
        kind: d.kind,
        name: d.name,
        serverUrl,
        username,
        credentialsRef,
      })
      .returning()
  )[0]!;

  return c.json({ account: safeAccount(row) }, 201);
});

/** List the current user's connected accounts (credentials never returned). */
accountRoutes.get('/', async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(externalAccounts)
    .where(eq(externalAccounts.userId, c.get('user').id));
  return c.json({ accounts: rows.map(safeAccount) });
});

/**
 * List the calendars available in an account (owner only) — the picker the
 * client uses to choose a feed's source or an output feed's target calendar.
 * Returns `{ id, name }` where `id` is the CalDAV collection URL or Google
 * calendar id (stored as the feed's immutable `sourceCalendarId`).
 */
accountRoutes.post('/:accountId/calendars', async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get('user');
  const account = await loadOwnAccount(db, user.id, c.req.param('accountId'));
  if (!account) return c.json({ error: 'not_found' }, 404);

  const credential = await resolveAccountCredential(db, buildKekKeySet(c.env), account.id);
  if (!credential) return c.json({ error: 'no_credential' }, 400);

  try {
    if (account.kind === 'google') {
      if (credential.kind !== 'oauth') return c.json({ error: 'bad_credential' }, 400);
      const refresh = googleRefresherFor(c.env);
      const accessToken =
        credential.accessToken ??
        (credential.refreshToken && refresh
          ? await refresh(credential.refreshToken)
          : undefined);
      if (!accessToken) return c.json({ error: 'google_no_access_token' }, 400);
      return c.json({ calendars: await fetchGoogleCalendars(accessToken) });
    }
    if (credential.kind !== 'basic') return c.json({ error: 'bad_credential' }, 400);
    // Re-vet the stored serverUrl: rows written before the outbound policy
    // existed were never checked, and DNS may have moved since. The guarded
    // fetch also re-checks every discovery hop tsdav walks to from here.
    const serverUrl = account.serverUrl ?? ICLOUD_CALDAV_URL;
    try {
      assertSafeOutboundUrl(serverUrl, outboundPolicy(c.env));
    } catch (err) {
      if (err instanceof UnsafeOutboundUrlError) {
        return c.json({ error: 'unsafe_url', reason: err.reason, path: 'serverUrl' }, 400);
      }
      throw err;
    }
    const client = await createCalDavClient({
      serverUrl,
      username: credential.username,
      password: credential.password,
      fetchImpl: createGuardedFetch(c.env),
    });
    const calendars = await client.fetchCalendars();
    const list = calendars.map((cal) => ({
      id: cal.url,
      name:
        typeof cal.displayName === 'string' && cal.displayName.length > 0
          ? cal.displayName
          : cal.url,
    }));
    return c.json({ calendars: list });
  } catch (err) {
    // Deliberately opaque: the upstream error text is derived from a response
    // to a URL the caller chose, so reflecting it turns a failed discovery
    // into a read primitive. The detail stays in the Worker's logs.
    console.error(`calendar discovery failed for account ${account.id}`, err);
    return c.json({ error: 'list_failed' }, 400);
  }
});

/** Disconnect an account (owner only). Blocked (409) while any feed/target uses it. */
accountRoutes.delete('/:accountId', async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get('user');
  const account = await loadOwnAccount(db, user.id, c.req.param('accountId'));
  if (!account) return c.json({ error: 'not_found' }, 404);

  const usedByFeed = (
    await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.externalAccountId, account.id)).limit(1)
  )[0];
  const usedByTarget = (
    await db
      .select({ id: memberCalendars.id })
      .from(memberCalendars)
      .where(eq(memberCalendars.targetExternalAccountId, account.id))
      .limit(1)
  )[0];
  if (usedByFeed || usedByTarget) return c.json({ error: 'in_use' }, 409);

  // Best-effort: revoke the upstream Google grant before dropping our own
  // copy, so disconnecting here also disconnects at Google. Never blocks the
  // disconnect on Google's availability.
  const revokeKeys = buildKekKeySet(c.env);
  if (account.kind === 'google' && account.credentialsRef && revokeKeys) {
    try {
      const credential = await resolveAccountCredential(db, revokeKeys, account.id);
      if (credential?.kind === 'oauth' && credential.refreshToken) {
        await revokeGoogleToken(c.env, credential.refreshToken);
      }
    } catch (err) {
      console.error(`google token revoke failed for account ${account.id}`, err);
    }
  }

  await db.delete(externalAccounts).where(eq(externalAccounts.id, account.id));
  if (account.credentialsRef) {
    await db.delete(secrets).where(eq(secrets.id, account.credentialsRef));
  }
  return c.json({ ok: true });
});
