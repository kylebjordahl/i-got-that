import { and, type Db, eq, inArray, taskOwners, tasks } from '@igt/db';
import type { TaskStatus } from '@igt/domain';
import { syncClaimEvents } from './claim.js';

type TaskRow = typeof tasks.$inferSelect;

/**
 * A task as the API hands it out: the row plus who is covering it.
 *
 * `autoAssignedRuleId` summarises the set for the client — an assignment rule
 * claims a task for exactly one caretaker and any human touch clears every
 * stamp, so a task is either wholly rule-owned or not, and the client only
 * needs to know which (it labels the claim "auto" and names the rule).
 */
export interface TaskWithOwners extends TaskRow {
  ownerMemberIds: string[];
  autoAssignedRuleId: string | null;
}

type OwnerRow = { familyMemberId: string; autoAssignedRuleId: string | null };

/** Owner rows for a batch of tasks, oldest claim first, keyed by task id. */
export async function ownerRowsFor(
  db: Db,
  taskIds: string[],
): Promise<Map<string, OwnerRow[]>> {
  const byTask = new Map<string, OwnerRow[]>();
  if (taskIds.length === 0) return byTask;
  const rows = await db
    .select({
      taskId: taskOwners.taskId,
      familyMemberId: taskOwners.familyMemberId,
      autoAssignedRuleId: taskOwners.autoAssignedRuleId,
    })
    .from(taskOwners)
    .where(inArray(taskOwners.taskId, taskIds))
    .orderBy(taskOwners.createdAt);
  for (const r of rows) {
    const list = byTask.get(r.taskId) ?? [];
    list.push({
      familyMemberId: r.familyMemberId,
      autoAssignedRuleId: r.autoAssignedRuleId,
    });
    byTask.set(r.taskId, list);
  }
  return byTask;
}

/** Decorate task rows with their owner set, in one extra query. */
export async function withOwners(
  db: Db,
  rows: TaskRow[],
): Promise<TaskWithOwners[]> {
  const byTask = await ownerRowsFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => {
    const owners = byTask.get(row.id) ?? [];
    return {
      ...row,
      ownerMemberIds: owners.map((o) => o.familyMemberId),
      autoAssignedRuleId:
        owners.length > 0 && owners.every((o) => o.autoAssignedRuleId != null)
          ? owners[0]!.autoAssignedRuleId
          : null,
    };
  });
}

/** True when every current owner is there because an assignment rule put them there. */
export function isRuleOwned(owners: OwnerRow[]): boolean {
  return owners.length > 0 && owners.every((o) => o.autoAssignedRuleId != null);
}

/**
 * Set a task's owners to exactly `memberIds` and keep everything that hangs off
 * ownership in step: `tasks.status` (the set's summary — `owned` iff somebody
 * is covering it), the claimed events on each owner's unified calendar, and,
 * for a human action, the `manualOwnerOverride` that opts the task out of the
 * rule engine for good.
 *
 * Returns the updated task and every member whose calendar changed — the
 * caller enqueues a mirror reconcile for each (never awaited in a request path).
 */
export async function setTaskOwners(
  db: Db,
  task: TaskRow,
  memberIds: string[],
  opts: { manual: boolean; ruleId?: string | null; status?: TaskStatus },
): Promise<{ task: TaskRow; affected: string[] }> {
  const before = (await ownerRowsFor(db, [task.id])).get(task.id) ?? [];
  const priorIds = before.map((o) => o.familyMemberId);
  const wanted = [...new Set(memberIds)];

  const removed = priorIds.filter((id) => !wanted.includes(id));
  const added = wanted.filter((id) => !priorIds.includes(id));

  if (removed.length > 0) {
    await db
      .delete(taskOwners)
      .where(
        and(
          eq(taskOwners.taskId, task.id),
          inArray(taskOwners.familyMemberId, removed),
        ),
      );
  }
  for (const familyMemberId of added) {
    await db.insert(taskOwners).values({
      taskId: task.id,
      familyMemberId,
      autoAssignedRuleId: opts.ruleId ?? null,
    });
  }
  // Keep the surviving rows' rule stamps in step. A human action always wins
  // over the rule engine, so every stamp in the set goes and task-gen stops
  // moving this task around; a rule claim stamps the set with the rule that
  // matched *this* time, which is how a task that changes hands between two
  // rules stops re-reconciling on every pass.
  const stamp = opts.manual ? null : (opts.ruleId ?? null);
  const kept = before.filter((o) => wanted.includes(o.familyMemberId));
  if (kept.some((o) => o.autoAssignedRuleId !== stamp)) {
    await db
      .update(taskOwners)
      .set({ autoAssignedRuleId: stamp })
      .where(eq(taskOwners.taskId, task.id));
  }

  const updated = (
    await db
      .update(tasks)
      .set({
        status: opts.status ?? (wanted.length > 0 ? 'owned' : 'unowned'),
        ...(opts.manual ? { manualOwnerOverride: true } : {}),
      })
      .where(eq(tasks.id, task.id))
      .returning()
  )[0]!;

  await syncClaimEvents(db, updated, wanted);
  return { task: updated, affected: [...removed, ...added] };
}
