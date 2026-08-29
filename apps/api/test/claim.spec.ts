import { env } from 'cloudflare:test';
import { and, calendarEvents, eq, getDb, tasks } from '@igt/db';
import type { GeoLocation } from '@igt/domain';
import { describe, expect, it } from 'vitest';
import { reconcileClaimEvents } from '../src/services/claim.js';
import { hashCalendarEvent } from '../src/services/synthesis.js';
import { authed, bearer, call, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

async function insertTask(
  db: Db,
  familyId: string,
  childId: string,
  locationGeo: GeoLocation | null = null,
) {
  return (
    await db
      .insert(tasks)
      .values({
        familyId,
        familyMemberId: childId,
        type: 'pickup',
        dtstart: new Date('2026-07-06T21:45:00Z'),
        dtend: null,
        location: 'Lincoln Elementary',
        locationGeo,
        status: 'unowned',
        createdVia: 'generated',
      })
      .returning()
  )[0]!;
}

/** An attendance task generated from a real calendar event (source of truth for the mirror). */
async function insertAttendanceTaskWithEvent(db: Db, familyId: string, childId: string) {
  const payload = {
    dtstart: new Date('2026-07-06T15:30:00Z'),
    dtend: new Date('2026-07-06T17:00:00Z'),
    allDay: false,
    summary: 'Soccer practice',
    location: 'Elm Park Fields',
    locationGeo: { lat: 37.4, lon: -122.1, title: 'Elm Park Fields' },
    description: 'Bring cleats and shin guards',
  };
  const event = (
    await db
      .insert(calendarEvents)
      .values({
        familyId,
        familyMemberId: childId,
        provenance: 'synthesized',
        synthKey: 'ev:test:soccer',
        contentHash: hashCalendarEvent(payload),
        ...payload,
      })
      .returning()
  )[0]!;
  const task = (
    await db
      .insert(tasks)
      .values({
        familyId,
        familyMemberId: childId,
        calendarEventId: event.id,
        type: 'attendance',
        attendanceRequirement: 'any',
        dtstart: payload.dtstart,
        dtend: payload.dtend,
        location: payload.location,
        locationGeo: payload.locationGeo,
        status: 'unowned',
        createdVia: 'generated',
      })
      .returning()
  )[0]!;
  return { event, task };
}

function claimEventsFor(db: Db, taskId: string) {
  return db
    .select()
    .from(calendarEvents)
    .where(
      and(eq(calendarEvents.taskId, taskId), eq(calendarEvents.provenance, 'claimed_task')),
    );
}

describe('claiming (the recursion)', () => {
  it('claim → event on the claimer’s calendar; reassign moves it; unclaim removes it', async () => {
    const fam = await setupFamily('claim-flow@example.com');
    const db = getDb(env.DB);

    // A second caretaker to reassign to.
    const partnerRes = await call(
      `/families/${fam.familyId}/members`,
      authed(fam.admin.token, { relationName: 'partner', isCaretaker: true }),
    );
    const partnerId = ((await partnerRes.json()) as { member: { id: string } }).member.id;

    const task = await insertTask(db, fam.familyId, fam.childId);

    // Claim for self.
    const claim = await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, {}),
    );
    expect(claim.status).toBe(200);
    let events = await claimEventsFor(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      familyMemberId: fam.adminMemberId,
      synthKey: `task:${task.id}`,
      summary: 'Pickup — child',
      location: 'Lincoln Elementary',
    });

    // Reassign to the partner: same event row moves calendars.
    const reassign = await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberId: partnerId }),
    );
    expect(reassign.status).toBe(200);
    events = await claimEventsFor(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.familyMemberId).toBe(partnerId);

    // Unclaim: the event disappears.
    const unassign = await call(
      `/families/${fam.familyId}/tasks/${task.id}/unassign`,
      authed(fam.admin.token),
    );
    expect(unassign.status).toBe(200);
    expect(await claimEventsFor(db, task.id)).toHaveLength(0);
  });

  it('claiming an attendance task mirrors the source event exactly', async () => {
    const fam = await setupFamily('claim-attendance@example.com');
    const db = getDb(env.DB);
    const { event, task } = await insertAttendanceTaskWithEvent(db, fam.familyId, fam.childId);

    const claim = await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, {}),
    );
    expect(claim.status).toBe(200);

    const events = await claimEventsFor(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      familyMemberId: fam.adminMemberId,
      summary: event.summary,
      location: event.location,
      locationGeo: event.locationGeo,
      description: event.description,
      allDay: event.allDay,
    });
  });

  it('an attendance task with no resolvable source event falls back to "Attend: <name>"', async () => {
    const fam = await setupFamily('claim-attendance-fallback@example.com');
    const db = getDb(env.DB);
    const task = (
      await db
        .insert(tasks)
        .values({
          familyId: fam.familyId,
          familyMemberId: fam.childId,
          calendarEventId: null,
          type: 'attendance',
          attendanceRequirement: 'any',
          dtstart: new Date('2026-07-06T15:30:00Z'),
          dtend: new Date('2026-07-06T17:00:00Z'),
          status: 'unowned',
          createdVia: 'generated',
        })
        .returning()
    )[0]!;

    const claim = await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, {}),
    );
    expect(claim.status).toBe(200);

    const events = await claimEventsFor(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe('Attend: child');
  });

  it("a claimed transition keeps the task's geocode (Apple travel time)", async () => {
    const fam = await setupFamily('claim-geo@example.com');
    const db = getDb(env.DB);
    const geo: GeoLocation = {
      lat: 37.331686,
      lon: -122.030656,
      title: 'Lincoln Elementary',
      address: '123 Main St, Springfield',
    };
    const task = await insertTask(db, fam.familyId, fam.childId, geo);

    await call(`/families/${fam.familyId}/tasks/${task.id}/assign`, authed(fam.admin.token, {}));

    const events = await claimEventsFor(db, task.id);
    expect(events).toHaveLength(1);
    // Location text alone leaves Apple guessing; the coords are what the
    // mirror turns into GEO + X-APPLE-STRUCTURED-LOCATION.
    expect(events[0]!.location).toBe('Lincoln Elementary');
    expect(events[0]!.locationGeo).toEqual(geo);
  });

  it('dismiss removes the claimed event; deleting the task cascades it', async () => {
    const fam = await setupFamily('claim-dismiss@example.com');
    const db = getDb(env.DB);
    const task = await insertTask(db, fam.familyId, fam.childId);

    await call(`/families/${fam.familyId}/tasks/${task.id}/assign`, authed(fam.admin.token, {}));
    expect(await claimEventsFor(db, task.id)).toHaveLength(1);

    const dismiss = await call(
      `/families/${fam.familyId}/tasks/${task.id}/dismiss`,
      authed(fam.admin.token),
    );
    expect(dismiss.status).toBe(200);
    expect(await claimEventsFor(db, task.id)).toHaveLength(0);

    // Re-claim, then hard-delete the task: the event cascades.
    await call(`/families/${fam.familyId}/tasks/${task.id}/restore`, authed(fam.admin.token));
    await call(`/families/${fam.familyId}/tasks/${task.id}/assign`, authed(fam.admin.token, {}));
    expect(await claimEventsFor(db, task.id)).toHaveLength(1);
    await db.delete(tasks).where(eq(tasks.id, task.id));
    expect(await claimEventsFor(db, task.id)).toHaveLength(0);
  });

  it('rejects claiming for a non-caretaker and enforces family scoping', async () => {
    const fam = await setupFamily('claim-authz@example.com');
    const db = getDb(env.DB);
    const task = await insertTask(db, fam.familyId, fam.childId);

    // A child (not a caretaker) can't be the owner.
    const res = await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberId: fam.childId }),
    );
    expect(res.status).toBe(400);

    // A stranger can't touch the family's tasks at all.
    const other = await setupFamily('claim-stranger@example.com');
    const cross = await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(other.admin.token, {}),
    );
    expect(cross.status).toBe(403);
  });
});

describe('multiple caretakers on one attendance task', () => {
  /** A second claim-capable member to share the event with. */
  async function addCaretaker(fam: Awaited<ReturnType<typeof setupFamily>>, name: string) {
    const res = await call(
      `/families/${fam.familyId}/members`,
      authed(fam.admin.token, { relationName: name, isCaretaker: true }),
    );
    return ((await res.json()) as { member: { id: string } }).member.id;
  }

  it('claims for several caretakers at once — one claimed event each', async () => {
    const fam = await setupFamily('claim-multi@example.com');
    const db = getDb(env.DB);
    const partnerId = await addCaretaker(fam, 'partner');
    const { event, task } = await insertAttendanceTaskWithEvent(db, fam.familyId, fam.childId);

    const res = await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberIds: [fam.adminMemberId, partnerId] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { status: string; ownerMemberIds: string[] } };
    expect(body.task.status).toBe('owned');
    expect([...body.task.ownerMemberIds].sort()).toEqual([fam.adminMemberId, partnerId].sort());

    // Both caretakers get the event on their own calendar, each an exact copy
    // of the source event (so both keep the metadata travel time runs on).
    const events = await claimEventsFor(db, task.id);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.familyMemberId).sort()).toEqual(
      [fam.adminMemberId, partnerId].sort(),
    );
    for (const e of events) {
      expect(e.synthKey).toBe(`task:${task.id}`);
      expect(e.summary).toBe(event.summary);
      expect(e.locationGeo).toEqual(event.locationGeo);
    }
  });

  it('lets one caretaker step off while the others keep covering it', async () => {
    const fam = await setupFamily('claim-multi-step-off@example.com');
    const db = getDb(env.DB);
    const partnerId = await addCaretaker(fam, 'partner');
    const { task } = await insertAttendanceTaskWithEvent(db, fam.familyId, fam.childId);

    await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberIds: [fam.adminMemberId, partnerId] }),
    );

    const res = await call(
      `/families/${fam.familyId}/tasks/${task.id}/unassign`,
      authed(fam.admin.token, { memberId: partnerId }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { status: string; ownerMemberIds: string[] } };
    expect(body.task.status).toBe('owned');
    expect(body.task.ownerMemberIds).toEqual([fam.adminMemberId]);

    const events = await claimEventsFor(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.familyMemberId).toBe(fam.adminMemberId);

    // No member named ⇒ the whole set is released.
    await call(
      `/families/${fam.familyId}/tasks/${task.id}/unassign`,
      authed(fam.admin.token),
    );
    expect(await claimEventsFor(db, task.id)).toHaveLength(0);
  });

  it('assigning a smaller set drops the caretakers left out of it', async () => {
    const fam = await setupFamily('claim-multi-shrink@example.com');
    const db = getDb(env.DB);
    const partnerId = await addCaretaker(fam, 'partner');
    const { task } = await insertAttendanceTaskWithEvent(db, fam.familyId, fam.childId);

    await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberIds: [fam.adminMemberId, partnerId] }),
    );
    await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberIds: [partnerId] }),
    );

    const events = await claimEventsFor(db, task.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.familyMemberId).toBe(partnerId);
  });

  it('dismissing a shared task clears every caretaker’s claim', async () => {
    const fam = await setupFamily('claim-multi-dismiss@example.com');
    const db = getDb(env.DB);
    const partnerId = await addCaretaker(fam, 'partner');
    const { task } = await insertAttendanceTaskWithEvent(db, fam.familyId, fam.childId);

    await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberIds: [fam.adminMemberId, partnerId] }),
    );
    const res = await call(
      `/families/${fam.familyId}/tasks/${task.id}/dismiss`,
      authed(fam.admin.token),
    );
    expect(res.status).toBe(200);
    expect(await claimEventsFor(db, task.id)).toHaveLength(0);
  });

  it('refuses to put two caretakers on the same drop-off or pickup', async () => {
    const fam = await setupFamily('claim-multi-transition@example.com');
    const db = getDb(env.DB);
    const partnerId = await addCaretaker(fam, 'partner');
    const task = await insertTask(db, fam.familyId, fam.childId);

    // A transition is one person's trip — two claimants would mean two cars.
    const res = await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberIds: [fam.adminMemberId, partnerId] }),
    );
    expect(res.status).toBe(400);
    expect(await claimEventsFor(db, task.id)).toHaveLength(0);
  });

  it('rejects a set containing a non-caretaker or an outsider', async () => {
    const fam = await setupFamily('claim-multi-authz@example.com');
    const db = getDb(env.DB);
    const { task } = await insertAttendanceTaskWithEvent(db, fam.familyId, fam.childId);

    const withChild = await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberIds: [fam.adminMemberId, fam.childId] }),
    );
    expect(withChild.status).toBe(400);

    const other = await setupFamily('claim-multi-stranger@example.com');
    const withStranger = await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberIds: [fam.adminMemberId, other.adminMemberId] }),
    );
    expect(withStranger.status).toBe(404);
    expect(await claimEventsFor(db, task.id)).toHaveLength(0);
  });

  it('puts a task back in the queue when its only caretaker leaves the family', async () => {
    const fam = await setupFamily('claim-owner-removed@example.com');
    const db = getDb(env.DB);
    const partnerId = await addCaretaker(fam, 'partner');
    const task = await insertTask(db, fam.familyId, fam.childId);
    await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberId: partnerId }),
    );

    // Removing the member cascades their `task_owners` row away, which would
    // otherwise leave the task marked owned with nobody on it.
    const del = await call(`/families/${fam.familyId}/members/${partnerId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${fam.admin.token}` },
    });
    expect(del.status).toBe(204);

    await reconcileClaimEvents(db, fam.familyId);
    const after = (
      await db.select().from(tasks).where(eq(tasks.id, task.id)).limit(1)
    )[0]!;
    expect(after.status).toBe('unowned');
    expect(await claimEventsFor(db, task.id)).toHaveLength(0);
  });

  it('reports the owner set on GET /tasks', async () => {
    const fam = await setupFamily('claim-multi-list@example.com');
    const db = getDb(env.DB);
    const partnerId = await addCaretaker(fam, 'partner');
    const { task } = await insertAttendanceTaskWithEvent(db, fam.familyId, fam.childId);
    await call(
      `/families/${fam.familyId}/tasks/${task.id}/assign`,
      authed(fam.admin.token, { memberIds: [fam.adminMemberId, partnerId] }),
    );

    const res = await call(`/families/${fam.familyId}/tasks?status=owned`, bearer(fam.admin.token));
    const body = (await res.json()) as { tasks: { id: string; ownerMemberIds: string[] }[] };
    const row = body.tasks.find((t) => t.id === task.id)!;
    expect([...row.ownerMemberIds].sort()).toEqual([fam.adminMemberId, partnerId].sort());
  });
});
