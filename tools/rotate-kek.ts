#!/usr/bin/env node
/**
 * One-shot KEK rotation sweep: re-encrypts every `secrets` row still wrapped
 * by an older KEK version onto the current one. See `docs/DEPLOYMENT.md` §
 * "Rotating the envelope-encryption KEK" for the full procedure (order of
 * operations, when to set/remove `KEK_V<n>` Worker secrets).
 *
 * This is a plain Node script, not a Worker — it never gets a D1 binding, so
 * it shells out to `wrangler d1 execute --remote` (same approach as
 * `tools/reset-staging.zsh`) to read/write the deployed database. It reuses
 * the exact WebCrypto envelope-encryption scheme from
 * `apps/api/src/lib/secrets.ts` (duplicated here, not imported — this runs
 * under plain Node against a `@igt/db`-free CLI, outside the workspace's
 * bundler-style `.js` → `.ts` path resolution that only `tsc`/Vite understand;
 * keep the two in sync if the envelope format ever changes).
 *
 * Usage (from the repo root):
 *   ENV=staging DB=DB \
 *   KEK_CURRENT_VERSION=2 \
 *   KEK_V1=<old key b64> KEK_V2=<new key b64> \
 *     node tools/rotate-kek.ts
 *
 * Env vars:
 *   ENV                 wrangler named env to target (default: staging;
 *                        NEVER pass "production" without having verified this
 *                        against staging first)
 *   DB                   the D1 *binding* name in apps/api/wrangler.jsonc
 *                        (default: DB)
 *   KEK_CURRENT_VERSION  required — the version rows should end up on. Must
 *                        match the deployed Worker's KEK_CURRENT_VERSION, or
 *                        you'll re-encrypt rows onto a version the Worker
 *                        isn't writing new secrets with.
 *   KEK_V<n>             the base64 KEK for each version this sweep needs —
 *                        at minimum the current version and every older
 *                        version still present in the table. Only ever pass
 *                        these as env vars for the lifetime of this process;
 *                        never write them to a file.
 *
 * Safe to re-run: rows already on KEK_CURRENT_VERSION are left alone, and a
 * failure on one row (bad ciphertext, missing key version, etc.) is logged
 * and skipped rather than aborting the whole sweep — consistent with this
 * repo's "don't let one bad row take down the batch" ethos.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const KEK_BYTE_LENGTH = 32;

// --- Envelope-encryption primitives (mirrors apps/api/src/lib/secrets.ts) --

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
  const bytes = b64ToBytes(kekB64);
  if (bytes.length !== KEK_BYTE_LENGTH) {
    throw new Error(
      `KEK must base64-decode to exactly ${KEK_BYTE_LENGTH} bytes (AES-256 key), got ${bytes.length}`,
    );
  }
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  wrappedDek: string;
  keyVersion: number;
}

async function encryptSecret(kekB64: string, keyVersion: number, plaintext: string): Promise<EncryptedSecret> {
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

  const dekRaw = new Uint8Array((await crypto.subtle.exportKey('raw', dek)) as ArrayBuffer);
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

async function decryptSecret(kekB64: string, enc: EncryptedSecret): Promise<string> {
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

// --- Talking to the deployed D1 database via the wrangler CLI --------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(REPO_ROOT, 'apps/api');

/** Single quotes are the only special char these values can't contain safely. */
function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function runD1Command(env: string, db: string, sql: string, opts: { json: boolean }): string {
  const args = ['wrangler', 'd1', 'execute', db, '--env', env, '--remote', '--yes', '--command', sql];
  if (opts.json) args.push('--json');
  return execFileSync('npx', args, { cwd: API_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

interface SecretRow {
  id: string;
  ciphertext: string;
  iv: string;
  wrapped_dek: string;
  key_version: number;
}

function parseWranglerJson(output: string): unknown {
  // wrangler sometimes prints deprecation warnings / progress noise before the
  // JSON payload — find where the JSON actually starts.
  const start = output.search(/[[{]/);
  if (start === -1) throw new Error(`wrangler produced no JSON output:\n${output}`);
  return JSON.parse(output.slice(start));
}

function extractRows(raw: unknown): SecretRow[] {
  // `wrangler d1 execute --json` returns an array of per-statement results,
  // each with a `results` array of row objects.
  const statements = Array.isArray(raw) ? raw : [raw];
  const rows: SecretRow[] = [];
  for (const stmt of statements) {
    const results = (stmt as { results?: unknown }).results;
    if (Array.isArray(results)) rows.push(...(results as SecretRow[]));
  }
  return rows;
}

async function main() {
  const env = process.env.ENV ?? 'staging';
  const db = process.env.DB ?? 'DB';
  const rawCurrentVersion = process.env.KEK_CURRENT_VERSION;
  if (!rawCurrentVersion) {
    throw new Error('KEK_CURRENT_VERSION env var is required (must match the deployed Worker\'s value)');
  }
  const currentVersion = Number(rawCurrentVersion);
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new Error(`KEK_CURRENT_VERSION must be a positive integer, got ${JSON.stringify(rawCurrentVersion)}`);
  }
  const currentKek = process.env[`KEK_V${currentVersion}`];
  if (!currentKek) {
    throw new Error(`KEK_V${currentVersion} env var is required (the target key for this sweep)`);
  }

  console.log(`rotate-kek: env=${env} db=${db} target keyVersion=${currentVersion}`);
  console.log('rotate-kek: querying rows below the target version…');

  const selectSql = `SELECT id, ciphertext, iv, wrapped_dek, key_version FROM secrets WHERE key_version < ${currentVersion}`;
  const rawOut = runD1Command(env, db, selectSql, { json: true });
  const rows = extractRows(parseWranglerJson(rawOut));

  if (rows.length === 0) {
    console.log('rotate-kek: no rows below the target version — nothing to do.');
    return;
  }
  console.log(`rotate-kek: found ${rows.length} row(s) to re-encrypt.`);

  let succeeded = 0;
  let failed = 0;
  let skippedMissingKey = 0;

  for (const row of rows) {
    const oldKek = process.env[`KEK_V${row.key_version}`];
    if (!oldKek) {
      console.error(
        `rotate-kek: skipping secret ${row.id} — KEK_V${row.key_version} not provided in env, can't decrypt it`,
      );
      skippedMissingKey++;
      continue;
    }
    try {
      const plaintext = await decryptSecret(oldKek, {
        ciphertext: row.ciphertext,
        iv: row.iv,
        wrappedDek: row.wrapped_dek,
        keyVersion: row.key_version,
      });
      const reEncrypted = await encryptSecret(currentKek, currentVersion, plaintext);
      const updateSql =
        `UPDATE secrets SET ciphertext = '${sqlEscape(reEncrypted.ciphertext)}', ` +
        `iv = '${sqlEscape(reEncrypted.iv)}', ` +
        `wrapped_dek = '${sqlEscape(reEncrypted.wrappedDek)}', ` +
        `key_version = ${reEncrypted.keyVersion} ` +
        `WHERE id = '${sqlEscape(row.id)}'`;
      runD1Command(env, db, updateSql, { json: false });
      succeeded++;
    } catch (err) {
      console.error(
        `rotate-kek: failed to re-encrypt secret ${row.id} (was keyVersion ${row.key_version})`,
        err,
      );
      failed++;
    }
  }

  console.log(
    `rotate-kek: done. ${succeeded} re-encrypted, ${failed} failed, ${skippedMissingKey} skipped (missing key).`,
  );
  if (failed > 0 || skippedMissingKey > 0) {
    console.log(
      'rotate-kek: re-run once the missing KEK_V<n> values are available, or investigate the failures above — old rows keep working as long as their KEK_V<n> stays configured.',
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('rotate-kek: fatal error:', err);
  process.exitCode = 1;
});
