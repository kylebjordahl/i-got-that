import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { type AppleJwk, verifyAppleIdentityToken } from '../src/lib/apple.js';

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
