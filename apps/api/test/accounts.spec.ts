import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, externalAccounts, feeds, getDb } from '@igt/db';
import app from '../src/index.js';
import { resolveAccountCredential } from '../src/lib/account-credentials.js';
import { storeSecret } from '../src/lib/secrets.js';
import { authed, bearer, call, createFamily, login, testKeys } from './helpers.js';

type Account = { id: string; kind: string; serverUrl: string | null };

function createCalDavAccount(token: string, name = 'My CalDAV') {
  return call(
    '/accounts',
    authed(token, {
      kind: 'caldav',
      name,
      serverUrl: 'https://dav.example.com',
      username: 'u',
      password: 'p',
    }),
  );
}

describe('external accounts', () => {
  it('connects a caldav account and never leaks the credential', async () => {
    const user = await login('acct-user@example.com');
    const res = await createCalDavAccount(user.token);
    expect(res.status).toBe(201);
    const { account } = (await res.json()) as { account: Account };
    expect(account.kind).toBe('caldav');
    expect(account.serverUrl).toBe('https://dav.example.com');
    expect('credentialsRef' in (account as Record<string, unknown>)).toBe(false);

    const list = await call('/accounts', bearer(user.token));
    const { accounts } = (await list.json()) as { accounts: Account[] };
    expect(accounts).toHaveLength(1);
    expect('credentialsRef' in (accounts[0] as Record<string, unknown>)).toBe(false);
  });

  it('scopes accounts to their owner', async () => {
    const owner = await login('acct-owner@example.com');
    const other = await login('acct-other@example.com');
    const created = await createCalDavAccount(owner.token);
    const accountId = ((await created.json()) as { account: Account }).account.id;

    // A different user neither sees nor can delete it.
    const otherList = await call('/accounts', bearer(other.token));
    expect(((await otherList.json()) as { accounts: Account[] }).accounts).toHaveLength(0);

    const del = await call(`/accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(del.status).toBe(404);
  });

  it('blocks deletion while a feed uses the account (409)', async () => {
    const user = await login('acct-feed@example.com');
    const familyId = await createFamily(user.token, 'Acct Fam');
    const created = await createCalDavAccount(user.token);
    const accountId = ((await created.json()) as { account: Account }).account.id;

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(user.token, {
        kind: 'caldav',
        externalAccountId: accountId,
        sourceCalendarId: 'https://dav.example.com/cal/home/',
        sourceCalendarName: 'Home',
        mode: 'standard',
      }),
    );
    expect(feedRes.status).toBe(201);

    const del = await call(`/accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(del.status).toBe(409);
    const body = (await del.json()) as { error: string; feeds: unknown[]; targets: unknown[] };
    expect(body.error).toBe('in_use');
    expect(body.feeds).toHaveLength(1);
    expect(body.targets).toHaveLength(0);
  });

  it('audits what a blocked account is linked to, then force-disconnects it in one call', async () => {
    const user = await login('acct-force@example.com');
    const familyId = await createFamily(user.token, 'Force Fam');
    const created = await createCalDavAccount(user.token);
    const accountId = ((await created.json()) as { account: Account }).account.id;

    const memberRes = await call(
      `/families/${familyId}/members`,
      authed(user.token, { relationName: 'kiddo', requiresCaretaker: true }),
    );
    const { member } = (await memberRes.json()) as { member: { id: string } };

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(user.token, {
        kind: 'caldav',
        externalAccountId: accountId,
        sourceCalendarId: 'https://dav.example.com/cal/home/',
        sourceCalendarName: 'Home',
        mode: 'standard',
      }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };

    // Linking a member triggers the feed's first (best-effort) ingest —
    // stub the CalDAV REPORT dance so it resolves with zero events instead
    // of hitting the real (fake) host.
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"></D:multistatus>',
        { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } },
      );
    });
    const linkRes = await call(
      `/families/${familyId}/feeds/${feed.id}/member-links`,
      authed(user.token, { familyMemberId: member.id }),
    );
    vi.unstubAllGlobals();
    expect(linkRes.status).toBe(201);

    const usage = await call(`/accounts/${accountId}/usage`, bearer(user.token));
    expect(usage.status).toBe(200);
    const usageBody = (await usage.json()) as {
      feeds: { id: string; name: string | null; members: string[] }[];
      targets: unknown[];
    };
    expect(usageBody.feeds).toEqual([{ id: feed.id, name: 'Home', members: ['kiddo'] }]);

    const blocked = await call(`/accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(blocked.status).toBe(409);

    const forced = await call(`/accounts/${accountId}?force=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(forced.status).toBe(200);

    const feedsAfter = await call(`/families/${familyId}/feeds`, bearer(user.token));
    const { feeds: feedsList } = (await feedsAfter.json()) as {
      feeds: { id: string; status: string }[];
    };
    expect(feedsList.find((f) => f.id === feed.id)?.status).toBe('paused');
  });

  it('deletes an unused account', async () => {
    const user = await login('acct-del@example.com');
    const created = await createCalDavAccount(user.token);
    const accountId = ((await created.json()) as { account: Account }).account.id;

    const del = await call(`/accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(del.status).toBe(200);

    const list = await call('/accounts', bearer(user.token));
    expect(((await list.json()) as { accounts: Account[] }).accounts).toHaveLength(0);
  });

  it('rejects an account-backed feed referencing another user’s account', async () => {
    const owner = await login('acct-owner2@example.com');
    const created = await createCalDavAccount(owner.token);
    const accountId = ((await created.json()) as { account: Account }).account.id;

    // A different user (admin of their own family) can't draw the owner's account.
    const intruder = await login('acct-intruder@example.com');
    const familyId = await createFamily(intruder.token, 'Intruder Fam');
    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(intruder.token, {
        kind: 'caldav',
        externalAccountId: accountId,
        sourceCalendarId: 'https://dav.example.com/cal/home/',
        mode: 'standard',
      }),
    );
    expect(feedRes.status).toBe(404);
  });
});

/**
 * A deployed env that never had `KEK_V1` set (the shape a deployment upgraded
 * past the unversioned-`KEK` split lands in) can't store a credential at all.
 * That's a deployment gap, so it has to answer as one — the failure used to be
 * an opaque 500 that reached the client as a raw exception dump.
 */
describe('external accounts — unusable envelope-encryption KEK', () => {
  async function fetchWith(bindings: typeof env, init: RequestInit) {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request('https://api.test/accounts', init), bindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  const body = (token: string) =>
    authed(token, {
      kind: 'caldav',
      name: 'My CalDAV',
      serverUrl: 'https://dav.example.com',
      username: 'u',
      password: 'p',
    });

  it('refuses to connect with 503 + reason when no KEK_V<n> is configured', async () => {
    const user = await login('acct-no-kek@example.com');
    // KEK_CURRENT_VERSION with no matching KEK_V<n> — same resolution failure
    // as a deployed env that has neither a versioned key nor the legacy one.
    const res = await fetchWith({ ...env, KEK_CURRENT_VERSION: '9' }, body(user.token));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'kek_unconfigured', reason: 'missing' });
  });

  it('still connects on a pre-v0.9 env that has only the unversioned KEK', async () => {
    const user = await login('acct-legacy-kek@example.com');
    const legacyEnv = { ...env, KEK: env.KEK_V1, KEK_V1: undefined } as unknown as typeof env;
    const res = await fetchWith(legacyEnv, body(user.token));
    expect(res.status).toBe(201);
  });

  it('refuses to connect with 503 + reason when the KEK is not valid AES-256 material', async () => {
    const user = await login('acct-bad-kek@example.com');
    const res = await fetchWith({ ...env, KEK_V1: 'not-a-32-byte-key' }, body(user.token));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'kek_unconfigured', reason: 'invalid' });
  });

  it('does not burn the single-use Google auth code when the KEK is unusable', async () => {
    const user = await login('acct-no-kek-google@example.com');
    let exchanged = false;
    vi.stubGlobal('fetch', async () => {
      exchanged = true;
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), {
        status: 200,
      });
    });
    const googleEnvNoKek = {
      ...env,
      KEK_CURRENT_VERSION: '9',
      GOOGLE_OAUTH_CLIENT_ID: 'client-id-123',
      GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret-xyz',
    };
    const res = await fetchWith(
      googleEnvNoKek,
      authed(user.token, {
        kind: 'google',
        name: 'My Google Cal',
        authCode: 'auth-code-xyz',
        redirectUri: 'https://app.example/cb',
      }),
    );
    vi.unstubAllGlobals();
    expect(res.status).toBe(503);
    expect(exchanged).toBe(false);
  });
});

describe('Google external accounts — revoke on disconnect', () => {
  /** Base test env leaves GOOGLE_OAUTH_CLIENT_ID/SECRET empty ⇒ google accounts 501. */
  const googleEnv = {
    ...env,
    GOOGLE_OAUTH_CLIENT_ID: 'client-id-123',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret-xyz',
  };

  async function fetchWith(
    path: string,
    bindings: typeof env,
    init?: RequestInit,
  ): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`https://api.test${path}`, init), bindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('disconnecting a connected Google account revokes its stored refresh token at Google', async () => {
    const user = await login('acct-google-revoke@example.com');

    // Connecting exchanges the auth code for tokens (including a refresh token).
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'the-refresh-token' }),
          { status: 200 },
        ),
    );
    const created = await fetchWith(
      '/accounts',
      googleEnv,
      authed(user.token, {
        kind: 'google',
        name: 'My Google Cal',
        authCode: 'auth-code-xyz',
        redirectUri: 'https://app.example/cb',
      }),
    );
    expect(created.status).toBe(201);
    const accountId = ((await created.json()) as { account: Account }).account.id;
    vi.unstubAllGlobals();

    // Disconnecting should best-effort revoke the stored refresh token at Google.
    let revokeCall: { url: string; body: URLSearchParams } | null = null;
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      revokeCall = { url: String(url), body: init!.body as URLSearchParams };
      return new Response('', { status: 200 });
    });
    const del = await fetchWith(`/accounts/${accountId}`, googleEnv, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(del.status).toBe(200);
    expect(revokeCall).not.toBeNull();
    expect(revokeCall!.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(revokeCall!.body.get('token')).toBe('the-refresh-token');
  });

  it('tells the client to reconnect when Google refuses the calendar list (missing scope)', async () => {
    const user = await login('acct-google-scope@example.com');
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 }),
    );
    const created = await fetchWith(
      '/accounts',
      googleEnv,
      authed(user.token, {
        kind: 'google',
        name: 'Google',
        authCode: 'code',
        redirectUri: 'https://app.example/cb',
      }),
    );
    const accountId = ((await created.json()) as { account: Account }).account.id;

    // Token refresh works, but calendarList answers 403 insufficient scopes —
    // an account signed in natively with only `calendar.events`.
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) =>
      String(url).includes('oauth2.googleapis.com/token')
        ? new Response(JSON.stringify({ access_token: 'fresh' }), { status: 200 })
        : new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 }),
    );
    const res = await fetchWith(`/accounts/${accountId}/calendars`, googleEnv, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('google_reauth_required');
  });

  it('a failed upstream revoke never blocks the disconnect', async () => {
    const user = await login('acct-google-revoke-fail@example.com');

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'rt-2' }),
          { status: 200 },
        ),
    );
    const created = await fetchWith(
      '/accounts',
      googleEnv,
      authed(user.token, {
        kind: 'google',
        name: 'My Google Cal 2',
        authCode: 'auth-code-2',
        redirectUri: 'https://app.example/cb',
      }),
    );
    const accountId = ((await created.json()) as { account: Account }).account.id;
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', async () => new Response('server error', { status: 500 }));
    const del = await fetchWith(`/accounts/${accountId}`, googleEnv, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(del.status).toBe(200);

    const list = await fetchWith('/accounts', googleEnv, bearer(user.token));
    expect(((await list.json()) as { accounts: Account[] }).accounts).toHaveLength(0);
  });
});

describe('Google external accounts — reconnecting the account you already have', () => {
  const googleEnv = {
    ...env,
    GOOGLE_OAUTH_CLIENT_ID: 'client-id-123',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret-xyz',
  };
  const db = () => getDb(env.DB);

  async function fetchWith(path: string, init?: RequestInit): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`https://api.test${path}`, init), googleEnv, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  /** Google's token endpoint answering a consent by `email` with refresh token `rt`. */
  function stubTokenExchange(email: string | null, rt: string, scope?: string) {
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'at',
            refresh_token: rt,
            ...(scope ? { scope } : {}),
            ...(email ? { id_token: `${b64({ alg: 'none' })}.${b64({ sub: `sub-${email}`, email })}.sig` } : {}),
          }),
          { status: 200 },
        ),
    );
  }

  const consent = { authCode: 'code', redirectUri: 'https://app.example/cb' };

  async function storedRefreshToken(accountId: string) {
    const row = (await db().select().from(externalAccounts).where(eq(externalAccounts.id, accountId)))[0]!;
    const cred = await resolveAccountCredential(db(), testKeys(), row.id);
    return cred?.kind === 'oauth' ? cred.refreshToken : undefined;
  }

  /** A Google row the old wizard left behind: no email, generic name, dead token. */
  async function legacyAccount(userId: string) {
    const credentialsRef = await storeSecret(
      db(),
      testKeys(),
      null,
      JSON.stringify({ kind: 'oauth', refreshToken: 'expired-rt' }),
    );
    return (
      await db()
        .insert(externalAccounts)
        .values({ userId, kind: 'google', name: 'Google Calendar', credentialsRef })
        .returning()
    )[0]!;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("asks Google who the account is, so the wizard's consent carries an email", async () => {
    const user = await login('acct-google-identity@example.com');
    const res = await fetchWith(
      '/accounts/google/authorize-url',
      authed(user.token, { redirectUri: 'https://app.example/cb' }),
    );
    const { url } = (await res.json()) as { url: string };
    const scope = new URL(url).searchParams.get('scope')!.split(' ');
    expect(scope).toEqual(expect.arrayContaining(['openid', 'email']));
  });

  it('connecting the same Google account twice renews one row instead of adding another', async () => {
    const user = await login('acct-google-dedupe@example.com');
    stubTokenExchange('kyle@example.com', 'rt-1');
    const first = await fetchWith('/accounts', authed(user.token, { kind: 'google', name: 'Google', ...consent }));
    expect(first.status).toBe(201);
    const { account } = (await first.json()) as { account: Account & { username: string } };
    expect(account.username).toBe('kyle@example.com');

    stubTokenExchange('kyle@example.com', 'rt-2');
    const second = await fetchWith('/accounts', authed(user.token, { kind: 'google', name: 'Google', ...consent }));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { account: Account }).account.id).toBe(account.id);

    const rows = await db().select().from(externalAccounts).where(eq(externalAccounts.userId, user.userId));
    expect(rows).toHaveLength(1);
    expect(await storedRefreshToken(account.id)).toBe('rt-2');
  });

  it('reconnects a legacy no-email account in place and re-queues its failing feed', async () => {
    const user = await login('acct-google-reconnect@example.com');
    const familyId = await createFamily(user.token, 'Reconnect Fam');
    const legacy = await legacyAccount(user.userId);
    // The same Google account also has a newer, unused row under its email —
    // the explicit reconnect must still land on the row the feed uses.
    stubTokenExchange('kyle@example.com', 'rt-unused');
    await fetchWith('/accounts', authed(user.token, { kind: 'google', name: 'Google', ...consent }));
    const feed = (
      await db()
        .insert(feeds)
        .values({
          familyId,
          kind: 'google',
          externalAccountId: legacy.id,
          sourceCalendarId: 'work@example.com',
          mode: 'busy',
          status: 'error',
          consecutiveFailures: 66,
          lastErrorMessage: 'google token refresh failed: 400 invalid_grant',
        })
        .returning()
    )[0]!;

    stubTokenExchange('kyle@example.com', 'rt-fresh');
    const res = await fetchWith(`/accounts/${legacy.id}/reconnect`, authed(user.token, consent));
    expect(res.status).toBe(200);
    const { account } = (await res.json()) as { account: Account & { username: string; name: string } };
    expect(account.id).toBe(legacy.id);
    expect(account.username).toBe('kyle@example.com');
    expect(account.name).toBe('kyle@example.com');
    expect(await storedRefreshToken(legacy.id)).toBe('rt-fresh');

    const after = (await db().select().from(feeds).where(eq(feeds.id, feed.id)))[0]!;
    expect(after.status).toBe('active');
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastErrorMessage).toBeNull();
  });

  it('refuses a reconnect by a different Google account than the one on record', async () => {
    const user = await login('acct-google-mismatch@example.com');
    stubTokenExchange('kyle@example.com', 'rt-kyle');
    const created = await fetchWith('/accounts', authed(user.token, { kind: 'google', name: 'Google', ...consent }));
    const { account } = (await created.json()) as { account: Account };

    stubTokenExchange('someone-else@example.com', 'rt-other');
    const res = await fetchWith(`/accounts/${account.id}/reconnect`, authed(user.token, consent));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('google_account_mismatch');
    expect(await storedRefreshToken(account.id)).toBe('rt-kyle');
  });

  it('refuses a consent that unticked a calendar permission, keeping the working token', async () => {
    const user = await login('acct-google-partial@example.com');
    stubTokenExchange('kyle@example.com', 'rt-good');
    const created = await fetchWith('/accounts', authed(user.token, { kind: 'google', name: 'Google', ...consent }));
    const { account } = (await created.json()) as { account: Account };

    // Everything but free/busy: the token would refresh fine and 403 every busy sync.
    stubTokenExchange(
      'kyle@example.com',
      'rt-partial',
      'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly',
    );
    const res = await fetchWith(`/accounts/${account.id}/reconnect`, authed(user.token, consent));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'google_scopes_missing',
      missingScopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
    });
    expect(await storedRefreshToken(account.id)).toBe('rt-good');
  });

  it("won't reconnect another user's account", async () => {
    const owner = await login('acct-google-owner@example.com');
    const other = await login('acct-google-intruder@example.com');
    const legacy = await legacyAccount(owner.userId);
    stubTokenExchange('intruder@example.com', 'rt-x');
    const res = await fetchWith(`/accounts/${legacy.id}/reconnect`, authed(other.token, consent));
    expect(res.status).toBe(404);
    expect(await storedRefreshToken(legacy.id)).toBe('expired-rt');
  });
});
