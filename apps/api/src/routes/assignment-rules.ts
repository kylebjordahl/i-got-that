import {
  and,
  asc,
  assignmentRules,
  eq,
  familyMemberFeeds,
  familyMembers,
  getDb,
} from '@igt/db';
import {
  CreateAssignmentRuleInput,
  ReorderAssignmentRulesInput,
  UpdateAssignmentRuleInput,
} from '@igt/domain';
import { Hono } from 'hono';
import type { Bindings, HonoEnv } from '../env.js';
import { requireAdmin, requireFamilyMember } from '../middleware/auth.js';
import { enqueueReconcile } from '../services/mirror.js';
import { rebuildFamilyTasks } from '../services/task-gen.js';

/**
 * A family's assignment-rule pipeline: which caretaker auto-claims a matching
 * generated task. One flat ordered list per family (first match wins). Mounted
 * under /families/:familyId.
 */
export const assignmentRuleRoutes = new Hono<HonoEnv>();
assignmentRuleRoutes.use('*', requireFamilyMember);

/** Rebuild the family's tasks + reconcile every mirror after a rule change. */
async function afterChange(
  c: { env: Bindings; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  db: ReturnType<typeof getDb>,
  familyId: string,
): Promise<void> {
  await rebuildFamilyTasks(db, familyId);
  enqueueReconcile(c, { kind: 'family', familyId });
}

/** Validate that a member id belongs to this family (and optionally is a caretaker). */
async function memberInFamily(
  db: ReturnType<typeof getDb>,
  familyId: string,
  memberId: string,
): Promise<typeof familyMembers.$inferSelect | undefined> {
  return (
    await db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.id, memberId), eq(familyMembers.familyId, familyId)))
      .limit(1)
  )[0];
}

async function linkInFamily(
  db: ReturnType<typeof getDb>,
  familyId: string,
  linkId: string,
): Promise<typeof familyMemberFeeds.$inferSelect | undefined> {
  return (
    await db
      .select()
      .from(familyMemberFeeds)
      .where(and(eq(familyMemberFeeds.id, linkId), eq(familyMemberFeeds.familyId, familyId)))
      .limit(1)
  )[0];
}

/**
 * The family's whole assignment pipeline (ordered) plus the source-calendar
 * links the editor's per-feed picker needs. Caretakers / dependents are sourced
 * from the client's existing member providers.
 */
assignmentRuleRoutes.get('/assignment-rules', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');

  const rules = await db
    .select()
    .from(assignmentRules)
    .where(eq(assignmentRules.familyId, me.familyId))
    .orderBy(asc(assignmentRules.position));
  const links = await db
    .select({
      id: familyMemberFeeds.id,
      feedId: familyMemberFeeds.feedId,
      familyMemberId: familyMemberFeeds.familyMemberId,
    })
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.familyId, me.familyId));

  return c.json({ rules, links });
});

/** Create an assignment rule (admin), appended to the family's pipeline. */
assignmentRuleRoutes.post('/assignment-rules', requireAdmin, async (c) => {
  const parsed = CreateAssignmentRuleInput.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const d = parsed.data;

  // Owner must be a claim-capable member of this family.
  const owner = await memberInFamily(db, me.familyId, d.ownerMemberId);
  if (!owner) return c.json({ error: 'owner_not_found' }, 404);
  if (!owner.isCaretaker) return c.json({ error: 'not_a_caretaker' }, 400);
  if (d.aboutMemberId && !(await memberInFamily(db, me.familyId, d.aboutMemberId))) {
    return c.json({ error: 'about_member_not_found' }, 404);
  }
  if (d.linkId && !(await linkInFamily(db, me.familyId, d.linkId))) {
    return c.json({ error: 'link_not_found' }, 404);
  }

  const existing = await db
    .select()
    .from(assignmentRules)
    .where(eq(assignmentRules.familyId, me.familyId))
    .orderBy(asc(assignmentRules.position));
  const position = Math.min(d.position ?? existing.length, existing.length);
  for (let i = existing.length - 1; i >= position; i--) {
    await db
      .update(assignmentRules)
      .set({ position: i + 1 })
      .where(eq(assignmentRules.id, existing[i]!.id));
  }

  const rule = (
    await db
      .insert(assignmentRules)
      .values({
        familyId: me.familyId,
        ownerMemberId: d.ownerMemberId,
        aboutMemberId: d.aboutMemberId ?? null,
        linkId: d.linkId ?? null,
        taskType: d.taskType ?? null,
        position,
        weekdayMask: d.weekdayMask,
        cadenceWeeks: d.cadenceWeeks,
        anchorDate: d.anchorDate != null ? new Date(d.anchorDate) : null,
      })
      .returning()
  )[0]!;

  await afterChange(c, db, me.familyId);
  return c.json({ rule }, 201);
});

/** Update an assignment rule (admin). */
assignmentRuleRoutes.patch('/assignment-rules/:ruleId', requireAdmin, async (c) => {
  const parsed = UpdateAssignmentRuleInput.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');

  const rule = (
    await db
      .select()
      .from(assignmentRules)
      .where(
        and(
          eq(assignmentRules.id, c.req.param('ruleId')),
          eq(assignmentRules.familyId, me.familyId),
        ),
      )
      .limit(1)
  )[0];
  if (!rule) return c.json({ error: 'rule_not_found' }, 404);

  const d = parsed.data;
  const set: Partial<typeof assignmentRules.$inferInsert> = {};
  if (d.ownerMemberId !== undefined) {
    const owner = await memberInFamily(db, me.familyId, d.ownerMemberId);
    if (!owner) return c.json({ error: 'owner_not_found' }, 404);
    if (!owner.isCaretaker) return c.json({ error: 'not_a_caretaker' }, 400);
    set.ownerMemberId = d.ownerMemberId;
  }
  if ('aboutMemberId' in d) {
    if (d.aboutMemberId && !(await memberInFamily(db, me.familyId, d.aboutMemberId))) {
      return c.json({ error: 'about_member_not_found' }, 404);
    }
    set.aboutMemberId = d.aboutMemberId ?? null;
  }
  if ('linkId' in d) {
    if (d.linkId && !(await linkInFamily(db, me.familyId, d.linkId))) {
      return c.json({ error: 'link_not_found' }, 404);
    }
    set.linkId = d.linkId ?? null;
  }
  if ('taskType' in d) set.taskType = d.taskType ?? null;
  if (d.weekdayMask !== undefined) set.weekdayMask = d.weekdayMask;
  if (d.cadenceWeeks !== undefined) set.cadenceWeeks = d.cadenceWeeks;
  if ('anchorDate' in d) {
    set.anchorDate = d.anchorDate != null ? new Date(d.anchorDate) : null;
  }
  if (Object.keys(set).length > 0) {
    await db.update(assignmentRules).set(set).where(eq(assignmentRules.id, rule.id));
  }

  await afterChange(c, db, me.familyId);
  const updated = (
    await db.select().from(assignmentRules).where(eq(assignmentRules.id, rule.id)).limit(1)
  )[0]!;
  return c.json({ rule: updated });
});

/** Delete an assignment rule (admin) and close the pipeline gap. */
assignmentRuleRoutes.delete('/assignment-rules/:ruleId', requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');

  const deleted = (
    await db
      .delete(assignmentRules)
      .where(
        and(
          eq(assignmentRules.id, c.req.param('ruleId')),
          eq(assignmentRules.familyId, me.familyId),
        ),
      )
      .returning()
  )[0];
  if (!deleted) return c.json({ error: 'rule_not_found' }, 404);

  const remaining = await db
    .select()
    .from(assignmentRules)
    .where(eq(assignmentRules.familyId, me.familyId))
    .orderBy(asc(assignmentRules.position));
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i]!.position !== i) {
      await db
        .update(assignmentRules)
        .set({ position: i })
        .where(eq(assignmentRules.id, remaining[i]!.id));
    }
  }

  await afterChange(c, db, me.familyId);
  return c.json({ ok: true });
});

/** Reorder the family's assignment rules (admin) — every rule id once, new order. */
assignmentRuleRoutes.put('/assignment-rules/order', requireAdmin, async (c) => {
  const parsed = ReorderAssignmentRulesInput.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');

  const all = await db
    .select()
    .from(assignmentRules)
    .where(eq(assignmentRules.familyId, me.familyId))
    .orderBy(asc(assignmentRules.position));
  const ids = new Set(all.map((r) => r.id));
  const requested = parsed.data.ruleIds;
  if (
    requested.length !== all.length ||
    !requested.every((id) => ids.has(id)) ||
    new Set(requested).size !== requested.length
  ) {
    return c.json({ error: 'order_mismatch' }, 400);
  }

  for (let i = 0; i < requested.length; i++) {
    await db
      .update(assignmentRules)
      .set({ position: i })
      .where(eq(assignmentRules.id, requested[i]!));
  }

  await afterChange(c, db, me.familyId);
  const reordered = await db
    .select()
    .from(assignmentRules)
    .where(eq(assignmentRules.familyId, me.familyId))
    .orderBy(asc(assignmentRules.position));
  return c.json({ rules: reordered });
});
