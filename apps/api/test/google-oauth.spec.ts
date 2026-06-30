import { describe, expect, it } from 'vitest';
import type { Bindings } from '../src/env.js';
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  googleOAuthConfigured,
  refreshGoogleAccessToken,
} from '../src/lib/google-oauth.js';

const env = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id-123',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret-xyz',
} as Bindings;

describe('Google OAuth', () => {
  it('reports configured state', () => {
    expect(googleOAuthConfigured(env)).toBe(true);
    expect(googleOAuthConfigured({} as Bindings)).toBe(false);
  });

  it('builds a consent URL requesting offline access + the calendar scope', () => {
    const url = new URL(
      buildGoogleAuthorizeUrl(env, { redirectUri: 'https://app.example/cb', state: 's1' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe('client-id-123');
    expect(p.get('redirect_uri')).toBe('https://app.example/cb');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('scope')).toContain('calendar.events');
    expect(p.get('state')).toBe('s1');
  });

  it('throws when not configured', () => {
    expect(() => buildGoogleAuthorizeUrl({} as Bindings, { redirectUri: 'https://x/cb' })).toThrow(
      /not_configured/,
    );
  });

  it('exchanges an auth code for tokens', async () => {
    let captured: { url: string; body: URLSearchParams } | null = null;
    const fakeFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(url), body: init!.body as URLSearchParams };
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 });
    };
    const tokens = await exchangeGoogleCode(
      env,
      { code: 'auth-code', redirectUri: 'https://app.example/cb' },
      fakeFetch as typeof fetch,
    );
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt' });
    expect(captured!.url).toBe('https://oauth2.googleapis.com/token');
    expect(captured!.body.get('grant_type')).toBe('authorization_code');
    expect(captured!.body.get('code')).toBe('auth-code');
    expect(captured!.body.get('client_secret')).toBe('client-secret-xyz');
  });

  it('refreshes a refresh token into an access token', async () => {
    const fakeFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect((init!.body as URLSearchParams).get('grant_type')).toBe('refresh_token');
      return new Response(JSON.stringify({ access_token: 'fresh-at' }), { status: 200 });
    };
    const at = await refreshGoogleAccessToken(env, 'rt', fakeFetch as typeof fetch);
    expect(at).toBe('fresh-at');
  });

  it('throws on a non-2xx token response', async () => {
    const fakeFetch = async () => new Response('nope', { status: 400 });
    await expect(
      refreshGoogleAccessToken(env, 'rt', fakeFetch as typeof fetch),
    ).rejects.toThrow(/refresh failed/);
  });
});
