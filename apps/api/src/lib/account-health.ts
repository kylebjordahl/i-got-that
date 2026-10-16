import { and, type Db, eq, externalAccounts, isNotNull, sql } from '@igt/db';
import { GoogleApiError } from '@igt/ical';
import { GoogleTokenRefreshError } from './google-oauth.js';

/**
 * Account-level health shared by every path that talks to a connected calendar
 * account on its owner's behalf: ingest (input feeds), read-back and the mirror
 * (the member's target calendar). Whichever one finds the grant dead raises the
 * same `externalAccounts.authFailedAt` flag — the Home screen's reconnect card
 * and the reauth push both hang off it — and whichever one reads or writes the
 * account successfully lowers it again.
 */

/** Cap on a stored failure message — enough to diagnose, not enough to bloat the row. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/** A stored failure message for `err`: its message, trimmed to fit the row. */
export function errorMessage(err: unknown): string {
  return truncateError(err instanceof Error ? err.message : String(err));
}

export function truncateError(message: string): string {
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * A failure only the account's owner can fix, by reconnecting it: Google
 * refused the refresh token, or the grant can't do the read. Anything else
 * (network, a quota, a calendar that was unshared) retries on its own or needs
 * a different fix, so it doesn't ask anyone to sign in again.
 */
export function needsReauth(err: unknown): boolean {
  return (
    (err instanceof GoogleTokenRefreshError || err instanceof GoogleApiError) && err.needsReauth
  );
}

/**
 * Flag `accountId` for reconnection when `err` is one only a reconnect fixes
 * (no-op for any other error, or no account). Keeps the *first* failure time:
 * the reauth alert waits on how long the account has been broken, not on how
 * recently it last failed.
 */
export async function recordAccountAuthFailure(
  db: Db,
  accountId: string | null | undefined,
  err: unknown,
  at: Date,
): Promise<void> {
  if (!accountId || !needsReauth(err)) return;
  await db
    .update(externalAccounts)
    .set({
      authFailedAt: sql`coalesce(${externalAccounts.authFailedAt}, ${at.getTime()})`,
      authFailureMessage: errorMessage(err),
    })
    .where(eq(externalAccounts.id, accountId));
}

/** The account reads (or writes) fine again: drop its reconnect prompt. */
export async function clearAccountAuthFailure(
  db: Db,
  accountId: string | null | undefined,
): Promise<void> {
  if (!accountId) return;
  await db
    .update(externalAccounts)
    .set({ authFailedAt: null, authFailureMessage: null, reauthNotifiedAt: null })
    .where(and(eq(externalAccounts.id, accountId), isNotNull(externalAccounts.authFailedAt)));
}
