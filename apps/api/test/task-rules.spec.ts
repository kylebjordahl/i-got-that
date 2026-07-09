import { env } from 'cloudflare:test';
import {
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

async function insertEvent(db: Db, familyId: string, memberId: string, linkId: string | null, summary: string, synthKey: string) {
  const payload = {
    dtstart: new Date('2026-07-06T15:30:00Z'),
    dtend: new Date('2026-07-06T21:45:00Z'),
    allDay: false,
    summary,
    location: null,
    description: null,
  };
  return (
    await db
      .insert(calendarEvents)
      .values({
        familyId,
        familyMemberId: memberId,
        provenance: linkId ? 'synthesized' : 'human',
        contentHash: hashCalendarEvent(payload),
        ...payload,
        synthKey,
        linkId,
      })
      .returning()
  )[0]!;
}

describe('task-rule pipeline (6k/6n)', () => {
  it('CRUD + reorder + a change re-types existing tasks', async () => {
    const fam = await setupFamily('tr-crud@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    const base = `/families/${fam.familyId}/members/${fam.childId}/task-rules`;

    // An event that, by default (unified/link default = transition here? no —
    // the standard link's default is 'transition'), generates a transition.
    const event = await insertEvent(db, fam.familyId, fam.childId, link.id, 'Field trip to museum', 'ev:l:ft');

    // List: no rules yet, defaults present.
    const list0 = await call(base, bearer(fam.admin.token));
    const body0 = (await list0.json()) as { rules: unknown[]; defaults: { links: Record<string, unknown> } };
    expect(body0.rules).toHaveLength(0);
    expect(Object.keys(body0.defaults.links)).toContain(link.id);

    // Create a this-calendar rule → attendance for field trips.
    const create = await call(
      base,
      authed(fam.admin.token, {
        linkId: link.id,
        scope: 'this_calendar',
        matchValue: '/field trip/i',
        resultType: 'attendance',
      }),
    );
    expect(create.status).toBe(201);
    const ruleId = ((await create.json()) as { rule: { id: string } }).rule.id;

    // The rule re-typed the existing event's tasks to attendance.
    let taskRows = await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id));
    expect(taskRows.map((t) => t.type)).toEqual(['attendance']);

    // A second, all-calendars rule; then reorder.
    const create2 = await call(
      base,
      authed(fam.admin.token, {
        scope: 'all_calendars',
        matchValue: '/early/i',
        resultType: 'transition',
        dropoffWindowMin: 20,
        pickupWindowMin: 10,
      }),
    );
    const rule2Id = ((await create2.json()) as { rule: { id: string } }).rule.id;

    const reorder = await call(`${base}/order`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ruleIds: [rule2Id, ruleId] }),
    });
    expect(reorder.status).toBe(200);
    const reordered = ((await reorder.json()) as { rules: { id: string }[] }).rules;
    expect(reordered.map((r) => r.id)).toEqual([rule2Id, ruleId]);

    // Update the first rule's result; delete the second.
    const patch = await call(`${base}/${ruleId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ resultType: 'transition' }),
    });
    expect(patch.status).toBe(200);
    taskRows = await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id));
    expect(taskRows.map((t) => t.type).sort()).toEqual(['dropoff', 'pickup']);

    const del = await call(`${base}/${rule2Id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${fam.admin.token}` },
    });
    expect(del.status).toBe(200);
  });

  it('setting a calendar default re-types unmatched events', async () => {
    const fam = await setupFamily('tr-default@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    const event = await insertEvent(db, fam.familyId, fam.childId, link.id, 'Regular practice', 'ev:l:rp');

    // Default starts at transition → drop-off + pickup.
    await call(
      `/families/${fam.familyId}/members/${fam.childId}/task-rules`,
      authed(fam.admin.token, { linkId: link.id, resultType: 'attendance', matchValue: '/never-matches-zz/' }),
    ).then((r) => r.json());
    // (that rule won't match; flip the default instead)
    const setDefault = await call(`/families/${fam.familyId}/members/${fam.childId}/task-default`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ linkId: link.id, defaultResultType: 'attendance' }),
    });
    expect(setDefault.status).toBe(200);

    const taskRows = await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id));
    expect(taskRows.map((t) => t.type)).toEqual(['attendance']);
  });

  it('non-admins cannot mutate task rules', async () => {
    const fam = await setupFamily('tr-authz@example.com');
    const other = await setupFamily('tr-authz-other@example.com');
    const res = await call(
      `/families/${fam.familyId}/members/${fam.childId}/task-rules`,
      authed(other.admin.token, { resultType: 'attendance', matchValue: '/x/' }),
    );
    expect(res.status).toBe(403);
  });
});
