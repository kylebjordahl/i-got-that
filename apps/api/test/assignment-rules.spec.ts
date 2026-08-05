import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { hashCalendarEvent } from '../src/services/synthesis.js';
import { authed, bearer, call, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

// 2026-07-06 is a Monday (weekdayBit 0 → mask bit 1).
const MONDAY = new Date('2026-07-06T15:30:00Z');

async function linkedFeed(db: Db, familyId: string, childId: string) {
  const feed = (
    await db
      .insert(feeds)
      .values({ familyId, mode: 'standard', url: 'https://f/c.ics', sourceCalendarName: 'Soccer' })
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

async function insertEvent(db: Db, familyId: string, memberId: string, linkId: string, when: Date, synthKey: string) {
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
  return db.select().from(tasks).where(eq(tasks.calendarEventId, eventId));
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
      expect(t.ownerMemberId).toBe(fam.adminMemberId);
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
