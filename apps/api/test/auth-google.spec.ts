import { and, eq, externalAccounts, getDb, identities } from '@igt/db';
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.js';
import { connectGoogleAccount } from '../src/lib/google-account.js';
import { findOrCreateUserByGoogle, linkGoogleIdentity } from '../src/services/auth.js';
import { login } from './helpers.js';

/** Env with the Google login/connect redirect flow configured (the base test
 *  env leaves GOOGLE_OAUTH_CLIENT_ID + PUBLIC_ORIGIN empty ⇒ 501). */
const googleEnv = {
  ...env,
  GOOGLE_OAUTH_CLIENT_ID: 'client-id-123',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret-xyz',
  PUBLIC_ORIGIN: 'https://app.test',
};

async function fetchWith(
  path: string,
  bindings: typeof env,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://app.test${path}`, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Craft a base64url JWT whose payload carries the given claims (payload-only). */
function fakeIdToken(claims: Record<string, unknown>): string {
  const b64url = (s: string) =>
    btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url(JSON.stringify({ alg: 'RS256' }))}.${b64url(JSON.stringify(claims))}.sig`;
}

/** Drive `/auth/google/start` and return the minted `state` + the raw state cookie. */
async function startFlow(
  bindings: typeof env,
  init?: RequestInit & { link?: boolean },
): Promise<{ state: string; cookie: string }> {
  const { link, ...rest } = init ?? {};
  const res = await fetchWith(`/auth/google/start${link ? '?link=1' : ''}`, bindings, {
    redirect: 'manual',
    ...rest,
  });
  expect(res.status).toBe(302);
  const location = res.headers.get('location')!;
  const state = new URL(location).searchParams.get('state')!;
  const setCookie = res.headers.get('set-cookie')!;
  const value = setCookie.slice(setCookie.indexOf('=') + 1, setCookie.indexOf(';'));
  return { state, cookie: `igt_google_oauth=${value}` };
}

/** Stub the global fetch so the code exchange returns a fixed token set. */
function stubTokenExchange(tokens: {
  refresh_token?: string;
  id_token?: string;
}): void {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ access_token: 'at', ...tokens }), { status: 200 }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Sign in with Google — services', () => {
  it('creates then reuses the user behind a Google sub', async () => {
    const db = getDb(env.DB);
    const a = await findOrCreateUserByGoogle(db, 'g-sub-1', 'grace@example.com');
    expect(a.username).toBe('grace@example.com');
    const b = await findOrCreateUserByGoogle(db, 'g-sub-1', 'grace@example.com');
    expect(b.id).toBe(a.id);
    const rows = await db
      .select()
      .from(identities)
      .where(and(eq(identities.provider, 'google'), eq(identities.providerRef, 'g-sub-1')));
    expect(rows).toHaveLength(1);
  });

  it('threads a Google identity onto an existing user, idempotently', async () => {
    const alice = await login('g-link@example.com');
    const db = getDb(env.DB);
    expect(await linkGoogleIdentity(db, alice.userId, 'g-sub-link')).toEqual({
      ok: true,
      status: 'linked',
    });
    expect(await linkGoogleIdentity(db, alice.userId, 'g-sub-link')).toEqual({
      ok: true,
      status: 'already_linked',
    });
  });

  it("refuses to steal a Google identity that's someone else's login", async () => {
    const db = getDb(env.DB);
    const owner = await findOrCreateUserByGoogle(db, 'g-sub-owned', 'owner@example.com');
    const other = await login('g-other@example.com');
    const res = await linkGoogleIdentity(db, other.userId, 'g-sub-owned');
    expect(res).toEqual({ ok: false, error: 'identity_linked_to_other_user' });
    // The identity stays with its original owner.
    const rows = await db
      .select()
      .from(identities)
      .where(and(eq(identities.provider, 'google'), eq(identities.providerRef, 'g-sub-owned')));
    expect(rows[0]!.userId).toBe(owner.id);
  });

  it('connects a Google Calendar account and rotates on re-consent', async () => {
    const db = getDb(env.DB);
    const u = await findOrCreateUserByGoogle(db, 'g-sub-cal', 'cal@example.com');
    const first = await connectGoogleAccount(db, env.KEK, {
      userId: u.id,
      refreshToken: 'refresh-1',
      email: 'cal@example.com',
    });
    const second = await connectGoogleAccount(db, env.KEK, {
      userId: u.id,
      refreshToken: 'refresh-2',
      email: 'cal@example.com',
    });
    // Same account row reused (rotated in place, not duplicated).
    expect(second).toBe(first);
    const accounts = await db
      .select()
      .from(externalAccounts)
      .where(and(eq(externalAccounts.userId, u.id), eq(externalAccounts.kind, 'google')));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.username).toBe('cal@example.com');
  });
});

describe('Sign in with Google — redirect flow', () => {
  it('reports 501 when the flow is unconfigured', async () => {
    const res = await fetchWith('/auth/google/start', env, { redirect: 'manual' });
    expect(res.status).toBe(501);
  });

  it('redirects to Google consent with identity + offline scopes', async () => {
    const res = await fetchWith('/auth/google/start', googleEnv, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.test/api/auth/google/callback',
    );
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('scope')).toContain('calendar.events');
    expect(url.searchParams.get('scope')).toContain('calendar.readonly');
    expect(res.headers.get('set-cookie')).toContain('igt_google_oauth=');
  });

  it('logs in, creating the user + auto-connecting their calendar', async () => {
    const { state, cookie } = await startFlow(googleEnv);
    stubTokenExchange({
      refresh_token: 'login-refresh',
      id_token: fakeIdToken({ sub: 'g-login-1', email: 'newlogin@example.com' }),
    });

    const res = await fetchWith(
      `/auth/google/callback?code=abc&state=${state}`,
      googleEnv,
      { redirect: 'manual', headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/app/#session=');
    expect(res.headers.get('set-cookie')).toContain('igt_session=');

    const db = getDb(env.DB);
    const idRows = await db
      .select()
      .from(identities)
      .where(and(eq(identities.provider, 'google'), eq(identities.providerRef, 'g-login-1')));
    expect(idRows).toHaveLength(1);
    const acct = await db
      .select()
      .from(externalAccounts)
      .where(
        and(eq(externalAccounts.userId, idRows[0]!.userId), eq(externalAccounts.kind, 'google')),
      );
    expect(acct).toHaveLength(1);
    expect(acct[0]!.username).toBe('newlogin@example.com');
  });

  it('link mode threads Google onto the signed-in user and connects the calendar', async () => {
    const alice = await login('g-wizard@example.com');
    const { state, cookie } = await startFlow(googleEnv, {
      link: true,
      headers: { Authorization: `Bearer ${alice.token}`, cookie: `igt_session=${alice.token}` },
    });
    stubTokenExchange({
      refresh_token: 'wizard-refresh',
      id_token: fakeIdToken({ sub: 'g-wizard-sub', email: 'gcal@example.com' }),
    });

    const res = await fetchWith(
      `/auth/google/callback?code=abc&state=${state}`,
      googleEnv,
      { redirect: 'manual', headers: { cookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/app/#connected=google');

    const db = getDb(env.DB);
    const idRows = await db
      .select()
      .from(identities)
      .where(and(eq(identities.provider, 'google'), eq(identities.providerRef, 'g-wizard-sub')));
    expect(idRows[0]!.userId).toBe(alice.userId);
    const acct = await db
      .select()
      .from(externalAccounts)
      .where(and(eq(externalAccounts.userId, alice.userId), eq(externalAccounts.kind, 'google')));
    expect(acct).toHaveLength(1);
  });

  it('rejects a mismatched state (CSRF guard)', async () => {
    await startFlow(googleEnv);
    const res = await fetchWith('/auth/google/callback?code=abc&state=forged', googleEnv, {
      redirect: 'manual',
      headers: { cookie: 'igt_google_oauth=tampered.value' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('auth_error=state_mismatch');
  });
});
