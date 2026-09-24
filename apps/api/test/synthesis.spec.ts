import { env, fetchMock } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  linkBaselineChanges,
  linkRules,
  pendingDecisions,
  sourceEvents,
  taskRules,
  tasks,
} from '@igt/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { authed, bearer, call, patched, setupFamily } from './helpers.js';

const EMPTY_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//test//EN\r\nEND:VCALENDAR';

// The 'link-rule (override) routes' spec below hits the real member-links
// route, whose first call now opportunistically ingests a never-synced feed
// (see resynthesize() in routes/feeds.ts) — stub that out so it resolves
// deterministically instead of attempting a real DNS lookup for these feeds'
// placeholder URLs.
beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

// Fixed window (Mon Jul 6 – Sun Jul 12 2026) so weekday assertions are stable.
const WINDOW = {
  windowStart: new Date('2026-07-06T00:00:00Z'),
  windowEnd: new Date('2026-07-13T00:00:00Z'),
};

type FeedRow = typeof feeds.$inferSelect;
type Db = ReturnType<typeof getDb>;

/** Service-level fixture: everything inserted directly so the only synthesis
 *  runs are the ones the spec triggers with its fixed window. */
async function exceptionFixture(email: string) {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        mode: 'exception',
        url: 'https://feed.example.com/cal.ics',
        sourceCalendarName: 'Lincoln Elementary',
      })
      .returning()
  )[0]!;
  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({
        familyId: fam.familyId,
        feedId: feed.id,
        familyMemberId: fam.childId,
        weekdayMask: 31, // Mon–Fri
        dayStart: '08:30',
        dayEnd: '14:45',
      })
      .returning()
  )[0]!;
  return { ...fam, db, feed, linkId: link.id };
}

let rulePos = 0;
async function insertRule(
  db: Db,
  f: { familyId: string; linkId: string },
  values: Partial<typeof linkRules.$inferInsert> & {
    matchField: 'summary' | 'location' | 'description' | 'any_text' | 'all_day' | 'duration';
    matchOp: string;
    outcome: 'cancel_day' | 'modify_day' | 'ignore' | 'add_event';
  },
) {
  return (
    await db
      .insert(linkRules)
      .values({
        familyId: f.familyId,
        linkId: f.linkId,
        position: rulePos++,
        ...values,
      } as typeof linkRules.$inferInsert)
      .returning()
  )[0]!;
}

async function insertSource(
  db: Db,
  feed: FeedRow,
  values: Partial<typeof sourceEvents.$inferInsert> & { icalUid: string },
) {
  return (
    await db
      .insert(sourceEvents)
      .values({
        feedId: feed.id,
        familyId: feed.familyId,
        recurrenceId: '',
        dtstart: new Date('2026-07-08T00:00:00Z'),
        allDay: true,
        contentHash: `hash-${values.icalUid}`,
        ...values,
      })
      .returning()
  )[0]!;
}

describe('synthesis: exception feeds (schedule only)', () => {
  it('expands the baseline; cancel_day drops a day; modify_day patches hours; ignore keeps it', async () => {
    const f = await exceptionFixture('synth-exc@example.com');
    await insertRule(f.db, f, {
      matchField: 'summary',
      matchOp: 'regex',
      matchValue: '/no school|closed/i',
      outcome: 'cancel_day',
    });
    await insertRule(f.db, f, {
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Early Release',
      outcome: 'modify_day',
      params: { dayEnd: '12:00' },
    });
    await insertRule(f.db, f, {
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Spirit',
      outcome: 'ignore',
    });

    await insertSource(f.db, f.feed, {
      icalUid: 'closed',
      summary: 'MCH Closed - Holiday',
      dtstart: new Date('2026-07-07T00:00:00Z'),
      dtend: new Date('2026-07-08T00:00:00Z'),
    });
    await insertSource(f.db, f.feed, {
      icalUid: 'early',
      summary: 'Early Release - Conferences',
      dtstart: new Date('2026-07-08T00:00:00Z'),
      dtend: new Date('2026-07-09T00:00:00Z'),
    });
    await insertSource(f.db, f.feed, {
      icalUid: 'spirit',
      summary: 'Spirit Day',
      dtstart: new Date('2026-07-09T00:00:00Z'),
      dtend: new Date('2026-07-10T00:00:00Z'),
    });

    const result = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(result.pendingOpen).toBe(0);

    const events = await f.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.familyMemberId, f.childId));
    const byKey = new Map(events.map((e) => [e.synthKey, e]));
    expect(byKey.has(`bl:${f.linkId}:2026-07-07`)).toBe(false); // Tuesday cancelled
    expect(events).toHaveLength(4);

    const mon = byKey.get(`bl:${f.linkId}:2026-07-06`)!;
    expect(mon.summary).toBe('Lincoln Elementary');
    expect(mon.dtstart.toISOString()).toBe('2026-07-06T08:30:00.000Z');
    expect(mon.dtend!.toISOString()).toBe('2026-07-06T14:45:00.000Z');

    const wed = byKey.get(`bl:${f.linkId}:2026-07-08`)!; // Early Release
    expect(wed.dtend!.toISOString()).toBe('2026-07-08T12:00:00.000Z');

    const thu = byKey.get(`bl:${f.linkId}:2026-07-09`)!; // Spirit Day → ignore, full hours
    expect(thu.dtend!.toISOString()).toBe('2026-07-09T14:45:00.000Z');
  });

  it("stamps the link's geocoded location onto synthesized baseline events", async () => {
    const f = await exceptionFixture('synth-geo@example.com');
    await f.db
      .update(familyMemberFeeds)
      .set({
        location: 'Lincoln Elementary',
        locationGeo: {
          lat: 37.331686,
          lon: -122.030656,
          title: 'Lincoln Elementary',
          address: '123 Main St, Springfield',
        },
      })
      .where(eq(familyMemberFeeds.id, f.linkId));

    await synthesizeFeed(f.db, f.feed, WINDOW);

    const mon = (
      await f.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.synthKey, `bl:${f.linkId}:2026-07-06`))
    )[0]!;
    expect(mon.location).toBe('Lincoln Elementary');
    expect(mon.locationGeo).toEqual({
      lat: 37.331686,
      lon: -122.030656,
      title: 'Lincoln Elementary',
      address: '123 Main St, Springfield',
    });
  });

  it('resynthesizes idempotently: rerun is a no-op; removing a rule reinstates the day', async () => {
    const f = await exceptionFixture('synth-idem@example.com');
    const cancel = await insertRule(f.db, f, {
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Closed',
      outcome: 'cancel_day',
    });
    await insertSource(f.db, f.feed, {
      icalUid: 'closed',
      summary: 'Closed - Holiday',
      dtstart: new Date('2026-07-07T00:00:00Z'),
      dtend: new Date('2026-07-08T00:00:00Z'),
    });

    const r1 = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(r1.eventsUpserted).toBe(4);
    const r2 = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(r2.eventsUpserted).toBe(0);
    expect(r2.eventsRemoved).toBe(0);

    await f.db.delete(linkRules).where(eq(linkRules.id, cancel.id));
    const r3 = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(r3.pendingOpen).toBe(1); // now-unmatched occurrence pends
    const events = await f.db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.familyMemberId, f.childId),
          eq(calendarEvents.provenance, 'synthesized'),
        ),
      );
    const keys = events.map((e) => e.synthKey).sort();
    expect(new Set(keys).size).toBe(keys.length); // no dupes
    expect(keys).toContain(`bl:${f.linkId}:2026-07-07`);
    expect(events).toHaveLength(5);
  });

  it('add_event adds the feed event beside an untouched school day, and it types via task rules', async () => {
    const f = await exceptionFixture('synth-add-event@example.com');
    await insertRule(f.db, f, {
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Community Dinner',
      outcome: 'add_event',
    });
    // The whole family attends the dinner; the school day itself is a transition.
    await f.db.insert(taskRules).values({
      familyId: f.familyId,
      familyMemberId: f.childId,
      linkId: f.linkId,
      scope: 'this_calendar',
      position: 0,
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Community Dinner',
      resultType: 'attendance',
    });
    const dinner = await insertSource(f.db, f.feed, {
      icalUid: 'dinner',
      summary: 'Community Dinner',
      location: 'Lincoln Cafeteria',
      allDay: false,
      dtstart: new Date('2026-07-08T22:30:00Z'),
      dtend: new Date('2026-07-09T00:30:00Z'),
    });

    const result = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(result.pendingOpen).toBe(0);

    const events = await f.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.familyMemberId, f.childId));
    const byKey = new Map(events.map((e) => [e.synthKey, e]));
    expect(events).toHaveLength(6); // Mon–Fri baseline + the dinner

    const added = byKey.get(`ev:${f.linkId}:${dinner.id}`)!;
    expect(added.summary).toBe('Community Dinner');
    expect(added.location).toBe('Lincoln Cafeteria');
    expect(added.dtstart.toISOString()).toBe('2026-07-08T22:30:00.000Z');
    expect(added.sourceEventId).toBe(dinner.id);
    // Wednesday's school day is unchanged — the dinner is in addition to it.
    const wed = byKey.get(`bl:${f.linkId}:2026-07-08`)!;
    expect(wed.dtstart.toISOString()).toBe('2026-07-08T08:30:00.000Z');
    expect(wed.dtend!.toISOString()).toBe('2026-07-08T14:45:00.000Z');

    await buildMemberTasks(f.db, f.childId);
    const dinnerTasks = await f.db.select().from(tasks).where(eq(tasks.calendarEventId, added.id));
    expect(dinnerTasks.map((t) => t.type)).toEqual(['attendance']);
    const schoolTasks = await f.db.select().from(tasks).where(eq(tasks.calendarEventId, wed.id));
    expect(schoolTasks.map((t) => t.type).sort()).toEqual(['dropoff', 'pickup']);
  });

  it("add_event doesn't duplicate an occurrence a human already resolved onto the calendar", async () => {
    const f = await exceptionFixture('synth-add-event-pd@example.com');
    const dinner = await insertSource(f.db, f.feed, {
      icalUid: 'dinner-pd',
      summary: 'Community Dinner',
      allDay: false,
      dtstart: new Date('2026-07-08T22:30:00Z'),
      dtend: new Date('2026-07-09T00:30:00Z'),
    });
    expect((await synthesizeFeed(f.db, f.feed, WINDOW)).pendingOpen).toBe(1);
    const decision = (
      await f.db
        .select()
        .from(pendingDecisions)
        .where(eq(pendingDecisions.sourceEventId, dinner.id))
    )[0]!;
    const res = await call(
      `/families/${f.familyId}/pending-decisions/${decision.id}/resolve`,
      authed(f.admin.token, {}),
    );
    expect(res.status).toBe(200);

    // A rule written afterwards now matches the same occurrence: the human's
    // event stands alone — no second copy of the dinner.
    await insertRule(f.db, f, {
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Community Dinner',
      outcome: 'add_event',
    });
    await synthesizeFeed(f.db, f.feed, WINDOW);

    const forSource = await f.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.sourceEventId, dinner.id));
    expect(forSource.map((e) => e.synthKey)).toEqual([`pd:${decision.id}`]);
  });

  it('raises a pending decision for an unmatched occurrence and reopens it when content changes', async () => {
    const f = await exceptionFixture('synth-pending@example.com');
    const source = await insertSource(f.db, f.feed, {
      icalUid: 'bookfair',
      summary: 'Book Fair',
      dtstart: new Date('2026-07-07T17:00:00Z'),
      dtend: new Date('2026-07-07T19:00:00Z'),
      allDay: false,
      contentHash: 'v1',
    });

    const r1 = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(r1.pendingOpen).toBe(1);
    const decision = (
      await f.db
        .select()
        .from(pendingDecisions)
        .where(eq(pendingDecisions.sourceEventId, source.id))
    )[0]!;
    expect(decision.status).toBe('pending');
    // The baseline still stands that day.
    expect(
      await f.db
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.familyMemberId, f.childId),
            eq(calendarEvents.synthKey, `bl:${f.linkId}:2026-07-07`),
          ),
        ),
    ).toHaveLength(1);

    const dis = await call(
      `/families/${f.familyId}/pending-decisions/${decision.id}/dismiss`,
      authed(f.admin.token),
    );
    expect(dis.status).toBe(200);
    const r2 = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(r2.pendingOpen).toBe(0);

    await f.db
      .update(sourceEvents)
      .set({ summary: 'Book Fair — NEW TIME', contentHash: 'v2' })
      .where(eq(sourceEvents.id, source.id));
    const r3 = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(r3.pendingOpen).toBe(1);
    const reopened = (
      await f.db
        .select()
        .from(pendingDecisions)
        .where(eq(pendingDecisions.sourceEventId, source.id))
    )[0]!;
    expect(reopened.status).toBe('pending');
    expect(reopened.sourceContentHash).toBe('v2');
  });
});

describe('synthesis: dated baseline changes', () => {
  it('switches the baseline hours on the effective date; tasks follow; removal restores', async () => {
    const f = await exceptionFixture('synth-baseline-change@example.com');
    const change = (
      await f.db
        .insert(linkBaselineChanges)
        .values({
          familyId: f.familyId,
          linkId: f.linkId,
          effectiveFrom: '2026-07-08',
          dayStart: '08:30',
          dayEnd: '17:00',
        })
        .returning()
    )[0]!;

    await synthesizeFeed(f.db, f.feed, WINDOW);
    const ends = async () => {
      const events = await f.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.familyMemberId, f.childId));
      return Object.fromEntries(
        events.map((e) => [e.synthKey, e.dtend!.toISOString().slice(11, 16)]),
      );
    };
    expect(await ends()).toEqual({
      [`bl:${f.linkId}:2026-07-06`]: '14:45',
      [`bl:${f.linkId}:2026-07-07`]: '14:45',
      [`bl:${f.linkId}:2026-07-08`]: '17:00',
      [`bl:${f.linkId}:2026-07-09`]: '17:00',
      [`bl:${f.linkId}:2026-07-10`]: '17:00',
    });

    // The pickup moves with the day's end.
    await buildMemberTasks(f.db, f.childId);
    const pickupAt = async (day: string) => {
      const ev = (
        await f.db
          .select()
          .from(calendarEvents)
          .where(eq(calendarEvents.synthKey, `bl:${f.linkId}:${day}`))
      )[0]!;
      const pickup = (
        await f.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.calendarEventId, ev.id), eq(tasks.type, 'pickup')))
      )[0]!;
      return pickup.dtstart.toISOString().slice(11, 16);
    };
    expect(await pickupAt('2026-07-07')).toBe('14:45');
    expect(await pickupAt('2026-07-08')).toBe('17:00');

    // Deleting the change puts the link's hours back on the same keys.
    await f.db.delete(linkBaselineChanges).where(eq(linkBaselineChanges.id, change.id));
    const r = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(r.eventsUpserted).toBe(3);
    expect(r.eventsRemoved).toBe(0);
    expect(Object.values(await ends())).toEqual(['14:45', '14:45', '14:45', '14:45', '14:45']);
    await buildMemberTasks(f.db, f.childId);
    expect(await pickupAt('2026-07-08')).toBe('14:45');
  });
});

describe('baseline-change routes', () => {
  /** A date `days` from today (UTC), inside the default synthesis window. */
  const dayFromNow = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  async function routeFixture(email: string, mode: 'exception' | 'standard' = 'exception') {
    const fam = await setupFamily(email);
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          mode,
          url: 'https://feed.example.com/cal.ics',
          // Already synced, so resynthesis doesn't try an ingest.
          lastSyncedAt: new Date(),
        })
        .returning()
    )[0]!;
    const link = (
      await db
        .insert(familyMemberFeeds)
        .values({
          familyId: fam.familyId,
          feedId: feed.id,
          familyMemberId: fam.childId,
          weekdayMask: 127, // every day, so any date lands on a baseline day
          dayStart: '08:30',
          dayEnd: '14:45',
        })
        .returning()
    )[0]!;
    const base = `/families/${fam.familyId}/feeds/${feed.id}/member-links/${link.id}/baseline-changes`;
    return { ...fam, db, feed, link, base };
  }

  const endOn = async (db: Db, linkId: string, day: string) =>
    (
      await db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.synthKey, `bl:${linkId}:${day}`))
    )[0]?.dtend?.toISOString().slice(11, 16);

  it('creates, lists, updates and deletes a change, resynthesizing each time', async () => {
    const f = await routeFixture('baseline-routes@example.com');
    const from = dayFromNow(5);

    const created = await call(
      f.base,
      authed(f.admin.token, { effectiveFrom: from, dayStart: '08:30', dayEnd: '17:00' }),
    );
    expect(created.status).toBe(201);
    const { change } = (await created.json()) as { change: { id: string } };
    expect(await endOn(f.db, f.link.id, dayFromNow(4))).toBe('14:45');
    expect(await endOn(f.db, f.link.id, from)).toBe('17:00');
    expect(await endOn(f.db, f.link.id, dayFromNow(10))).toBe('17:00');

    const list = await call(f.base, bearer(f.admin.token));
    const { changes } = (await list.json()) as { changes: { effectiveFrom: string }[] };
    expect(changes.map((c) => c.effectiveFrom)).toEqual([from]);

    // Same date again → 409.
    const dupe = await call(
      f.base,
      authed(f.admin.token, { effectiveFrom: from, dayStart: '09:00', dayEnd: '15:00' }),
    );
    expect(dupe.status).toBe(409);

    const patchedRes = await call(`${f.base}/${change.id}`, patched(f.admin.token, { dayEnd: '16:30' }));
    expect(patchedRes.status).toBe(200);
    expect(await endOn(f.db, f.link.id, from)).toBe('16:30');

    const del = await call(`${f.base}/${change.id}`, {
      ...bearer(f.admin.token),
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    expect(await endOn(f.db, f.link.id, from)).toBe('14:45');
  });

  it('validates dates and hours, and rejects non-exception feeds', async () => {
    const f = await routeFixture('baseline-routes-invalid@example.com');
    const post = (body: unknown) => call(f.base, authed(f.admin.token, body));

    expect((await post({ effectiveFrom: '2026-02-30', dayStart: '08:30', dayEnd: '17:00' })).status).toBe(400);
    expect((await post({ effectiveFrom: '2026-10-01', dayStart: '8:30', dayEnd: '17:00' })).status).toBe(400);
    const backwards = await post({ effectiveFrom: '2026-10-01', dayStart: '17:00', dayEnd: '08:30' });
    expect(backwards.status).toBe(400);
    expect(await backwards.json()).toEqual({ error: 'day_end_before_start' });

    const s = await routeFixture('baseline-routes-standard@example.com', 'standard');
    const onStandard = await call(
      s.base,
      authed(s.admin.token, { effectiveFrom: '2026-10-01', dayStart: '08:30', dayEnd: '17:00' }),
    );
    expect(onStandard.status).toBe(400);
    expect(await onStandard.json()).toEqual({ error: 'baseline_requires_exception_feed' });
  });
});

describe('synthesis: standard feeds', () => {
  it('passes every occurrence through as an event; never pends', async () => {
    const fam = await setupFamily('synth-std@example.com');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          mode: 'standard',
          url: 'https://feed.example.com/soccer.ics',
        })
        .returning()
    )[0]!;
    await db
      .insert(familyMemberFeeds)
      .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId: fam.childId });

    await insertSource(db, feed, {
      icalUid: 'practice',
      summary: 'Soccer Practice',
      dtstart: new Date('2026-07-08T16:00:00Z'),
      dtend: new Date('2026-07-08T17:00:00Z'),
      allDay: false,
    });
    await insertSource(db, feed, {
      icalUid: 'social',
      summary: 'Team Pizza Night',
      dtstart: new Date('2026-07-10T18:00:00Z'),
      dtend: new Date('2026-07-10T19:00:00Z'),
      allDay: false,
    });

    const result = await synthesizeFeed(db, feed, WINDOW);
    expect(result.pendingOpen).toBe(0);
    const events = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.familyMemberId, fam.childId));
    expect(events.map((e) => e.summary).sort()).toEqual(['Soccer Practice', 'Team Pizza Night']);
    expect(
      await db.select().from(pendingDecisions).where(eq(pendingDecisions.familyId, fam.familyId)),
    ).toHaveLength(0);
  });

  it("carries a source event's geocode through to the tasks it generates", async () => {
    // The reported gap: a calendar input whose events are geocoded upstream
    // produced drop-off/pickup tasks with free text only, so the claimed events
    // mirrored out with nothing for Apple to compute travel time against.
    const fam = await setupFamily('synth-std-geo@example.com');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          mode: 'standard',
          url: 'https://feed.example.com/swim.ics',
        })
        .returning()
    )[0]!;
    await db
      .insert(familyMemberFeeds)
      .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId: fam.childId });

    const geo = { lat: 37.331686, lon: -122.030656, title: 'Rec Center' };
    await insertSource(db, feed, {
      icalUid: 'swim',
      summary: 'Swim lesson',
      location: 'Rec Center',
      locationGeo: geo,
      dtstart: new Date('2026-07-08T16:00:00Z'),
      dtend: new Date('2026-07-08T17:00:00Z'),
      allDay: false,
    });

    await synthesizeFeed(db, feed, WINDOW);
    const events = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.familyMemberId, fam.childId));
    expect(events).toHaveLength(1);
    expect(events[0]!.locationGeo).toEqual(geo);

    await buildMemberTasks(db, fam.childId);
    const generated = await db
      .select()
      .from(tasks)
      .where(eq(tasks.familyMemberId, fam.childId));
    // Default typing is a transition: a drop-off and a pickup, both pinned.
    expect(generated.map((t) => t.type).sort()).toEqual(['dropoff', 'pickup']);
    expect(generated.every((t) => t.locationGeo?.lat === geo.lat)).toBe(true);
  });

  it('resynthesizes idempotently when the window boundary lands inside an already-synthesized event', async () => {
    // Regression: production 500 — an evening event in a negative-UTC-offset
    // zone commonly starts before the UTC day rolls over and ends after
    // (window.start is always a UTC midnight). The source-occurrence query
    // already treats "started before the window but still ongoing at
    // window.start" as in-window; the existing-calendar_events lookup used to
    // check dtstart alone, so on the day the window boundary crossed into the
    // event's span it couldn't find its own already-synthesized row, tried to
    // INSERT a duplicate, and hit the (familyMemberId, synthKey) unique index
    // — crashing the whole feed's synthesis (and the request that triggered it).
    const fam = await setupFamily('synth-std-straddle@example.com');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          mode: 'standard',
          url: 'https://feed.example.com/evening.ics',
        })
        .returning()
    )[0]!;
    await db
      .insert(familyMemberFeeds)
      .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId: fam.childId });

    // Straddles the WINDOW's start (2026-07-06T00:00:00Z): starts the evening
    // before, ends 20 minutes after midnight UTC.
    await insertSource(db, feed, {
      icalUid: 'dentist',
      summary: 'Dentist',
      dtstart: new Date('2026-07-05T23:20:00Z'),
      dtend: new Date('2026-07-06T00:20:00Z'),
      allDay: false,
    });

    const r1 = await synthesizeFeed(db, feed, WINDOW);
    expect(r1.eventsUpserted).toBe(1);

    // Re-running against the same window with unchanged content must be a
    // pure no-op, not a duplicate-key crash.
    await expect(synthesizeFeed(db, feed, WINDOW)).resolves.toMatchObject({
      eventsUpserted: 0,
      eventsRemoved: 0,
    });

    const events = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.familyMemberId, fam.childId));
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe('Dentist');
  });
});

describe('link-rule (override) routes', () => {
  it('rejects override rules on standard feeds; orders inserts; reorders; deletes', async () => {
    // One implicit ingest per feed (standard + exception), triggered by each
    // feed's first member-link creation below.
    fetchMock
      .get('https://f.example.com')
      .intercept({ path: (p: string) => p === '/x.ics' || p === '/e.ics', method: 'GET' })
      .reply(200, EMPTY_ICS, { headers: { 'content-type': 'text/calendar' } })
      .times(2);

    const fam = await setupFamily('rules-routes@example.com');
    const db = getDb(env.DB);
    const standard = (
      await db
        .insert(feeds)
        .values({ familyId: fam.familyId, mode: 'standard', url: 'https://f.example.com/x.ics' })
        .returning()
    )[0]!;
    const stdLink = await call(
      `/families/${fam.familyId}/feeds/${standard.id}/member-links`,
      authed(fam.admin.token, { familyMemberId: fam.childId }),
    );
    const stdLinkId = ((await stdLink.json()) as { link: { id: string } }).link.id;

    // Override rules only apply to exception feeds → 400 on a standard link.
    const bad = await call(
      `/families/${fam.familyId}/feeds/${standard.id}/member-links/${stdLinkId}/rules`,
      authed(fam.admin.token, { matchField: 'summary', matchOp: 'contains', matchValue: 'x', outcome: 'cancel_day' }),
    );
    expect(bad.status).toBe(400);

    // On an exception feed: create + order + reorder + delete.
    const feed = (
      await db
        .insert(feeds)
        .values({ familyId: fam.familyId, mode: 'exception', url: 'https://f.example.com/e.ics' })
        .returning()
    )[0]!;
    const linkRes = await call(
      `/families/${fam.familyId}/feeds/${feed.id}/member-links`,
      authed(fam.admin.token, { familyMemberId: fam.childId, weekdayMask: 31, dayStart: '08:30', dayEnd: '14:45' }),
    );
    const linkId = ((await linkRes.json()) as { link: { id: string } }).link.id;
    const base = `/families/${fam.familyId}/feeds/${feed.id}/member-links/${linkId}/rules`;

    // Invalid regex → 400.
    const badRegex = await call(
      base,
      authed(fam.admin.token, { matchField: 'summary', matchOp: 'regex', matchValue: '(', outcome: 'cancel_day' }),
    );
    expect(badRegex.status).toBe(400);

    const mk = async (matchValue: string, position?: number) => {
      const res = await call(
        base,
        authed(fam.admin.token, {
          matchField: 'summary',
          matchOp: 'contains',
          matchValue,
          outcome: 'cancel_day',
          ...(position !== undefined ? { position } : {}),
        }),
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { rule: { id: string } }).rule;
    };
    const a = await mk('Alpha');
    const b = await mk('Beta');
    const c = await mk('Gamma', 0);

    const listRes = await call(base, { headers: { Authorization: `Bearer ${fam.admin.token}` } });
    let rules = ((await listRes.json()) as { rules: { id: string }[] }).rules;
    expect(rules.map((r) => r.id)).toEqual([c.id, a.id, b.id]);

    const reorder = await call(`${base}/order`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ruleIds: [b.id, c.id, a.id] }),
    });
    expect(reorder.status).toBe(200);
    rules = ((await reorder.json()) as { rules: { id: string }[] }).rules;
    expect(rules.map((r) => r.id)).toEqual([b.id, c.id, a.id]);

    const del = await call(`${base}/${c.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${fam.admin.token}` },
    });
    expect(del.status).toBe(200);
    const after = await call(base, { headers: { Authorization: `Bearer ${fam.admin.token}` } });
    const finalRules = ((await after.json()) as { rules: { id: string; position: number }[] }).rules;
    expect(finalRules.map((r) => [r.id, r.position])).toEqual([
      [b.id, 0],
      [a.id, 1],
    ]);
  });
});
