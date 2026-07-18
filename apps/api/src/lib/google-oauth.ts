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
// calendar.events: read/write events (input feeds via events.list + the output
// mirror). calendar.freebusy: freebusy.query for busy-mode feeds — the
// intervals-only read of a work calendar shared as "see only free/busy"
// (calendar.events does NOT authorize freebusy.query). Accounts connected
// before the freebusy scope was added must be reconnected once to grant it.
const SCOPE =
  'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy';
/** OpenID Connect scopes so the same consent that grants calendar access also
 *  identifies the user (id_token with `sub` + `email`) — used by the login /
 *  connect redirect flow (`/auth/google/*`). */
const IDENTITY_SCOPES = 'openid email profile';

function requireClient(env: Bindings): { id: string; secret: string } {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('google_oauth_not_configured');
  }
  return { id: env.GOOGLE_OAUTH_CLIENT_ID, secret: env.GOOGLE_OAUTH_CLIENT_SECRET };
}

export function googleOAuthConfigured(env: Bindings): boolean {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

/**
 * A refresh-token→access-token exchanger bound to this env, or undefined when
 * Google OAuth isn't configured. Shared by delivery (output feeds) and ingest
 * (Google input feeds) so the client secret stays in `apps/api`.
 */
export function googleRefresherFor(
  env: Bindings,
): ((refreshToken: string) => Promise<string>) | undefined {
  return googleOAuthConfigured(env)
    ? (refreshToken: string) => refreshGoogleAccessToken(env, refreshToken)
    : undefined;
}

/** The consent URL to send the user to. `access_type=offline` + `prompt=consent`
 *  are required to receive a refresh token. Pass `identity: true` (the login /
 *  connect redirect flow) to also request the OpenID scopes, so the returned
 *  token set carries an id_token identifying the user. */
export function buildGoogleAuthorizeUrl(
  env: Bindings,
  opts: { redirectUri: string; state?: string; identity?: boolean },
): string {
  const client = requireClient(env);
  const params = new URLSearchParams({
    client_id: client.id,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.identity ? `${IDENTITY_SCOPES} ${SCOPE}` : SCOPE,
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
  /** OpenID Connect id_token (present only when identity scopes were granted). */
  idToken?: string;
}

/** The identity claims we read out of a Google id_token. */
export interface GoogleIdentity {
  sub: string;
  email?: string;
}

/**
 * Decode the claims from a Google id_token. No signature check is needed: the
 * token is delivered straight from Google's token endpoint over TLS in response
 * to our client-secret-authenticated code exchange (not via the browser), so it
 * is already trusted — the same trust model as the code exchange itself.
 */
export function decodeGoogleIdToken(idToken: string): GoogleIdentity {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('google id_token malformed');
  const json = new TextDecoder().decode(
    Uint8Array.from(
      atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')),
      (ch) => ch.charCodeAt(0),
    ),
  );
  const claims = JSON.parse(json) as { sub?: string; email?: string };
  if (!claims.sub) throw new Error('google id_token missing sub');
  return { sub: claims.sub, email: claims.email };
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
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
  };
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
