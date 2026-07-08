import { env } from 'cloudflare:test';
import { calendarEvents, eq, getDb, tasks } from '@igt/db';
import { describe, expect, it } from 'vitest';
import { hashCalendarEvent } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { authed, call, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

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
    annotation: values.annotation ?? null,
    generatesTypes: (values.generatesTypes as string[] | null | undefined) ?? null,
    defaultAttendance: values.defaultAttendance ?? null,
  };
  return (
    await db
      .insert(calendarEvents)
      .values({
        familyId,
        familyMemberId,
        provenance: values.provenance ?? 'synthesized',
        contentHash: hashCalendarEvent(payload as never),
        ...payload,
        synthKey: values.synthKey,
        taskId: values.taskId ?? null,
      })
      .returning()
  )[0]!;
}

describe('task generation (Module B)', () => {
  it('generates dropoff@start + pickup@end from a configured event, convertible attendance otherwise', async () => {
    const fam = await setupFamily('gen-basic@example.com');
    const db = getDb(env.DB);

    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'bl:l1:2026-07-06',
      generatesTypes: ['dropoff', 'pickup'],
      location: 'Lincoln Elementary',
    });
    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ev:l1:soccer',
      summary: 'Team Pizza Night',
      dtstart: new Date('2026-07-10T18:00:00Z'),
      dtend: new Date('2026-07-10T19:00:00Z'),
    });

    const result = await buildMemberTasks(db, fam.childId);
    expect(result.tasksCreated).toBe(3);

    const rows = await db.select().from(tasks).where(eq(tasks.familyMemberId, fam.childId));
    const dropoff = rows.find((t) => t.type === 'dropoff')!;
    expect(dropoff.dtstart.toISOString()).toBe('2026-07-06T15:30:00.000Z');
    expect(dropoff.dtend).toBeNull();
    expect(dropoff.location).toBe('Lincoln Elementary');
    expect(dropoff.status).toBe('unowned');
    expect(dropoff.createdVia).toBe('generated');
    const pickup = rows.find((t) => t.type === 'pickup')!;
    expect(pickup.dtstart.toISOString()).toBe('2026-07-06T21:45:00.000Z');
    const attendance = rows.find((t) => t.type === 'attendance')!;
    expect(attendance.attendanceRequirement).toBe('any');
    expect(attendance.dtend!.toISOString()).toBe('2026-07-10T19:00:00.000Z');
  });

  it('is idempotent and heals task anchors when the event moves', async () => {
    const fam = await setupFamily('gen-heal@example.com');
    const db = getDb(env.DB);
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'bl:l1:2026-07-06',
      generatesTypes: ['pickup'],
    });

    const r1 = await buildMemberTasks(db, fam.childId);
    expect(r1.tasksCreated).toBe(1);
    const r2 = await buildMemberTasks(db, fam.childId);
    expect(r2.tasksCreated).toBe(0);

    // Move the day end (early release): the pickup anchor heals.
    const newEnd = new Date('2026-07-06T19:00:00.000Z');
    const payload = {
      dtstart: event.dtstart,
      dtend: newEnd,
      allDay: false,
      summary: event.summary,
      location: null,
      description: null,
      annotation: null,
      generatesTypes: ['pickup'],
      defaultAttendance: null,
    };
    await db
      .update(calendarEvents)
      .set({ dtend: newEnd, contentHash: hashCalendarEvent(payload as never) })
      .where(eq(calendarEvents.id, event.id));

    await buildMemberTasks(db, fam.childId);
    const rows = await db.select().from(tasks).where(eq(tasks.calendarEventId, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dtstart.toISOString()).toBe('2026-07-06T19:00:00.000Z');
  });

  it('never generates from claimed_task events (the recursion guard)', async () => {
    const fam = await setupFamily('gen-guard@example.com');
    const db = getDb(env.DB);
    await insertEvent(db, fam.familyId, fam.adminMemberId, {
      synthKey: 'task:some-task',
      provenance: 'claimed_task',
      generatesTypes: ['pickup', 'dropoff'],
      summary: 'Pickup — child',
    });
    const result = await buildMemberTasks(db, fam.adminMemberId);
    expect(result.tasksCreated).toBe(0);
    expect(
      await db.select().from(tasks).where(eq(tasks.familyMemberId, fam.adminMemberId)),
    ).toHaveLength(0);
  });

  it('preserves owned tasks and manual conversions across rebuilds; sweeps unowned orphans', async () => {
    const fam = await setupFamily('gen-preserve@example.com');
    const db = getDb(env.DB);
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ev:l1:appt',
      summary: 'Dentist',
      dtstart: new Date('2026-07-09T09:15:00Z'),
      dtend: new Date('2026-07-09T10:15:00Z'),
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
    const converted = ((await convert.json()) as { tasks: { type: string; createdVia: string }[] })
      .tasks;
    expect(converted.map((t) => t.type).sort()).toEqual(['dropoff', 'pickup']);
    expect(converted.every((t) => t.createdVia === 'manual')).toBe(true);

    // A rebuild (event marked dirty) must NOT reintroduce the attendance task.
    await db
      .update(calendarEvents)
      .set({ tasksBuiltHash: null })
      .where(eq(calendarEvents.id, event.id));
    await buildMemberTasks(db, fam.childId);
    const afterRebuild = await db
      .select()
      .from(tasks)
      .where(eq(tasks.calendarEventId, event.id));
    expect(afterRebuild.map((t) => t.type).sort()).toEqual(['dropoff', 'pickup']);

    // Claim the pickup, then delete the event: the owned task survives the
    // orphan sweep; the unowned one is removed.
    const pickup = afterRebuild.find((t) => t.type === 'pickup')!;
    const claim = await call(
      `/families/${fam.familyId}/tasks/${pickup.id}/assign`,
      authed(fam.admin.token, {}),
    );
    expect(claim.status).toBe(200);
    await db.delete(calendarEvents).where(eq(calendarEvents.id, event.id));
    // (the claimed event on the admin's calendar cascades with... nothing —
    // deleting the source event doesn't touch the task or its claimed event)
    await buildMemberTasks(db, fam.childId);
    const survivors = await db
      .select()
      .from(tasks)
      .where(eq(tasks.calendarEventId, event.id));
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.type).toBe('pickup');
    expect(survivors[0]!.status).toBe('owned');
  });
});
