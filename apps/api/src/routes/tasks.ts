import {
  and,
  asc,
  classificationRules,
  eq,
  familyMembers,
  getDb,
  tasks,
} from '@igt/db';
import { AssignTaskInput, CreateClassificationRuleInput } from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { requireAdmin, requireFamilyMember } from '../middleware/auth.js';
import {
  cancelTaskDeliveries,
  deliverTask,
  getProductionRegistry,
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

/** Take ownership of a task (defaults to the caller; admins may assign others). */
taskRoutes.post('/tasks/:taskId/assign', async (c) => {
  const parsed = AssignTaskInput.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  const db = getDb(c.env.DB);
  const me = c.get('member');
  const targetMemberId = parsed.data.memberId ?? me.id;

  // Only admins may assign someone other than themselves.
  if (targetMemberId !== me.id && !me.isAdmin) {
    return c.json({ error: 'forbidden_admin' }, 403);
  }

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

  const updated = (
    await db
      .update(tasks)
      .set({ ownerMemberId: targetMemberId, status: 'owned' })
      .where(eq(tasks.id, task.id))
      .returning()
  )[0]!;

  // Best-effort: push to the owner's calendars. Assignment succeeds regardless.
  try {
    await deliverTask(db, getProductionRegistry(c.env), c.env.KEK, updated.id);
  } catch (err) {
    console.error('deliverTask failed', err);
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

  try {
    await cancelTaskDeliveries(db, getProductionRegistry(c.env), c.env.KEK, task.id);
  } catch (err) {
    console.error('cancelTaskDeliveries failed', err);
  }

  const updated = (
    await db
      .update(tasks)
      .set({ ownerMemberId: null, status: 'unowned' })
      .where(eq(tasks.id, task.id))
      .returning()
  )[0]!;
  return c.json({ task: updated });
});

/**
 * Re-deliver every owned task to its owner's calendars. Use after connecting a
 * calendar (tasks claimed earlier were never delivered) — there is no automatic
 * backfill. Returns counts + any per-task errors so failures are visible.
 */
taskRoutes.post('/tasks/resync-deliveries', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const owned = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.familyId, me.familyId), eq(tasks.status, 'owned')));

  const registry = getProductionRegistry(c.env);
  let delivered = 0;
  const errors: { taskId: string; error: string }[] = [];
  for (const t of owned) {
    try {
      delivered += await deliverTask(db, registry, c.env.KEK, t.id);
    } catch (err) {
      errors.push({ taskId: t.id, error: String(err) });
    }
  }
  return c.json({ ownedTasks: owned.length, delivered, errors });
});
