import { env } from 'cloudflare:test';
import {
  calendarEvents,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  pendingDecisions,
  sourceEvents,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { authed, bearer, call, setupFamily } from './helpers.js';

const WINDOW = {
  windowStart: new Date('2026-07-06T00:00:00Z'),
  windowEnd: new Date('2026-07-13T00:00:00Z'),
};

async function fixtureWithPending(email: string) {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        mode: 'exception',
        url: 'https://feed.example.com/cal.ics',
        timezone: 'UTC',
      })
      .returning()
  )[0]!;
  await db.insert(familyMemberFeeds).values({
    familyId: fam.familyId,
    feedId: feed.id,
    familyMemberId: fam.childId,
    weekdayMask: 31,
    dayStart: '08:30',
    dayEnd: '14:45',
    generatesTypes: ['dropoff', 'pickup'],
  });
  const source = (
    await db
      .insert(sourceEvents)
      .values({
        feedId: feed.id,
        familyId: fam.familyId,
        icalUid: 'bookfair',
        recurrenceId: '',
        summary: 'Book Fair',
        location: 'Gymnasium',
        dtstart: new Date('2026-07-07T17:00:00Z'),
        dtend: new Date('2026-07-07T19:00:00Z'),
        allDay: false,
        contentHash: 'v1',
      })
      .returning()
  )[0]!;
  await synthesizeFeed(db, feed, WINDOW);
  const decision = (
    await db
      .select()
      .from(pendingDecisions)
      .where(eq(pendingDecisions.sourceEventId, source.id))
  )[0]!;
  return { ...fam, db, feed, source, decision };
}

describe('pending decisions', () => {
  it('lists open decisions with the source event payload', async () => {
    const f = await fixtureWithPending('pd-list@example.com');
    const res = await call(`/families/${f.familyId}/pending-decisions`, bearer(f.admin.token));
    expect(res.status).toBe(200);
    const { decisions } = (await res.json()) as {
      decisions: { id: string; summary: string; location: string; familyMemberId: string }[];
    };
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      id: f.decision.id,
      summary: 'Book Fair',
      location: 'Gymnasium',
      familyMemberId: f.childId,
    });
  });

  it('resolve creates a synthesized event with the chosen types and generates its tasks', async () => {
    const f = await fixtureWithPending('pd-resolve@example.com');
    const res = await call(
      `/families/${f.familyId}/pending-decisions/${f.decision.id}/resolve`,
      authed(f.admin.token, { types: ['attendance'], defaultAttendance: 'both' }),
    );
    expect(res.status).toBe(200);

    const event = (
      await f.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.pendingDecisionId, f.decision.id))
    )[0]!;
    expect(event).toMatchObject({
      provenance: 'synthesized',
      synthKey: `pd:${f.decision.id}`,
      summary: 'Book Fair',
      generatesTypes: ['attendance'],
      defaultAttendance: 'both',
      familyMemberId: f.childId,
    });

    const generated = await f.db
      .select()
      .from(tasks)
      .where(eq(tasks.calendarEventId, event.id));
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ type: 'attendance', attendanceRequirement: 'both' });

    const after = (
      await f.db
        .select()
        .from(pendingDecisions)
        .where(eq(pendingDecisions.id, f.decision.id))
    )[0]!;
    expect(after.status).toBe('resolved');
    expect(after.resolvedTypes).toEqual(['attendance']);
    expect(after.resolvedByMemberId).toBe(f.adminMemberId);

    // Resolving twice is rejected; the decision no longer lists.
    const again = await call(
      `/families/${f.familyId}/pending-decisions/${f.decision.id}/resolve`,
      authed(f.admin.token, { types: ['pickup'] }),
    );
    expect(again.status).toBe(409);
    const list = await call(`/families/${f.familyId}/pending-decisions`, bearer(f.admin.token));
    expect(((await list.json()) as { decisions: unknown[] }).decisions).toHaveLength(0);

    // A resynthesis with unchanged content leaves the resolution alone.
    await synthesizeFeed(f.db, f.feed, WINDOW);
    expect(
      await f.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.pendingDecisionId, f.decision.id)),
    ).toHaveLength(1);
  });

  it('resolve honors start-time/duration adjustments (wall clock in the feed tz)', async () => {
    const f = await fixtureWithPending('pd-adjust@example.com');
    const res = await call(
      `/families/${f.familyId}/pending-decisions/${f.decision.id}/resolve`,
      authed(f.admin.token, { types: ['pickup'], startTime: '15:30', durationMinutes: 45 }),
    );
    expect(res.status).toBe(200);
    const event = (
      await f.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.pendingDecisionId, f.decision.id))
    )[0]!;
    expect(event.dtstart.toISOString()).toBe('2026-07-07T15:30:00.000Z');
    expect(event.dtend!.toISOString()).toBe('2026-07-07T16:15:00.000Z');
  });

  it('a reopened decision (source content changed) drops the stale resolution event', async () => {
    const f = await fixtureWithPending('pd-reopen@example.com');
    await call(
      `/families/${f.familyId}/pending-decisions/${f.decision.id}/resolve`,
      authed(f.admin.token, { types: ['attendance'] }),
    );
    await f.db
      .update(sourceEvents)
      .set({ summary: 'Book Fair — moved', contentHash: 'v2' })
      .where(eq(sourceEvents.id, f.source.id));
    await synthesizeFeed(f.db, f.feed, WINDOW);

    const decision = (
      await f.db
        .select()
        .from(pendingDecisions)
        .where(eq(pendingDecisions.id, f.decision.id))
    )[0]!;
    expect(decision.status).toBe('pending');
    expect(
      await f.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.pendingDecisionId, f.decision.id)),
    ).toHaveLength(0);
  });

  it('dismiss keeps the event off the calendar and 409s on double-dismiss', async () => {
    const f = await fixtureWithPending('pd-dismiss@example.com');
    const res = await call(
      `/families/${f.familyId}/pending-decisions/${f.decision.id}/dismiss`,
      authed(f.admin.token),
    );
    expect(res.status).toBe(200);
    expect(
      await f.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.pendingDecisionId, f.decision.id)),
    ).toHaveLength(0);
    const again = await call(
      `/families/${f.familyId}/pending-decisions/${f.decision.id}/dismiss`,
      authed(f.admin.token),
    );
    expect(again.status).toBe(409);
  });
});
