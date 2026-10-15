import { and, eq, externalAccounts, getDb, isNotNull, isNull, lte, users } from '@igt/db';
import { tzOffsetMs } from '@igt/classification';
import type { Bindings } from '../env.js';
import { getPusher, type Pusher } from '../lib/apns.js';
import { liveDevices, pushToDevices } from './notifications.js';

/**
 * The "reconnect your calendar account" push.
 *
 * Ingest stamps `external_accounts.authFailedAt` when a sync fails in a way
 * only the account's owner can fix (see `needsReauth` in ingest.ts). This pass
 * — run once per cron tick, across users, like the digests — tells them, once
 * per failure episode: `reauthNotifiedAt` is set on send and cleared, with
 * `authFailedAt`, by the next good sync or a reconnect.
 */

/**
 * How long an account has to stay broken before anyone is pushed. One failed
 * tick can be Google having a moment; the Home screen card shows immediately.
 */
export const REAUTH_ALERT_DELAY_MS = 30 * 60_000;

/** Device-local hours, [start, end), during which the alert waits for morning. */
export const QUIET_HOURS = { start: 21, end: 8 } as const;

/**
 * Is it overnight where this device is? A device that never reported its zone
 * can't be judged, so it isn't held back — it's the only way it hears at all.
 */
export function inQuietHours(timezone: string | null, now: Date): boolean {
  if (!timezone) return false;
  let hour: number;
  try {
    hour = new Date(now.getTime() + tzOffsetMs(timezone, now.getTime())).getUTCHours();
  } catch {
    return false;
  }
  return hour >= QUIET_HOURS.start || hour < QUIET_HOURS.end;
}

/** Send every reauth alert that's due. Returns how many accounts were alerted. */
export async function dispatchReauthAlerts(
  env: Pick<Bindings, 'DB' | 'APNS_KEY_P8' | 'APNS_KEY_ID' | 'APNS_TEAM_ID'>,
  now: Date,
  pusher: Pusher = getPusher(env),
): Promise<number> {
  const db = getDb(env.DB);
  const due = await db
    .select({
      id: externalAccounts.id,
      userId: externalAccounts.userId,
      kind: externalAccounts.kind,
      name: externalAccounts.name,
      username: externalAccounts.username,
    })
    .from(externalAccounts)
    .innerJoin(users, eq(users.id, externalAccounts.userId))
    .where(
      and(
        isNotNull(externalAccounts.authFailedAt),
        isNull(externalAccounts.reauthNotifiedAt),
        lte(externalAccounts.authFailedAt, new Date(now.getTime() - REAUTH_ALERT_DELAY_MS)),
        eq(users.reauthAlertsEnabled, true),
      ),
    );
  if (due.length === 0) return 0;

  let alerted = 0;
  for (const account of due) {
    // Overnight devices are skipped, not dropped: the account stays due, so
    // the first tick after 8am local sends it.
    const awake = (await liveDevices(db, account.userId)).filter(
      (d) => !inQuietHours(d.timezone, now),
    );
    if (awake.length === 0) continue;

    // Claim before sending, so overlapping cron invocations can't both push.
    const claimed = await db
      .update(externalAccounts)
      .set({ reauthNotifiedAt: now })
      .where(and(eq(externalAccounts.id, account.id), isNull(externalAccounts.reauthNotifiedAt)))
      .returning({ id: externalAccounts.id });
    if (claimed.length === 0) continue;

    const provider = account.kind === 'google' ? 'Google' : 'calendar';
    const who = account.username ?? account.name;
    const outcome = await pushToDevices(db, pusher, awake, (device) => ({
      deviceToken: device.deviceToken,
      bundleId: device.bundleId,
      environment: device.environment,
      title: `Reconnect your ${provider} account`,
      body: `Calendars from ${who} stopped syncing. Open I Got That to reconnect.`,
      threadId: 'reauth',
      collapseId: `reauth-${account.id}`,
      data: { type: 'reauth', accountId: account.id },
    }));
    if (outcome.delivered > 0) {
      alerted++;
    } else {
      // Nothing landed: give the claim back so a later tick tries again.
      await db
        .update(externalAccounts)
        .set({ reauthNotifiedAt: null })
        .where(eq(externalAccounts.id, account.id));
    }
  }
  return alerted;
}
