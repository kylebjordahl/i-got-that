import { env } from 'cloudflare:test';
import {
  calendarEvents,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  taskRules,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { hashCalendarEvent } from '../src/services/synthesis.js';
import { buildMemberTasks, rebuildMemberTasks } from '../src/services/task-gen.js';
import { authed, call, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

/** A feed + active link for the child, with a task-gen default on the link. */
async function linkedFeed(
  db: Db,
  familyId: string,
  childId: string,
  defaultTaskType: 'transition' | 'attendance' = 'transition',
) {
  const feed = (
    await db
      .insert(feeds)
      .values({ familyId, mode: 'standard', url: 'https://f.example.com/c.ics' })
      .returning()
  )[0]!;
  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({ familyId, feedId: feed.id, familyMemberId: childId, defaultTaskType })
      .returning()
  )[0]!;
  return { feed, link };
}

async function insertEvent(
  db: Db,
  familyId: string,
  familyMemberId: string,
  values: Partial<typeof calendarEvents.$inferInsert> & { synthKey: string },
) {
  const payload = {
    dtstart: values.dtstart ?? new Date('2026-07-06T15:30:00Z'),
    dtend: values.dtend === undefined ? new Date('2026-07-06T21:45:00Z') : values.dtend,
    allDay: values.allDay ?? false,
    summary: values.summary ?? 'School day',
    location: values.location ?? null,
    description: null,
  };
  return (
    await db
      .insert(calendarEvents)
      .values({
        familyId,
        familyMemberId,
        provenance: values.provenance ?? 'synthesized',
        contentHash: hashCalendarEvent(payload),
        ...payload,
        synthKey: values.synthKey,
        linkId: values.linkId ?? null,
        taskId: values.taskId ?? null,
      })
      .returning()
  )[0]!;
}

describe('task generation (Module B)', () => {
  it("uses the event's source-calendar default when no task rule matches", async () => {
    const fam = await setupFamily('gen-default@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'transition');

    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'bl:l1:2026-07-06',
      linkId: link.id,
      location: 'Lincoln Elementary',
    });

    const result = await buildMemberTasks(db, fam.childId);
    expect(result.tasksCreated).toBe(2); // transition ⇒ drop-off + pickup

    const rows = await db.select().from(tasks).where(eq(tasks.familyMemberId, fam.childId));
    const dropoff = rows.find((t) => t.type === 'dropoff')!;
    expect(dropoff.dtstart.toISOString()).toBe('2026-07-06T15:30:00.000Z');
    expect(dropoff.location).toBe('Lincoln Elementary');
    expect(dropoff.createdVia).toBe('generated');
    const pickup = rows.find((t) => t.type === 'pickup')!;
    expect(pickup.dtstart.toISOString()).toBe('2026-07-06T21:45:00.000Z');
  });

  it('a matching task rule overrides the default (→ attendance)', async () => {
    const fam = await setupFamily('gen-rule@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'transition');
    await db.insert(taskRules).values({
      familyId: fam.familyId,
      familyMemberId: fam.childId,
      linkId: link.id,
      scope: 'this_calendar',
      position: 0,
      matchField: 'summary',
      matchOp: 'regex',
      matchValue: '/field trip/i',
      resultType: 'attendance',
    });

    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ev:l1:ft',
      linkId: link.id,
      summary: 'Class field trip',
    });

    await buildMemberTasks(db, fam.childId);
    const rows = await db.select().from(tasks).where(eq(tasks.familyMemberId, fam.childId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('attendance');
  });

  it("an all_calendars rule inherits into a member's unified/direct events", async () => {
    const fam = await setupFamily('gen-inherit@example.com');
    const db = getDb(env.DB);
    // The member's unified default is 'attendance' (schema default). An
    // all-calendars rule flips a matching direct event to a transition.
    await db.insert(taskRules).values({
      familyId: fam.familyId,
      familyMemberId: fam.childId,
      linkId: null,
      scope: 'all_calendars',
      position: 0,
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Carpool',
      resultType: 'transition',
    });

    await insertEvent(db, fam.familyId, fam.childId, { synthKey: 'ext:a:', provenance: 'human', summary: 'Carpool duty' });
    await insertEvent(db, fam.familyId, fam.childId, { synthKey: 'ext:b:', provenance: 'human', summary: 'Dentist' });

    await buildMemberTasks(db, fam.childId);
    const rows = await db.select().from(tasks).where(eq(tasks.familyMemberId, fam.childId));
    const carpool = rows.filter((t) => t.location === null && (t.type === 'dropoff' || t.type === 'pickup'));
    expect(carpool).toHaveLength(2); // Carpool → transition
    expect(rows.filter((t) => t.type === 'attendance')).toHaveLength(1); // Dentist → unified default
  });

  it('never generates from claimed_task events (the recursion guard)', async () => {
    const fam = await setupFamily('gen-guard@example.com');
    const db = getDb(env.DB);
    await insertEvent(db, fam.familyId, fam.adminMemberId, {
      synthKey: 'task:some-task',
      provenance: 'claimed_task',
      summary: 'Pickup — child',
    });
    const result = await buildMemberTasks(db, fam.adminMemberId);
    expect(result.tasksCreated).toBe(0);
  });

  it('rebuildMemberTasks re-types events after a rule change; owned + manual preserved', async () => {
    const fam = await setupFamily('gen-rebuild@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'transition');
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ev:l1:x',
      linkId: link.id,
      summary: 'Robotics club',
    });
    await buildMemberTasks(db, fam.childId);
    expect(
      (await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id))).map((t) => t.type).sort(),
    ).toEqual(['dropoff', 'pickup']);

    // Add a rule flipping it to attendance, then rebuild (rules don't change
    // the event content hash, so a plain build wouldn't reconsider it).
    await db.insert(taskRules).values({
      familyId: fam.familyId,
      familyMemberId: fam.childId,
      linkId: link.id,
      scope: 'this_calendar',
      position: 0,
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Robotics',
      resultType: 'attendance',
    });
    await rebuildMemberTasks(db, fam.childId);
    const after = await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id));
    expect(after.map((t) => t.type)).toEqual(['attendance']);
  });

  it('healing a moved event carries its dtend along, not just dtstart', async () => {
    const fam = await setupFamily('gen-heal-dtend@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'transition');
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ev:l1:heal',
      linkId: link.id,
      dtstart: new Date('2026-07-06T15:30:00Z'),
      dtend: new Date('2026-07-06T21:45:00Z'),
    });
    await buildMemberTasks(db, fam.childId);
    const dropoffBefore = (
      await db
        .select()
        .from(tasks)
        .where(eq(tasks.calendarEventId, event.id))
    ).find((t) => t.type === 'dropoff')!;
    // Default dropoff window is 15min, anchored to the event's dtstart.
    expect(dropoffBefore.dtend!.getTime()).toBe(
      new Date('2026-07-06T15:45:00Z').getTime(),
    );

    // The event reschedules an hour later — a re-ingested feed correction, or
    // a DST-driven recompute upstream. Its content hash changes so task-gen
    // reconsiders it.
    const movedStart = new Date('2026-07-06T16:30:00Z');
    const movedEnd = new Date('2026-07-06T22:45:00Z');
    const payload = {
      dtstart: movedStart,
      dtend: movedEnd,
      allDay: false,
      summary: 'School day',
      location: null,
      description: null,
    };
    await db
      .update(calendarEvents)
      .set({ ...payload, contentHash: hashCalendarEvent(payload) })
      .where(eq(calendarEvents.id, event.id));
    await buildMemberTasks(db, fam.childId);

    const dropoffAfter = (
      await db
        .select()
        .from(tasks)
        .where(eq(tasks.calendarEventId, event.id))
    ).find((t) => t.type === 'dropoff')!;
    expect(dropoffAfter.dtstart.getTime()).toBe(movedStart.getTime());
    // The window should track the new anchor (15min later), not stay pinned
    // to the pre-move dtend.
    expect(dropoffAfter.dtend!.getTime()).toBe(movedStart.getTime() + 15 * 60_000);
  });

  it('preserves manual conversions and sweeps unowned orphans', async () => {
    const fam = await setupFamily('gen-preserve@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'attendance');
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ev:l1:appt',
      linkId: link.id,
      summary: 'Dentist',
    });
    await buildMemberTasks(db, fam.childId);
    const attendance = (
      await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id))
    )[0]!;

    // Convert to pickup+dropoff via the route → marked manual.
    const convert = await call(
      `/families/${fam.familyId}/tasks/${attendance.id}/convert`,
      authed(fam.admin.token, { types: ['pickup', 'dropoff'] }),
    );
    expect(convert.status).toBe(200);

    // Rebuild must NOT reintroduce the attendance task.
    await rebuildMemberTasks(db, fam.childId);
    const afterRebuild = await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id));
    expect(afterRebuild.map((t) => t.type).sort()).toEqual(['dropoff', 'pickup']);

    // Claim the pickup, delete the event: the owned task survives the sweep.
    const pickup = afterRebuild.find((t) => t.type === 'pickup')!;
    await call(`/families/${fam.familyId}/tasks/${pickup.id}/assign`, authed(fam.admin.token, {}));
    await db.delete(calendarEvents).where(eq(calendarEvents.id, event.id));
    await buildMemberTasks(db, fam.childId);
    const survivors = await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id));
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.type).toBe('pickup');
    expect(survivors[0]!.status).toBe('owned');
  });

  it('sets a positive duration override on a transition task and freezes the pair', async () => {
    const fam = await setupFamily('gen-dur-pos@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'transition');
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ev:l1:dur-pos',
      linkId: link.id,
      dtstart: new Date('2026-07-06T15:30:00Z'),
      dtend: new Date('2026-07-06T21:45:00Z'),
    });
    await buildMemberTasks(db, fam.childId);
    const pickup = (
      await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id))
    ).find((t) => t.type === 'pickup')!;

    const res = await call(
      `/families/${fam.familyId}/tasks/${pickup.id}/duration`,
      authed(fam.admin.token, { durationMinutes: 30 }),
    );
    expect(res.status).toBe(200);

    const updated = (await db.select().from(tasks).where(eq(tasks.id, pickup.id)))[0]!;
    // Pickup anchors to the event's end; +30 extends forward from it.
    expect(updated.dtstart.getTime()).toBe(new Date('2026-07-06T21:45:00Z').getTime());
    expect(updated.dtend!.getTime()).toBe(new Date('2026-07-06T22:15:00Z').getTime());
    expect(updated.durationOverrideMin).toBe(30);
    expect(updated.createdVia).toBe('manual');
    // The whole transition pair is frozen so a rebuild can't reclassify it.
    const dropoff = (
      await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id))
    ).find((t) => t.type === 'dropoff')!;
    expect(dropoff.createdVia).toBe('manual');
  });

  it('a negative duration reverses the window before the anchor', async () => {
    const fam = await setupFamily('gen-dur-neg@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'transition');
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ev:l1:dur-neg',
      linkId: link.id,
      dtstart: new Date('2026-07-06T15:30:00Z'),
      dtend: new Date('2026-07-06T21:45:00Z'),
    });
    await buildMemberTasks(db, fam.childId);
    const dropoff = (
      await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id))
    ).find((t) => t.type === 'dropoff')!;

    const res = await call(
      `/families/${fam.familyId}/tasks/${dropoff.id}/duration`,
      authed(fam.admin.token, { durationMinutes: -20 }),
    );
    expect(res.status).toBe(200);

    const updated = (await db.select().from(tasks).where(eq(tasks.id, dropoff.id)))[0]!;
    // Drop-off anchors to the event's start; -20 sits before it (dtend at anchor).
    expect(updated.dtstart.getTime()).toBe(new Date('2026-07-06T15:10:00Z').getTime());
    expect(updated.dtend!.getTime()).toBe(new Date('2026-07-06T15:30:00Z').getTime());
    expect(updated.durationOverrideMin).toBe(-20);
  });

  it('a duration override survives a moved event, preserving its signed window', async () => {
    const fam = await setupFamily('gen-dur-heal@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'transition');
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ev:l1:dur-heal',
      linkId: link.id,
      dtstart: new Date('2026-07-06T15:30:00Z'),
      dtend: new Date('2026-07-06T21:45:00Z'),
    });
    await buildMemberTasks(db, fam.childId);
    const dropoff = (
      await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id))
    ).find((t) => t.type === 'dropoff')!;
    await call(
      `/families/${fam.familyId}/tasks/${dropoff.id}/duration`,
      authed(fam.admin.token, { durationMinutes: -20 }),
    );

    // The event reschedules an hour later; its hash changes so task-gen heals.
    const movedStart = new Date('2026-07-06T16:30:00Z');
    const movedEnd = new Date('2026-07-06T22:45:00Z');
    const payload = {
      dtstart: movedStart,
      dtend: movedEnd,
      allDay: false,
      summary: 'School day',
      location: null,
      description: null,
    };
    await db
      .update(calendarEvents)
      .set({ ...payload, contentHash: hashCalendarEvent(payload) })
      .where(eq(calendarEvents.id, event.id));
    await buildMemberTasks(db, fam.childId);

    const healed = (await db.select().from(tasks).where(eq(tasks.id, dropoff.id)))[0]!;
    // Anchor tracks the new start; the -20 window still sits before it.
    expect(healed.dtend!.getTime()).toBe(movedStart.getTime());
    expect(healed.dtstart.getTime()).toBe(movedStart.getTime() - 20 * 60_000);
    expect(healed.durationOverrideMin).toBe(-20);
  });

  it('rejects a duration change on a non-transition (attendance) task', async () => {
    const fam = await setupFamily('gen-dur-att@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId, 'attendance');
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ev:l1:dur-att',
      linkId: link.id,
    });
    await buildMemberTasks(db, fam.childId);
    const attendance = (
      await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id))
    )[0]!;

    const res = await call(
      `/families/${fam.familyId}/tasks/${attendance.id}/duration`,
      authed(fam.admin.token, { durationMinutes: 30 }),
    );
    expect(res.status).toBe(400);
  });
});
