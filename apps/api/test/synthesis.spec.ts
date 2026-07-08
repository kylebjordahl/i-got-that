import { env } from 'cloudflare:test';
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
import { describe, expect, it } from 'vitest';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { authed, call, setupFamily } from './helpers.js';

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
        generatesTypes: ['dropoff', 'pickup'],
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
    outcome: 'cancel_day' | 'modify_day' | 'annotate' | 'set_event';
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

describe('synthesis: exception feeds', () => {
  it('expands the baseline into calendar events and applies cancel/modify/annotate rules', async () => {
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
      matchValue: 'Photos',
      outcome: 'annotate',
      params: { text: 'Photo Day' },
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
      icalUid: 'photos',
      summary: 'School Photos',
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
    // Tuesday cancelled; Mon/Wed/Thu/Fri remain.
    expect(byKey.has(`bl:${f.linkId}:2026-07-07`)).toBe(false);
    expect(events).toHaveLength(4);

    const mon = byKey.get(`bl:${f.linkId}:2026-07-06`)!;
    expect(mon.summary).toBe('Lincoln Elementary');
    expect(mon.provenance).toBe('synthesized');
    expect(mon.generatesTypes).toEqual(['dropoff', 'pickup']);
    expect(mon.dtstart.toISOString()).toBe('2026-07-06T08:30:00.000Z');
    expect(mon.dtend!.toISOString()).toBe('2026-07-06T14:45:00.000Z');

    const wed = byKey.get(`bl:${f.linkId}:2026-07-08`)!;
    expect(wed.dtend!.toISOString()).toBe('2026-07-08T12:00:00.000Z');

    const thu = byKey.get(`bl:${f.linkId}:2026-07-09`)!;
    expect(thu.annotation).toBe('Photo Day');
  });

  it('resynthesizes idempotently: rerun is a no-op, a rule change heals without duplicating', async () => {
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

    // Removing the cancel rule reinstates Tuesday — still no duplicates — and
    // the now-unmatched occurrence surfaces as a pending decision.
    await f.db.delete(linkRules).where(eq(linkRules.id, cancel.id));
    const r3 = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(r3.pendingOpen).toBe(1);
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
    // The baseline still stands on that day (never guess ≠ block the day).
    const tue = await f.db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.familyMemberId, f.childId),
          eq(calendarEvents.synthKey, `bl:${f.linkId}:2026-07-07`),
        ),
      );
    expect(tue).toHaveLength(1);

    // Dismiss it; a rerun with unchanged content stays dismissed.
    const dis = await call(
      `/families/${f.familyId}/pending-decisions/${decision.id}/dismiss`,
      authed(f.admin.token),
    );
    expect(dis.status).toBe(200);
    const r2 = await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(r2.pendingOpen).toBe(0);

    // Content change reopens the decision.
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

  it('cleans up a pending decision once a rule handles its occurrence', async () => {
    const f = await exceptionFixture('synth-pending-cleanup@example.com');
    const source = await insertSource(f.db, f.feed, {
      icalUid: 'assembly',
      summary: 'All-School Assembly',
    });
    await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(
      await f.db
        .select()
        .from(pendingDecisions)
        .where(eq(pendingDecisions.sourceEventId, source.id)),
    ).toHaveLength(1);

    await insertRule(f.db, f, {
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Assembly',
      outcome: 'annotate',
      params: { text: 'Assembly' },
    });
    await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(
      await f.db
        .select()
        .from(pendingDecisions)
        .where(eq(pendingDecisions.sourceEventId, source.id)),
    ).toHaveLength(0);
  });
});

describe('synthesis: standard feeds', () => {
  it('passes events through, applies rules, never pends', async () => {
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
    const link = (
      await db
        .insert(familyMemberFeeds)
        .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId: fam.childId })
        .returning()
    )[0]!;
    await insertRule(db, { familyId: fam.familyId, linkId: link.id }, {
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Practice',
      outcome: 'set_event',
      generatesTypes: ['pickup', 'dropoff'],
    });

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
    expect(events).toHaveLength(2);
    const practice = events.find((e) => e.summary === 'Soccer Practice')!;
    expect(practice.generatesTypes).toEqual(['pickup', 'dropoff']);
    const social = events.find((e) => e.summary === 'Team Pizza Night')!;
    expect(social.generatesTypes).toBeNull(); // convertible-attendance default downstream
    expect(
      await db.select().from(pendingDecisions).where(eq(pendingDecisions.familyId, fam.familyId)),
    ).toHaveLength(0);
  });
});

describe('link-rule routes', () => {
  it('validates outcomes against feed mode, orders inserts, and reorders the pipeline', async () => {
    const fam = await setupFamily('rules-routes@example.com');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          mode: 'standard',
          url: 'https://feed.example.com/x.ics',
        })
        .returning()
    )[0]!;
    const linkRes = await call(
      `/families/${fam.familyId}/feeds/${feed.id}/member-links`,
      authed(fam.admin.token, { familyMemberId: fam.childId }),
    );
    expect(linkRes.status).toBe(201);
    const { link } = (await linkRes.json()) as { link: { id: string } };
    const base = `/families/${fam.familyId}/feeds/${feed.id}/member-links/${link.id}/rules`;

    // Baseline-only outcome on a standard link → 400.
    const bad = await call(
      base,
      authed(fam.admin.token, {
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'Closed',
        outcome: 'cancel_day',
      }),
    );
    expect(bad.status).toBe(400);

    // Invalid regex → 400 from the domain validator.
    const badRegex = await call(
      base,
      authed(fam.admin.token, {
        matchField: 'summary',
        matchOp: 'regex',
        matchValue: '(',
        outcome: 'annotate',
        params: { text: 'x' },
      }),
    );
    expect(badRegex.status).toBe(400);

    // Two rules; insert a third at position 0 and confirm shifting.
    const mk = async (matchValue: string, position?: number) => {
      const res = await call(
        base,
        authed(fam.admin.token, {
          matchField: 'summary',
          matchOp: 'contains',
          matchValue,
          outcome: 'annotate',
          params: { text: matchValue },
          ...(position !== undefined ? { position } : {}),
        }),
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { rule: { id: string; position: number } }).rule;
    };
    const a = await mk('Alpha');
    const b = await mk('Beta');
    const c = await mk('Gamma', 0);
    expect(c.position).toBe(0);

    const listRes = await call(base, { headers: { Authorization: `Bearer ${fam.admin.token}` } });
    let rules = ((await listRes.json()) as { rules: { id: string; position: number }[] }).rules;
    expect(rules.map((r) => r.id)).toEqual([c.id, a.id, b.id]);

    // Reorder must include every id exactly once.
    const badOrder = await call(`${base}/order`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ruleIds: [a.id] }),
    });
    expect(badOrder.status).toBe(400);

    const reorder = await call(`${base}/order`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ruleIds: [b.id, c.id, a.id] }),
    });
    expect(reorder.status).toBe(200);
    rules = ((await reorder.json()) as { rules: { id: string; position: number }[] }).rules;
    expect(rules.map((r) => r.id)).toEqual([b.id, c.id, a.id]);

    // Delete the middle rule; positions close the gap.
    const del = await call(`${base}/${c.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${fam.admin.token}` },
    });
    expect(del.status).toBe(200);
    const after = await call(base, { headers: { Authorization: `Bearer ${fam.admin.token}` } });
    rules = ((await after.json()) as { rules: { id: string; position: number }[] }).rules;
    expect(rules.map((r) => [r.id, r.position])).toEqual([
      [b.id, 0],
      [a.id, 1],
    ]);
  });
});
