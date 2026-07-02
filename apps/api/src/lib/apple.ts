/**
 * Sign in with Apple — verify RS256 JWTs Apple signs: the **identity token** the
 * client obtains at login, and the **server-to-server notification** JWS Apple
 * sends when a user disables their relay email, revokes consent, or deletes their
 * Apple ID.
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

/** A decoded server-to-server notification event (from the JWS `events` claim). */
export interface AppleNotificationEvent {
  /**
   * `consent-revoked` (user revoked our app) and `account-delete` (Apple ID
   * deleted) require us to drop the identity/sessions; the `email-*` variants
   * just report a relay-address toggle.
   */
  type: 'email-disabled' | 'email-enabled' | 'consent-revoked' | 'account-delete';
  /** The Apple subject the event is about — matches identities.provider_ref. */
  sub: string;
  email?: string;
  isPrivateEmail?: boolean;
  eventTime?: number;
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
  /**
   * Expected `nonce`. The web (Services ID) flow round-trips a nonce through
   * Apple, which echoes it into the token; passing it here asserts the token
   * belongs to the flow we started (replay protection). Omitted for the native
   * flow, which doesn't set one.
   */
  nonce?: string;
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

/**
 * Verify an Apple-signed JWS — RS256 signature (via JWKS/`kid`), `iss`, `aud`,
 * and (when present) `exp` — and return the decoded payload. Shared by the
 * identity-token and notification checks; callers assert their own extra claims.
 */
async function verifyAppleJws(
  token: string,
  opts: Pick<VerifyAppleOptions, 'audience' | 'jwks' | 'fetchImpl' | 'now'>,
): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(base64UrlToString(headerB64)) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('unexpected token header');
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
  if (!valid) throw new Error('invalid token signature');

  const payload = JSON.parse(base64UrlToString(payloadB64)) as Record<string, unknown>;
  if (payload.iss !== APPLE_ISSUER) throw new Error('unexpected token issuer');
  const audiences = Array.isArray(opts.audience) ? opts.audience : [opts.audience];
  if (typeof payload.aud !== 'string' || !audiences.includes(payload.aud)) {
    throw new Error('token audience mismatch');
  }
  const now = opts.now ?? Date.now();
  if (typeof payload.exp === 'number' && payload.exp * 1000 < now) {
    throw new Error('token expired');
  }
  return payload;
}

export async function verifyAppleIdentityToken(
  identityToken: string,
  opts: VerifyAppleOptions,
): Promise<AppleIdentity> {
  const payload = await verifyAppleJws(identityToken, opts);
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) {
    throw new Error('identity token nonce mismatch');
  }
  if (typeof payload.sub !== 'string') throw new Error('identity token missing subject');
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  };
}

/**
 * Verify a server-to-server notification JWS and decode its single event. Apple
 * nests the event as a JSON **string** in the `events` claim; we parse it into a
 * typed {@link AppleNotificationEvent}. (No `nonce`/`exp` is expected here.)
 */
export async function verifyAppleNotificationToken(
  notificationToken: string,
  opts: Pick<VerifyAppleOptions, 'audience' | 'jwks' | 'fetchImpl' | 'now'>,
): Promise<AppleNotificationEvent> {
  const payload = await verifyAppleJws(notificationToken, opts);
  if (typeof payload.events !== 'string') {
    throw new Error('notification missing events');
  }
  const event = JSON.parse(payload.events) as {
    type?: string;
    sub?: string;
    email?: string;
    is_private_email?: string | boolean;
    event_time?: number;
  };
  if (!event.type || !event.sub) throw new Error('notification missing type/sub');
  return {
    type: event.type as AppleNotificationEvent['type'],
    sub: event.sub,
    email: event.email,
    // Apple sends this as the string "true"/"false" (or a bool in some payloads).
    isPrivateEmail: event.is_private_email === true || event.is_private_email === 'true',
    eventTime: event.event_time,
  };
}
