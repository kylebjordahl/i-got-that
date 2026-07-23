import { and, type Db, eq, externalAccounts, secrets } from '@igt/db';
import { storeSecret } from './secrets.js';

/**
 * Connect (or refresh) a user's Google Calendar as an `external_accounts` row,
 * from a refresh token obtained during the OAuth login / connect flow — the
 * "automatically connect Google Calendar" side of Google sign-in, and the
 * calendar hook-up done when any user links a Google account through the wizard.
 *
 * Idempotent per Google account: keyed on `(userId, kind='google', username=
 * email)`, a repeat consent rotates the stored refresh token in place rather
 * than piling up duplicate accounts. The credential is envelope-encrypted into a
 * user-owned `secret` (familyId=null), exactly as the `/accounts` route does.
 */
export async function connectGoogleAccount(
  db: Db,
  kek: string,
  opts: { userId: string; refreshToken: string; email?: string },
): Promise<string> {
  const label = opts.email ?? 'Google Calendar';
  const payload = JSON.stringify({ kind: 'oauth', refreshToken: opts.refreshToken });

  // Match an existing Google account for this user (by email when we have one, so
  // re-consenting the same Google account rotates rather than duplicates).
  const existing = (
    await db
      .select()
      .from(externalAccounts)
      .where(
        and(
          eq(externalAccounts.userId, opts.userId),
          eq(externalAccounts.kind, 'google'),
          opts.email
            ? eq(externalAccounts.username, opts.email)
            : eq(externalAccounts.name, label),
        ),
      )
      .limit(1)
  )[0];

  const credentialsRef = await storeSecret(db, kek, null, payload);

  if (existing) {
    await db
      .update(externalAccounts)
      .set({ credentialsRef })
      .where(eq(externalAccounts.id, existing.id));
    // Drop the superseded secret so rotated refresh tokens don't linger.
    if (existing.credentialsRef && existing.credentialsRef !== credentialsRef) {
      await db.delete(secrets).where(eq(secrets.id, existing.credentialsRef));
    }
    return existing.id;
  }

  const row = (
    await db
      .insert(externalAccounts)
      .values({
        userId: opts.userId,
        kind: 'google',
        name: label,
        serverUrl: null,
        username: opts.email ?? null,
        credentialsRef,
      })
      .returning()
  )[0]!;
  return row.id;
}
