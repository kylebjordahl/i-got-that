import { and, eq, getDb, identities, users } from '@igt/db';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index.js';
import {
  type AppleJwk,
  verifyAppleIdentityToken,
  verifyAppleNotificationToken,
} from '../src/lib/apple.js';
import {
  createSession,
  findOrCreateUserByApple,
  getUserBySessionToken,
  handleAppleAccountEvent,
} from '../src/services/auth.js';

const ISSUER = 'https://appleid.apple.com';
const AUD = 'com.example.caretaker';
const KID = 'test-key-1';

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlStr = (s: string) => b64url(new TextEncoder().encode(s));

async function signToken(
  privateKey: CryptoKey,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', kid }));
  const payload = b64urlStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, data),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

async function makeKeyAndJwks(kid: string) {
  const kp = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  const jwks: AppleJwk[] = [{ kty: 'RSA', kid, n: jwk.n!, e: jwk.e! }];
  return { privateKey: kp.privateKey, jwks };
}

describe('Sign in with Apple — token verification', () => {
  it('verifies a well-formed token and extracts sub + email', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks(KID);
    const now = Date.now();
    const token = await signToken(privateKey, KID, {
      iss: ISSUER,
      aud: AUD,
      sub: 'apple-sub-123',
      email: 'abc@privaterelay.appleid.com',
      exp: Math.floor(now / 1000) + 600,
    });
    const id = await verifyAppleIdentityToken(token, { audience: AUD, jwks, now });
    expect(id.sub).toBe('apple-sub-123');
    expect(id.email).toBe('abc@privaterelay.appleid.com');
  });

  it('enforces the nonce when one is expected (web flow)', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks(KID);
    const now = Date.now();
    const token = await signToken(privateKey, KID, {
      iss: ISSUER,
      aud: AUD,
      sub: 's',
      nonce: 'the-real-nonce',
      exp: Math.floor(now / 1000) + 600,
    });
    // Matching nonce → ok.
    const id = await verifyAppleIdentityToken(token, {
      audience: AUD,
      jwks,
      now,
      nonce: 'the-real-nonce',
    });
    expect(id.sub).toBe('s');
    // Wrong nonce → rejected.
    await expect(
      verifyAppleIdentityToken(token, { audience: AUD, jwks, now, nonce: 'other' }),
    ).rejects.toThrow(/nonce/);
  });

  it('rejects a wrong audience, expiry, and a wrong signing key', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks(KID);
    const now = Date.now();
    const base = { iss: ISSUER, aud: AUD, sub: 's' };

    const valid = await signToken(privateKey, KID, {
      ...base,
      exp: Math.floor(now / 1000) + 600,
    });
    await expect(
      verifyAppleIdentityToken(valid, { audience: 'other.app', jwks, now }),
    ).rejects.toThrow(/audience/);

    const expired = await signToken(privateKey, KID, {
      ...base,
      exp: Math.floor(now / 1000) - 10,
    });
    await expect(
      verifyAppleIdentityToken(expired, { audience: AUD, jwks, now }),
    ).rejects.toThrow(/expired/);

    // A JWKS from a different key pair → signature fails.
    const other = await makeKeyAndJwks(KID);
    await expect(
      verifyAppleIdentityToken(valid, { audience: AUD, jwks: other.jwks, now }),
    ).rejects.toThrow(/signature/);
  });
});

describe('POST /auth/apple', () => {
  it('returns 501 when Apple is not configured (no APPLE_CLIENT_IDS)', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://api.test/auth/apple', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identityToken: 'x.y.z' }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    // APPLE_CLIENT_IDS isn't set in the test env → the route is disabled.
    expect(res.status).toBe(501);
  });
});

describe('Web Sign in with Apple redirect flow', () => {
  const WEB_ID = 'com.example.caretaker.web';
  const ORIGIN = 'https://app.test';
  const REDIRECT = `${ORIGIN}/api/auth/apple/callback`;
  const webEnv = {
    ...env,
    PUBLIC_ORIGIN: ORIGIN,
    APPLE_CLIENT_IDS: WEB_ID,
    APPLE_WEB_CLIENT_ID: WEB_ID,
  };

  async function fetchWith(request: Request, bindings: typeof env) {
    const ctx = createExecutionContext();
    const res = await app.fetch(request, bindings, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it('GET /auth/apple/start → 501 when the web flow is unconfigured', async () => {
    const res = await fetchWith(
      new Request('https://api.test/auth/apple/start'),
      env,
    );
    expect(res.status).toBe(501);
  });

  it('GET /auth/apple/start → 302 to Apple with state cookie + params', async () => {
    const res = await fetchWith(
      new Request('https://api.test/auth/apple/start'),
      webEnv,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(
      'https://appleid.apple.com/auth/authorize',
    );
    expect(location.searchParams.get('client_id')).toBe(WEB_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(location.searchParams.get('response_mode')).toBe('form_post');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('nonce')).toBeTruthy();
    expect(res.headers.get('set-cookie')).toContain('igt_apple_oauth=');
  });

  it('POST /auth/apple/callback → sends Apple errors back to the app', async () => {
    const res = await fetchWith(
      new Request('https://api.test/auth/apple/callback', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ error: 'user_cancelled_authorize' }).toString(),
      }),
      webEnv,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.test/app/#auth_error=user_cancelled_authorize',
    );
  });

  it('POST /auth/apple/callback → rejects a response with no matching state cookie', async () => {
    const res = await fetchWith(
      new Request('https://api.test/auth/apple/callback', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ state: 'abc', id_token: 'x.y.z' }).toString(),
      }),
      webEnv,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.test/app/#auth_error=state_mismatch',
    );
  });
});

describe('Apple server-to-server notifications', () => {
  const AUD = 'com.example.caretaker';

  async function signNotification(
    privateKey: CryptoKey,
    kid: string,
    eventPayload: Record<string, unknown>,
  ): Promise<string> {
    // Apple nests the event as a JSON *string* in the `events` claim.
    return signToken(privateKey, kid, {
      iss: ISSUER,
      aud: AUD,
      iat: Math.floor(Date.now() / 1000),
      events: JSON.stringify(eventPayload),
    });
  }

  it('verifies a notification and decodes its event', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks(KID);
    const token = await signNotification(privateKey, KID, {
      type: 'consent-revoked',
      sub: 'apple-sub-revoke',
      event_time: 1700000000000,
    });
    const event = await verifyAppleNotificationToken(token, { audience: AUD, jwks });
    expect(event.type).toBe('consent-revoked');
    expect(event.sub).toBe('apple-sub-revoke');
  });

  it('rejects a notification for a wrong audience', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks(KID);
    const token = await signNotification(privateKey, KID, {
      type: 'account-delete',
      sub: 's',
    });
    await expect(
      verifyAppleNotificationToken(token, { audience: 'other.app', jwks }),
    ).rejects.toThrow(/audience/);
  });

  it('consent-revoked signs the user out and drops the Apple identity', async () => {
    const db = getDb(env.DB);
    const sub = `sub-revoke-${crypto.randomUUID()}`;
    const user = await findOrCreateUserByApple(db, sub, 'revoke@relay.test');
    const session = await createSession(db, user.id);

    await handleAppleAccountEvent(db, { type: 'consent-revoked', sub });

    // Session invalidated…
    expect(await getUserBySessionToken(db, session)).toBeNull();
    // …and the Apple identity is gone (a fresh sign-in mints a new user).
    const stillLinked = await db
      .select({ id: identities.id })
      .from(identities)
      .where(and(eq(identities.provider, 'apple'), eq(identities.providerRef, sub)));
    expect(stillLinked).toHaveLength(0);
    // The user row itself survives (they may have other identities).
    const userRow = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    expect(userRow).toHaveLength(1);
  });

  it('account-delete removes the user (cascading identities + sessions)', async () => {
    const db = getDb(env.DB);
    const sub = `sub-delete-${crypto.randomUUID()}`;
    const user = await findOrCreateUserByApple(db, sub, 'delete@relay.test');
    const session = await createSession(db, user.id);

    await handleAppleAccountEvent(db, { type: 'account-delete', sub });

    expect(await getUserBySessionToken(db, session)).toBeNull();
    const userRow = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    expect(userRow).toHaveLength(0);
  });

  it('no-ops for an unknown subject', async () => {
    const db = getDb(env.DB);
    await expect(
      handleAppleAccountEvent(db, { type: 'account-delete', sub: 'never-seen' }),
    ).resolves.toBeUndefined();
  });

  it('POST /auth/apple/notifications → 501 when Apple is unconfigured', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://api.test/auth/apple/notifications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: 'x.y.z' }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(501);
  });

  it('POST /auth/apple/notifications → 400 on a malformed body', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://api.test/auth/apple/notifications', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nope: true }),
      }),
      { ...env, APPLE_CLIENT_IDS: AUD },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});
