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
} from '../lib/google-oauth.js';
import { authMiddleware } from '../middleware/auth.js';
import { storeSecret } from '../lib/secrets.js';

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
  if (!c.env.KEK) return c.json({ error: 'kek_unconfigured' }, 500);

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
    username = d.username!;
    payload = JSON.stringify({ kind: 'basic', username: d.username, password: d.password });
  }

  const credentialsRef = await storeSecret(db, c.env.KEK, null, payload);
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

  const credential = await resolveAccountCredential(db, c.env.KEK, account.id);
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
    const client = await createCalDavClient({
      serverUrl: account.serverUrl ?? ICLOUD_CALDAV_URL,
      username: credential.username,
      password: credential.password,
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
    return c.json({ error: 'list_failed', message: String(err) }, 400);
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

  await db.delete(externalAccounts).where(eq(externalAccounts.id, account.id));
  if (account.credentialsRef) {
    await db.delete(secrets).where(eq(secrets.id, account.credentialsRef));
  }
  return c.json({ ok: true });
});
