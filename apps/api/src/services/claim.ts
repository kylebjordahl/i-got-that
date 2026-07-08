import {
  and,
  calendarEvents,
  type Db,
  eq,
  familyMembers,
  tasks,
} from '@igt/db';
import { hashCalendarEvent } from './synthesis.js';

type TaskRow = typeof tasks.$inferSelect;

export function taskSummary(task: TaskRow, aboutName: string): string {
  const label =
    task.type === 'pickup'
      ? 'Pickup'
      : task.type === 'dropoff'
        ? 'Drop-off'
        : 'Attendance';
  return `${label} — ${aboutName}`;
}

async function memberName(db: Db, memberId: string): Promise<string> {
  const row = (
    await db
      .select({ relationName: familyMembers.relationName })
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .limit(1)
  )[0];
  return row?.relationName ?? 'child';
}

/**
 * The recursion (§3.1): a claimed task becomes an event on the CLAIMING
 * member's unified calendar (`task:<taskId>` synthKey, provenance
 * `claimed_task`), from where the mirror writes it out to the calendar they
 * already use. Task-gen never generates tasks from these events. Idempotent —
 * reassignment moves the same row to the new owner's calendar.
 *
 * Callers do DB writes first, then `enqueueReconcile` for every affected
 * member (never awaiting the reconcile in a request path).
 */
export async function upsertClaimEvent(db: Db, task: TaskRow): Promise<void> {
  if (task.status !== 'owned' || !task.ownerMemberId) return;
  const summary = taskSummary(task, await memberName(db, task.familyMemberId));
  const payload = {
    familyMemberId: task.ownerMemberId,
    dtstart: task.dtstart,
    dtend: task.dtend,
    allDay: false,
    summary,
    location: task.location,
    description: null,
    annotation: null,
    generatesTypes: null,
    defaultAttendance: null,
  };
  const contentHash = hashCalendarEvent(payload);

  const prior = (
    await db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.taskId, task.id),
          eq(calendarEvents.provenance, 'claimed_task'),
        ),
      )
      .limit(1)
  )[0];

  if (prior) {
    if (prior.contentHash === contentHash && prior.familyMemberId === task.ownerMemberId) {
      return;
    }
    await db
      .update(calendarEvents)
      .set({ ...payload, contentHash })
      .where(eq(calendarEvents.id, prior.id));
    return;
  }

  await db.insert(calendarEvents).values({
    familyId: task.familyId,
    provenance: 'claimed_task',
    synthKey: `task:${task.id}`,
    taskId: task.id,
    contentHash,
    // Claimed events never generate tasks; stamp them pre-built so task-gen's
    // dirty query skips them without special-casing.
    tasksBuiltHash: contentHash,
    ...payload,
  });
}

/** Remove a task's claimed event (unclaim / dismiss / delete). */
export async function removeClaimEvent(db: Db, taskId: string): Promise<void> {
  await db
    .delete(calendarEvents)
    .where(
      and(
        eq(calendarEvents.taskId, taskId),
        eq(calendarEvents.provenance, 'claimed_task'),
      ),
    );
}

/**
 * True-up every claimed event in a family (cron safety net): owned tasks get
 * their event upserted/healed; stray claimed events whose task is no longer
 * owned are removed by cascade when the task went away, or here when it was
 * unowned without cleanup.
 */
export async function reconcileClaimEvents(db: Db, familyId: string): Promise<void> {
  const owned = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.familyId, familyId), eq(tasks.status, 'owned')));
  for (const task of owned) {
    await upsertClaimEvent(db, task);
  }

  const claimEvents = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.familyId, familyId),
        eq(calendarEvents.provenance, 'claimed_task'),
      ),
    );
  const ownedById = new Map(owned.map((t) => [t.id, t]));
  for (const ev of claimEvents) {
    const task = ev.taskId ? ownedById.get(ev.taskId) : undefined;
    if (!task) {
      await db.delete(calendarEvents).where(eq(calendarEvents.id, ev.id));
    }
  }
}
