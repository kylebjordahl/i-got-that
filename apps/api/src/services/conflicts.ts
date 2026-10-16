import {
  and,
  calendarEvents,
  conflicts,
  type Db,
  eq,
  familyMemberFeeds,
  familyMembers,
  gt,
  gte,
  inArray,
  lt,
  or,
  tasks,
} from '@igt/db';
import { selectChunked } from '../lib/d1.js';
import {
  detectConflicts,
  subtractIntervals,
  type PriorityInterval,
} from '@igt/classification';
import {
  hashCalendarEvent,
  synthesisWindow,
  type SynthesisWindowOptions,
} from './synthesis.js';
import { ownerRowsFor, setTaskOwners } from './task-owners.js';

type CalendarEventRow = typeof calendarEvents.$inferSelect;

/** Manual (human) + claimed commitments outrank every feed. Lower wins. */
const HUMAN_PRIORITY = -1;

export interface ConflictReconcileResult {
  familyMemberId: string;
  /** How many overlaps are awaiting an admin decision. */
  conflictsOpen: number;
  /** How many losers were split/trimmed by a resolved conflict this pass. */
  masksApplied: number;
  /** Caretakers whose claim was released because its time changed (need a mirror pass). */
  releasedOwnerIds: string[];
}

/**
 * How an event participates in conflict resolution. Returns null for events that
 * are neither maskable nor a mask source (opaque busy blocks and our own split
 * segments — the latter would otherwise recurse).
 */
function participation(
  e: CalendarEventRow,
  linkPosition: Map<string, number>,
): { priority: number; maskable: boolean } | null {
  if (e.provenance === 'human' || e.provenance === 'claimed_task') {
    return { priority: HUMAN_PRIORITY, maskable: false };
  }
  // synthesized:
  const key = e.synthKey;
  // fb: opaque free/busy firewall blocks; cf: our own split segments (derived).
  if (key.startsWith('fb:') || key.startsWith('cf:')) return null;
  const priority = e.linkId != null ? (linkPosition.get(e.linkId) ?? 0) : 0;
  // Only baseline days and feed events get trimmed/split. pd: (a human-accepted
  // exception) stands as a mask source at its feed's priority.
  const maskable = key.startsWith('bl:') || key.startsWith('ev:');
  return { priority, maskable };
}

const pairId = (loserKey: string, winnerKey: string) => `${loserKey}|${winnerKey}`;

/** Prefix identifying the current `scheduleStamp` format. */
const SCHEDULE_STAMP_V1 = 's1';

/**
 * The part of an event a conflict decision actually rests on: when it starts,
 * when it ends, and whether it's all-day. Both outcomes — "split the loser
 * around the winner" and "leave both as they are" — are statements about two
 * commitments colliding in time, so a decision stays valid for exactly as long
 * as neither event moves.
 *
 * Deliberately narrower than the event's `contentHash`, which also covers
 * summary / location / geocode / description. For a `bl:` baseline day those
 * fields are the link's and the feed's *config* (the feed's display name, the
 * link's location and its geocode), not any feed event's content — so keying
 * decisions off the content hash meant re-pinning a school's location, or a
 * sync auto-detecting the feed's timezone, silently reopened every decided
 * conflict on that member's calendar with nothing about the events changed.
 * Versioned so a value stored in any older format is recognisable as stale
 * bookkeeping rather than read as drift.
 */
export function scheduleStamp(e: {
  dtstart: Date;
  dtend: Date | null;
  allDay: boolean;
}): string {
  return `${SCHEDULE_STAMP_V1}:${e.dtstart.getTime()}:${e.dtend?.getTime() ?? ''}:${e.allDay ? 1 : 0}`;
}

/** Whether a stored snapshot is a stamp this version knows how to compare. */
function isCurrentStamp(stamp: string | null): boolean {
  return stamp != null && stamp.startsWith(`${SCHEDULE_STAMP_V1}:`);
}

/** The event fields a conflict card (or a digest line) needs. */
export type ConflictSideEvent = Pick<
  CalendarEventRow,
  | 'familyMemberId'
  | 'synthKey'
  | 'summary'
  | 'location'
  | 'locationGeo'
  | 'dtstart'
  | 'dtend'
  | 'allDay'
>;

export interface HydratedConflict {
  conflict: typeof conflicts.$inferSelect;
  loser: ConflictSideEvent;
  winner: ConflictSideEvent;
}

/**
 * Resolve each conflict's `loserKey`/`winnerKey` back to the calendar events
 * they name. A conflict's identity is that pair of `synthKey`s rather than any
 * event id (so it survives resynthesis), which means *every* reader — the
 * conflicts list, the notification digest — has to do this join to learn so
 * much as when the overlap is.
 *
 * Rows whose events have vanished are dropped: they clear on the next
 * reconcile, and a half-hydrated conflict has nothing to say.
 *
 * Only the keys actually referenced are fetched. That matters for the digest,
 * which runs on every cron tick — the alternative (all of the affected members'
 * events) is unbounded in the size of their calendars.
 */
export async function hydrateConflicts(
  db: Db,
  familyIds: string[],
  rows: (typeof conflicts.$inferSelect)[],
): Promise<HydratedConflict[]> {
  if (rows.length === 0 || familyIds.length === 0) return [];
  const memberIds = [...new Set(rows.map((r) => r.familyMemberId))];
  const synthKeys = [...new Set(rows.flatMap((r) => [r.loserKey, r.winnerKey]))];
  // Two keys per conflict, so the key list outgrows D1's 100-parameter cap
  // long before the family or member lists do — chunk on it, leaving room for
  // the other two `inArray`s the same statement binds.
  const evs = await selectChunked(
    synthKeys,
    (chunk) =>
      db
        .select({
          familyMemberId: calendarEvents.familyMemberId,
          synthKey: calendarEvents.synthKey,
          summary: calendarEvents.summary,
          location: calendarEvents.location,
          locationGeo: calendarEvents.locationGeo,
          dtstart: calendarEvents.dtstart,
          dtend: calendarEvents.dtend,
          allDay: calendarEvents.allDay,
        })
        .from(calendarEvents)
        .where(
          and(
            inArray(calendarEvents.familyId, familyIds),
            inArray(calendarEvents.familyMemberId, memberIds),
            inArray(calendarEvents.synthKey, chunk),
          ),
        ),
    familyIds.length + memberIds.length,
  );
  const byKey = new Map(evs.map((e) => [`${e.familyMemberId}|${e.synthKey}`, e]));

  const out: HydratedConflict[] = [];
  for (const conflict of rows) {
    const loser = byKey.get(`${conflict.familyMemberId}|${conflict.loserKey}`);
    const winner = byKey.get(`${conflict.familyMemberId}|${conflict.winnerKey}`);
    if (loser && winner) out.push({ conflict, loser, winner });
  }
  return out;
}

/**
 * Detect and reconcile overlaps on one member's unified calendar, then apply the
 * splits for any the admin has resolved. Runs after synthesis + read-back and
 * before task-gen (so the split segments drive drop-off/pickup generation).
 *
 * Idempotent and self-healing: synthesis re-creates a masked loser every pass;
 * this pass removes it again and (re)materialises the `cf:<loserKey>:<i>` split
 * segments, so the steady state task-gen and the mirror observe is the split.
 * Conflicts are detected live, so an overlap that disappears clears its row and
 * un-masks the loser.
 */
export async function reconcileMemberConflicts(
  db: Db,
  familyMemberId: string,
  opts: SynthesisWindowOptions = {},
): Promise<ConflictReconcileResult> {
  const result: ConflictReconcileResult = {
    familyMemberId,
    conflictsOpen: 0,
    masksApplied: 0,
    releasedOwnerIds: [],
  };
  const member = (
    await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, familyMemberId))
      .limit(1)
  )[0];
  if (!member) return result;
  const window = synthesisWindow(opts);

  const links = await db
    .select({ id: familyMemberFeeds.id, position: familyMemberFeeds.position })
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.familyMemberId, familyMemberId));
  const linkPosition = new Map(links.map((l) => [l.id, l.position]));

  // The member's in-window events (the same overlap check synthesis uses: a span
  // that started before the window but is still ongoing at window.start counts).
  const events = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.familyMemberId, familyMemberId),
        lt(calendarEvents.dtstart, window.end),
        or(
          gte(calendarEvents.dtstart, window.start),
          gt(calendarEvents.dtend, window.start),
        ),
      ),
    );
  const byKey = new Map(events.map((e) => [e.synthKey, e]));

  const intervals: PriorityInterval[] = [];
  for (const e of events) {
    const p = participation(e, linkPosition);
    if (!p) continue;
    intervals.push({
      key: e.synthKey,
      dtstart: e.dtstart,
      dtend: e.dtend,
      priority: p.priority,
      maskable: p.maskable,
    });
  }
  const detected = detectConflicts(intervals);

  // --- Reconcile the conflicts table to the detected set. --------------------
  const existing = await db
    .select()
    .from(conflicts)
    .where(eq(conflicts.familyMemberId, familyMemberId));
  const existingByPair = new Map(existing.map((c) => [pairId(c.loserKey, c.winnerKey), c]));
  const detectedSet = new Set(detected.map((p) => pairId(p.loserKey, p.winnerKey)));

  for (const p of detected) {
    if (!existingByPair.has(pairId(p.loserKey, p.winnerKey))) {
      await db.insert(conflicts).values({
        familyId: member.familyId,
        familyMemberId,
        loserKey: p.loserKey,
        winnerKey: p.winnerKey,
        status: 'pending',
      });
    }
  }
  // Drop rows whose overlap no longer exists (auto-clear).
  for (const c of existing) {
    if (!detectedSet.has(pairId(c.loserKey, c.winnerKey))) {
      await db.delete(conflicts).where(eq(conflicts.id, c.id));
    }
  }

  // Reopen decided (resolved/dismissed) conflicts where one of the two events
  // has since MOVED — a decision made against an event that has been
  // rescheduled must be re-reviewed, not silently kept in force. An event that
  // was merely retitled or relocated leaves the collision (and so the decision)
  // exactly as the admin left it.
  for (const c of existing) {
    if (c.status === 'pending') continue;
    if (!detectedSet.has(pairId(c.loserKey, c.winnerKey))) continue; // deleted above
    const loser = byKey.get(c.loserKey);
    const winner = byKey.get(c.winnerKey);
    if (!loser || !winner) continue; // can't compare without both current rows
    const stamps = {
      loserScheduleStamp: scheduleStamp(loser),
      winnerScheduleStamp: scheduleStamp(winner),
    };
    if (
      !isCurrentStamp(c.loserScheduleStamp) ||
      !isCurrentStamp(c.winnerScheduleStamp)
    ) {
      // Decided before this snapshot existed, or against an older stamp format
      // — establish a baseline now rather than reopening on a value that was
      // never a comparable schedule stamp.
      await db.update(conflicts).set(stamps).where(eq(conflicts.id, c.id));
      continue;
    }
    if (
      stamps.loserScheduleStamp !== c.loserScheduleStamp ||
      stamps.winnerScheduleStamp !== c.winnerScheduleStamp
    ) {
      await db
        .update(conflicts)
        .set({
          status: 'pending',
          resolvedByMemberId: null,
          resolvedAt: null,
          dismissedAt: null,
          loserScheduleStamp: null,
          winnerScheduleStamp: null,
        })
        .where(eq(conflicts.id, c.id));
    }
  }

  // --- Materialise the splits for resolved conflicts. ------------------------
  const surviving = await db
    .select()
    .from(conflicts)
    .where(eq(conflicts.familyMemberId, familyMemberId));
  result.conflictsOpen = surviving.filter((c) => c.status === 'pending').length;

  // Resolved winners grouped by the loser they displace, each carrying its own
  // resolution parameters (travel buffers + per-side "not needed").
  interface ResolvedCut {
    winnerKey: string;
    travelBeforeMin: number;
    travelAfterMin: number;
    beforeNeeded: boolean;
    afterNeeded: boolean;
  }
  const resolvedByLoser = new Map<string, ResolvedCut[]>();
  for (const c of surviving) {
    if (c.status !== 'resolved') continue;
    const list = resolvedByLoser.get(c.loserKey) ?? [];
    list.push({
      winnerKey: c.winnerKey,
      travelBeforeMin: c.travelBeforeMin,
      travelAfterMin: c.travelAfterMin,
      beforeNeeded: c.beforeNeeded,
      afterNeeded: c.afterNeeded,
    });
    resolvedByLoser.set(c.loserKey, list);
  }

  const MIN = 60_000;
  const desiredCf = new Map<string, typeof calendarEvents.$inferInsert>();
  const maskedLoserKeys = new Set<string>();
  for (const [loserKey, cutsMeta] of resolvedByLoser) {
    const loser = byKey.get(loserKey);
    if (!loser || loser.dtend == null) continue; // loser gone this pass, or a point
    const loserEnd = loser.dtend;
    // Pair each still-present winner with its resolution params.
    const resolved = cutsMeta
      .map((meta) => ({ meta, w: byKey.get(meta.winnerKey) }))
      .filter(
        (x): x is { meta: ResolvedCut; w: CalendarEventRow } =>
          !!x.w && x.w.dtend != null,
      );
    if (resolved.length === 0) continue; // every winner vanished — leave the loser whole
    // Widen each cut by its travel buffers so the trimmed halves pull back,
    // leaving a gap the pick-up / drop-off task lands in.
    const cuts = resolved.map(({ meta, w }) => ({
      dtstart: new Date(w.dtstart.getTime() - meta.travelBeforeMin * MIN),
      dtend: new Date((w.dtend as Date).getTime() + meta.travelAfterMin * MIN),
    }));
    let segments = subtractIntervals(
      { dtstart: loser.dtstart, dtend: loserEnd },
      cuts,
    );
    // Per-side "not needed" drops the leading / trailing half of the loser (a
    // cancel_day for that side). With multiple winners, "before" is governed by
    // the earliest winner and "after" by the latest.
    const earliest = resolved.reduce((a, b) =>
      b.w.dtstart < a.w.dtstart ? b : a,
    );
    const latest = resolved.reduce((a, b) =>
      (b.w.dtend as Date) > (a.w.dtend as Date) ? b : a,
    );
    const first = segments[0];
    if (
      !earliest.meta.beforeNeeded &&
      first &&
      first.dtstart.getTime() === loser.dtstart.getTime()
    ) {
      segments = segments.slice(1);
    }
    const last = segments[segments.length - 1];
    if (
      !latest.meta.afterNeeded &&
      last &&
      last.dtend.getTime() === loserEnd.getTime()
    ) {
      segments = segments.slice(0, -1);
    }
    maskedLoserKeys.add(loserKey);
    result.masksApplied++;
    segments.forEach((seg, i) => {
      const payload = {
        dtstart: seg.dtstart,
        dtend: seg.dtend,
        allDay: false,
        summary: loser.summary,
        location: loser.location,
        locationGeo: loser.locationGeo,
        description: loser.description,
      };
      const synthKey = `cf:${loserKey}:${i}`;
      desiredCf.set(synthKey, {
        familyId: member.familyId,
        familyMemberId,
        provenance: 'synthesized',
        synthKey,
        linkId: loser.linkId,
        // A segment lives and dies with its loser: an `ev:` loser's carries the
        // source event (so the segment goes when the source does), a `bl:`
        // loser's is null (the baseline day outlives any one feed event).
        sourceEventId: loser.sourceEventId,
        contentHash: hashCalendarEvent(payload),
        ...payload,
      });
    });
  }

  // Flag/unflag the maskable losers. The masked row survives (so detection stays
  // stable and synthesis keeps owning it) but is skipped by task-gen, the
  // mirror, and the calendar views — the cf: segments stand in for it.
  for (const e of events) {
    const maskable = e.synthKey.startsWith('bl:') || e.synthKey.startsWith('ev:');
    if (!maskable) continue;
    const shouldMask = maskedLoserKeys.has(e.synthKey);
    if (shouldMask && e.maskedAt == null) {
      await db
        .update(calendarEvents)
        .set({ maskedAt: new Date() })
        .where(eq(calendarEvents.id, e.id));
    } else if (!shouldMask && e.maskedAt != null) {
      // Un-masking has to clear the build stamp too. Task-gen swept this
      // event's unowned tasks while it was masked (its cf: segments carried
      // them), and its content hasn't changed since — so with the stamp still
      // matching, task-gen's dirty query would skip it forever and the event
      // would sit back on the calendar with nothing to claim, permanently.
      await db
        .update(calendarEvents)
        .set({ maskedAt: null, tasksBuiltHash: null })
        .where(eq(calendarEvents.id, e.id));
    }
  }

  // Reconcile the cf: split segments: upsert desired (hash skip), move or
  // release claimed tasks across the old and new segment sets, then delete
  // stale segments (their tasks have left by then).
  const existingCf = events.filter((e) => e.synthKey.startsWith('cf:'));
  const existingCfByKey = new Map(existingCf.map((e) => [e.synthKey, e]));
  const desiredSpans = new Map<string, Span>();
  for (const [synthKey, row] of desiredCf) {
    const prior = existingCfByKey.get(synthKey);
    let id: string;
    if (!prior) {
      id = (
        await db.insert(calendarEvents).values(row).returning({ id: calendarEvents.id })
      )[0]!.id;
    } else {
      id = prior.id;
      // `sourceEventId` is compared too: it isn't in the hash, but a segment
      // of a `bl:` day inherits that day's (now null) one, and a segment cut
      // before baseline days stopped carrying their exception event's id would
      // otherwise keep an ON DELETE CASCADE link to it forever.
      if (
        prior.contentHash !== row.contentHash ||
        prior.sourceEventId !== row.sourceEventId
      ) {
        await db
          .update(calendarEvents)
          .set({
            dtstart: row.dtstart,
            dtend: row.dtend,
            allDay: row.allDay,
            summary: row.summary,
            location: row.location,
            locationGeo: row.locationGeo,
            description: row.description,
            linkId: row.linkId,
            sourceEventId: row.sourceEventId,
            contentHash: row.contentHash,
          })
          .where(eq(calendarEvents.id, prior.id));
      }
    }
    desiredSpans.set(synthKey, { id, dtstart: row.dtstart as Date, dtend: row.dtend ?? null });
  }

  // Every loser whose segments existed or now exist: claims on its old events
  // (the parent day and its old segments, at their OLD times) are matched by
  // boundary time to its new events (the new segments if it is masked, else the
  // restored parent day).
  const cfParentKey = (key: string) => key.slice('cf:'.length).replace(/:\d+$/, '');
  const loserKeys = new Set([...maskedLoserKeys, ...existingCf.map((e) => cfParentKey(e.synthKey))]);
  for (const loserKey of loserKeys) {
    const parent = byKey.get(loserKey);
    const sources: Span[] = [
      ...(parent ? [parent] : []),
      ...existingCf.filter((e) => cfParentKey(e.synthKey) === loserKey),
    ].map((e) => ({ id: e.id, dtstart: e.dtstart, dtend: e.dtend }));
    const targets: Span[] = maskedLoserKeys.has(loserKey)
      ? [...desiredSpans].filter(([k]) => cfParentKey(k) === loserKey).map(([, v]) => v)
      : parent
        ? [{ id: parent.id, dtstart: parent.dtstart, dtend: parent.dtend }]
        : [];
    await reassignClaimedTasks(db, sources, targets, result);
  }

  for (const cf of existingCf) {
    if (!desiredCf.has(cf.synthKey)) {
      await db.delete(calendarEvents).where(eq(calendarEvents.id, cf.id));
    }
  }

  return result;
}

interface Span {
  id: string;
  dtstart: Date;
  dtend: Date | null;
}

/**
 * Whether a task anchored to `from`'s boundary is still anchored at the same
 * instant on `to`: a drop-off rides its event's start, a pickup its end, an
 * attendance the whole span.
 */
function sameBoundary(type: string, from: Span, to: Span): boolean {
  const end = (e: Span) => e.dtend?.getTime() ?? null;
  if (type === 'dropoff') return from.dtstart.getTime() === to.dtstart.getTime();
  if (type === 'pickup') return end(from) != null && end(from) === end(to);
  return from.dtstart.getTime() === to.dtstart.getTime() && end(from) === end(to);
}

/**
 * A conflict split replaced one event (the day) with others (its segments), or
 * back again, and claimed/dismissed tasks sit on the old ones. Owned tasks are
 * never swept, so left alone they duplicate: a claimed pickup stays on the old
 * event while the new one spawns an unclaimed twin.
 *
 * Each task is matched by boundary time to the new event set. Same instant → it
 * moves there (replacing the unclaimed twin, if one was already built), so the
 * claim carries over untouched. No match → a claim is released (the caretaker's
 * claimed event goes with it and the unclaimed task is the decision about who
 * takes the new time); a dismissal is dropped since the thing it dismissed no
 * longer exists. User-converted (`manual`) tasks are never moved onto another
 * event — they'd freeze its task types — so they're released instead.
 */
async function reassignClaimedTasks(
  db: Db,
  sources: Span[],
  targets: Span[],
  result: ConflictReconcileResult,
): Promise<void> {
  if (sources.length === 0) return;
  const held = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(
          tasks.calendarEventId,
          sources.map((s) => s.id),
        ),
        inArray(tasks.status, ['owned', 'dismissed']),
      ),
    );
  // Phase 1: decide every task's fate before touching any, so a task can't be
  // blocked by one that is itself leaving the same row.
  const moving = new Map<string, { task: (typeof held)[number]; to: Span }>();
  const leaving: (typeof held)[number][] = [];
  for (const t of held) {
    const from = sources.find((s) => s.id === t.calendarEventId)!;
    const to = targets.find((x) => sameBoundary(t.type, from, x));
    if (to && to.id === from.id) continue; // never moved
    if (to && t.createdVia !== 'manual') moving.set(t.id, { task: t, to });
    else leaving.push(t);
  }

  // A target keeps at most one task per type; a second claimant for the same
  // slot (two claims landing on one boundary) can't both move.
  const slotTaken = new Set<string>();
  for (const [id, { task, to }] of moving) {
    const slot = `${to.id}|${task.type}`;
    if (slotTaken.has(slot)) {
      moving.delete(id);
      leaving.push(task);
    } else slotTaken.add(slot);
  }

  // Phase 2a: release claims / drop dismissals that have no home.
  for (const t of leaving) {
    if (t.status === 'dismissed') {
      await db.delete(tasks).where(eq(tasks.id, t.id));
      continue;
    }
    const owners = (await ownerRowsFor(db, [t.id])).get(t.id) ?? [];
    await setTaskOwners(db, t, [], { manual: false });
    // Back to the pool means back under the assignment rules too.
    await db.update(tasks).set({ manualOwnerOverride: false }).where(eq(tasks.id, t.id));
    result.releasedOwnerIds.push(...owners.map((o) => o.familyMemberId));
  }

  // Phase 2b: move the rest. The target's own unclaimed generated twin gives
  // way; a leftover of any other kind (manual, or a claim that isn't leaving)
  // blocks the move and the task is released instead.
  const movingIds = new Set(moving.keys());
  for (const { task: t, to } of moving.values()) {
    await db
      .delete(tasks)
      .where(
        and(
          eq(tasks.calendarEventId, to.id),
          eq(tasks.type, t.type),
          eq(tasks.status, 'unowned'),
          eq(tasks.createdVia, 'generated'),
        ),
      );
    const others = (
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.calendarEventId, to.id), eq(tasks.type, t.type)))
    ).filter((o) => !movingIds.has(o.id));
    if (others.length === 0) {
      await db.update(tasks).set({ calendarEventId: to.id }).where(eq(tasks.id, t.id));
      continue;
    }
    const owners = (await ownerRowsFor(db, [t.id])).get(t.id) ?? [];
    if (t.status === 'dismissed') {
      await db.delete(tasks).where(eq(tasks.id, t.id));
    } else {
      await setTaskOwners(db, t, [], { manual: false });
      await db.update(tasks).set({ manualOwnerOverride: false }).where(eq(tasks.id, t.id));
      result.releasedOwnerIds.push(...owners.map((o) => o.familyMemberId));
    }
  }
}

/** Reconcile conflicts for every member of a family (cron + refresh-all). */
export async function reconcileFamilyConflicts(
  db: Db,
  familyId: string,
  opts: SynthesisWindowOptions = {},
): Promise<ConflictReconcileResult[]> {
  const members = await db
    .select({ id: familyMembers.id })
    .from(familyMembers)
    .where(eq(familyMembers.familyId, familyId));
  const results: ConflictReconcileResult[] = [];
  for (const { id } of members) {
    results.push(await reconcileMemberConflicts(db, id, opts));
  }
  return results;
}
