import {
  and,
  asc,
  eq,
  familyMemberFeeds,
  familyMembers,
  getDb,
  taskRules,
} from '@igt/db';
import {
  CreateTaskRuleInput,
  ReorderTaskRulesInput,
  SetTaskDefaultInput,
  UpdateTaskRuleInput,
} from '@igt/domain';
import { Hono } from 'hono';
import type { Bindings, HonoEnv } from '../env.js';
import { requireAdmin, requireFamilyMember } from '../middleware/auth.js';
import { enqueueReconcile } from '../services/mirror.js';
import { rebuildMemberTasks } from '../services/task-gen.js';

/**
 * A member's task-rule pipeline (screen 6k/6n): what tasks their events
 * generate. One flat ordered list per member; each rule is scoped to one
 * calendar or all of them. Mounted under /families/:familyId.
 */
export const taskRuleRoutes = new Hono<HonoEnv>();
taskRuleRoutes.use('*', requireFamilyMember);

async function loadMember(
  db: ReturnType<typeof getDb>,
  familyId: string,
  memberId: string,
) {
  return (
    await db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.id, memberId), eq(familyMembers.familyId, familyId)))
      .limit(1)
  )[0];
}

/** Rebuild the member's tasks + reconcile their mirror after a rule change. */
async function afterChange(
  c: { env: Bindings; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  db: ReturnType<typeof getDb>,
  memberId: string,
): Promise<void> {
  await rebuildMemberTasks(db, memberId);
  enqueueReconcile(c, { kind: 'member', memberId });
}

/**
 * The member's whole task-rule pipeline + every calendar's default. The client
 * (6k) filters to the active calendar's applicable subset with the same rule
 * the engine uses. `defaults.unified` is the member's own calendar; `links`
 * maps each linked feed to its default.
 */
taskRuleRoutes.get('/members/:memberId/task-rules', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);

  const rules = await db
    .select()
    .from(taskRules)
    .where(eq(taskRules.familyMemberId, member.id))
    .orderBy(asc(taskRules.position));
  const links = await db
    .select()
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.familyMemberId, member.id));

  return c.json({
    rules,
    defaults: {
      unified: {
        defaultResultType: member.unifiedDefaultTaskType,
        dropoffWindowMin: member.unifiedDropoffWindowMin,
        pickupWindowMin: member.unifiedPickupWindowMin,
      },
      links: Object.fromEntries(
        links.map((l) => [
          l.id,
          {
            defaultResultType: l.defaultTaskType,
            dropoffWindowMin: l.defaultDropoffWindowMin,
            pickupWindowMin: l.defaultPickupWindowMin,
          },
        ]),
      ),
    },
  });
});

/** Create a task rule (admin), appended to the member's pipeline. */
taskRuleRoutes.post('/members/:memberId/task-rules', requireAdmin, async (c) => {
  const parsed = CreateTaskRuleInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);
  const d = parsed.data;

  const existing = await db
    .select()
    .from(taskRules)
    .where(eq(taskRules.familyMemberId, member.id))
    .orderBy(asc(taskRules.position));
  const position = Math.min(d.position ?? existing.length, existing.length);
  for (let i = existing.length - 1; i >= position; i--) {
    await db
      .update(taskRules)
      .set({ position: i + 1 })
      .where(eq(taskRules.id, existing[i]!.id));
  }

  const rule = (
    await db
      .insert(taskRules)
      .values({
        familyId: me.familyId,
        familyMemberId: member.id,
        linkId: d.scope === 'all_calendars' ? null : (d.linkId ?? null),
        scope: d.scope,
        position,
        matchField: d.matchField,
        matchOp: d.matchOp,
        matchValue: d.matchValue ?? null,
        resultType: d.resultType,
        dropoffWindowMin: d.dropoffWindowMin ?? null,
        pickupWindowMin: d.pickupWindowMin ?? null,
      })
      .returning()
  )[0]!;

  await afterChange(c, db, member.id);
  return c.json({ rule }, 201);
});

/** Update a task rule (admin). */
taskRuleRoutes.patch('/members/:memberId/task-rules/:ruleId', requireAdmin, async (c) => {
  const parsed = UpdateTaskRuleInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);

  const rule = (
    await db
      .select()
      .from(taskRules)
      .where(
        and(eq(taskRules.id, c.req.param('ruleId')), eq(taskRules.familyMemberId, member.id)),
      )
      .limit(1)
  )[0];
  if (!rule) return c.json({ error: 'rule_not_found' }, 404);

  const d = parsed.data;
  const set: Partial<typeof taskRules.$inferInsert> = {};
  if (d.scope !== undefined) {
    set.scope = d.scope;
    if (d.scope === 'all_calendars') set.linkId = null;
  }
  if (d.matchField !== undefined) set.matchField = d.matchField;
  if (d.matchOp !== undefined) set.matchOp = d.matchOp;
  if ('matchValue' in d) set.matchValue = d.matchValue ?? null;
  if (d.resultType !== undefined) set.resultType = d.resultType;
  if ('dropoffWindowMin' in d) set.dropoffWindowMin = d.dropoffWindowMin ?? null;
  if ('pickupWindowMin' in d) set.pickupWindowMin = d.pickupWindowMin ?? null;
  if (Object.keys(set).length > 0) {
    await db.update(taskRules).set(set).where(eq(taskRules.id, rule.id));
  }

  await afterChange(c, db, member.id);
  const updated = (
    await db.select().from(taskRules).where(eq(taskRules.id, rule.id)).limit(1)
  )[0]!;
  return c.json({ rule: updated });
});

/** Delete a task rule (admin) and close the pipeline gap. */
taskRuleRoutes.delete('/members/:memberId/task-rules/:ruleId', requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);

  const deleted = (
    await db
      .delete(taskRules)
      .where(
        and(eq(taskRules.id, c.req.param('ruleId')), eq(taskRules.familyMemberId, member.id)),
      )
      .returning()
  )[0];
  if (!deleted) return c.json({ error: 'rule_not_found' }, 404);

  const remaining = await db
    .select()
    .from(taskRules)
    .where(eq(taskRules.familyMemberId, member.id))
    .orderBy(asc(taskRules.position));
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i]!.position !== i) {
      await db.update(taskRules).set({ position: i }).where(eq(taskRules.id, remaining[i]!.id));
    }
  }

  await afterChange(c, db, member.id);
  return c.json({ ok: true });
});

/**
 * Reorder the rules visible in one calendar's pipeline (admin). The client
 * sends the visible subset's ids in their new order; we reassign only the
 * global positions those rules occupy, so rules hidden from this calendar view
 * stay interleaved where they were.
 */
taskRuleRoutes.put('/members/:memberId/task-rules/order', requireAdmin, async (c) => {
  const parsed = ReorderTaskRulesInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);

  const all = await db
    .select()
    .from(taskRules)
    .where(eq(taskRules.familyMemberId, member.id))
    .orderBy(asc(taskRules.position));
  const byId = new Map(all.map((r) => [r.id, r]));
  const requested = parsed.data.ruleIds;
  if (!requested.every((id) => byId.has(id)) || new Set(requested).size !== requested.length) {
    return c.json({ error: 'order_mismatch' }, 400);
  }

  // The global slots the visible subset currently occupies, ascending.
  const slots = requested
    .map((id) => byId.get(id)!.position)
    .sort((a, b) => a - b);
  for (let i = 0; i < requested.length; i++) {
    await db
      .update(taskRules)
      .set({ position: slots[i]! })
      .where(eq(taskRules.id, requested[i]!));
  }

  await afterChange(c, db, member.id);
  const reordered = await db
    .select()
    .from(taskRules)
    .where(eq(taskRules.familyMemberId, member.id))
    .orderBy(asc(taskRules.position));
  return c.json({ rules: reordered });
});

/**
 * Set a calendar's terminal default (admin) — what an unmatched event
 * generates. `linkId` null = the member's own unified/direct calendar.
 */
taskRuleRoutes.put('/members/:memberId/task-default', requireAdmin, async (c) => {
  const parsed = SetTaskDefaultInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);
  const d = parsed.data;

  if (d.linkId) {
    const link = (
      await db
        .select()
        .from(familyMemberFeeds)
        .where(
          and(
            eq(familyMemberFeeds.id, d.linkId),
            eq(familyMemberFeeds.familyMemberId, member.id),
          ),
        )
        .limit(1)
    )[0];
    if (!link) return c.json({ error: 'link_not_found' }, 404);
    await db
      .update(familyMemberFeeds)
      .set({
        defaultTaskType: d.defaultResultType,
        defaultDropoffWindowMin: d.dropoffWindowMin ?? link.defaultDropoffWindowMin,
        defaultPickupWindowMin: d.pickupWindowMin ?? link.defaultPickupWindowMin,
      })
      .where(eq(familyMemberFeeds.id, link.id));
  } else {
    await db
      .update(familyMembers)
      .set({
        unifiedDefaultTaskType: d.defaultResultType,
        unifiedDropoffWindowMin: d.dropoffWindowMin ?? member.unifiedDropoffWindowMin,
        unifiedPickupWindowMin: d.pickupWindowMin ?? member.unifiedPickupWindowMin,
      })
      .where(eq(familyMembers.id, member.id));
  }

  await afterChange(c, db, member.id);
  return c.json({ ok: true });
});
