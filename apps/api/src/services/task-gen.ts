import {
  and,
  calendarEvents,
  type Db,
  eq,
  familyMemberFeeds,
  familyMembers,
  inArray,
  isNull,
  ne,
  or,
  sql,
  taskRules,
  tasks,
} from '@igt/db';
import {
  generateTaskIntents,
  resolveTaskResult,
  type TaskDefault,
  type TaskIntent,
  type TaskRuleLike,
} from '@igt/classification';

type CalendarEventRow = typeof calendarEvents.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export interface TaskGenResult {
  familyMemberId: string;
  tasksCreated: number;
  tasksRemoved: number;
}

function toTaskRuleLike(r: typeof taskRules.$inferSelect): TaskRuleLike {
  return {
    id: r.id,
    position: r.position,
    scope: r.scope,
    linkId: r.linkId,
    matchField: r.matchField,
    matchOp: r.matchOp,
    matchValue: r.matchValue,
    resultType: r.resultType,
    dropoffWindowMin: r.dropoffWindowMin,
    pickupWindowMin: r.pickupWindowMin,
  };
}

/** Heal an existing task's anchor/location if the event moved; keep its window. */
async function healTask(
  db: Db,
  task: TaskRow,
  dtstart: Date,
  location: string | null,
): Promise<void> {
  if (
    task.dtstart.getTime() === dtstart.getTime() &&
    (task.location ?? null) === (location ?? null)
  ) {
    return;
  }
  await db.update(tasks).set({ dtstart, location }).where(eq(tasks.id, task.id));
}

/** The start anchor a given task type takes on an event (for manual healing). */
function anchorStart(event: CalendarEventRow, type: string): Date {
  return type === 'pickup' ? (event.dtend ?? event.dtstart) : event.dtstart;
}

/**
 * Module B — task generation. Reads a member's unified-calendar events (never
 * `claimed_task` ones — the recursion guard) and reconciles the claimable tasks
 * each event spawns, keyed by (calendarEventId, type). Task TYPE is resolved at
 * build time from the member's task-rule pipeline (keyed by the event's source
 * calendar, `linkId`; null ⇒ the member's own unified/direct calendar), falling
 * through to that calendar's default.
 *
 * Preservation rules:
 *  - User-converted tasks (`createdVia: 'manual'`) freeze the type set — the
 *    builder only heals their anchor/location, never reclassifies.
 *  - Owned tasks are never deleted by reconciliation; only unowned ones are.
 *  - Unowned tasks whose event vanished are swept; owned ones survive.
 */
export async function buildMemberTasks(
  db: Db,
  familyMemberId: string,
): Promise<TaskGenResult> {
  const result: TaskGenResult = { familyMemberId, tasksCreated: 0, tasksRemoved: 0 };

  const member = (
    await db.select().from(familyMembers).where(eq(familyMembers.id, familyMemberId)).limit(1)
  )[0];
  if (!member) return result;

  // The member's task-rule pipeline + per-calendar defaults, loaded once.
  const rules = (
    await db.select().from(taskRules).where(eq(taskRules.familyMemberId, familyMemberId))
  ).map(toTaskRuleLike);
  const links = await db
    .select()
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.familyMemberId, familyMemberId));
  const linkDefault = new Map<string, TaskDefault>(
    links.map((l) => [
      l.id,
      {
        resultType: l.defaultTaskType,
        dropoffWindowMin: l.defaultDropoffWindowMin,
        pickupWindowMin: l.defaultPickupWindowMin,
      },
    ]),
  );
  const unifiedDefault: TaskDefault = {
    resultType: member.unifiedDefaultTaskType,
    dropoffWindowMin: member.unifiedDropoffWindowMin,
    pickupWindowMin: member.unifiedPickupWindowMin,
  };

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
    const fallback =
      (event.linkId && linkDefault.get(event.linkId)) || unifiedDefault;
    const resolution = resolveTaskResult(
      {
        summary: event.summary,
        location: event.location,
        description: event.description,
        allDay: event.allDay,
        dtstart: event.dtstart,
        dtend: event.dtend,
      },
      rules,
      event.linkId ?? null,
      fallback,
    );
    const intents = generateTaskIntents(event, resolution);

    const existing = await db
      .select()
      .from(tasks)
      .where(eq(tasks.calendarEventId, event.id));

    // User-converted tasks freeze the type set; only heal their anchors.
    const manual = existing.filter((t) => t.createdVia === 'manual');
    if (manual.length > 0) {
      for (const t of manual) {
        await healTask(db, t, anchorStart(event, t.type), event.location);
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
          await healTask(db, prior, intent.dtstart, intent.location);
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
 * Rebuild a member's tasks after a task-rule/default change. Task rules don't
 * touch event content hashes, so force reconsideration by clearing every
 * (non-claimed) event's `tasksBuiltHash` first, then run task-gen.
 */
export async function rebuildMemberTasks(
  db: Db,
  familyMemberId: string,
): Promise<TaskGenResult> {
  await db
    .update(calendarEvents)
    .set({ tasksBuiltHash: null })
    .where(
      and(
        eq(calendarEvents.familyMemberId, familyMemberId),
        ne(calendarEvents.provenance, 'claimed_task'),
      ),
    );
  return buildMemberTasks(db, familyMemberId);
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
