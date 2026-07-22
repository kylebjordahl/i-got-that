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
  lt,
  or,
} from '@igt/db';
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

type CalendarEventRow = typeof calendarEvents.$inferSelect;

/** Manual (human) + claimed commitments outrank every feed. Lower wins. */
const HUMAN_PRIORITY = -1;

export interface ConflictReconcileResult {
  familyMemberId: string;
  /** How many overlaps are awaiting an admin decision. */
  conflictsOpen: number;
  /** How many losers were split/trimmed by a resolved conflict this pass. */
  masksApplied: number;
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

  // --- Materialise the splits for resolved conflicts. ------------------------
  const surviving = await db
    .select()
    .from(conflicts)
    .where(eq(conflicts.familyMemberId, familyMemberId));
  result.conflictsOpen = surviving.filter((c) => c.status === 'pending').length;

  // Resolved winners grouped by the loser they displace.
  const resolvedWinners = new Map<string, string[]>();
  for (const c of surviving) {
    if (c.status !== 'resolved') continue;
    const list = resolvedWinners.get(c.loserKey) ?? [];
    list.push(c.winnerKey);
    resolvedWinners.set(c.loserKey, list);
  }

  const desiredCf = new Map<string, typeof calendarEvents.$inferInsert>();
  const maskedLoserKeys = new Set<string>();
  for (const [loserKey, winnerKeys] of resolvedWinners) {
    const loser = byKey.get(loserKey);
    if (!loser || loser.dtend == null) continue; // loser gone this pass, or a point
    const cuts = winnerKeys
      .map((wk) => byKey.get(wk))
      .filter((w): w is CalendarEventRow => !!w && w.dtend != null)
      .map((w) => ({ dtstart: w.dtstart, dtend: w.dtend as Date }));
    if (cuts.length === 0) continue; // every winner vanished — leave the loser whole
    const segments = subtractIntervals(
      { dtstart: loser.dtstart, dtend: loser.dtend },
      cuts,
    );
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
      await db
        .update(calendarEvents)
        .set({ maskedAt: null })
        .where(eq(calendarEvents.id, e.id));
    }
  }

  // Reconcile the cf: split segments: delete stale, upsert desired (hash skip).
  const existingCf = events.filter((e) => e.synthKey.startsWith('cf:'));
  const existingCfByKey = new Map(existingCf.map((e) => [e.synthKey, e]));
  for (const cf of existingCf) {
    if (!desiredCf.has(cf.synthKey)) {
      await db.delete(calendarEvents).where(eq(calendarEvents.id, cf.id));
    }
  }
  for (const [synthKey, row] of desiredCf) {
    const prior = existingCfByKey.get(synthKey);
    if (!prior) {
      await db.insert(calendarEvents).values(row);
    } else if (prior.contentHash !== row.contentHash) {
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

  return result;
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
