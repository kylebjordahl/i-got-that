import { type Db, eq, externalAccounts } from '@igt/db';
import type { DeliveryCredential } from '@igt/delivery';
import { KekVersionNotConfiguredError, loadSecret, type KekKeySet } from './secrets.js';

/**
 * Decrypt a connected external account's stored credential. CalDAV/iCloud
 * accounts hold a `basic` credential (username + app-specific password); Google
 * accounts hold an `oauth` credential (a stored refresh token). Used by both the
 * ingest path (input feeds) and the delivery path (output feeds), which resolve
 * the credential from the feed/target's linked account rather than storing it
 * per-feed. Returns undefined when there's no account, no stored secret, no
 * configured KEK, or decryption fails — an unconfigured KEK and a decryption
 * failure are both logged first (the latter distinctly for a rotation-left-a-gap
 * `KekVersionNotConfiguredError` vs. any other decrypt error) so a missing key
 * or a botched rotation is diagnosable instead of looking like a random
 * feed/mirror error, or like nothing at all.
 */
export async function resolveAccountCredential(
  db: Db,
  keys: KekKeySet | undefined,
  accountId: string | null,
): Promise<DeliveryCredential | undefined> {
  if (!accountId) return undefined;
  if (!keys) {
    // Distinct from "no account" / "no secret": the credential is intact and
    // simply unreadable in this environment. Left silent, a deployment missing
    // KEK_V<n> looks like every feed and mirror deciding it has nothing to do.
    console.error(
      `resolveAccountCredential: no envelope-encryption KEK configured (KEK_V<n>) — account ${accountId}'s credential can't be decrypted; its feeds and mirrors will be skipped. See docs/DEPLOYMENT.md § KEK.`,
    );
    return undefined;
  }
  const account = (
    await db
      .select()
      .from(externalAccounts)
      .where(eq(externalAccounts.id, accountId))
      .limit(1)
  )[0];
  if (!account?.credentialsRef) return undefined;

  let raw: string | null;
  try {
    raw = await loadSecret(db, keys, account.credentialsRef);
  } catch (err) {
    if (err instanceof KekVersionNotConfiguredError) {
      console.error(
        `resolveAccountCredential: keyVersion ${err.keyVersion} not configured for account ${accountId} (secret ${account.credentialsRef}) — a KEK rotation likely dropped the old KEK_V${err.keyVersion} before every secret was re-encrypted; run tools/rotate-kek.ts`,
      );
    } else {
      console.error(
        `resolveAccountCredential: decrypt failed for account ${accountId} (secret ${account.credentialsRef})`,
        err,
      );
    }
    return undefined;
  }
  return raw ? (JSON.parse(raw) as DeliveryCredential) : undefined;
}
