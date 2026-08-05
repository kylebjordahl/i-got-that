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

import { sha256hex } from './crypto.js';

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
  /** Milliseconds since epoch — required and freshness-checked (see `verifyAppleNotificationToken`). */
  eventTime: number;
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
   * Expected `nonce`, already SHA-256-hashed the same way Apple hashes what it
   * echoes into the token's `nonce` claim (Apple never returns the raw value —
   * it round-trips whatever digest the client sent it at authorization time).
   * Prefer {@link rawNonce} when you have the client's original, unhashed
   * value; this is here for callers that already have the digest.
   */
  nonce?: string;
  /**
   * The client's original (unhashed) nonce. When present, this is SHA-256'd
   * and compared against the token's `nonce` claim — replay protection: the
   * token can only be redeemed by whoever holds the raw value the client
   * generated for this specific sign-in attempt, since Apple ties the digest
   * it echoes back to the digest the client sent it. Preferred over
   * {@link nonce}; only one of the two should be set.
   */
  rawNonce?: string;
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
 * and `exp` — and return the decoded payload. Shared by the identity-token and
 * notification checks; callers assert their own extra claims.
 */
async function verifyAppleJws(
  token: string,
  opts: Pick<VerifyAppleOptions, 'audience' | 'jwks' | 'fetchImpl' | 'now'> & {
    /**
     * Identity tokens always carry `exp` and it must be enforced strictly —
     * default `true`. Apple's server-to-server *notification* JWS never sets
     * `exp` (it's not a bearer credential), so the notification-verification
     * path passes `false` and relies on its own `iat`/`event_time` freshness
     * checks instead.
     */
    requireExp?: boolean;
  },
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
  const requireExp = opts.requireExp ?? true;
  if (typeof payload.exp === 'number') {
    if (payload.exp * 1000 < now) throw new Error('token expired');
  } else if (requireExp) {
    throw new Error('token missing exp');
  }
  return payload;
}

export async function verifyAppleIdentityToken(
  identityToken: string,
  opts: VerifyAppleOptions,
): Promise<AppleIdentity> {
  const payload = await verifyAppleJws(identityToken, { ...opts, requireExp: true });
  const expectedNonce = opts.rawNonce !== undefined ? await sha256hex(opts.rawNonce) : opts.nonce;
  if (expectedNonce !== undefined && payload.nonce !== expectedNonce) {
    throw new Error('identity token nonce mismatch');
  }
  if (typeof payload.sub !== 'string') throw new Error('identity token missing subject');
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  };
}

/** Max allowed clock skew (ms) between our clock and the `iat` Apple stamped on a notification. */
const NOTIFICATION_IAT_SKEW_MS = 5 * 60 * 1000;
/** Max allowed age (ms) of the *event* itself (Apple's `event_time`, not the JWS `iat`). */
const NOTIFICATION_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Verify a server-to-server notification JWS and decode its single event. Apple
 * nests the event as a JSON **string** in the `events` claim; we parse it into a
 * typed {@link AppleNotificationEvent}.
 *
 * Notifications never carry `exp` (they're not bearer credentials), so instead
 * of the identity-token's `exp` check we require a fresh `iat` (within
 * {@link NOTIFICATION_IAT_SKEW_MS} of our clock) and a recent `event_time`
 * (within {@link NOTIFICATION_MAX_AGE_MS}) — both close a replay window where
 * an old, legitimately-signed notification is resent later to re-trigger a
 * destructive action (`consent-revoked` / `account-delete`). Callers should
 * additionally dedupe by digest (see `services/auth.ts`'s
 * `recordAppleNotificationOnce`) so an in-window replay still no-ops.
 */
export async function verifyAppleNotificationToken(
  notificationToken: string,
  opts: Pick<VerifyAppleOptions, 'audience' | 'jwks' | 'fetchImpl' | 'now'>,
): Promise<AppleNotificationEvent> {
  const payload = await verifyAppleJws(notificationToken, { ...opts, requireExp: false });
  const now = opts.now ?? Date.now();

  if (typeof payload.iat !== 'number') throw new Error('notification missing iat');
  if (Math.abs(payload.iat * 1000 - now) > NOTIFICATION_IAT_SKEW_MS) {
    throw new Error('notification iat outside allowed skew');
  }

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
  // Apple's `event_time` is milliseconds since epoch (unlike the second-based `iat`/`exp`).
  if (typeof event.event_time !== 'number') throw new Error('notification missing event_time');
  if (now - event.event_time > NOTIFICATION_MAX_AGE_MS) {
    throw new Error('notification event_time too old');
  }

  return {
    type: event.type as AppleNotificationEvent['type'],
    sub: event.sub,
    email: event.email,
    // Apple sends this as the string "true"/"false" (or a bool in some payloads).
    isPrivateEmail: event.is_private_email === true || event.is_private_email === 'true',
    eventTime: event.event_time,
  };
}
