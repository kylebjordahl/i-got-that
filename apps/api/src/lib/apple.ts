/**
 * Sign in with Apple — verify the identity token (an RS256 JWT) the client gets
 * from Apple, then map its `sub` to an identity (provider='apple').
 *
 * Verification is done with WebCrypto (available in Workers): fetch Apple's
 * JWKS, select the signing key by `kid`, RS256-verify the signature, and check
 * `iss` / `aud` / `exp`. The JWKS + clock are injectable so it tests without a
 * network or a live Apple token.
 */

export interface AppleIdentity {
  /** Apple's stable subject — becomes identities.provider_ref. */
  sub: string;
  email?: string;
}

export interface AppleJwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
}

export interface VerifyAppleOptions {
  /** Allowed `aud` values — your iOS bundle id and/or web Services ID. */
  audience: string | string[];
  /** Injected JWKS (skips the network fetch); used in tests. */
  jwks?: AppleJwk[];
  fetchImpl?: typeof fetch;
  /** Clock override (ms) for tests. */
  now?: number;
}

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

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

async function fetchAppleJwks(fetchImpl: typeof fetch): Promise<AppleJwk[]> {
  const res = await fetchImpl(APPLE_JWKS_URL);
  if (!res.ok) throw new Error(`failed to fetch Apple JWKS: ${res.status}`);
  const json = (await res.json()) as { keys: AppleJwk[] };
  return json.keys;
}

export async function verifyAppleIdentityToken(
  identityToken: string,
  opts: VerifyAppleOptions,
): Promise<AppleIdentity> {
  const parts = identityToken.split('.');
  if (parts.length !== 3) throw new Error('malformed identity token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(base64UrlToString(headerB64)) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('unexpected identity token header');
  }

  const jwks = opts.jwks ?? (await fetchAppleJwks(opts.fetchImpl ?? fetch));
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('no matching Apple signing key');

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
  if (!valid) throw new Error('invalid identity token signature');

  const payload = JSON.parse(base64UrlToString(payloadB64)) as {
    iss?: string;
    aud?: string;
    sub?: string;
    exp?: number;
    email?: string;
  };
  if (payload.iss !== APPLE_ISSUER) throw new Error('unexpected token issuer');
  const audiences = Array.isArray(opts.audience) ? opts.audience : [opts.audience];
  if (!payload.aud || !audiences.includes(payload.aud)) {
    throw new Error('token audience mismatch');
  }
  const now = opts.now ?? Date.now();
  if (typeof payload.exp === 'number' && payload.exp * 1000 < now) {
    throw new Error('identity token expired');
  }
  if (!payload.sub) throw new Error('identity token missing subject');

  return { sub: payload.sub, email: payload.email };
}
