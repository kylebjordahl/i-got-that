/** Token + hashing helpers using WebCrypto (available in Workers). */

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cryptographically-random opaque token (hex). */
export function randomToken(byteLength = 32): string {
  const arr = new Uint8Array(byteLength);
  crypto.getRandomValues(arr);
  return toHex(arr);
}

/** SHA-256 hex digest — we store hashes of one-time/session tokens, not the raw value. */
export async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}
