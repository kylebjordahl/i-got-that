import {
  and,
  calendarEvents,
  type Db,
  eq,
  familyMembers,
  inArray,
  isNull,
  ne,
  or,
  sql,
  tasks,
} from '@igt/db';
import { generateTaskIntents, type TaskIntent } from '@igt/classification';
import type { TaskType } from '@igt/domain';

type CalendarEventRow = typeof calendarEvents.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export interface TaskGenResult {
  familyMemberId: string;
  tasksCreated: number;
  tasksRemoved: number;
}

/** The canonical time anchor for a task type on an event (used for healing). */
function anchorFor(event: CalendarEventRow, type: TaskType): TaskIntent {
  if (type === 'dropoff') {
    return {
      type,
      attendanceRequirement: null,
      dtstart: event.dtstart,
      dtend: null,
      location: event.location,
    };
  }
  if (type === 'pickup') {
    return {
      type,
      attendanceRequirement: null,
      dtstart: event.dtend ?? event.dtstart,
      dtend: null,
      location: event.location,
    };
  }
  return {
    type,
    attendanceRequirement: null,
    dtstart: event.dtstart,
    dtend: event.dtend,
    location: event.location,
  };
}

async function healTask(db: Db, task: TaskRow, intent: TaskIntent): Promise<void> {
  if (
    task.dtstart.getTime() === intent.dtstart.getTime() &&
    (task.dtend?.getTime() ?? null) === (intent.dtend?.getTime() ?? null) &&
    (task.location ?? null) === (intent.location ?? null)
  ) {
    return;
  }
  await db
    .update(tasks)
    .set({ dtstart: intent.dtstart, dtend: intent.dtend, location: intent.location })
    .where(eq(tasks.id, task.id));
}

/**
 * Module B — task generation. Reads a member's unified-calendar events (never
 * `claimed_task` ones — the recursion guard lives in the engine) and reconciles
 * the claimable tasks each event spawns, keyed by (calendarEventId, type).
 *
 * Preservation rules (carried over from the pre-rework builder):
 *  - Once a user has converted an event's tasks (`createdVia: 'manual'`), the
 *    builder never reclassifies — it only heals times/location so a moved event
 *    moves its tasks.
 *  - Owned tasks are never deleted by reconciliation; only unowned tasks are
 *    removed when no longer desired.
 *  - Unowned tasks whose event vanished entirely are swept; owned ones survive
 *    (surfaced as stale rather than silently dropped).
 */
export async function buildMemberTasks(
  db: Db,
  familyMemberId: string,
): Promise<TaskGenResult> {
  const result: TaskGenResult = { familyMemberId, tasksCreated: 0, tasksRemoved: 0 };

  const dirty = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.familyMemberId, familyMemberId),
        ne(calendarEvents.provenance, 'claimed_task'),
        or(
          isNull(calendarEvents.tasksBuiltHash),
          ne(calendarEvents.tasksBuiltHash, calendarEvents.contentHash),
        ),
      ),
    );

  for (const event of dirty) {
    const intents = generateTaskIntents({
      provenance: event.provenance,
      generatesTypes: (event.generatesTypes as TaskType[] | null) ?? null,
      defaultAttendance: event.defaultAttendance ?? null,
      dtstart: event.dtstart,
      dtend: event.dtend,
      location: event.location,
    });

    const existing = await db
      .select()
      .from(tasks)
      .where(eq(tasks.calendarEventId, event.id));

    // User-converted tasks freeze the type set; only heal their anchors.
    const manual = existing.filter((t) => t.createdVia === 'manual');
    if (manual.length > 0) {
      for (const t of manual) {
        await healTask(db, t, anchorFor(event, t.type));
      }
    } else {
      const desiredByType = new Map(intents.map((i) => [i.type, i]));
      for (const t of existing) {
        if (!desiredByType.has(t.type) && t.status === 'unowned') {
          await db.delete(tasks).where(eq(tasks.id, t.id));
          result.tasksRemoved++;
        }
      }
      const existingByType = new Map(existing.map((t) => [t.type, t]));
      for (const intent of intents) {
        const prior = existingByType.get(intent.type);
        if (prior) {
          await healTask(db, prior, intent);
        } else {
          await db.insert(tasks).values({
            familyId: event.familyId,
            calendarEventId: event.id,
            familyMemberId: event.familyMemberId,
            type: intent.type,
            attendanceRequirement: intent.attendanceRequirement,
            dtstart: intent.dtstart,
            dtend: intent.dtend,
            location: intent.location,
            status: 'unowned',
            createdVia: 'generated',
          });
          result.tasksCreated++;
        }
      }
    }

    await db
      .update(calendarEvents)
      .set({ tasksBuiltHash: event.contentHash })
      .where(eq(calendarEvents.id, event.id));
  }

  // Orphan sweep: unowned event-derived tasks (generated OR converted) whose
  // event no longer exists. Fully-manual tasks (null calendarEventId) and
  // owned tasks are left alone.
  const orphans = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.familyMemberId, familyMemberId),
        eq(tasks.status, 'unowned'),
        sql`${tasks.calendarEventId} IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM ${calendarEvents}
          WHERE ${calendarEvents.id} = ${tasks.calendarEventId}
        )`,
      ),
    );
  if (orphans.length > 0) {
    await db.delete(tasks).where(
      inArray(
        tasks.id,
        orphans.map((o) => o.id),
      ),
    );
    result.tasksRemoved += orphans.length;
  }

  return result;
}

/**
 * Run task generation for every member of a family (all members, not just
 * those with events — the orphan sweep must reach a member whose last event
 * vanished).
 */
export async function buildFamilyTasks(
  db: Db,
  familyId: string,
): Promise<TaskGenResult[]> {
  const members = await db
    .select({ id: familyMembers.id })
    .from(familyMembers)
    .where(eq(familyMembers.familyId, familyId));
  const results: TaskGenResult[] = [];
  for (const { id } of members) {
    results.push(await buildMemberTasks(db, id));
  }
  return results;
}
