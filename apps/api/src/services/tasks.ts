import {
  and,
  classificationRules,
  type Db,
  eq,
  familyMemberFeeds,
  feeds,
  gt,
  gte,
  isNull,
  lt,
  ne,
  or,
  sourceEvents,
  tasks,
} from '@igt/db';
import {
  classifyExplicit,
  resolveExceptionDay,
  type OccurrenceLike,
  type RuleLike,
} from '@igt/classification';

type FeedRow = typeof feeds.$inferSelect;
type RuleRow = typeof classificationRules.$inferSelect;
type LinkRow = typeof familyMemberFeeds.$inferSelect;
type EventRow = typeof sourceEvents.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BuildOptions {
  windowStart?: Date;
  windowEnd?: Date;
}

export interface BuildResult {
  feedId: string;
  mode: FeedRow['mode'];
  tasksCreated: number;
  tasksRemoved: number;
}

function toRuleLike(r: RuleRow): RuleLike {
  return {
    feedId: r.feedId,
    priority: r.priority,
    matchField: r.matchField,
    matchOp: r.matchOp,
    matchValue: r.matchValue,
    effect: r.effect,
    producesTypes: (r.producesTypes as RuleLike['producesTypes']) ?? null,
    defaultAttendance: r.defaultAttendance ?? null,
    shiftToTime: r.shiftToTime ?? null,
    defaultOwnerMemberId: r.defaultOwnerMemberId ?? null,
  };
}

function toOccurrence(e: EventRow): OccurrenceLike {
  return { summary: e.summary, location: e.location, description: null };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Every UTC-day key (midnight ms) an exception event covers, so a multi-day
 * span (e.g. a week-long closure) cancels the baseline on *all* its days, not
 * just the first. All-day `dtend` is exclusive (the midnight after the last
 * covered day); a timed event covers through the day its end instant falls in.
 * A missing or non-positive-length end covers only the start day.
 */
function coveredUtcDays(e: EventRow): number[] {
  const first = startOfUtcDay(e.dtstart).getTime();
  if (!e.dtend || e.dtend.getTime() <= e.dtstart.getTime()) return [first];
  const endExclusive = e.allDay
    ? startOfUtcDay(e.dtend).getTime()
    : startOfUtcDay(new Date(e.dtend.getTime() - 1)).getTime() + DAY_MS;
  const days: number[] = [];
  for (let d = first; d < endExclusive; d += DAY_MS) days.push(d);
  return days.length > 0 ? days : [first];
}

/** Mon=bit0 … Sun=bit6. */
function weekdayBit(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

/** Offset (ms) of `tz` from UTC at the given instant; 0 for UTC/unknown zones. */
function tzOffsetMs(tz: string, utcMs: number): number {
  if (tz === 'UTC') return 0;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const m: Record<string, number> = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) {
      if (p.type !== 'literal') m[p.type] = Number(p.value);
    }
    const asUtc = Date.UTC(m.year!, m.month! - 1, m.day!, m.hour!, m.minute!, m.second!);
    return asUtc - utcMs;
  } catch {
    return 0; // unknown timezone → treat as UTC
  }
}

/** Interpret `hhmm` as a wall-clock time in `tz` on `day`'s calendar date → UTC. */
function wallTimeToUtc(
  day: Date,
  hhmm: string | null | undefined,
  fallbackHour: number,
  tz: string,
): Date {
  const [h, m] = (hhmm ?? '').split(':');
  const hour = h !== undefined && m !== undefined ? Number(h) : fallbackHour;
  const min = h !== undefined && m !== undefined ? Number(m) : 0;
  const guess = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, min);
  return new Date(guess - tzOffsetMs(tz, guess));
}

/**
 * Generate/refresh tasks for a feed. Explicit feeds turn each changed event
 * into tasks (one per linked dependent); exception feeds expand each linked
 * dependent's baseline over the window and apply cancel/shift/ignore exceptions.
 * Idempotent: unowned tasks are reconciled; owned tasks are preserved.
 */
export async function buildFeedTasks(
  db: Db,
  feed: FeedRow,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const rules = (
    await db
      .select()
      .from(classificationRules)
      .where(
        and(
          eq(classificationRules.familyId, feed.familyId),
          or(
            isNull(classificationRules.feedId),
            eq(classificationRules.feedId, feed.id),
          ),
        ),
      )
  ).map(toRuleLike);

  const links = await db
    .select()
    .from(familyMemberFeeds)
    .where(
      and(
        eq(familyMemberFeeds.feedId, feed.id),
        eq(familyMemberFeeds.active, true),
      ),
    );

  const result: BuildResult = {
    feedId: feed.id,
    mode: feed.mode,
    tasksCreated: 0,
    tasksRemoved: 0,
  };

  if (feed.mode === 'explicit') {
    await buildExplicit(db, feed, rules, links, result);
  } else {
    await buildException(db, feed, rules, links, opts, result);
  }
  return result;
}

async function buildExplicit(
  db: Db,
  feed: FeedRow,
  rules: RuleLike[],
  links: LinkRow[],
  result: BuildResult,
): Promise<void> {
  const pending = await db
    .select()
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.feedId, feed.id),
        isNull(sourceEvents.dismissedAt), // skip events manually marked unneeded
        or(
          isNull(sourceEvents.tasksBuiltHash),
          ne(sourceEvents.tasksBuiltHash, sourceEvents.contentHash),
        ),
      ),
    );

  for (const event of pending) {
    const intents = classifyExplicit(toOccurrence(event), rules) ?? [];
    const desiredTypes = new Set(intents.map((i) => i.type));

    for (const link of links) {
      const existing = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.sourceEventId, event.id),
            eq(tasks.familyMemberId, link.familyMemberId),
          ),
        );
      const existingByType = new Map(existing.map((t) => [t.type, t]));

      // Remove unowned tasks no longer desired.
      for (const t of existing) {
        if (!desiredTypes.has(t.type) && t.status === 'unowned') {
          await db.delete(tasks).where(eq(tasks.id, t.id));
          result.tasksRemoved++;
        }
      }

      for (const intent of intents) {
        const match = existingByType.get(intent.type);
        if (match) {
          await db
            .update(tasks)
            .set({
              dtstart: event.dtstart,
              dtend: event.dtend,
              location: event.location,
            })
            .where(eq(tasks.id, match.id));
        } else {
          await db.insert(tasks).values({
            familyId: feed.familyId,
            feedId: feed.id,
            sourceEventId: event.id,
            familyMemberId: link.familyMemberId,
            type: intent.type,
            attendanceRequirement: intent.attendanceRequirement,
            dtstart: event.dtstart,
            dtend: event.dtend,
            location: event.location,
            ownerMemberId: intent.defaultOwnerMemberId,
            status: intent.defaultOwnerMemberId ? 'owned' : 'unowned',
            createdVia: 'rule',
          });
          result.tasksCreated++;
        }
      }
    }

    await db
      .update(sourceEvents)
      .set({ tasksBuiltHash: event.contentHash })
      .where(eq(sourceEvents.id, event.id));
  }
}

async function buildException(
  db: Db,
  feed: FeedRow,
  rules: RuleLike[],
  links: LinkRow[],
  opts: BuildOptions,
  result: BuildResult,
): Promise<void> {
  const windowStart = startOfUtcDay(opts.windowStart ?? new Date());
  const windowEnd = opts.windowEnd ?? new Date(windowStart.getTime() + 30 * DAY_MS);
  const tz = feed.timezone ?? 'UTC';

  // Feed events overlapping the window, grouped by every UTC day they cover —
  // these are the exceptions. A multi-day span (e.g. a week-long break) lands in
  // each of its days' buckets, and a span that started before the window still
  // counts for the days it reaches into it (dtend > windowStart). Dismissed
  // events are ignored so an erroneous closure no longer cancels the baseline.
  const events = await db
    .select()
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.feedId, feed.id),
        isNull(sourceEvents.dismissedAt),
        lt(sourceEvents.dtstart, windowEnd),
        or(
          gte(sourceEvents.dtstart, windowStart),
          gt(sourceEvents.dtend, windowStart),
        ),
      ),
    );
  const eventsByDay = new Map<number, EventRow[]>();
  for (const e of events) {
    for (const key of coveredUtcDays(e)) {
      (eventsByDay.get(key) ?? eventsByDay.set(key, []).get(key)!).push(e);
    }
  }

  for (const link of links) {
    const baselineTypes = (link.generatesTypes as string[] | null) ?? [];
    if (link.weekdayMask == null || baselineTypes.length === 0) continue;

    for (let day = windowStart; day < windowEnd; day = new Date(day.getTime() + DAY_MS)) {
      if ((link.weekdayMask & (1 << weekdayBit(day))) === 0) continue;

      const dayEvents = eventsByDay.get(day.getTime()) ?? [];
      const resolved = resolveExceptionDay(
        { types: baselineTypes as never, pickupTime: link.dayEnd ?? undefined },
        dayEvents.map(toOccurrence),
        rules,
      );

      const dayEnd = new Date(day.getTime() + DAY_MS);
      const existing = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.familyMemberId, link.familyMemberId),
            eq(tasks.createdVia, 'baseline'),
            gte(tasks.dtstart, day),
            lt(tasks.dtstart, dayEnd),
          ),
        );
      const existingByType = new Map(existing.map((t) => [t.type, t]));

      if (resolved.cancelled) {
        for (const t of existing) {
          if (t.status === 'unowned') {
            await db.delete(tasks).where(eq(tasks.id, t.id));
            result.tasksRemoved++;
          }
        }
        continue;
      }

      for (const type of resolved.types) {
        const start =
          type === 'pickup'
            ? wallTimeToUtc(day, resolved.pickupTime ?? link.dayEnd, 15, tz)
            : wallTimeToUtc(day, link.dayStart, 8, tz);
        // Block length + location are configured on the exclusion pattern (the
        // link); a null duration leaves dtend null (delivery falls back to 1h).
        const end =
          link.durationMinutes != null
            ? new Date(start.getTime() + link.durationMinutes * 60_000)
            : null;
        const location = link.location ?? null;

        // Heal an existing baseline task whose start/block/location drifted
        // (e.g. tz/config change); otherwise leave it (preserves ownership).
        const priorTask = existingByType.get(type);
        if (priorTask) {
          if (
            priorTask.dtstart.getTime() !== start.getTime() ||
            (priorTask.dtend?.getTime() ?? null) !== (end?.getTime() ?? null) ||
            (priorTask.location ?? null) !== location
          ) {
            await db
              .update(tasks)
              .set({ dtstart: start, dtend: end, location })
              .where(eq(tasks.id, priorTask.id));
          }
          continue;
        }

        await db.insert(tasks).values({
          familyId: feed.familyId,
          feedId: feed.id,
          sourceEventId: null,
          familyMemberId: link.familyMemberId,
          type: type as never,
          attendanceRequirement: link.defaultAttendance ?? null,
          dtstart: start,
          dtend: end,
          location,
          status: 'unowned',
          createdVia: 'baseline',
        });
        result.tasksCreated++;
      }
    }
  }

  // Mark exception events processed so they don't appear perpetually pending.
  for (const e of events) {
    if (e.tasksBuiltHash !== e.contentHash) {
      await db
        .update(sourceEvents)
        .set({ tasksBuiltHash: e.contentHash })
        .where(eq(sourceEvents.id, e.id));
    }
  }
}
