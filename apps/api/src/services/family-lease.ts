import { and, type Db, eq, families, isNull, lt, or } from '@igt/db';

/**
 * A per-family lease on the CRON tick (`runFamilyTick`), so one family's
 * scheduled pipeline pass is never run twice at once.
 *
 * The cron fires every 15 minutes; a family with a slow CalDAV/Google target
 * (or a backlog after an outage) can still be mid-tick when the next one
 * starts, and a queue message can be redelivered after its consumer died. Two
 * ticks over the same family is pure duplicated work and a race on remote
 * writes — the lease is the cheap way to skip the second one.
 *
 * It is deliberately NOT taken by request paths. A route handler that
 * resynthesizes a feed and regenerates tasks inline runs unlocked, and that is
 * safe: every pipeline write is idempotent (calendar_events upsert on
 * (member, synthKey), conflicts `onConflictDoNothing`, generated tasks
 * `onConflictDoNothing` on `tasks_generated_event_type_uq`), so overlapping runs
 * converge instead of duplicating or throwing. A lease on the request path would
 * only make a user's edit wait on, or be refused by, a background tick.
 *
 * The lease is a timestamp, not a held lock: if a tick dies without releasing
 * it, it simply expires. The TTL is set just under the cron period so a crashed
 * tick never costs the family more than the next one.
 */

/** Just under the 15-minute cron period. */
export const CRON_TICK_LEASE_MS = 14 * 60 * 1000;

/**
 * Try to take the family's lease for `ttlMs`. One conditional UPDATE, so exactly
 * one of several concurrent callers wins. Returns the expiry it wrote — the
 * holder's token, to hand back to `releaseFamilyLease` — or null when somebody
 * else holds an unexpired lease.
 */
export async function acquireFamilyLease(
  db: Db,
  familyId: string,
  ttlMs: number,
  now: Date = new Date(),
): Promise<Date | null> {
  const until = new Date(now.getTime() + ttlMs);
  const rows = await db
    .update(families)
    .set({ pipelineLeaseUntil: until })
    .where(
      and(
        eq(families.id, familyId),
        or(isNull(families.pipelineLeaseUntil), lt(families.pipelineLeaseUntil, now)),
      ),
    )
    .returning({ id: families.id });
  return rows.length > 0 ? until : null;
}

/**
 * Hand the lease back, but only if it is still the one `until` names. A tick
 * that outlived its TTL finds the lease has since been taken by a newer tick
 * (a later expiry) and must not clear that one. Safe to call on a lease that
 * has expired or been released already.
 */
export async function releaseFamilyLease(
  db: Db,
  familyId: string,
  until: Date,
): Promise<void> {
  await db
    .update(families)
    .set({ pipelineLeaseUntil: null })
    .where(and(eq(families.id, familyId), eq(families.pipelineLeaseUntil, until)));
}
