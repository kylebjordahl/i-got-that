import {
  and,
  type Db,
  eq,
  getDb,
  isNull,
  ne,
  notificationSchedules,
  or,
  pushDevices,
} from '@igt/db';
import { weekdayBit } from '@igt/classification';
import type { NotificationCategory } from '@igt/domain';
import type { Bindings } from '../env.js';
import { getPusher, type PushMessage, type Pusher } from '../lib/apns.js';
import {
  buildUserDigest,
  digestNotificationText,
  digestWindow,
  localDateKey,
  localWallInstant,
  type UserDigest,
} from './digest.js';

/**
 * Dispatch of the daily "what's still outstanding" digests.
 *
 * The cron ticks every 15 minutes and this pass runs once per tick, across all
 * users — deliberately a sibling of `scheduled.ts`'s per-family loop rather
 * than part of it, because a schedule belongs to a *user* and its digest spans
 * every family they're in.
 */

type ScheduleRow = typeof notificationSchedules.$inferSelect;

/** A queued send. Carries the slot so a retry still describes the right day. */
export type PushDigestJob = {
  kind: 'push-digest';
  scheduleId: string;
  slot: string;
};

/**
 * How late a tick may still deliver a slot. The cron fires every 15 minutes and
 * can be delayed, so exact equality would silently drop digests; half an hour
 * is late enough to survive a missed tick and early enough that a "7:00 brief"
 * never arrives at lunchtime.
 */
const SLOT_GRACE_MS = 30 * 60 * 1000;

/**
 * The slot this schedule is currently due for, or null.
 *
 * A slot key is the schedule's local `YYYY-MM-DDTHH:MM`. Being local is what
 * makes DST behave: the spring-forward gap simply never produces a slot for the
 * hour that didn't happen, and the fall-back repeat produces the same key
 * twice, which the claim below rejects the second time.
 *
 * Yesterday's slot is considered too — a 23:50 send time is still within the
 * grace window at 00:05 the next day.
 */
export function dueSlot(schedule: ScheduleRow, now: Date): string | null {
  const tz = schedule.timezone;
  for (const dayOffset of [0, -1]) {
    const dateKey = localDateKey(
      new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000),
      tz,
    );
    const [y, m, d] = dateKey.split('-').map(Number);
    if ((schedule.weekdayMask & (1 << weekdayBit(new Date(Date.UTC(y!, m! - 1, d!))))) === 0) {
      continue;
    }
    const at = localWallInstant(dateKey, schedule.sendAt, tz);
    const elapsed = now.getTime() - at.getTime();
    if (elapsed >= 0 && elapsed < SLOT_GRACE_MS) return `${dateKey}T${schedule.sendAt}`;
  }
  return null;
}

/**
 * Claim a slot for this schedule, returning whether *this* caller got it.
 *
 * A conditional UPDATE rather than read-then-write: two overlapping cron
 * invocations both see the same due slot, and only the one whose UPDATE matches
 * a row that hasn't already been stamped goes on to enqueue.
 */
export async function claimSlot(
  db: Db,
  scheduleId: string,
  slot: string,
  now: Date,
): Promise<boolean> {
  const claimed = await db
    .update(notificationSchedules)
    .set({ lastSentSlot: slot, lastSentAt: now })
    .where(
      and(
        eq(notificationSchedules.id, scheduleId),
        or(
          isNull(notificationSchedules.lastSentSlot),
          ne(notificationSchedules.lastSentSlot, slot),
        ),
      ),
    )
    .returning({ id: notificationSchedules.id });
  return claimed.length > 0;
}

type EnqueueCtx = {
  env: Bindings;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
};

/**
 * Queue a send, or run it inline when no queue is bound (local dev + tests) —
 * the same fallback shape `enqueueReconcile` uses for mirror work.
 */
function enqueueDigest(c: EnqueueCtx, job: PushDigestJob): void {
  const queue = c.env.DELIVERY_QUEUE;
  if (queue) {
    c.executionCtx.waitUntil(
      queue
        .send(job)
        .catch((err) => console.error('failed to enqueue digest job', err)),
    );
    return;
  }
  c.executionCtx.waitUntil(
    deliverDigest(c.env, job).catch((err) =>
      console.error('inline digest delivery failed', err),
    ),
  );
}

/**
 * Find every schedule due right now, claim its slot, and queue the send.
 * Returns how many were dispatched (for the cron log).
 */
export async function dispatchDueDigests(
  c: EnqueueCtx,
  now = new Date(),
): Promise<number> {
  const db = getDb(c.env.DB);
  const rows = await db
    .select()
    .from(notificationSchedules)
    .where(eq(notificationSchedules.enabled, true));

  let dispatched = 0;
  for (const schedule of rows) {
    const slot = dueSlot(schedule, now);
    if (!slot || schedule.lastSentSlot === slot) continue;
    if (!(await claimSlot(db, schedule.id, slot, now))) continue;
    enqueueDigest(c, { kind: 'push-digest', scheduleId: schedule.id, slot });
    dispatched++;
  }
  return dispatched;
}

/** The instant a slot key names, for reconstructing its window on delivery. */
function slotInstant(schedule: ScheduleRow, slot: string): Date {
  const [dateKey, hhmm] = slot.split('T');
  return localWallInstant(dateKey!, hhmm ?? schedule.sendAt, schedule.timezone);
}

export interface DigestSendOutcome {
  digest: UserDigest;
  /** Devices the push actually reached. */
  delivered: number;
  /** True when a transient failure means the queue should try again. */
  retry: boolean;
  /** Set when nothing was sent, and why — for the test endpoint's response. */
  skipped?: 'empty' | 'no_devices';
}

/**
 * Build a schedule's digest and push it to every live device the user has.
 *
 * `at` is the moment the digest describes — the *slot*, not the wall clock when
 * the queue got round to it, so a retry an hour later still reports the same
 * day rather than silently shifting the window.
 */
export async function sendDigest(
  db: Db,
  pusher: Pusher,
  schedule: ScheduleRow,
  at: Date,
  opts: { force?: boolean; collapseId?: string } = {},
): Promise<DigestSendOutcome> {
  const window = digestWindow(
    at,
    schedule.timezone,
    schedule.startOffsetDays,
    schedule.horizonDays,
  );
  const digest = await buildUserDigest(
    db,
    schedule.userId,
    window,
    schedule.categories as NotificationCategory[],
  );

  if (digest.total === 0 && schedule.skipWhenEmpty && !opts.force) {
    return { digest, delivered: 0, retry: false, skipped: 'empty' };
  }

  const devices = await db
    .select()
    .from(pushDevices)
    .where(
      and(eq(pushDevices.userId, schedule.userId), isNull(pushDevices.disabledAt)),
    );
  if (devices.length === 0) {
    return { digest, delivered: 0, retry: false, skipped: 'no_devices' };
  }

  const { title, body } = digestNotificationText(digest, at, schedule.timezone);
  let delivered = 0;
  let retry = false;

  for (const device of devices) {
    const message: PushMessage = {
      deviceToken: device.deviceToken,
      bundleId: device.bundleId,
      environment: device.environment,
      title,
      body,
      badge: digest.total,
      threadId: schedule.id,
      collapseId: opts.collapseId,
      data: {
        type: 'digest',
        scheduleId: schedule.id,
        familyIds: digest.familyIds,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
      },
    };
    const result = await pusher.send(message);
    if (result.ok) {
      delivered++;
      continue;
    }
    if (result.kind === 'device_gone') {
      // The install is gone or the token was minted for the other APNs
      // environment. Stop sending to it; a re-register revives the row.
      await db
        .update(pushDevices)
        .set({ disabledAt: new Date() })
        .where(eq(pushDevices.id, device.id));
      console.warn(`push device ${device.id} disabled: ${result.reason}`);
      continue;
    }
    if (result.kind === 'retryable') retry = true;
    console.error(`push to device ${device.id} failed: ${result.reason}`);
  }

  return { digest, delivered, retry };
}

/**
 * Queue-side handler for a `push-digest` job. Returns whether the message
 * should be retried; anything permanent is acked so it doesn't sit in the
 * queue burning retries.
 */
export async function deliverDigest(
  env: Bindings,
  job: PushDigestJob,
): Promise<{ retry: boolean }> {
  const db = getDb(env.DB);
  const schedule = (
    await db
      .select()
      .from(notificationSchedules)
      .where(eq(notificationSchedules.id, job.scheduleId))
      .limit(1)
  )[0];
  // Deleted or switched off between claim and delivery — nothing to send.
  if (!schedule || !schedule.enabled) return { retry: false };

  const outcome = await sendDigest(
    db,
    getPusher(env),
    schedule,
    slotInstant(schedule, job.slot),
    { collapseId: `digest:${schedule.id}:${job.slot}` },
  );
  return { retry: outcome.retry };
}
