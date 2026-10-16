import { env } from 'cloudflare:test';
import {
  calendarEvents,
  conflicts,
  eq,
  families,
  familyMemberFeeds,
  feeds,
  getDb,
  linkRules,
  pendingDecisions,
  sourceEvents,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { batchChunked, D1_BATCH_SIZE, D1_MAX_BOUND_PARAMS } from '../src/lib/d1.js';
import { reconcileMemberConflicts } from '../src/services/conflicts.js';
import { ingestFeed } from '../src/services/ingest.js';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { countD1 } from './d1-counter.js';
import { pinClockTo, setupFamily } from './helpers.js';

/**
 * #265 — the pipeline used to await one D1 statement per row, sequentially: a
 * round trip and a subrequest each, and an unchanged row was rewritten (and
 * billed) as readily as a changed one. These specs run a realistic family
 * through ingest -> synthesis -> conflicts -> task-gen against a counting D1
 * (`d1-counter.ts`, which also enforces D1's 100-parameter cap) and pin both
 * halves of the fix: a stage sends its writes in batches, and a pass that has
 * nothing to change writes nothing.
 *
 * The fixture ("2 feeds x 30 days"): a standard activity feed with a practice
 * every day for 30 days (overlapping the school day, so there are conflicts to
 * detect), and an exception-mode school feed whose 22 weekday baseline days are
 * synthesized, with 7 exception events on top — 2 no-school days and 2 early
 * releases (each matched by a link rule) and 3 picture-day events no rule
 * matches (pending decisions).
 *
 * Measured on that fixture, D1 round trips, before -> after:
 *   ingest (both feeds)       41 -> 6      conflicts (detect)       22 -> 6
 *   synthesis (both feeds)   101 -> 16     conflicts (10 resolved)  45 -> 17
 *   task-gen                 245 -> 13
 * The remaining round trips are reads. The bounds asserted below sit well above
 * the "after" figures (they are there to catch a loop of single writes coming
 * back, not to pin an exact count) and well below the "before" ones.
 */

// A Monday; the synthesis window is [2026-09-07, 2026-10-07).
pinClockTo('2026-09-07T12:00:00Z');

const DAYS = 30;
const EXCEPTIONS = 7;
/** In-window practices: the 30th lands on the window's (exclusive) end date. */
const PRACTICES_IN_WINDOW = DAYS - 1;
/** Weekdays in the window, less the two no-school days. */
const SCHOOL_DAYS = 22 - 2;

const pad = (n: number) => String(n).padStart(2, '0');
const base = new Date('2026-09-07T00:00:00Z');
function icsStamp(offsetDays: number, hour: number, min = 0): string {
  const d = new Date(base.getTime() + offsetDays * 86_400_000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(hour)}${pad(min)}00Z`;
}
const icsDate = (offsetDays: number) => icsStamp(offsetDays, 0).slice(0, 8);

function ics(events: string[][]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//igt//test//EN',
    ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']),
    'END:VCALENDAR',
  ].join('\r\n');
}

function fetching(body: string): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
  })) as unknown as typeof fetch;
}

/** Daily practice, 14:00-15:00 UTC: 45 minutes of it overlap the 08:30-14:45 school day. */
function practiceIcs(opts: { days?: number; renamed?: number; without?: number } = {}): string {
  const days = opts.days ?? DAYS;
  return ics(
    Array.from({ length: days }, (_, i) => i)
      .filter((i) => i !== opts.without)
      .map((i) => [
        `UID:practice-${i}@example.com`,
        `DTSTART:${icsStamp(i + 1, 14)}`,
        `DTEND:${icsStamp(i + 1, 15)}`,
        `SUMMARY:${i === opts.renamed ? 'Practice (moved to the dome)' : `Practice ${i}`}`,
        'LOCATION:Field 2',
      ]),
  );
}

function schoolIcs(): string {
  const allDay = (uid: string, offset: number, summary: string) => [
    `UID:${uid}@example.com`,
    `DTSTART;VALUE=DATE:${icsDate(offset)}`,
    `DTEND;VALUE=DATE:${icsDate(offset + 1)}`,
    `SUMMARY:${summary}`,
  ];
  const timed = (uid: string, offset: number, summary: string) => [
    `UID:${uid}@example.com`,
    `DTSTART:${icsStamp(offset, 8, 30)}`,
    `DTEND:${icsStamp(offset, 12, 0)}`,
    `SUMMARY:${summary}`,
  ];
  return ics([
    allDay('noschool-1', 8, 'No School'), // Tue
    allDay('noschool-2', 15, 'No School'), // Tue
    timed('early-1', 10, 'Early Release'), // Thu
    timed('early-2', 17, 'Early Release'), // Thu
    allDay('picture-1', 11, 'Picture Day'), // Fri
    allDay('picture-2', 18, 'Picture Day'), // Fri
    allDay('picture-3', 25, 'Picture Day'), // Fri
  ]);
}

/**
 * The fixture family. Pipeline calls go through `db` (the counting, capped
 * binding); `setup` is the plain one, for arranging and inspecting state
 * without touching the counters.
 */
async function fixture(email: string) {
  const counter = countD1(env.DB, { maxBoundParams: D1_MAX_BOUND_PARAMS });
  const fam = await setupFamily(email);
  const setup = getDb(env.DB);
  const practice = (
    await setup
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        mode: 'standard',
        url: 'https://feed.example.com/practice.ics',
        sourceCalendarName: 'Soccer',
      })
      .returning()
  )[0]!;
  const school = (
    await setup
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        mode: 'exception',
        url: 'https://feed.example.com/school.ics',
        sourceCalendarName: 'Lincoln Elementary',
        timezone: 'UTC',
      })
      .returning()
  )[0]!;
  await setup.insert(familyMemberFeeds).values({
    familyId: fam.familyId,
    feedId: practice.id,
    familyMemberId: fam.childId,
    defaultTaskType: 'attendance',
    // Behind the school (position 0): where the two overlap, practice loses.
    position: 1,
  });
  const schoolLink = (
    await setup
      .insert(familyMemberFeeds)
      .values({
        familyId: fam.familyId,
        feedId: school.id,
        familyMemberId: fam.childId,
        weekdayMask: 31, // Mon-Fri
        dayStart: '08:30',
        dayEnd: '14:45',
        defaultTaskType: 'transition',
      })
      .returning()
  )[0]!;
  await setup.insert(linkRules).values([
    {
      familyId: fam.familyId,
      linkId: schoolLink.id,
      position: 0,
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'No School',
      outcome: 'cancel_day',
    },
    {
      familyId: fam.familyId,
      linkId: schoolLink.id,
      position: 1,
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Early Release',
      outcome: 'modify_day',
      params: { dayEnd: '12:00' },
    },
  ]);
  return { ...fam, counter, setup, practice, school, db: getDb(counter.db) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

const ingestPractice = (f: Fixture, body = practiceIcs()) =>
  ingestFeed(f.db, f.practice, { fetchImpl: fetching(body) });
const ingestSchool = (f: Fixture) =>
  ingestFeed(f.db, f.school, { fetchImpl: fetching(schoolIcs()) });
const ingestAll = async (f: Fixture) => {
  await ingestPractice(f);
  await ingestSchool(f);
};
const synthesizeAll = async (f: Fixture) => {
  await synthesizeFeed(f.db, f.practice);
  await synthesizeFeed(f.db, f.school);
};

/** Run `run`, returning what it sent to D1. */
async function measure(f: Fixture, run: () => Promise<unknown>) {
  f.counter.reset();
  await run();
  return { ...f.counter.snapshot(), log: [...f.counter.stats.log] };
}

const childEvents = (f: Fixture) =>
  f.setup.select().from(calendarEvents).where(eq(calendarEvents.familyMemberId, f.childId));

const sortedById = <T extends { id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));

describe('batchChunked', () => {
  it('sends statements in batches of at most the chunk size, in order, and returns results in order', async () => {
    const counter = countD1(env.DB, { maxBoundParams: D1_MAX_BOUND_PARAMS });
    const db = getDb(counter.db);

    const inserts = Array.from({ length: 120 }, (_, i) =>
      db.insert(families).values({ name: `batch-${i}` }).returning({ name: families.name }),
    );
    const results = await batchChunked(db, inserts);

    expect(counter.stats.batchSizes).toEqual([D1_BATCH_SIZE, D1_BATCH_SIZE, 120 - 2 * D1_BATCH_SIZE]);
    expect(counter.stats.roundTrips).toBe(3);
    expect(results.map((r) => (r as { name: string }[])[0]!.name)).toEqual(
      Array.from({ length: 120 }, (_, i) => `batch-${i}`),
    );

    counter.reset();
    await batchChunked(
      db,
      Array.from({ length: 7 }, (_, i) => db.insert(families).values({ name: `again-${i}` })),
      3,
    );
    expect(counter.stats.batchSizes).toEqual([3, 3, 1]);
  });

  it('makes no call for an empty list', async () => {
    const counter = countD1(env.DB);
    expect(await batchChunked(getDb(counter.db), [])).toEqual([]);
    expect(counter.stats.roundTrips).toBe(0);
  });
});

describe('ingest (#265)', () => {
  it('upserts a feed in batches, and a second identical ingest writes no source_events rows', async () => {
    const f = await fixture('batched-ingest@example.com');

    const first = await measure(f, () => ingestAll(f));
    // 30 + 7 upserts: one batch per feed. What is left is each feed's stale-row
    // lookup and its own `UPDATE feeds`.
    expect(first.batchSizes).toEqual([DAYS, EXCEPTIONS]);
    expect(first.unbatchedWrites).toBe(2);
    expect(first.roundTrips).toBeLessThanOrEqual(8);
    expect(first.rowsWrittenBy.source_events).toBeGreaterThan(0);

    const stored = sortedById(await f.setup.select().from(sourceEvents));
    expect(stored).toHaveLength(DAYS + EXCEPTIONS);

    // Same feed again (no ETag, so it is read and upserted in full): the upserts
    // are still sent, but SQLite skips every one of them — `setWhere` on the
    // content hash — so not a single source_events row is written.
    const second = await measure(f, () => ingestAll(f));
    expect(second.batchSizes).toEqual([DAYS, EXCEPTIONS]);
    expect(second.rowsWrittenBy.source_events ?? 0).toBe(0);
    expect(sortedById(await f.setup.select().from(sourceEvents))).toEqual(stored);
  });

  it('writes only the event that changed upstream', async () => {
    const f = await fixture('batched-ingest-changed@example.com');
    await ingestPractice(f);
    const before = sortedById(await f.setup.select().from(sourceEvents));

    const run = await measure(f, () => ingestPractice(f, practiceIcs({ renamed: 3 })));
    const after = sortedById(await f.setup.select().from(sourceEvents));

    expect(after).toHaveLength(before.length);
    const changed = after.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before[i]));
    expect(changed.map((r) => r.icalUid)).toEqual(['practice-3@example.com']);
    expect(changed[0]!.summary).toBe('Practice (moved to the dome)');
    expect(changed[0]!.contentHash).not.toBe(before.find((r) => r.id === changed[0]!.id)!.contentHash);
    // One row (plus its index entries), not thirty.
    expect(run.rowsWrittenBy.source_events).toBeGreaterThan(0);
    expect(run.rowsWrittenBy.source_events).toBeLessThan(10);
  });

  it('still drops an event removed upstream', async () => {
    const f = await fixture('batched-ingest-removed@example.com');
    await ingestPractice(f);
    await ingestPractice(f, practiceIcs({ without: 5 }));
    const uids = (await f.setup.select().from(sourceEvents)).map((r) => r.icalUid);
    expect(uids).toHaveLength(DAYS - 1);
    expect(uids).not.toContain('practice-5@example.com');
  });

  it('chunks a large feed into batches of at most 50 statements', async () => {
    const f = await fixture('batched-ingest-large@example.com');
    const run = await measure(f, () =>
      ingestFeed(f.db, f.practice, {
        fetchImpl: fetching(practiceIcs({ days: 120 })),
        windowEnd: new Date(base.getTime() + 200 * 86_400_000), // past the default 90 days
      }),
    );
    expect(run.batchSizes).toEqual([D1_BATCH_SIZE, D1_BATCH_SIZE, 120 - 2 * D1_BATCH_SIZE]);
    expect(await f.setup.select().from(sourceEvents)).toHaveLength(120);
  });
});

describe('synthesis (#265)', () => {
  it('writes a feed in batches, never stamps synthesized_hash, and writes nothing the second time', async () => {
    const f = await fixture('batched-synthesis@example.com');
    await ingestAll(f);

    const first = await measure(f, () => synthesizeAll(f));
    expect(first.unbatchedWrites).toBe(0);
    expect(first.roundTrips).toBeLessThanOrEqual(20);
    // The write-only `source_events.synthesized_hash` stamp (one UPDATE per
    // changed occurrence) is gone entirely.
    expect(first.log.filter((q) => /^\s*update\s+"source_events"/i.test(q))).toEqual([]);
    expect(first.rowsWrittenBy.source_events ?? 0).toBe(0);

    const events = await childEvents(f);
    expect(events.filter((e) => e.synthKey.startsWith('ev:'))).toHaveLength(PRACTICES_IN_WINDOW);
    expect(events.filter((e) => e.synthKey.startsWith('bl:'))).toHaveLength(SCHOOL_DAYS);
    expect(await f.setup.select().from(pendingDecisions)).toHaveLength(3);

    // Nothing changed: reads only.
    const second = await measure(f, () => synthesizeAll(f));
    expect(second.writeStatements).toBe(0);
    expect(second.batches).toBe(0);
  });

  it('writes one statement for one changed event, and clears the ones that vanished', async () => {
    const f = await fixture('batched-synthesis-changed@example.com');
    await ingestAll(f);
    await synthesizeAll(f);

    await ingestPractice(f, practiceIcs({ renamed: 3 }));
    const renamed = await measure(f, () => synthesizeFeed(f.db, f.practice));
    expect(renamed.writeStatements).toBe(1);
    expect(renamed.batchSizes).toEqual([1]);

    // A dismissed feed event leaves the desired set: its calendar event is stale.
    await f.setup
      .update(sourceEvents)
      .set({ dismissedAt: new Date() })
      .where(eq(sourceEvents.icalUid, 'practice-4@example.com'));
    const removed = await measure(f, () => synthesizeFeed(f.db, f.practice));
    expect(removed.writeStatements).toBe(1);
    expect(removed.unbatchedWrites).toBe(0);
    expect((await childEvents(f)).filter((e) => e.synthKey.startsWith('ev:'))).toHaveLength(
      PRACTICES_IN_WINDOW - 1,
    );
  });

  it('batches the pending-decision writes when a picture day is moved', async () => {
    const f = await fixture('batched-synthesis-pending@example.com');
    await ingestAll(f);
    await synthesizeAll(f);
    // Resolving a decision is the human's; what matters here is the sourceContentHash
    // on a still-pending one following the event when it changes.
    await f.setup.update(sourceEvents).set({ contentHash: 'changed-upstream' }).where(eq(sourceEvents.icalUid, 'picture-1@example.com'));

    const run = await measure(f, () => synthesizeFeed(f.db, f.school));
    expect(run.unbatchedWrites).toBe(0);
    expect(run.writeStatements).toBe(1);
    const decision = (await f.setup.select().from(pendingDecisions)).find(
      (d) => d.sourceContentHash === 'changed-upstream',
    );
    expect(decision?.status).toBe('pending');
  });
});

describe('conflicts and task-gen (#265)', () => {
  it('batches conflict rows, masks and split segments, and task-gen builds a month in a few round trips', async () => {
    const f = await fixture('batched-conflicts@example.com');
    await ingestAll(f);
    await synthesizeAll(f);

    // --- conflicts: every overlap is one row, written as one batch. -----------
    const detect = await measure(f, () => reconcileMemberConflicts(f.db, f.childId));
    const detected = await f.setup.select().from(conflicts).where(eq(conflicts.familyMemberId, f.childId));
    // Practices on a weekday school runs (21 of the 29), less the two no-school
    // days and the two early releases, which are over before practice starts.
    expect(detected).toHaveLength(17);
    expect(detect.unbatchedWrites).toBe(0);
    expect(detect.batchSizes).toEqual([detected.length]);
    expect(detect.roundTrips).toBeLessThanOrEqual(8);

    // An admin resolves ten of them: their practices are split around school.
    for (const c of detected.slice(0, 10)) {
      await f.setup
        .update(conflicts)
        .set({ status: 'resolved', resolvedAt: new Date() })
        .where(eq(conflicts.id, c.id));
    }
    const resolve = await measure(f, () => reconcileMemberConflicts(f.db, f.childId));
    expect(resolve.unbatchedWrites).toBe(0);
    expect(resolve.roundTrips).toBeLessThanOrEqual(20);
    const afterResolve = await childEvents(f);
    const masked = afterResolve.filter((e) => e.maskedAt != null);
    expect(masked).toHaveLength(10);
    expect(afterResolve.filter((e) => e.synthKey.startsWith('cf:'))).toHaveLength(10);

    const settled = await measure(f, () => reconcileMemberConflicts(f.db, f.childId));
    expect(settled.writeStatements).toBe(0);

    // --- task-gen: the month's events, tasks read and written in bulk. --------
    const build = await measure(f, () => buildMemberTasks(f.db, f.childId));
    expect(build.unbatchedWrites).toBe(0);
    expect(build.roundTrips).toBeLessThanOrEqual(20);
    expect(Math.max(...build.batchSizes)).toBeLessThanOrEqual(D1_BATCH_SIZE);

    const built = await f.setup.select().from(tasks).where(eq(tasks.familyMemberId, f.childId));
    const stamped = await childEvents(f);
    const live = stamped.filter((e) => e.maskedAt == null);
    // One drop-off + one pickup per school day and one attendance per practice
    // (or per segment of one a conflict split); never two of a type on one
    // event, and nothing on a masked one.
    const perEvent = new Map<string, string[]>();
    for (const t of built) perEvent.set(t.calendarEventId!, [...(perEvent.get(t.calendarEventId!) ?? []), t.type]);
    for (const e of live) expect(perEvent.has(e.id)).toBe(true);
    for (const [eventId, types] of perEvent) {
      expect(new Set(types).size).toBe(types.length);
      expect(masked.some((m) => m.id === eventId)).toBe(false);
    }
    const types = (prefix: string) =>
      live
        .filter((e) => e.synthKey.startsWith(prefix))
        .map((e) => (perEvent.get(e.id) ?? []).sort().join('+'));
    expect(new Set(types('bl:'))).toEqual(new Set(['dropoff+pickup']));
    expect(types('ev:').every((t) => t === 'attendance')).toBe(true);
    expect(types('cf:').every((t) => t === 'attendance')).toBe(true);
    // Every event task-gen visited is stamped.
    expect(live.every((e) => e.tasksBuiltHash === e.contentHash)).toBe(true);

    // Nothing left to build: reads only.
    const again = await measure(f, () => buildMemberTasks(f.db, f.childId));
    expect(again.writeStatements).toBe(0);
  });

  it('builds more events than one chunk in several, stamping each', async () => {
    const f = await fixture('batched-taskgen-chunks@example.com');
    const link = (await f.setup.select().from(familyMemberFeeds).where(eq(familyMemberFeeds.feedId, f.school.id)))[0]!;
    const count = 130; // 50 + 50 + 30
    for (let i = 0; i < count; i += 5) {
      await f.setup.insert(calendarEvents).values(
        Array.from({ length: Math.min(5, count - i) }, (_, j) => {
          const n = i + j;
          const dtstart = new Date(base.getTime() + (1 + (n % 25)) * 86_400_000 + (8 + Math.floor(n / 25)) * 3_600_000);
          return {
            familyId: f.familyId,
            familyMemberId: f.childId,
            provenance: 'synthesized' as const,
            synthKey: `bl:${link.id}:n${n}`,
            linkId: link.id,
            dtstart,
            dtend: new Date(dtstart.getTime() + 1_800_000),
            allDay: false,
            summary: `Event ${n}`,
            location: null,
            locationGeo: null,
            description: null,
            contentHash: `h${n}`,
          };
        }),
      );
    }

    const build = await measure(f, () => buildMemberTasks(f.db, f.childId));
    expect(build.unbatchedWrites).toBe(0);
    expect(Math.max(...build.batchSizes)).toBeLessThanOrEqual(D1_BATCH_SIZE);
    // A drop-off and a pickup each, from three chunks' worth of round trips.
    expect(await f.setup.select().from(tasks).where(eq(tasks.familyMemberId, f.childId))).toHaveLength(count * 2);
    expect((await childEvents(f)).every((e) => e.tasksBuiltHash === e.contentHash)).toBe(true);
    expect(build.roundTrips).toBeLessThanOrEqual(25);

    const again = await measure(f, () => buildMemberTasks(f.db, f.childId));
    expect(again.writeStatements).toBe(0);
  });
});
