import { and, eq, externalAccounts, getDb, identities } from '@igt/db';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.js';
import type { GoogleJwk } from '../src/lib/google-identity.js';
import { verifyGoogleIdentityToken } from '../src/lib/google-identity.js';
import { login } from './helpers.js';

const ISSUER = 'https://accounts.google.com';
const AUD = 'ios-client-123.apps.googleusercontent.com';
const KID = 'test-key-1';

/** Env with native Google login configured (the base test env leaves
 *  GOOGLE_IOS_CLIENT_IDS empty ⇒ 501). */
const googleEnv = { ...env, GOOGLE_IOS_CLIENT_IDS: AUD };

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
  const jwks: GoogleJwk[] = [{ kty: 'RSA', kid, n: jwk.n!, e: jwk.e! }];
  return { privateKey: kp.privateKey, jwks };
}

async function fetchWith(
  path: string,
  bindings: typeof env,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://api.test${path}`, init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('Sign in with Google (native) — token verification', () => {
  it('verifies a well-formed token and extracts sub + email', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks(KID);
    const now = Date.now();
    const token = await signToken(privateKey, KID, {
      iss: ISSUER,
      aud: AUD,
      sub: 'google-sub-123',
      email: 'abc@example.com',
      exp: Math.floor(now / 1000) + 600,
    });
    const id = await verifyGoogleIdentityToken(token, { audience: AUD, jwks, now });
    expect(id.sub).toBe('google-sub-123');
    expect(id.email).toBe('abc@example.com');
  });

  it('accepts either issuer form Google uses', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks(KID);
    const now = Date.now();
    const token = await signToken(privateKey, KID, {
      iss: 'accounts.google.com',
      aud: AUD,
      sub: 's',
      exp: Math.floor(now / 1000) + 600,
    });
    const id = await verifyGoogleIdentityToken(token, { audience: AUD, jwks, now });
    expect(id.sub).toBe('s');
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
      verifyGoogleIdentityToken(valid, { audience: 'other.apps.googleusercontent.com', jwks, now }),
    ).rejects.toThrow(/audience/);

    const expired = await signToken(privateKey, KID, {
      ...base,
      exp: Math.floor(now / 1000) - 10,
    });
    await expect(
      verifyGoogleIdentityToken(expired, { audience: AUD, jwks, now }),
    ).rejects.toThrow(/expired/);

    const other = await makeKeyAndJwks(KID);
    await expect(
      verifyGoogleIdentityToken(valid, { audience: AUD, jwks: other.jwks, now }),
    ).rejects.toThrow(/signature/);
  });
});

describe('POST /auth/google (native)', () => {
  it('returns 501 when native Google is not configured (no GOOGLE_IOS_CLIENT_IDS)', async () => {
    const res = await fetchWith('/auth/google', env, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'x.y.z' }),
    });
    expect(res.status).toBe(501);
  });

  it('logs in with a valid identity token, creating the user', async () => {
    const { privateKey, jwks } = await makeKeyAndJwks(KID);
    const now = Date.now();
    const token = await signToken(privateKey, KID, {
      iss: ISSUER,
      aud: AUD,
      sub: 'g-native-1',
      email: 'native@example.com',
      exp: Math.floor(now / 1000) + 600,
    });
    // The route fetches Google's JWKS over the network; stub it to return ours.
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 }),
    );
    try {
      const res = await fetchWith('/auth/google', googleEnv, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessionToken: string; user: { id: string } };
      expect(body.sessionToken).toBeTruthy();

      const db = getDb(env.DB);
      const idRows = await db
        .select()
        .from(identities)
        .where(and(eq(identities.provider, 'google'), eq(identities.providerRef, 'g-native-1')));
      expect(idRows).toHaveLength(1);
      expect(idRows[0]!.userId).toBe(body.user.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects an invalid identity token', async () => {
    const res = await fetchWith('/auth/google', googleEnv, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: 'not.a.jwt' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/link/google (native)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('threads a native Google identity onto the signed-in user', async () => {
    const alice = await login('g-native-link@example.com');
    const { privateKey, jwks } = await makeKeyAndJwks(KID);
    const now = Date.now();
    const token = await signToken(privateKey, KID, {
      iss: ISSUER,
      aud: AUD,
      sub: 'g-native-link-sub',
      email: 'nativelink@example.com',
      exp: Math.floor(now / 1000) + 600,
    });
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ keys: jwks }), { status: 200 }),
    );

    const res = await fetchWith('/auth/link/google', googleEnv, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${alice.token}`,
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(res.status).toBe(200);

    const db = getDb(env.DB);
    const idRows = await db
      .select()
      .from(identities)
      .where(and(eq(identities.provider, 'google'), eq(identities.providerRef, 'g-native-link-sub')));
    expect(idRows[0]!.userId).toBe(alice.userId);
    // No serverAuthCode was sent, so no calendar account is connected.
    const accounts = await db
      .select()
      .from(externalAccounts)
      .where(and(eq(externalAccounts.userId, alice.userId), eq(externalAccounts.kind, 'google')));
    expect(accounts).toHaveLength(0);
  });
});
