import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  buildKekKeySet,
  decryptSecret,
  encryptSecret,
  InvalidKekError,
  kekStatus,
  KekVersionNotConfiguredError,
  type KekKeySet,
} from '../src/lib/secrets.js';

/** A 32-byte (AES-256) key, base64-encoded — the only valid KEK shape. */
function fakeKek(byte: number): string {
  let s = '';
  for (const b of new Uint8Array(32).fill(byte)) s += String.fromCharCode(b);
  return btoa(s);
}

function keySet(currentVersion: number, keys: Record<number, string>): KekKeySet {
  return {
    currentVersion,
    getKey: (version) => keys[version],
  };
}

describe('encryptSecret / decryptSecret', () => {
  it('stamps the current key version on the encrypted result', async () => {
    const keys = keySet(3, { 3: fakeKek(3) });
    const enc = await encryptSecret(keys, 'hello world');
    expect(enc.keyVersion).toBe(3);
  });

  it('round-trips plaintext through encrypt then decrypt', async () => {
    const keys = keySet(1, { 1: fakeKek(1) });
    const enc = await encryptSecret(keys, 'super secret value');
    const plaintext = await decryptSecret(keys, enc);
    expect(plaintext).toBe('super secret value');
  });

  it('decrypts old-version rows after rotation, using each row\'s own key version', async () => {
    const oldKeys = keySet(1, { 1: fakeKek(1) });
    const encOld = await encryptSecret(oldKeys, 'pre-rotation secret');

    // After rotation the key set carries both versions, but new encrypts
    // stamp the new current version.
    const rotatedKeys = keySet(2, { 1: fakeKek(1), 2: fakeKek(2) });
    expect((await decryptSecret(rotatedKeys, encOld)).toString()).toBe(
      'pre-rotation secret',
    );
    const encNew = await encryptSecret(rotatedKeys, 'post-rotation secret');
    expect(encNew.keyVersion).toBe(2);
    expect(await decryptSecret(rotatedKeys, encNew)).toBe('post-rotation secret');
  });

  it('throws a distinct, typed error when decrypting with a missing key version', async () => {
    const keys = keySet(1, { 1: fakeKek(1) });
    const enc = await encryptSecret(keys, 'value');

    // Simulate the KEK_V1 secret being removed from the environment (e.g. a
    // rotation cleanup that ran ahead of the sweep re-encrypting this row).
    const keysWithoutV1 = keySet(2, { 2: fakeKek(2) });
    await expect(decryptSecret(keysWithoutV1, enc)).rejects.toBeInstanceOf(
      KekVersionNotConfiguredError,
    );
  });

  it('throws a distinct, typed error when encrypting with an unconfigured current version', async () => {
    const keys = keySet(5, {});
    await expect(encryptSecret(keys, 'value')).rejects.toBeInstanceOf(
      KekVersionNotConfiguredError,
    );
  });

  it('rejects a KEK that does not base64-decode to exactly 32 bytes (importKek, via encryptSecret)', async () => {
    let s = '';
    for (const b of new Uint8Array(16)) s += String.fromCharCode(b);
    const tooShort = btoa(s);
    const keys = keySet(1, { 1: tooShort });
    await expect(encryptSecret(keys, 'value')).rejects.toBeInstanceOf(InvalidKekError);
  });

  it('rejects a non-base64 KEK string (importKek, via decryptSecret)', async () => {
    const keys = keySet(1, { 1: fakeKek(1) });
    const enc = await encryptSecret(keys, 'value');
    const badKeys = keySet(1, { 1: 'not-valid-base64!!' });
    await expect(decryptSecret(badKeys, enc)).rejects.toBeInstanceOf(InvalidKekError);
  });
});

describe('buildKekKeySet', () => {
  it('defaults to version 1 when KEK_CURRENT_VERSION is unset', () => {
    // The test env's wrangler.jsonc leaves KEK_CURRENT_VERSION unset and
    // provides KEK_V1 (dev-only value) — mirrors an un-rotated deployment.
    const keys = buildKekKeySet(env);
    expect(keys?.currentVersion).toBe(1);
    expect(keys?.getKey(1)).toBe(env.KEK_V1);
  });

  it('returns undefined when the current version\'s key is not configured', () => {
    const keys = buildKekKeySet({ ...env, KEK_CURRENT_VERSION: '7' });
    expect(keys).toBeUndefined();
  });

  it('rejects a non-integer KEK_CURRENT_VERSION', () => {
    expect(() => buildKekKeySet({ ...env, KEK_CURRENT_VERSION: 'not-a-number' })).toThrow();
  });

  it('looks up KEK_V<n> by name for any configured version', () => {
    const keys = buildKekKeySet({
      ...env,
      KEK_CURRENT_VERSION: '2',
      // @ts-expect-error — KEK_V2 isn't declared on ProvidedEnv, but
      // buildKekKeySet reads any KEK_V<n> by name at runtime.
      KEK_V2: fakeKek(2),
    });
    expect(keys?.currentVersion).toBe(2);
    expect(keys?.getKey(1)).toBe(env.KEK_V1);
    expect(keys?.getKey(2)).toBeTruthy();
  });
});

describe('kekStatus', () => {
  it('is ok when the current version resolves to valid AES-256 material', () => {
    expect(kekStatus(env)).toBe('ok');
  });

  it('is missing when the current version has no KEK_V<n>', () => {
    expect(kekStatus({ ...env, KEK_CURRENT_VERSION: '7' })).toBe('missing');
  });

  it('is missing when KEK_CURRENT_VERSION is unusable (no version can resolve)', () => {
    expect(kekStatus({ ...env, KEK_CURRENT_VERSION: 'not-a-number' })).toBe('missing');
  });

  it('is invalid when a key is set but is not 32 bytes of base64', () => {
    expect(kekStatus({ ...env, KEK_V1: fakeKek(1).slice(0, 20) })).toBe('invalid');
    expect(kekStatus({ ...env, KEK_V1: 'not-valid-base64!!' })).toBe('invalid');
  });
});
