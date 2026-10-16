import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  memberCalendars,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { hashCalendarEvent } from '../src/services/synthesis.js';
import { withOwners } from '../src/services/task-owners.js';
import { authed, bearer, call, pinClockTo, setupFamily } from './helpers.js';

// The fixtures are on 2026-07-06; a rule change only rebuilds events on the
// active horizon around "now".
pinClockTo('2026-07-06T12:00:00Z');

type Db = ReturnType<typeof getDb>;

// 2026-07-06 is a Monday (weekdayBit 0 → mask bit 1).
const MONDAY = new Date('2026-07-06T15:30:00Z');

async function linkedFeed(db: Db, familyId: string, childId: string, timezone: string | null = null) {
  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId,
        mode: 'standard',
        url: 'https://f/c.ics',
        sourceCalendarName: 'Soccer',
        timezone,
      })
      .returning()
  )[0]!;
  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({ familyId, feedId: feed.id, familyMemberId: childId })
      .returning()
  )[0]!;
  return { feed, link };
}

async function insertEvent(
  db: Db,
  familyId: string,
  memberId: string,
  linkId: string | null,
  when: Date,
  synthKey: string,
) {
  const payload = {
    dtstart: when,
    dtend: new Date(when.getTime() + 90 * 60_000),
    allDay: false,
    summary: 'Practice',
    location: null,
    description: null,
  };
  return (
    await db
      .insert(calendarEvents)
      .values({
        familyId,
        familyMemberId: memberId,
        provenance: 'synthesized',
        contentHash: hashCalendarEvent(payload),
        ...payload,
        synthKey,
        linkId,
      })
      .returning()
  )[0]!;
}

async function childTasks(db: Db, eventId: string) {
  return withOwners(db, await db.select().from(tasks).where(eq(tasks.calendarEventId, eventId)));
}

async function claimEventsFor(db: Db, familyId: string, ownerId: string) {
  return db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.familyId, familyId),
        eq(calendarEvents.familyMemberId, ownerId),
        eq(calendarEvents.provenance, 'claimed_task'),
      ),
    );
}

describe('assignment-rule pipeline (issue #24)', () => {
  it('auto-claims matching tasks for the owner and writes claim events', async () => {
    const fam = await setupFamily('ar-claim@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    const event = await insertEvent(db, fam.familyId, fam.childId, link.id, MONDAY, 'ev:l:mon');
    const base = `/families/${fam.familyId}/assignment-rules`;

    // A Monday rule: admin caretaker handles all of the child's Monday tasks.
    const create = await call(
      base,
      authed(fam.admin.token, {
        ownerMemberId: fam.adminMemberId,
        aboutMemberId: fam.childId,
        weekdayMask: 1, // Monday
      }),
    );
    expect(create.status).toBe(201);

    const rows = await childTasks(db, event.id);
    expect(rows.map((t) => t.type).sort()).toEqual(['dropoff', 'pickup']);
    for (const t of rows) {
      expect(t.status).toBe('owned');
      expect(t.ownerMemberIds).toEqual([fam.adminMemberId]);
      expect(t.autoAssignedRuleId).toBeTruthy();
    }
    // The claim recursion mirrored both onto the owner's calendar.
    const claims = await claimEventsFor(db, fam.familyId, fam.adminMemberId);
    expect(claims.length).toBe(2);
  });

  it('does not claim tasks on a non-matching weekday', async () => {
    const fam = await setupFamily('ar-noday@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    const event = await insertEvent(db, fam.familyId, fam.childId, link.id, MONDAY, 'ev:l:mon2');

    await call(
      `/families/${fam.familyId}/assignment-rules`,
      authed(fam.admin.token, {
        ownerMemberId: fam.adminMemberId,
        weekdayMask: 2, // Tuesday only — the event is a Monday
      }),
    );

    const rows = await childTasks(db, event.id);
    expect(rows.length).toBe(2);
    for (const t of rows) expect(t.status).toBe('unowned');
  });

  // A rule's weekday is the day the family lives the event on, which is the
  // local date in the feed's zone — not the UTC date of the stored instant.
  describe('weekday is read in local time, not UTC (issue #261)', () => {
    // Mon 2026-07-06 18:00 PDT, stored as Tue 2026-07-07 01:00Z.
    const MONDAY_EVENING_PT = new Date('2026-07-07T01:00:00Z');

    it('a Monday rule claims the pickup of a Monday 6pm PDT event from a Pacific feed', async () => {
      const fam = await setupFamily('ar-tz-mon@example.com');
      const db = getDb(env.DB);
      const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'America/Los_Angeles');
      const event = await insertEvent(db, fam.familyId, fam.childId, link.id, MONDAY_EVENING_PT, 'ev:l:tz-mon');

      const create = await call(
        `/families/${fam.familyId}/assignment-rules`,
        authed(fam.admin.token, {
          ownerMemberId: fam.adminMemberId,
          aboutMemberId: fam.childId,
          taskType: 'pickup',
          weekdayMask: 1, // Monday
        }),
      );
      expect(create.status).toBe(201);

      const pickup = (await childTasks(db, event.id)).find((t) => t.type === 'pickup')!;
      expect(pickup.status).toBe('owned');
      expect(pickup.ownerMemberIds).toEqual([fam.adminMemberId]);
      expect(pickup.autoAssignedRuleId).toBeTruthy();
    });

    it('a Tuesday rule (the UTC weekday of the stored instant) does not claim it', async () => {
      const fam = await setupFamily('ar-tz-tue@example.com');
      const db = getDb(env.DB);
      const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'America/Los_Angeles');
      const event = await insertEvent(db, fam.familyId, fam.childId, link.id, MONDAY_EVENING_PT, 'ev:l:tz-tue');

      await call(
        `/families/${fam.familyId}/assignment-rules`,
        authed(fam.admin.token, { ownerMemberId: fam.adminMemberId, weekdayMask: 2 }), // Tuesday
      );

      const rows = await childTasks(db, event.id);
      expect(rows.length).toBe(2);
      for (const t of rows) expect(t.status).toBe('unowned');
    });

    it('a feed with no zone falls back to the member calendar zone for its events', async () => {
      const fam = await setupFamily('ar-tz-member@example.com');
      const db = getDb(env.DB);
      await db.insert(memberCalendars).values({
        familyId: fam.familyId,
        familyMemberId: fam.childId,
        targetMethod: 'google',
        targetCalendarId: 'kid-calendar-id',
        timezone: 'America/Los_Angeles',
      });
      // The member's own direct-calendar event (no source link) and one from a
      // zoneless feed both read in the member calendar's zone.
      const { link } = await linkedFeed(db, fam.familyId, fam.childId);
      const direct = await insertEvent(db, fam.familyId, fam.childId, null, MONDAY_EVENING_PT, 'ext:tz-direct');
      const viaFeed = await insertEvent(db, fam.familyId, fam.childId, link.id, MONDAY_EVENING_PT, 'ev:l:tz-zoneless');

      await call(
        `/families/${fam.familyId}/assignment-rules`,
        authed(fam.admin.token, { ownerMemberId: fam.adminMemberId, weekdayMask: 1 }), // Monday
      );

      // (A direct-calendar event defaults to one attendance task, a feed event to
      // a drop-off + pickup pair.)
      for (const event of [direct, viaFeed]) {
        const rows = await childTasks(db, event.id);
        expect(rows.length).toBeGreaterThan(0);
        for (const t of rows) expect(t.status).toBe('owned');
      }
    });
  });

  it('a manual unassign wins and survives a later rebuild', async () => {
    const fam = await setupFamily('ar-manual@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    const event = await insertEvent(db, fam.familyId, fam.childId, link.id, MONDAY, 'ev:l:mon3');
    const base = `/families/${fam.familyId}/assignment-rules`;

    const create = await call(
      base,
      authed(fam.admin.token, { ownerMemberId: fam.adminMemberId, weekdayMask: 1 }),
    );
    const ruleId = ((await create.json()) as { rule: { id: string } }).rule.id;

    // Manually release one of the auto-claimed tasks.
    const [dropoff] = await childTasks(db, event.id);
    const unassign = await call(
      `/families/${fam.familyId}/tasks/${dropoff!.id}/unassign`,
      authed(fam.admin.token),
    );
    expect(unassign.status).toBe(200);

    // Force a rebuild by editing the rule; the human action must stick.
    await call(`${base}/${ruleId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cadenceWeeks: 1 }),
    });

    const after = (await childTasks(db, event.id)).find((t) => t.id === dropoff!.id)!;
    expect(after.status).toBe('unowned');
    expect(after.manualOwnerOverride).toBe(true);
    expect(after.autoAssignedRuleId).toBeNull();
  });

  it('deleting a rule releases its rule-owned tasks', async () => {
    const fam = await setupFamily('ar-delete@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    const event = await insertEvent(db, fam.familyId, fam.childId, link.id, MONDAY, 'ev:l:mon4');
    const base = `/families/${fam.familyId}/assignment-rules`;

    const create = await call(
      base,
      authed(fam.admin.token, { ownerMemberId: fam.adminMemberId, weekdayMask: 1 }),
    );
    const ruleId = ((await create.json()) as { rule: { id: string } }).rule.id;
    expect((await childTasks(db, event.id)).every((t) => t.status === 'owned')).toBe(true);

    const del = await call(`${base}/${ruleId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${fam.admin.token}` },
    });
    expect(del.status).toBe(200);

    const rows = await childTasks(db, event.id);
    for (const t of rows) {
      expect(t.status).toBe('unowned');
      expect(t.autoAssignedRuleId).toBeNull();
    }
    expect((await claimEventsFor(db, fam.familyId, fam.adminMemberId)).length).toBe(0);
  });

  it('rejects a non-caretaker owner and non-admin mutations', async () => {
    const fam = await setupFamily('ar-authz@example.com');
    const base = `/families/${fam.familyId}/assignment-rules`;

    // The child is not a caretaker → cannot be an owner.
    const badOwner = await call(
      base,
      authed(fam.admin.token, { ownerMemberId: fam.childId, weekdayMask: 1 }),
    );
    expect(badOwner.status).toBe(400);

    // An outsider admin cannot mutate this family's rules.
    const other = await setupFamily('ar-authz-other@example.com');
    const forbidden = await call(
      base,
      authed(other.admin.token, { ownerMemberId: other.adminMemberId, weekdayMask: 1 }),
    );
    expect(forbidden.status).toBe(403);
  });
});
