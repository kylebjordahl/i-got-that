import { type Db, eq, secrets } from '@igt/db';

/**
 * App-level envelope encryption. A per-secret DEK encrypts the plaintext; the
 * DEK is wrapped by the KEK (a Worker secret, base64 of 32 random bytes). Only
 * ciphertext + iv + wrapped DEK live in D1. WebCrypto (AES-256-GCM) runs in the
 * Worker; decryption happens only in-Worker at delivery time.
 */

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
  return crypto.subtle.importKey('raw', b64ToBytes(kekB64), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  wrappedDek: string;
  keyVersion: number;
}

export async function encryptSecret(
  kekB64: string,
  plaintext: string,
  keyVersion = 1,
): Promise<EncryptedSecret> {
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
  kekB64: string,
  enc: EncryptedSecret,
): Promise<string> {
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

/** Encrypt + persist a secret; returns its id (for calendar_target.credentialsRef). */
export async function storeSecret(
  db: Db,
  kekB64: string,
  familyId: string,
  plaintext: string,
): Promise<string> {
  const enc = await encryptSecret(kekB64, plaintext);
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
  kekB64: string,
  secretId: string,
): Promise<string | null> {
  const row = (
    await db.select().from(secrets).where(eq(secrets.id, secretId)).limit(1)
  )[0];
  if (!row) return null;
  return decryptSecret(kekB64, {
    ciphertext: row.ciphertext,
    iv: row.iv,
    wrappedDek: row.wrappedDek,
    keyVersion: row.keyVersion,
  });
}
