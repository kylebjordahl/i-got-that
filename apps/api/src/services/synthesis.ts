import {
  and,
  calendarEvents,
  type Db,
  eq,
  feeds,
  familyMemberFeeds,
  gte,
  inArray,
  isNull,
  linkRules,
  lt,
  or,
  gt,
  pendingDecisions,
  sourceEvents,
} from '@igt/db';
import {
  DAY_MS,
  startOfUtcDay,
  synthesizeBusy,
  synthesizeException,
  synthesizeStandard,
  type EventIntent,
  type OverrideRuleLike,
  type SourceOccurrence,
  type SynthesisResult as EngineResult,
} from '@igt/classification';
import type { GeoLocation } from '@igt/domain';

type FeedRow = typeof feeds.$inferSelect;
type LinkRow = typeof familyMemberFeeds.$inferSelect;
type EventRow = typeof sourceEvents.$inferSelect;
type CalendarEventRow = typeof calendarEvents.$inferSelect;

export interface SynthesisWindowOptions {
  windowStart?: Date;
  windowEnd?: Date;
}

/** The shared 30-day forward window synthesis (and read-back) operate over. */
export function synthesisWindow(opts: SynthesisWindowOptions = {}): {
  start: Date;
  end: Date;
} {
  const start = startOfUtcDay(opts.windowStart ?? new Date());
  const end = opts.windowEnd ?? new Date(start.getTime() + 30 * DAY_MS);
  return { start, end };
}

export interface SynthesizeResult {
  feedId: string;
  eventsUpserted: number;
  eventsRemoved: number;
  pendingOpen: number;
}

/** djb2 over the payload (schedule) fields of a unified-calendar event. */
export function hashCalendarEvent(e: {
  dtstart: Date;
  dtend: Date | null;
  allDay: boolean;
  summary: string | null;
  location: string | null;
  locationGeo?: GeoLocation | null;
  description: string | null;
}): string {
  const g = e.locationGeo;
  const parts = [
    e.dtstart.toISOString(),
    e.dtend ? e.dtend.toISOString() : '',
    e.allDay ? '1' : '0',
    e.summary ?? '',
    e.location ?? '',
    // Include the geocode so a location that gains/loses/changes coordinates
    // (but keeps the same text) still resynthesizes and re-mirrors.
    g ? `${g.lat},${g.lon},${g.title ?? ''},${g.address ?? ''},${g.radius ?? ''}` : '',
    e.description ?? '',
  ].join('|');
  let h = 5381;
  for (let i = 0; i < parts.length; i++) h = ((h << 5) + h) ^ parts.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function toOccurrence(e: EventRow): SourceOccurrence {
  return {
    id: e.id,
    contentHash: e.contentHash,
    summary: e.summary,
    location: e.location,
    description: null,
    allDay: e.allDay,
    dtstart: e.dtstart,
    dtend: e.dtend,
  };
}

function toRuleLike(r: typeof linkRules.$inferSelect): OverrideRuleLike {
  return {
    id: r.id,
    position: r.position,
    matchField: r.matchField,
    matchOp: r.matchOp,
    matchValue: r.matchValue,
    outcome: r.outcome,
    params: r.params ?? null,
  };
}

/**
 * Upsert one desired event by (member, synthKey), skipping no-op rewrites via
 * contentHash. A changed payload leaves `tasksBuiltHash` stale so task-gen
 * reprocesses the event.
 */
async function upsertIntent(
  db: Db,
  feed: FeedRow,
  link: LinkRow,
  intent: EventIntent,
  existingByKey: Map<string, CalendarEventRow>,
): Promise<boolean> {
  const contentHash = hashCalendarEvent(intent);
  const prior = existingByKey.get(intent.synthKey);
  if (prior && prior.contentHash === contentHash) return false;

  const payload = {
    dtstart: intent.dtstart,
    dtend: intent.dtend,
    allDay: intent.allDay,
    summary: intent.summary,
    location: intent.location,
    locationGeo: intent.locationGeo,
    description: intent.description,
    sourceEventId: intent.sourceEventId,
    matchedRuleId: intent.matchedRuleId,
    contentHash,
  };
  if (prior) {
    await db.update(calendarEvents).set(payload).where(eq(calendarEvents.id, prior.id));
  } else {
    await db.insert(calendarEvents).values({
      familyId: feed.familyId,
      familyMemberId: link.familyMemberId,
      provenance: 'synthesized',
      synthKey: intent.synthKey,
      linkId: link.id,
      ...payload,
    });
  }
  return true;
}

/**
 * Reconcile one link's pending decisions with what the engine reported.
 * Resolved/dismissed rows persist (so we don't re-raise them) unless the source
 * event's content changed — then the decision reopens and any event created by
 * the stale resolution is removed. Pending rows whose occurrence is now handled
 * by a rule are cleaned up.
 */
async function reconcilePending(
  db: Db,
  feed: FeedRow,
  link: LinkRow,
  engineResult: EngineResult,
): Promise<number> {
  const existing = await db
    .select()
    .from(pendingDecisions)
    .where(eq(pendingDecisions.linkId, link.id));
  const existingBySource = new Map(existing.map((p) => [p.sourceEventId, p]));
  const reportedSourceIds = new Set(engineResult.pending.map((p) => p.sourceEventId));

  let open = 0;
  for (const intent of engineResult.pending) {
    const prior = existingBySource.get(intent.sourceEventId);
    if (!prior) {
      await db.insert(pendingDecisions).values({
        familyId: feed.familyId,
        feedId: feed.id,
        linkId: link.id,
        familyMemberId: link.familyMemberId,
        sourceEventId: intent.sourceEventId,
        status: 'pending',
        sourceContentHash: intent.contentHash,
      });
      open++;
      continue;
    }
    if (prior.status === 'pending') {
      open++;
      if (prior.sourceContentHash !== intent.contentHash) {
        await db
          .update(pendingDecisions)
          .set({ sourceContentHash: intent.contentHash })
          .where(eq(pendingDecisions.id, prior.id));
      }
      continue;
    }
    // Resolved/dismissed: stay closed while the content is unchanged; reopen
    // (and drop the stale resolution event) when the feed event changed.
    if (prior.sourceContentHash !== intent.contentHash) {
      await db
        .update(pendingDecisions)
        .set({
          status: 'pending',
          sourceContentHash: intent.contentHash,
          resolvedTypes: null,
          resolvedByMemberId: null,
          resolvedAt: null,
          dismissedAt: null,
        })
        .where(eq(pendingDecisions.id, prior.id));
      await db
        .delete(calendarEvents)
        .where(eq(calendarEvents.pendingDecisionId, prior.id));
      open++;
    }
  }

  // A pending row whose occurrence the engine no longer reports is now handled
  // (a rule matched after a config change) or its source vanished (cascade).
  for (const prior of existing) {
    if (prior.status === 'pending' && !reportedSourceIds.has(prior.sourceEventId)) {
      await db.delete(pendingDecisions).where(eq(pendingDecisions.id, prior.id));
    }
  }
  return open;
}

/**
 * Module A — synthesis (SCHEDULE only). Runs each active link of a feed through
 * the pure engine and reconciles the member's unified calendar to the desired
 * set: upserts by (member, synthKey) with contentHash skip, deletes this link's
 * in-window synthesized events whose key vanished (rule/config changes
 * resynthesize without duplicating), and keeps pending decisions in step.
 * Task typing is decided later, by the task-rule pipeline. Events from resolved
 * decisions (`pd:` keys) are owned by the resolution flow, not by this reconcile.
 */
export async function synthesizeFeed(
  db: Db,
  feed: FeedRow,
  opts: SynthesisWindowOptions = {},
): Promise<SynthesizeResult> {
  const window = synthesisWindow(opts);
  const tz = feed.timezone ?? 'UTC';
  const result: SynthesizeResult = {
    feedId: feed.id,
    eventsUpserted: 0,
    eventsRemoved: 0,
    pendingOpen: 0,
  };

  const links = await db
    .select()
    .from(familyMemberFeeds)
    .where(
      and(eq(familyMemberFeeds.feedId, feed.id), eq(familyMemberFeeds.active, true)),
    );
  if (links.length === 0) return result;

  // Occurrences overlapping the window (a span that started before the window
  // still counts for the days it reaches into it). Dismissed events are ignored.
  const occurrenceRows = await db
    .select()
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.feedId, feed.id),
        isNull(sourceEvents.dismissedAt),
        lt(sourceEvents.dtstart, window.end),
        or(
          gte(sourceEvents.dtstart, window.start),
          gt(sourceEvents.dtend, window.start),
        ),
      ),
    );
  const occurrences = occurrenceRows.map(toOccurrence);

  const allRules = await db
    .select()
    .from(linkRules)
    .where(
      inArray(
        linkRules.linkId,
        links.map((l) => l.id),
      ),
    );

  for (const link of links) {
    const rules = allRules.filter((r) => r.linkId === link.id).map(toRuleLike);
    const linkConfig = {
      id: link.id,
      weekdayMask: link.weekdayMask,
      dayStart: link.dayStart,
      dayEnd: link.dayEnd,
      location: link.location,
      locationGeo: link.locationGeo,
      baselineSummary: baselineSummaryFor(feed),
    };

    const engineResult =
      feed.mode === 'busy'
        ? synthesizeBusy(linkConfig, occurrences)
        : feed.mode === 'exception'
          ? synthesizeException(linkConfig, occurrences, rules, window, tz)
          : synthesizeStandard(linkConfig, occurrences);

    // Existing synthesized rows this link owns within the window (pd: rows are
    // keyed to the decision, not the link, and are never touched here).
    const existing = await db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.linkId, link.id),
          eq(calendarEvents.provenance, 'synthesized'),
          gte(calendarEvents.dtstart, window.start),
          lt(calendarEvents.dtstart, window.end),
        ),
      );
    const linkOwnedExisting = existing.filter(
      (e) =>
        e.synthKey.startsWith('bl:') ||
        e.synthKey.startsWith('ev:') ||
        e.synthKey.startsWith('fb:'),
    );
    const existingByKey = new Map(linkOwnedExisting.map((e) => [e.synthKey, e]));
    const desiredKeys = new Set(engineResult.events.map((e) => e.synthKey));

    for (const stale of linkOwnedExisting) {
      if (!desiredKeys.has(stale.synthKey)) {
        await db.delete(calendarEvents).where(eq(calendarEvents.id, stale.id));
        result.eventsRemoved++;
      }
    }
    for (const intent of engineResult.events) {
      if (await upsertIntent(db, feed, link, intent, existingByKey)) {
        result.eventsUpserted++;
      }
    }

    result.pendingOpen += await reconcilePending(db, feed, link, engineResult);
  }

  // Stamp every processed occurrence so "needs synthesis" queries stay cheap.
  for (const e of occurrenceRows) {
    if (e.synthesizedHash !== e.contentHash) {
      await db
        .update(sourceEvents)
        .set({ synthesizedHash: e.contentHash })
        .where(eq(sourceEvents.id, e.id));
    }
  }

  return result;
}

/**
 * Summary stamped on generated events: baseline days take the feed's name
 * (e.g. "Lincoln Elementary"); busy blocks take the user's chosen label —
 * the ONLY text a busy event ever carries.
 */
function baselineSummaryFor(feed: FeedRow): string {
  if (feed.mode === 'busy') return feed.sourceCalendarName ?? 'Busy';
  return feed.sourceCalendarName ?? 'School day';
}

/**
 * Synthesize every feed a member is linked to (used after link/rule edits so a
 * config change takes effect immediately, not on the next cron tick).
 */
export async function synthesizeMemberFeeds(
  db: Db,
  familyId: string,
  familyMemberId: string,
  opts: SynthesisWindowOptions = {},
): Promise<SynthesizeResult[]> {
  const rows = await db
    .select({ feed: feeds })
    .from(feeds)
    .innerJoin(familyMemberFeeds, eq(familyMemberFeeds.feedId, feeds.id))
    .where(
      and(
        eq(feeds.familyId, familyId),
        eq(familyMemberFeeds.familyMemberId, familyMemberId),
      ),
    );
  const results: SynthesizeResult[] = [];
  for (const { feed } of rows) {
    results.push(await synthesizeFeed(db, feed, opts));
  }
  return results;
}
