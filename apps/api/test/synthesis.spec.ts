import { env, fetchMock } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  linkRules,
  pendingDecisions,
  sourceEvents,
} from '@igt/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { authed, call, setupFamily } from './helpers.js';

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
    outcome: 'cancel_day' | 'modify_day' | 'ignore';
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
});

describe('link-rule (override) routes', () => {
  it('rejects override rules on standard feeds; orders inserts; reorders; deletes', async () => {
    // One implicit ingest per feed (standard + exception), triggered by each
    // feed's first member-link creation below.
    fetchMock
      .get('https://f')
      .intercept({ path: (p: string) => p === '/x.ics' || p === '/e.ics', method: 'GET' })
      .reply(200, EMPTY_ICS, { headers: { 'content-type': 'text/calendar' } })
      .times(2);

    const fam = await setupFamily('rules-routes@example.com');
    const db = getDb(env.DB);
    const standard = (
      await db
        .insert(feeds)
        .values({ familyId: fam.familyId, mode: 'standard', url: 'https://f/x.ics' })
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
        .values({ familyId: fam.familyId, mode: 'exception', url: 'https://f/e.ics' })
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
