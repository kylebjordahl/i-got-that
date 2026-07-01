import {
  and,
  asc,
  classificationRules,
  eq,
  familyMembers,
  getDb,
  sourceEvents,
  tasks,
} from '@igt/db';
import { AssignTaskInput, CreateClassificationRuleInput, UpdateClassificationRuleInput } from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { requireAdmin, requireFamilyMember } from '../middleware/auth.js';
import {
  enqueueReconcile,
  getProductionRegistry,
  syncFamily,
} from '../services/delivery.js';

/** Mounted under /families/:familyId (auth applied by parent router). */
export const taskRoutes = new Hono<HonoEnv>();
taskRoutes.use('*', requireFamilyMember);

// --- Classification rules ------------------------------------------------

taskRoutes.post('/classification-rules', requireAdmin, async (c) => {
  const parsed = CreateClassificationRuleInput.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const rule = (
    await getDb(c.env.DB)
      .insert(classificationRules)
      .values({
        familyId: c.get('member').familyId,
        feedId: parsed.data.feedId ?? null,
        priority: parsed.data.priority,
        matchField: parsed.data.matchField,
        matchOp: parsed.data.matchOp,
        matchValue: parsed.data.matchValue,
        effect: parsed.data.effect,
        producesTypes: parsed.data.producesTypes ?? null,
        defaultAttendance: parsed.data.defaultAttendance ?? null,
        shiftToTime: parsed.data.shiftToTime ?? null,
        defaultOwnerMemberId: parsed.data.defaultOwnerMemberId ?? null,
      })
      .returning()
  )[0]!;
  return c.json({ rule }, 201);
});

taskRoutes.get('/classification-rules', async (c) => {
  const rows = await getDb(c.env.DB)
    .select()
    .from(classificationRules)
    .where(eq(classificationRules.familyId, c.get('member').familyId));
  return c.json({ rules: rows });
});

taskRoutes.patch('/classification-rules/:ruleId', requireAdmin, async (c) => {
  const me = c.get('member');
  const ruleId = c.req.param('ruleId');
  const parsed = UpdateClassificationRuleInput.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }

  const data = parsed.data;
  // Build the update set with only the keys the client explicitly sent.
  // Checking 'key in data' distinguishes "omitted" (leave unchanged) from an
  // explicit null (clear the nullable column). Do NOT use ?? null coalescing
  // for omitted keys — that would silently erase fields the caller didn't touch.
  const set: Record<string, unknown> = {};
  if ('feedId' in data) set.feedId = data.feedId ?? null;
  if ('priority' in data) set.priority = data.priority;
  if ('matchField' in data) set.matchField = data.matchField;
  if ('matchOp' in data) set.matchOp = data.matchOp;
  if ('matchValue' in data) set.matchValue = data.matchValue;
  if ('effect' in data) set.effect = data.effect;
  if ('producesTypes' in data) set.producesTypes = data.producesTypes ?? null;
  if ('defaultAttendance' in data) set.defaultAttendance = data.defaultAttendance ?? null;
  if ('shiftToTime' in data) set.shiftToTime = data.shiftToTime ?? null;
  if ('defaultOwnerMemberId' in data) set.defaultOwnerMemberId = data.defaultOwnerMemberId ?? null;

  const db = getDb(c.env.DB);

  // Empty body (no recognized keys) → return current row unchanged (idempotent).
  // Avoids a Drizzle error from an empty SET clause.
  if (Object.keys(set).length === 0) {
    const existing = (
      await db
        .select()
        .from(classificationRules)
        .where(
          and(
            eq(classificationRules.id, ruleId),
            eq(classificationRules.familyId, me.familyId),
          ),
        )
        .limit(1)
    )[0];
    if (!existing) return c.json({ error: 'rule_not_found' }, 404);
    return c.json({ rule: existing });
  }

  const updated = (
    await db
      .update(classificationRules)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set(set as any)
      .where(
        and(
          eq(classificationRules.id, ruleId),
          eq(classificationRules.familyId, me.familyId),
        ),
      )
      .returning()
  )[0];

  if (!updated) return c.json({ error: 'rule_not_found' }, 404);
  return c.json({ rule: updated });
});

taskRoutes.delete('/classification-rules/:ruleId', requireAdmin, async (c) => {
  const me = c.get('member');
  const ruleId = c.req.param('ruleId');
  const deleted = (
    await getDb(c.env.DB)
      .delete(classificationRules)
      .where(
        and(
          eq(classificationRules.id, ruleId),
          eq(classificationRules.familyId, me.familyId),
        ),
      )
      .returning()
  )[0];
  if (!deleted) return c.json({ error: 'rule_not_found' }, 404);
  return c.json({ ok: true });
});

// --- Tasks (unowned dashboard + assignment) ------------------------------

taskRoutes.get('/tasks', async (c) => {
  const status = c.req.query('status'); // 'unowned' | 'owned' | undefined (all)
  const familyId = c.get('member').familyId;
  const where =
    status === 'unowned' || status === 'owned'
      ? and(eq(tasks.familyId, familyId), eq(tasks.status, status))
      : eq(tasks.familyId, familyId);

  const rows = await getDb(c.env.DB)
    .select()
    .from(tasks)
    .where(where)
    .orderBy(asc(tasks.dtstart));
  return c.json({ tasks: rows });
});

/**
 * Assign a task to a caretaker — claim it for yourself (default) or hand it to
 * any other caretaker in the family. Works from both the unowned and an already
 * owned state (reassignment).
 */
taskRoutes.post('/tasks/:taskId/assign', async (c) => {
  const parsed = AssignTaskInput.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  const db = getDb(c.env.DB);
  const me = c.get('member');
  const targetMemberId = parsed.data.memberId ?? me.id;

  // Target must be a caretaker in this family.
  const target = (
    await db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.id, targetMemberId),
          eq(familyMembers.familyId, me.familyId),
        ),
      )
      .limit(1)
  )[0];
  if (!target) return c.json({ error: 'member_not_found' }, 404);
  if (!target.isCaretaker) return c.json({ error: 'not_a_caretaker' }, 400);

  // Task must belong to this family.
  const task = (
    await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, c.req.param('taskId')),
          eq(tasks.familyId, me.familyId),
        ),
      )
      .limit(1)
  )[0];
  if (!task) return c.json({ error: 'task_not_found' }, 404);

  const formerOwner = task.ownerMemberId;
  const updated = (
    await db
      .update(tasks)
      .set({ ownerMemberId: targetMemberId, status: 'owned' })
      .where(eq(tasks.id, task.id))
      .returning()
  )[0]!;

  // Reconcile the new owner's calendars (queued); on a reassignment also
  // reconcile the former owner so the event leaves their calendar.
  enqueueReconcile(c, { kind: 'member', memberId: targetMemberId });
  if (formerOwner && formerOwner !== targetMemberId) {
    enqueueReconcile(c, { kind: 'member', memberId: formerOwner });
  }
  return c.json({ task: updated });
});

/** Release a task back to the unowned pool. */
taskRoutes.post('/tasks/:taskId/unassign', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');

  const task = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, c.req.param('taskId')), eq(tasks.familyId, me.familyId)))
      .limit(1)
  )[0];
  if (!task) return c.json({ error: 'task_not_found' }, 404);

  const formerOwner = task.ownerMemberId;
  const updated = (
    await db
      .update(tasks)
      .set({ ownerMemberId: null, status: 'unowned' })
      .where(eq(tasks.id, task.id))
      .returning()
  )[0]!;

  // Reconcile the former owner's calendars (the event is no longer desired).
  if (formerOwner) {
    enqueueReconcile(c, { kind: 'member', memberId: formerOwner });
  }
  return c.json({ task: updated });
});

/** Mark a task as unneeded — drops it from the queue + the owner's calendar. */
taskRoutes.post('/tasks/:taskId/dismiss', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const task = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, c.req.param('taskId')), eq(tasks.familyId, me.familyId)))
      .limit(1)
  )[0];
  if (!task) return c.json({ error: 'task_not_found' }, 404);

  const formerOwner = task.ownerMemberId;
  const updated = (
    await db
      .update(tasks)
      .set({ status: 'dismissed', ownerMemberId: null })
      .where(eq(tasks.id, task.id))
      .returning()
  )[0]!;
  if (formerOwner) {
    enqueueReconcile(c, { kind: 'member', memberId: formerOwner });
  }
  return c.json({ task: updated });
});

/** Restore a dismissed task back to the unowned pool. */
taskRoutes.post('/tasks/:taskId/restore', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const task = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, c.req.param('taskId')), eq(tasks.familyId, me.familyId)))
      .limit(1)
  )[0];
  if (!task) return c.json({ error: 'task_not_found' }, 404);

  const updated = (
    await db
      .update(tasks)
      .set({ status: 'unowned', ownerMemberId: null })
      .where(eq(tasks.id, task.id))
      .returning()
  )[0]!;
  return c.json({ task: updated });
});

/**
 * Source feed events for oversight — the raw calendar events behind the tasks,
 * so the All view can show generated tasks alongside their originating event.
 * Unbounded, mirroring the tasks endpoint; the client relates by event id.
 */
taskRoutes.get('/source-events', async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const rows = await db
    .select({
      id: sourceEvents.id,
      feedId: sourceEvents.feedId,
      dtstart: sourceEvents.dtstart,
      dtend: sourceEvents.dtend,
      allDay: sourceEvents.allDay,
      summary: sourceEvents.summary,
      location: sourceEvents.location,
      dismissedAt: sourceEvents.dismissedAt,
    })
    .from(sourceEvents)
    .where(eq(sourceEvents.familyId, familyId))
    .orderBy(asc(sourceEvents.dtstart));
  return c.json({ events: rows });
});

/**
 * Re-deliver every owned task to its owner's calendars. Use after connecting a
 * calendar (tasks claimed earlier were never delivered) — there is no automatic
 * backfill. Returns counts + any per-task errors so failures are visible.
 */
taskRoutes.post('/tasks/resync-deliveries', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const result = await syncFamily(db, getProductionRegistry(c.env), c.env.KEK, me.familyId);
  return c.json(result);
});
