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
  linkBaselineChanges,
  lte,
  linkRules,
  lt,
  or,
  gt,
  pendingDecisions,
  sourceEvents,
  sql,
  tasks,
} from '@igt/db';
import {
  DAY_MS,
  startOfUtcDay,
  synthesizeBusy,
  synthesizeException,
  synthesizeRouted,
  synthesizeStandard,
  utcDayString,
  type EventIntent,
  type OverrideRuleLike,
  type RoutedSynthesisResult,
  type SourceOccurrence,
  type SynthesisResult as EngineResult,
} from '@igt/classification';
import {
  geoKey,
  type GeoLocation,
  type PendingDecisionKind,
} from '@igt/domain';

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

/**
 * "Overlaps the window" as a SQL condition on a row's `[dtstart, dtend)` span:
 * `dtstart < end AND (dtstart >= start OR dtend > start)`. A span that began
 * before the window but is still running at `window.start` counts, because
 * every reader (`occurrenceInWindow` in @igt/ical, and so ingest, read-back
 * and the synthesis engine) reports those spans too. Any query that has to
 * agree with what a reader/engine returns must use THIS predicate, not
 * `dtstart >= window.start` — a mismatch makes the row fall out of the
 * "existing" set while the reader still reports it, so the next pass INSERTs
 * a duplicate and trips the `(familyMemberId, synthKey)` unique index. One
 * shared helper so the copies can't drift. A null `dtend` (a point) only
 * overlaps by its start.
 */
export function overlapsWindow(
  dtstart: typeof calendarEvents.dtstart | typeof sourceEvents.dtstart,
  dtend: typeof calendarEvents.dtend | typeof sourceEvents.dtend,
  window: { start: Date; end: Date },
) {
  return and(
    lt(dtstart, window.end),
    or(gte(dtstart, window.start), gt(dtend, window.start)),
  );
}

/** How far behind the synthesis window the "still active" horizon reaches. */
export const ACTIVE_LOOKBACK_MS = 30 * DAY_MS;

/**
 * The range of a family's calendar the recurring passes (mirror, travel origin,
 * claim true-up, task rebuilds) still work over: the synthesis window plus the
 * 30 days behind it, so the recent past is still healed and cleaned up. Nothing
 * prunes finished rows, so those passes must be bounded by this rather than by
 * "everything the family ever had", or their cost grows with every day of
 * history on every cron tick and queue job. Passes that must also follow what
 * lies ahead (the mirror, claims) cut off only the past, at `start`.
 */
export function activeHorizon(opts: SynthesisWindowOptions = {}): { start: Date; end: Date } {
  const window = synthesisWindow(opts);
  return { start: new Date(window.start.getTime() - ACTIVE_LOOKBACK_MS), end: window.end };
}

/**
 * A calendar event or task that has not finished before `from`: it ends at or
 * after it, however far ahead. A null `dtend` is an instant at `dtstart`.
 */
export function endsAtOrAfter(
  dtstart: typeof calendarEvents.dtstart | typeof tasks.dtstart,
  dtend: typeof calendarEvents.dtend | typeof tasks.dtend,
  from: Date,
) {
  return sql`coalesce(${dtend}, ${dtstart}) >= ${from.getTime()}`;
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
  const parts = [
    e.dtstart.toISOString(),
    e.dtend ? e.dtend.toISOString() : '',
    e.allDay ? '1' : '0',
    e.summary ?? '',
    e.location ?? '',
    // Include the geocode so a location that gains/loses/changes coordinates
    // (but keeps the same text) still resynthesizes and re-mirrors.
    geoKey(e.locationGeo),
    e.description ?? '',
  ].join('|');
  let h = 5381;
  for (let i = 0; i < parts.length; i++) h = ((h << 5) + h) ^ parts.charCodeAt(i);
  return (h >>> 0).toString(16);
}

/**
 * Is this feed a routed shared family calendar? Routing is a property of the
 * feed (flip it once, from any member's copy, and every linked member routes),
 * and only meaningful where events mean what they say — an exception feed's are
 * already schedule overrides, a busy feed's are opaque intervals. The `mode`
 * guard is belt-and-braces for a row whose mode moved without the flag being
 * cleared.
 */
export function isRouted(feed: Pick<FeedRow, 'mode' | 'routed'>): boolean {
  return feed.mode === 'standard' && feed.routed;
}

function toOccurrence(e: EventRow): SourceOccurrence {
  return {
    id: e.id,
    contentHash: e.contentHash,
    summary: e.summary,
    location: e.location,
    locationGeo: e.locationGeo,
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
 *
 * The provenance links (`sourceEventId`, `matchedRuleId`) are not part of the
 * hash, but they are compared too: a row whose payload is unchanged still gets
 * them rewritten when they differ. That is what heals a `bl:` baseline day
 * written before it stopped carrying its exception event's id — that id is an
 * ON DELETE CASCADE FK, so every baseline day still holding one would be
 * deleted (and its tasks orphaned) when the exception left the feed. Rewriting
 * them doesn't touch `contentHash`, so task-gen and the mirror see no change.
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
  if (
    prior &&
    prior.contentHash === contentHash &&
    prior.sourceEventId === intent.sourceEventId &&
    prior.matchedRuleId === intent.matchedRuleId
  ) {
    return false;
  }

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
    // An upsert, not a bare insert: a concurrent synthesis (cron tick vs. a
    // route handler's inline resynthesize) may have created this
    // (member, synthKey) since our snapshot read, and the loser of that race
    // must converge on the same row rather than throw on the unique index.
    await db
      .insert(calendarEvents)
      .values({
        familyId: feed.familyId,
        familyMemberId: link.familyMemberId,
        provenance: 'synthesized',
        synthKey: intent.synthKey,
        linkId: link.id,
        ...payload,
      })
      .onConflictDoUpdate({
        target: [calendarEvents.familyMemberId, calendarEvents.synthKey],
        set: payload,
      });
  }
  return true;
}

/**
 * Reconcile one link's pending decisions of a given kind with what the engine
 * reported. Resolved/dismissed rows persist (so we don't re-raise them) unless
 * the source event's content changed — then the decision reopens and any event
 * created by the stale resolution is removed. Pending rows whose occurrence is
 * now handled by a rule are cleaned up.
 */
async function reconcilePending(
  db: Db,
  feed: FeedRow,
  link: LinkRow,
  engineResult: EngineResult,
  kind: PendingDecisionKind = 'exception',
): Promise<number> {
  const all = await db
    .select()
    .from(pendingDecisions)
    .where(eq(pendingDecisions.linkId, link.id));
  const reportedSourceIds = new Set(engineResult.pending.map((p) => p.sourceEventId));

  // A feed that changed shape (exception ⇄ routed) leaves rows asking a
  // question that no longer exists. Drop this link's rows of the other kind
  // when they'd either sit in the queue forever (still pending) or collide with
  // a row we're about to raise for the same occurrence — the (link, source)
  // unique index means the old row would block the new one outright.
  for (const prior of all) {
    if (prior.kind === kind) continue;
    if (prior.status === 'pending' || reportedSourceIds.has(prior.sourceEventId)) {
      await db.delete(pendingDecisions).where(eq(pendingDecisions.id, prior.id));
    }
  }

  const existing = all.filter((p) => p.kind === kind);
  const existingBySource = new Map(existing.map((p) => [p.sourceEventId, p]));

  let open = 0;
  for (const intent of engineResult.pending) {
    const prior = existingBySource.get(intent.sourceEventId);
    if (!prior) {
      // No-op if a concurrent synthesis raised the same (link, sourceEvent)
      // decision since our read: either way exactly one pending row exists.
      await db
        .insert(pendingDecisions)
        .values({
          familyId: feed.familyId,
          feedId: feed.id,
          kind,
          linkId: link.id,
          familyMemberId: link.familyMemberId,
          sourceEventId: intent.sourceEventId,
          status: 'pending',
          sourceContentHash: intent.contentHash,
        })
        .onConflictDoNothing();
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
  // (a rule matched after a config change — for routing, someone's rules now
  // claim the event) or its source vanished (cascade).
  for (const prior of existing) {
    if (prior.status === 'pending' && !reportedSourceIds.has(prior.sourceEventId)) {
      await db.delete(pendingDecisions).where(eq(pendingDecisions.id, prior.id));
    }
  }
  return open;
}

/**
 * Fold baseline changes that have taken effect into their links' own hours.
 * Synthesis never looks behind the window, so once a change's date is on or
 * before `today` only the latest such change matters: its hours become the
 * link's `dayStart`/`dayEnd` and it (plus anything older) is deleted. The
 * table then only holds upcoming changes, and the link's hours always mean
 * "the hours now". Past days' events already on calendars are the history.
 * Mutates `links` in place so the rest of this run sees the folded hours.
 */
async function foldEffectiveBaselineChanges(
  db: Db,
  links: LinkRow[],
  today: string,
): Promise<void> {
  const due = await db
    .select()
    .from(linkBaselineChanges)
    .where(
      and(
        inArray(
          linkBaselineChanges.linkId,
          links.map((l) => l.id),
        ),
        lte(linkBaselineChanges.effectiveFrom, today),
      ),
    );
  for (const link of links) {
    const latest = due
      .filter((c) => c.linkId === link.id)
      .reduce<(typeof due)[number] | null>(
        (best, c) => (!best || c.effectiveFrom > best.effectiveFrom ? c : best),
        null,
      );
    if (!latest) continue;
    await db
      .update(familyMemberFeeds)
      .set({ dayStart: latest.dayStart, dayEnd: latest.dayEnd })
      .where(eq(familyMemberFeeds.id, link.id));
    await db
      .delete(linkBaselineChanges)
      .where(
        and(
          eq(linkBaselineChanges.linkId, link.id),
          lte(linkBaselineChanges.effectiveFrom, today),
        ),
      );
    link.dayStart = latest.dayStart;
    link.dayEnd = latest.dayEnd;
  }
}

/**
 * Module A — synthesis (SCHEDULE only). Runs each active link of a feed through
 * the pure engine and reconciles the member's unified calendar to the desired
 * set: upserts by (member, synthKey) with contentHash skip, deletes this link's
 * in-window synthesized events whose key vanished (rule/config changes
 * resynthesize without duplicating), and keeps pending decisions in step.
 * Task typing is decided later, by the task-rule pipeline. Events from resolved
 * decisions (`pd:` keys) are owned by the resolution flow, not by this reconcile.
 *
 * A routed feed (shared family calendar) is the one mode whose engine pass runs
 * across all the links at once — routing an occurrence is a question about the
 * whole feed ("whose is this?"), not about one member's baseline — so it's
 * computed up front and then handed to each link in turn.
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
  await foldEffectiveBaselineChanges(db, links, utcDayString(window.start.getTime()));

  // Occurrences overlapping the window (a span that started before the window
  // still counts for the days it reaches into it). Dismissed events are ignored.
  const occurrenceRows = await db
    .select()
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.feedId, feed.id),
        isNull(sourceEvents.dismissedAt),
        overlapsWindow(sourceEvents.dtstart, sourceEvents.dtend, window),
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
  const rulesFor = (linkId: string) =>
    allRules.filter((r) => r.linkId === linkId).map(toRuleLike);

  // Dated baseline-hour changes only shape exception feeds' baseline days.
  const allBaselineChanges =
    feed.mode === 'exception'
      ? await db
          .select()
          .from(linkBaselineChanges)
          .where(
            inArray(
              linkBaselineChanges.linkId,
              links.map((l) => l.id),
            ),
          )
      : [];

  // Routed feeds are decided feed-wide before the per-link pass: every link's
  // `keep` pipeline sees the same occurrences, and an occurrence no link keeps
  // is unrouted — one routing decision per link, answered once.
  const routing: RoutedSynthesisResult | null =
    isRouted(feed)
      ? synthesizeRouted(
          links.map((l) => ({
            id: l.id,
            rules: rulesFor(l.id),
            location: l.location,
            locationGeo: l.locationGeo,
          })),
          occurrences,
        )
      : null;

  for (const link of links) {
    const rules = rulesFor(link.id);
    const linkConfig = {
      id: link.id,
      weekdayMask: link.weekdayMask,
      dayStart: link.dayStart,
      dayEnd: link.dayEnd,
      location: link.location,
      locationGeo: link.locationGeo,
      baselineSummary: baselineSummaryFor(feed),
      baselineChanges: allBaselineChanges.filter((b) => b.linkId === link.id),
    };

    const engineResult: EngineResult = routing
      ? {
          events: routing.byLink.get(link.id) ?? [],
          pending: routing.unrouted,
        }
      : feed.mode === 'busy'
        ? synthesizeBusy(linkConfig, occurrences)
        : feed.mode === 'exception'
          ? synthesizeException(linkConfig, occurrences, rules, window, tz)
          : synthesizeStandard(linkConfig, occurrences);

    // Existing synthesized rows this link owns within the window (pd: rows are
    // keyed to the decision, not the link, and are never touched here). The
    // overlap check must mirror the source-occurrence query above exactly (the
    // shared `overlapsWindow` predicate): an event that started before the
    // window but is still ongoing at window.start (e.g. an evening event in a
    // negative-UTC-offset zone that straddles the UTC day boundary the window
    // is computed from) is still reported by the engine every run. Without the
    // same `dtend > window.start` clause here, its existing row would fall out
    // of `existingByKey`, so `upsertIntent` would try to INSERT a duplicate of
    // an unchanged event and crash the whole synthesis on the
    // (familyMemberId, synthKey) unique index.
    const existing = await db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.linkId, link.id),
          eq(calendarEvents.provenance, 'synthesized'),
          overlapsWindow(calendarEvents.dtstart, calendarEvents.dtend, window),
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

    // Occurrences a human already accepted onto the calendar (a `pd:` event from
    // a resolved decision, possibly with adjusted times). If a rule written
    // *afterwards* now matches one — an `add_event` rule for the same community
    // dinner someone resolved by hand last week, or a `keep` rule for the swim
    // practice someone routed here one-off — the human's event stands and the
    // engine's `ev:` copy is skipped, so the day doesn't show it twice. Only
    // `ev:` intents are skipped: a `bl:` baseline day isn't a copy of any
    // occurrence (it carries no `sourceEventId`), and the day itself must still
    // be synthesized.
    const humanAccepted = new Set(
      existing
        .filter((e) => e.synthKey.startsWith('pd:') && e.sourceEventId)
        .map((e) => e.sourceEventId!),
    );

    for (const stale of linkOwnedExisting) {
      if (!desiredKeys.has(stale.synthKey)) {
        await db.delete(calendarEvents).where(eq(calendarEvents.id, stale.id));
        result.eventsRemoved++;
      }
    }
    for (const intent of engineResult.events) {
      if (
        intent.synthKey.startsWith('ev:') &&
        intent.sourceEventId &&
        humanAccepted.has(intent.sourceEventId)
      ) {
        continue;
      }
      if (await upsertIntent(db, feed, link, intent, existingByKey)) {
        result.eventsUpserted++;
      }
    }

    result.pendingOpen += await reconcilePending(
      db,
      feed,
      link,
      engineResult,
      routing ? 'routing' : 'exception',
    );
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
