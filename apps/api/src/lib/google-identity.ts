/**
 * Sign in with Google (native) — verify the RS256 identity token the
 * `google_sign_in` SDK returns. Same shape as Apple's identity-token check
 * (lib/apple.ts): fetch Google's JWKS, select the signing key by `kid`,
 * RS256-verify the signature, and check `iss`/`aud`/`exp`. The JWKS + clock
 * are injectable so it tests without a network or a live Google token.
 *
 * The web redirect flow (lib/google-oauth.ts's `decodeGoogleIdToken`) doesn't
 * need this: that id_token arrives server-to-server from Google's token
 * endpoint in response to our client-secret-authenticated code exchange, so
 * it's already trusted. Here the token arrives from the client, so it needs
 * the same untrusted-transport verification as Apple's native flow.
 */

export interface GoogleIdentity {
  /** Google's stable subject — becomes identities.provider_ref. */
  sub: string;
  email?: string;
}

export interface GoogleJwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
}

export interface VerifyGoogleOptions {
  /** Allowed `aud` values — your iOS OAuth client id(s). */
  audience: string | string[];
  /** Injected JWKS (skips the network fetch); used in tests. */
  jwks?: GoogleJwk[];
  fetchImpl?: typeof fetch;
  /** Clock override (ms) for tests. */
  now?: number;
}

/** Google accepts either form as `iss` on its identity tokens. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlToString(input: string): string {
  return new TextDecoder().decode(base64UrlToBytes(input));
}

async function fetchGoogleJwks(fetchImpl: typeof fetch): Promise<GoogleJwk[]> {
  const res = await fetchImpl(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`failed to fetch Google JWKS: ${res.status}`);
  const json = (await res.json()) as { keys: GoogleJwk[] };
  return json.keys;
}

export async function verifyGoogleIdentityToken(
  identityToken: string,
  opts: VerifyGoogleOptions,
): Promise<GoogleIdentity> {
  const parts = identityToken.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(base64UrlToString(headerB64)) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('unexpected token header');
  }

  const jwks = opts.jwks ?? (await fetchGoogleJwks(opts.fetchImpl ?? fetch));
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('no matching Google signing key');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signatureB64),
    signed,
  );
  if (!valid) throw new Error('invalid token signature');

  const payload = JSON.parse(base64UrlToString(payloadB64)) as Record<string, unknown>;
  if (typeof payload.iss !== 'string' || !GOOGLE_ISSUERS.includes(payload.iss)) {
    throw new Error('unexpected token issuer');
  }
  const audiences = Array.isArray(opts.audience) ? opts.audience : [opts.audience];
  if (typeof payload.aud !== 'string' || !audiences.includes(payload.aud)) {
    throw new Error('token audience mismatch');
  }
  const now = opts.now ?? Date.now();
  if (typeof payload.exp === 'number' && payload.exp * 1000 < now) {
    throw new Error('token expired');
  }
  if (typeof payload.sub !== 'string') throw new Error('identity token missing subject');
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  };
}
