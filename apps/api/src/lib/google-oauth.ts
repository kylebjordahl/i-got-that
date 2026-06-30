import type { Bindings } from '../env.js';

/**
 * Google OAuth for the Calendar provider. The client runs the consent flow and
 * sends us the authorization code; we exchange it (with the client secret) for
 * a long-lived **refresh token**, which we store encrypted. At delivery time we
 * exchange the refresh token for a short-lived access token. `fetchImpl` is
 * injectable for tests.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function requireClient(env: Bindings): { id: string; secret: string } {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('google_oauth_not_configured');
  }
  return { id: env.GOOGLE_OAUTH_CLIENT_ID, secret: env.GOOGLE_OAUTH_CLIENT_SECRET };
}

export function googleOAuthConfigured(env: Bindings): boolean {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

/** The consent URL to send the user to. `access_type=offline` + `prompt=consent`
 *  are required to receive a refresh token. */
export function buildGoogleAuthorizeUrl(
  env: Bindings,
  opts: { redirectUri: string; state?: string },
): string {
  const client = requireClient(env);
  const params = new URLSearchParams({
    client_id: client.id,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  if (opts.state) params.set('state', opts.state);
  return `${AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
}

export async function exchangeGoogleCode(
  env: Bindings,
  opts: { code: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokens> {
  const client = requireClient(env);
  const body = new URLSearchParams({
    code: opts.code,
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: opts.redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`google code exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { access_token: string; refresh_token?: string };
  return { accessToken: json.access_token, refreshToken: json.refresh_token };
}

export async function refreshGoogleAccessToken(
  env: Bindings,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const client = requireClient(env);
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: client.id,
    client_secret: client.secret,
    grant_type: 'refresh_token',
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`google token refresh failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}
