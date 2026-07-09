import { describe, expect, it } from 'vitest';
import { bearer, call } from './helpers.js';

/** Extract just the `name=value` pair a Set-Cookie header carries, for
 * round-tripping as a request `Cookie` header in these fetch-level tests. */
function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  const match = /igt_session=[^;]+/.exec(setCookie!);
  expect(match).toBeTruthy();
  return match![0];
}

describe('web session cookie', () => {
  it('magic-link verify sets an HttpOnly cookie that GET /me accepts with no bearer header', async () => {
    const reqRes = await call('/auth/magic-link/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cookie-user@example.com' }),
    });
    const { devToken } = (await reqRes.json()) as { devToken: string };
    const verifyRes = await call('/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: devToken }),
    });
    const setCookie = verifyRes.headers.get('set-cookie');
    expect(setCookie).toContain('igt_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    const { sessionToken } = (await verifyRes.json()) as { sessionToken: string };

    const cookie = sessionCookieFrom(verifyRes);
    const me = await call('/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    const { user } = (await me.json()) as { user: { username: string } };
    expect(user.username).toBe('cookie-user@example.com');

    // A bearer token still works too — the cookie is additive, not a replacement.
    const meBearer = await call('/me', bearer(sessionToken));
    expect(meBearer.status).toBe(200);
  });

  it('GET /me 401s with neither a bearer header nor a cookie', async () => {
    const res = await call('/me');
    expect(res.status).toBe(401);
  });

  it('logout invalidates the session and clears the cookie', async () => {
    const reqRes = await call('/auth/magic-link/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cookie-logout@example.com' }),
    });
    const { devToken } = (await reqRes.json()) as { devToken: string };
    const verifyRes = await call('/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: devToken }),
    });
    const cookie = sessionCookieFrom(verifyRes);

    const logoutRes = await call('/auth/logout', { method: 'POST', headers: { cookie } });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get('set-cookie')).toContain('igt_session=;');

    // The invalidated cookie no longer authenticates anything.
    const me = await call('/me', { headers: { cookie } });
    expect(me.status).toBe(401);
  });

  it('logout is a no-op-safe 200 with no session at all', async () => {
    const res = await call('/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});
