import { type Db, eq, secrets } from '@igt/db';
import type { Bindings } from '../env.js';

/**
 * App-level envelope encryption. A per-secret DEK encrypts the plaintext; the
 * DEK is wrapped by a versioned KEK (a Worker secret, base64 of 32 random
 * bytes — `KEK_V<n>` in `env.ts`). Only ciphertext + iv + wrapped DEK live in
 * D1. WebCrypto (AES-256-GCM) runs in the Worker; decryption happens only
 * in-Worker at delivery time.
 *
 * Rotation: `secrets.keyVersion` records which `KEK_V<n>` wrapped a given
 * row's DEK. `encryptSecret` always stamps the *current* version
 * (`KekKeySet.currentVersion`, driven by `env.KEK_CURRENT_VERSION`);
 * `decryptSecret` looks the right key up by the row's own `keyVersion`, so
 * old and newly-rotated secrets can coexist while a rotation sweep
 * (`tools/rotate-kek.ts`) walks the table re-encrypting old rows onto the new
 * version. See `docs/DEPLOYMENT.md` § KEK rotation for the full procedure.
 */

const KEK_BYTE_LENGTH = 32;

/**
 * Thrown when a KEK doesn't base64-decode to exactly 32 bytes (AES-256) —
 * surfaced at the point a key is first used, instead of as an opaque
 * WebCrypto exception deep in `encrypt`/`decrypt`.
 */
export class InvalidKekError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKekError';
  }
}

/**
 * Thrown by `encryptSecret`/`decryptSecret` when the key version they need
 * (the configured "current" version, or a stored secret's `keyVersion`) has
 * no matching `KEK_V<n>` in this environment — distinguishes "rotation left a
 * gap" from a generic decrypt failure (bad ciphertext, wrong key material).
 */
export class KekVersionNotConfiguredError extends Error {
  constructor(public readonly keyVersion: number) {
    super(
      `keyVersion ${keyVersion} not configured: no KEK_V${keyVersion} binding in this environment`,
    );
    this.name = 'KekVersionNotConfiguredError';
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

async function importKek(kekB64: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(kekB64);
  } catch (err) {
    throw new InvalidKekError(
      `KEK is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (bytes.length !== KEK_BYTE_LENGTH) {
    throw new InvalidKekError(
      `KEK must base64-decode to exactly ${KEK_BYTE_LENGTH} bytes (AES-256 key), got ${bytes.length}`,
    );
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * A resolved set of versioned KEKs for one request/tick: which version to
 * stamp new secrets with (`currentVersion`), and how to look up the raw
 * base64 key for any version a stored secret might carry (`getKey`). Built
 * from the Worker's `KEK_V<n>` / `KEK_CURRENT_VERSION` bindings by
 * `buildKekKeySet`; construct one by hand (e.g. from `process.env`) for
 * scripts like `tools/rotate-kek.ts`.
 */
export interface KekKeySet {
  readonly currentVersion: number;
  getKey(version: number): string | undefined;
}

/**
 * Build a `KekKeySet` from the Worker's bindings. Returns `undefined` when
 * the *current* version's key isn't configured — the same "nothing works"
 * fallback the single `env.KEK` had, so every existing `if (!kek) …` call-site
 * guard behaves the same when no rotation is in play.
 */
export function buildKekKeySet(env: Bindings): KekKeySet | undefined {
  // `KEK_V<n>` is open-ended (a new version per rotation) — env.ts only
  // declares KEK_V1 today, so this reads by name rather than through a
  // hardcoded field list.
  const byName = env as unknown as Record<string, string | undefined>;
  const rawVersion = env.KEK_CURRENT_VERSION;
  const currentVersion = rawVersion === undefined ? 1 : Number(rawVersion);
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new Error(
      `KEK_CURRENT_VERSION must be a positive integer if set, got ${JSON.stringify(rawVersion)}`,
    );
  }
  const getKey = (version: number): string | undefined => byName[`KEK_V${version}`];
  if (!getKey(currentVersion)) return undefined;
  return { currentVersion, getKey };
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  wrappedDek: string;
  keyVersion: number;
}

export async function encryptSecret(
  keys: KekKeySet,
  plaintext: string,
): Promise<EncryptedSecret> {
  const keyVersion = keys.currentVersion;
  const kekB64 = keys.getKey(keyVersion);
  if (!kekB64) throw new KekVersionNotConfiguredError(keyVersion);
  const kek = await importKek(kekB64);
  const dek = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])) as CryptoKey;

  const dataIv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: dataIv },
      dek,
      new TextEncoder().encode(plaintext),
    ),
  );

  const dekRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', dek)) as ArrayBuffer,
  );
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, kek, dekRaw),
  );

  return {
    ciphertext: bytesToB64(ct),
    iv: bytesToB64(dataIv),
    wrappedDek: bytesToB64(concat(wrapIv, wrapped)),
    keyVersion,
  };
}

export async function decryptSecret(
  keys: KekKeySet,
  enc: EncryptedSecret,
): Promise<string> {
  const kekB64 = keys.getKey(enc.keyVersion);
  if (!kekB64) throw new KekVersionNotConfiguredError(enc.keyVersion);
  const kek = await importKek(kekB64);
  const wrappedBytes = b64ToBytes(enc.wrappedDek);
  const wrapIv = wrappedBytes.slice(0, 12);
  const wrapped = wrappedBytes.slice(12);
  const dekRaw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wrapIv }, kek, wrapped);
  const dek = await crypto.subtle.importKey('raw', dekRaw, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(enc.iv) },
    dek,
    b64ToBytes(enc.ciphertext),
  );
  return new TextDecoder().decode(pt);
}

/**
 * Encrypt + persist a secret; returns its id. `familyId` scopes it to a family
 * (cascade-deleted with it); pass `null` for a user-owned secret (e.g. an
 * external account credential reused across the owner's families).
 */
export async function storeSecret(
  db: Db,
  keys: KekKeySet,
  familyId: string | null,
  plaintext: string,
): Promise<string> {
  const enc = await encryptSecret(keys, plaintext);
  const row = (
    await db
      .insert(secrets)
      .values({
        familyId,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        wrappedDek: enc.wrappedDek,
        keyVersion: enc.keyVersion,
      })
      .returning()
  )[0]!;
  return row.id;
}

export async function loadSecret(
  db: Db,
  keys: KekKeySet,
  secretId: string,
): Promise<string | null> {
  const row = (
    await db.select().from(secrets).where(eq(secrets.id, secretId)).limit(1)
  )[0];
  if (!row) return null;
  return decryptSecret(keys, {
    ciphertext: row.ciphertext,
    iv: row.iv,
    wrappedDek: row.wrappedDek,
    keyVersion: row.keyVersion,
  });
}
