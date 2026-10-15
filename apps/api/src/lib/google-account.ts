import { and, type Db, eq, externalAccounts, feeds, secrets } from '@igt/db';
import { storeSecret, type KekKeySet } from './secrets.js';

/** The name an account gets when Google didn't tell us its email. */
const GENERIC_LABEL = 'Google Calendar';

/**
 * A reconnect named an account the Google consent can't belong to: it isn't
 * this user's Google account, or it's recorded under a different email than
 * the Google account that just consented.
 */
export class GoogleAccountMismatchError extends Error {
  constructor(readonly reason: 'not_found' | 'different_google_account') {
    super(`google reconnect rejected: ${reason}`);
  }
}

/**
 * Connect (or refresh) a user's Google Calendar as an `external_accounts` row,
 * from a refresh token obtained during the OAuth login / connect flow — the
 * "automatically connect Google Calendar" side of Google sign-in, the
 * "connect a calendar" wizard, and an explicit reconnect of one account.
 *
 * Which row a consent lands on, in order:
 *   1. `accountId` — the person pressed "Reconnect" on that account. It wins
 *      over an email match: rows connected before the wizard asked Google who
 *      the account was have no email, so only the person can say which one
 *      this is. Refused when the row is recorded under a different email.
 *   2. `(userId, kind='google', username=email)` — a repeat consent for a
 *      Google account we already know rotates its token in place.
 *   3. Otherwise a new row, recorded under the email.
 *
 * A rotation also clears the error state of every feed on the account: a dead
 * refresh token (`invalid_grant`) is the usual reason they're failing, and a
 * feed left in `error` waits out its retry backoff (up to 6 h) before trying
 * the fresh token. Cleared, it's due on the next cron tick.
 *
 * The credential is envelope-encrypted into a user-owned `secret`
 * (familyId=null), exactly as the `/accounts` route does.
 */
export async function connectGoogleAccount(
  db: Db,
  keys: KekKeySet,
  opts: { userId: string; refreshToken: string; email?: string; accountId?: string },
): Promise<string> {
  const payload = JSON.stringify({ kind: 'oauth', refreshToken: opts.refreshToken });

  let existing: typeof externalAccounts.$inferSelect | undefined;
  if (opts.accountId) {
    existing = (
      await db
        .select()
        .from(externalAccounts)
        .where(
          and(
            eq(externalAccounts.id, opts.accountId),
            eq(externalAccounts.userId, opts.userId),
            eq(externalAccounts.kind, 'google'),
          ),
        )
        .limit(1)
    )[0];
    if (!existing) throw new GoogleAccountMismatchError('not_found');
    if (existing.username && opts.email && existing.username !== opts.email) {
      throw new GoogleAccountMismatchError('different_google_account');
    }
  } else if (opts.email) {
    existing = (
      await db
        .select()
        .from(externalAccounts)
        .where(
          and(
            eq(externalAccounts.userId, opts.userId),
            eq(externalAccounts.kind, 'google'),
            eq(externalAccounts.username, opts.email),
          ),
        )
        .limit(1)
    )[0];
  }

  const credentialsRef = await storeSecret(db, keys, null, payload);

  if (existing) {
    await db
      .update(externalAccounts)
      .set({
        credentialsRef,
        // A fresh grant answers the reconnect prompt; if it still can't read,
        // the next sync raises it again.
        authFailedAt: null,
        authFailureMessage: null,
        reauthNotifiedAt: null,
        // Backfill who this is the first time Google tells us, so the next
        // consent for it matches by email instead of piling up a new row.
        ...(opts.email && !existing.username
          ? {
              username: opts.email,
              ...(existing.name === GENERIC_LABEL ? { name: opts.email } : {}),
            }
          : {}),
      })
      .where(eq(externalAccounts.id, existing.id));
    // Drop the superseded secret so rotated refresh tokens don't linger.
    if (existing.credentialsRef && existing.credentialsRef !== credentialsRef) {
      await db.delete(secrets).where(eq(secrets.id, existing.credentialsRef));
    }
    await db
      .update(feeds)
      .set({ status: 'active', consecutiveFailures: 0, lastErrorMessage: null })
      .where(and(eq(feeds.externalAccountId, existing.id), eq(feeds.status, 'error')));
    return existing.id;
  }

  const row = (
    await db
      .insert(externalAccounts)
      .values({
        userId: opts.userId,
        kind: 'google',
        name: opts.email ?? GENERIC_LABEL,
        serverUrl: null,
        username: opts.email ?? null,
        credentialsRef,
      })
      .returning()
  )[0]!;
  return row.id;
}
