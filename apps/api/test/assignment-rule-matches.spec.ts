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
import { buildMemberTasks } from '../src/services/task-gen.js';
import { withOwners } from '../src/services/task-owners.js';
import { authed, bearer, call, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

const DAY = 86_400_000;
const MONDAY_BIT = 1;
const TUESDAY_BIT = 2;

/** The UTC Monday at least `minDays` ahead, at 15:30Z (no feed zone ⇒ UTC). */
function mondayAfter(minDays: number): Date {
  const d = new Date(Date.now() + minDays * DAY);
  d.setUTCHours(15, 30, 0, 0);
  while (d.getUTCDay() !== 1) d.setTime(d.getTime() + DAY);
  return d;
}

async function insertEvent(
  db: Db,
  familyId: string,
  memberId: string,
  linkId: string,
  when: Date,
  summary: string,
) {
  const payload = {
    dtstart: when,
    dtend: new Date(when.getTime() + 90 * 60_000),
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
        provenance: 'synthesized',
        contentHash: hashCalendarEvent(payload),
        ...payload,
        synthKey: `ev:${linkId}:${summary}:${when.toISOString()}`,
        linkId,
      })
      .returning()
  )[0]!;
}

async function taskOf(db: Db, eventId: string, type: string) {
  const rows = await withOwners(
    db,
    await db.select().from(tasks).where(eq(tasks.calendarEventId, eventId)),
  );
  return rows.find((t) => t.type === type)!;
}

type Match = {
  task: { id: string; type: string; ownerMemberIds: string[] };
  event: { id: string };
  status: 'applies' | 'shadowed' | 'omitted' | 'held';
  decidedByRuleId: string | null;
};

async function fixture(email: string) {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const partnerRes = await call(
    `/families/${fam.familyId}/members`,
    authed(fam.admin.token, { relationName: 'partner', isCaretaker: true }),
  );
  const partnerId = ((await partnerRes.json()) as { member: { id: string } }).member.id;
  const feed = (
    await db
      .insert(feeds)
      .values({ familyId: fam.familyId, mode: 'standard', url: 'https://f/s.ics' })
      .returning()
  )[0]!;
  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId: fam.childId })
      .returning()
  )[0]!;
  const mon = mondayAfter(1);
  const ev = {
    mon: await insertEvent(db, fam.familyId, fam.childId, link.id, mon, 'Practice'),
    tue: await insertEvent(db, fam.familyId, fam.childId, link.id, new Date(mon.getTime() + DAY), 'Practice'),
    nextMon: await insertEvent(db, fam.familyId, fam.childId, link.id, new Date(mon.getTime() + 7 * DAY), 'Practice'),
    farMon: await insertEvent(db, fam.familyId, fam.childId, link.id, new Date(mon.getTime() + 42 * DAY), 'Practice'),
  };
  await buildMemberTasks(db, fam.childId);
  const base = `/families/${fam.familyId}/assignment-rules`;
  return { fam, db, partnerId, link, ev, base };
}

async function createRule(base: string, token: string, body: Record<string, unknown>) {
  const res = await call(base, authed(token, body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { rule: { id: string } }).rule.id;
}

async function matchesOf(base: string, token: string, ruleId: string) {
  const res = await call(`${base}/${ruleId}/matches`, bearer(token));
  expect(res.status).toBe(200);
  return ((await res.json()) as { matches: Match[] }).matches;
}

describe('an assignment rule’s match list', () => {
  it('lists the tasks its filters match, and whether it claims each', async () => {
    const { fam, db, partnerId, ev, base } = await fixture('arm-list@example.com');
    const dropoffs = await createRule(base, fam.admin.token, {
      ownerMemberId: partnerId,
      aboutMemberId: fam.childId,
      taskType: 'dropoff',
    });
    const mondays = await createRule(base, fam.admin.token, {
      ownerMemberId: fam.adminMemberId,
      aboutMemberId: fam.childId,
      weekdayMask: MONDAY_BIT,
    });
    // A person reassigns next Monday's pickup by hand: rules leave it alone.
    const held = await taskOf(db, ev.nextMon.id, 'pickup');
    expect(
      (
        await call(
          `/families/${fam.familyId}/tasks/${held.id}/assign`,
          authed(fam.admin.token, { memberId: partnerId }),
        )
      ).status,
    ).toBe(200);

    const matches = await matchesOf(base, fam.admin.token, mondays);
    // Both Mondays' drop-off + pickup, in date order; Tuesday doesn't match the
    // weekday and the Monday six weeks out is outside the window.
    expect(matches.map((m) => [m.event.id, m.task.type, m.status])).toEqual(
      expect.arrayContaining([
        [ev.mon.id, 'dropoff', 'shadowed'],
        [ev.mon.id, 'pickup', 'applies'],
        [ev.nextMon.id, 'dropoff', 'shadowed'],
        [ev.nextMon.id, 'pickup', 'held'],
      ]),
    );
    expect(matches).toHaveLength(4);
    const monDropoff = matches.find((m) => m.event.id === ev.mon.id && m.task.type === 'dropoff')!;
    expect(monDropoff.decidedByRuleId).toBe(dropoffs);
    expect(monDropoff.task.ownerMemberIds).toEqual([partnerId]);
    const monPickup = matches.find((m) => m.event.id === ev.mon.id && m.task.type === 'pickup')!;
    expect(monPickup.task.ownerMemberIds).toEqual([fam.adminMemberId]);
  });

  it('omitting a task releases it from the rule, and restoring re-claims it', async () => {
    const { fam, db, partnerId, ev, base } = await fixture('arm-omit@example.com');
    const mondays = await createRule(base, fam.admin.token, {
      ownerMemberId: fam.adminMemberId,
      weekdayMask: MONDAY_BIT,
    });
    const everything = await createRule(base, fam.admin.token, { ownerMemberId: partnerId });
    expect((await taskOf(db, ev.mon.id, 'pickup')).ownerMemberIds).toEqual([fam.adminMemberId]);

    const omit = await call(
      `${base}/${mondays}/exceptions`,
      authed(fam.admin.token, { calendarEventId: ev.mon.id, taskType: 'pickup' }),
    );
    expect(omit.status).toBe(201);
    // Falls to the next matching rule; the drop-off and next Monday are untouched.
    const pickup = await taskOf(db, ev.mon.id, 'pickup');
    expect(pickup.ownerMemberIds).toEqual([partnerId]);
    expect(pickup.autoAssignedRuleId).toBe(everything);
    expect((await taskOf(db, ev.mon.id, 'dropoff')).ownerMemberIds).toEqual([fam.adminMemberId]);
    expect((await taskOf(db, ev.nextMon.id, 'pickup')).ownerMemberIds).toEqual([fam.adminMemberId]);

    const listed = (await matchesOf(base, fam.admin.token, mondays)).find(
      (m) => m.event.id === ev.mon.id && m.task.type === 'pickup',
    );
    expect(listed).toMatchObject({ status: 'omitted', decidedByRuleId: everything });

    const restore = await call(`${base}/${mondays}/exceptions/${ev.mon.id}/pickup`, {
      ...bearer(fam.admin.token),
      method: 'DELETE',
    });
    expect(restore.status).toBe(200);
    expect((await taskOf(db, ev.mon.id, 'pickup')).ownerMemberIds).toEqual([fam.adminMemberId]);
  });

  it('with no other rule, an omitted task goes back to the queue', async () => {
    const { fam, db, ev, base } = await fixture('arm-omit-queue@example.com');
    const mondays = await createRule(base, fam.admin.token, {
      ownerMemberId: fam.adminMemberId,
      weekdayMask: MONDAY_BIT,
    });
    await call(
      `${base}/${mondays}/exceptions`,
      authed(fam.admin.token, { calendarEventId: ev.mon.id, taskType: 'dropoff' }),
    );
    const dropoff = await taskOf(db, ev.mon.id, 'dropoff');
    expect(dropoff.status).toBe('unowned');
    expect(dropoff.ownerMemberIds).toEqual([]);
    // Its claim event on the caretaker's calendar went with it.
    const claims = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.synthKey, `task:${dropoff.id}`));
    expect(claims).toHaveLength(0);
  });

  it('refuses an outsider, another family’s event and a bad task type', async () => {
    const { fam, ev, base } = await fixture('arm-authz@example.com');
    const mondays = await createRule(base, fam.admin.token, {
      ownerMemberId: fam.adminMemberId,
      weekdayMask: MONDAY_BIT,
    });
    const other = await fixture('arm-authz-other@example.com');
    expect((await call(`${base}/${mondays}/matches`, bearer(other.fam.admin.token))).status).toBe(403);
    const foreign = await call(
      `${base}/${mondays}/exceptions`,
      authed(fam.admin.token, { calendarEventId: other.ev.mon.id, taskType: 'pickup' }),
    );
    expect(foreign.status).toBe(404);
    const badType = await call(`${base}/${mondays}/exceptions/${ev.mon.id}/lunch`, {
      ...bearer(fam.admin.token),
      method: 'DELETE',
    });
    expect(badType.status).toBe(400);
  });
});

describe('previewing an unsaved assignment rule', () => {
  it('shows what a draft would claim, where it would sit, without saving', async () => {
    const { fam, partnerId, ev, base } = await fixture('arm-preview@example.com');
    const mondays = await createRule(base, fam.admin.token, {
      ownerMemberId: fam.adminMemberId,
      weekdayMask: MONDAY_BIT,
    });

    // "Partner does every pickup": appended, Monday's rule still wins those.
    const draft = { ownerMemberId: partnerId, taskType: 'pickup' };
    const res = await call(`${base}/preview`, authed(fam.admin.token, { rule: draft }));
    expect(res.status).toBe(200);
    const { matches } = (await res.json()) as { matches: Match[] };
    const byEvent = new Map(matches.map((m) => [m.event.id, m]));
    expect(matches.every((m) => m.task.type === 'pickup')).toBe(true);
    expect(byEvent.get(ev.mon.id)).toMatchObject({ status: 'shadowed', decidedByRuleId: mondays });
    expect(byEvent.get(ev.tue.id)).toMatchObject({ status: 'applies', decidedByRuleId: 'draft' });

    // First in line, it would take Monday's pickup too.
    const first = await call(
      `${base}/preview`,
      authed(fam.admin.token, { rule: { ...draft, position: 0 } }),
    );
    const firstMatches = ((await first.json()) as { matches: Match[] }).matches;
    expect(firstMatches.find((m) => m.event.id === ev.mon.id)?.status).toBe('applies');

    // Nothing saved.
    const list = await call(base, bearer(fam.admin.token));
    expect(((await list.json()) as { rules: unknown[] }).rules).toHaveLength(1);
  });

  it('an edit keeps the rule’s place and omissions', async () => {
    const { fam, ev, base } = await fixture('arm-preview-edit@example.com');
    const mondays = await createRule(base, fam.admin.token, {
      ownerMemberId: fam.adminMemberId,
      weekdayMask: MONDAY_BIT,
    });
    await call(
      `${base}/${mondays}/exceptions`,
      authed(fam.admin.token, { calendarEventId: ev.mon.id, taskType: 'pickup' }),
    );
    // Widening it to Mondays and Tuesdays.
    const res = await call(
      `${base}/preview`,
      authed(fam.admin.token, {
        ruleId: mondays,
        rule: { ownerMemberId: fam.adminMemberId, weekdayMask: MONDAY_BIT | TUESDAY_BIT },
      }),
    );
    const { matches } = (await res.json()) as { matches: Match[] };
    const status = (eventId: string, type: string) =>
      matches.find((m) => m.event.id === eventId && m.task.type === type)?.status;
    expect(status(ev.mon.id, 'pickup')).toBe('omitted');
    expect(status(ev.mon.id, 'dropoff')).toBe('applies');
    expect(status(ev.tue.id, 'pickup')).toBe('applies');
  });
});
