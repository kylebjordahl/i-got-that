import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.js';
import { authed, bearer, call, createFamily, login } from './helpers.js';

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
