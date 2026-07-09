import { env } from 'cloudflare:test';
import { and, calendarEvents, eq, getDb, tasks } from '@igt/db';
import { describe, expect, it } from 'vitest';
import { authed, call, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

async function insertTask(db: Db, familyId: string, childId: string) {
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
        status: 'unowned',
        createdVia: 'generated',
      })
      .returning()
  )[0]!;
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
