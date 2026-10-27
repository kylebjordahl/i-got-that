import {
  and,
  asc,
  calendarEvents,
  eq,
  familyMemberFeeds,
  familyMembers,
  getDb,
  taskRuleExceptions,
  taskRules,
} from '@igt/db';
import type { TaskRuleLike } from '@igt/classification';
import {
  CreateTaskRuleInput,
  PreviewTaskRuleInput,
  ReorderTaskRulesInput,
  RuleMatchWindowInput,
  SetTaskDefaultInput,
  TaskRuleExceptionInput,
  UpdateTaskRuleInput,
} from '@igt/domain';
import { Hono } from 'hono';
import type { Bindings, HonoEnv } from '../env.js';
import { requireAdmin, requireFamilyMember } from '../middleware/auth.js';
import { enqueueReconcile } from '../services/mirror.js';
import { defaultMatchWindow, matchTaskRule } from '../services/rule-matches.js';
import { buildMemberTasks, rebuildMemberTasks, toTaskRuleLike } from '../services/task-gen.js';

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

// --- What a rule catches (match list, dry-run preview, one-off omissions) ----

/** The window a match list covers: the request's, else the past/next 30 days. */
function matchWindow(from?: string, to?: string): { from: Date; to: Date } {
  const fallback = defaultMatchWindow();
  return {
    from: from ? new Date(from) : fallback.from,
    to: to ? new Date(to) : fallback.to,
  };
}

/**
 * Every event in the window this rule's matcher catches on its calendars, with
 * how the member's pipeline resolves each (`applies` / `shadowed` by an earlier
 * rule / `omitted` one-off) and the tasks each has now. Read-only, so any
 * family member may look.
 */
taskRuleRoutes.get('/members/:memberId/task-rules/:ruleId/matches', async (c) => {
  const parsed = RuleMatchWindowInput.safeParse({
    from: c.req.query('from'),
    to: c.req.query('to'),
  });
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);

  const pipeline = (
    await db.select().from(taskRules).where(eq(taskRules.familyMemberId, member.id))
  ).map(toTaskRuleLike);
  const target = pipeline.find((r) => r.id === c.req.param('ruleId'));
  if (!target) return c.json({ error: 'rule_not_found' }, 404);

  const window = matchWindow(parsed.data.from, parsed.data.to);
  const matches = await matchTaskRule(db, member.id, target, pipeline, window, {
    withTasks: true,
  });
  return c.json({
    from: window.from,
    to: window.to,
    generatesFamilyTasks: member.generatesFamilyTasks,
    matches,
  });
});

/**
 * Dry-run an unsaved rule from the editor: what it would catch in the window,
 * and what each of those would then generate. The draft stands in for the rule
 * named by `ruleId` (keeping its place in the pipeline and its omissions), or
 * is inserted at `rule.position` (default: appended, as a create would). Reads
 * only, so it doesn't need admin.
 */
taskRuleRoutes.post('/members/:memberId/task-rules/preview', async (c) => {
  const parsed = PreviewTaskRuleInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const windowParsed = RuleMatchWindowInput.safeParse({
    from: parsed.data.from,
    to: parsed.data.to,
  });
  if (!windowParsed.success) {
    return c.json({ error: 'invalid', issues: windowParsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);

  // The saved pipeline, renumbered to its order so a draft can slot between.
  const saved = (
    await db
      .select()
      .from(taskRules)
      .where(eq(taskRules.familyMemberId, member.id))
      .orderBy(asc(taskRules.position))
  ).map((r, i) => ({ ...toTaskRuleLike(r), position: i }));
  const d = parsed.data.rule;
  const editing = parsed.data.ruleId
    ? saved.find((r) => r.id === parsed.data.ruleId)
    : undefined;
  if (parsed.data.ruleId && !editing) return c.json({ error: 'rule_not_found' }, 404);

  const draft: TaskRuleLike = {
    id: editing?.id ?? 'draft',
    position: editing
      ? editing.position
      : Math.min(d.position ?? saved.length, saved.length) - 0.5,
    scope: d.scope,
    linkId: d.scope === 'all_calendars' ? null : (d.linkId ?? null),
    matchField: d.matchField,
    matchOp: d.matchOp,
    matchValue: d.matchValue ?? null,
    resultType: d.resultType,
    dropoffWindowMin: d.dropoffWindowMin ?? null,
    pickupWindowMin: d.pickupWindowMin ?? null,
  };
  const pipeline = [...saved.filter((r) => r.id !== draft.id), draft];

  const window = matchWindow(windowParsed.data.from, windowParsed.data.to);
  const matches = await matchTaskRule(db, member.id, draft, pipeline, window, {
    withTasks: false,
  });
  return c.json({ from: window.from, to: window.to, matches });
});

/** The rule and the calendar event an omission names, both scoped to the member. */
async function ruleAndEvent(
  db: ReturnType<typeof getDb>,
  memberId: string,
  ruleId: string,
  calendarEventId: string,
) {
  const rule = (
    await db
      .select()
      .from(taskRules)
      .where(and(eq(taskRules.id, ruleId), eq(taskRules.familyMemberId, memberId)))
      .limit(1)
  )[0];
  const event = (
    await db
      .select()
      .from(calendarEvents)
      .where(
        and(eq(calendarEvents.id, calendarEventId), eq(calendarEvents.familyMemberId, memberId)),
      )
      .limit(1)
  )[0];
  return { rule, event };
}

/** Re-type one event after its omissions changed, then reconcile the mirror. */
async function rebuildEvent(
  c: { env: Bindings; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  db: ReturnType<typeof getDb>,
  memberId: string,
  eventId: string,
): Promise<void> {
  // The event's content didn't change, so its build stamp would skip it.
  await db
    .update(calendarEvents)
    .set({ tasksBuiltHash: null })
    .where(eq(calendarEvents.id, eventId));
  await buildMemberTasks(db, memberId);
  enqueueReconcile(c, { kind: 'member', memberId });
}

/**
 * Omit one event from a rule (admin) — a one-off exception: the event falls
 * through to the next matching rule or its calendar's default, as if this rule
 * didn't match it. Tasks someone already covers are kept, as with any re-type.
 */
taskRuleRoutes.post('/members/:memberId/task-rules/:ruleId/exceptions', requireAdmin, async (c) => {
  const parsed = TaskRuleExceptionInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);
  const { rule, event } = await ruleAndEvent(
    db,
    member.id,
    c.req.param('ruleId'),
    parsed.data.calendarEventId,
  );
  if (!rule) return c.json({ error: 'rule_not_found' }, 404);
  if (!event) return c.json({ error: 'event_not_found' }, 404);

  await db
    .insert(taskRuleExceptions)
    .values({ familyId: me.familyId, ruleId: rule.id, calendarEventId: event.id })
    .onConflictDoNothing();
  await rebuildEvent(c, db, member.id, event.id);
  return c.json({ ok: true }, 201);
});

/** Put an omitted event back under the rule (admin). */
taskRuleRoutes.delete(
  '/members/:memberId/task-rules/:ruleId/exceptions/:calendarEventId',
  requireAdmin,
  async (c) => {
    const db = getDb(c.env.DB);
    const me = c.get('member');
    const member = await loadMember(db, me.familyId, c.req.param('memberId'));
    if (!member) return c.json({ error: 'not_found' }, 404);
    const { rule, event } = await ruleAndEvent(
      db,
      member.id,
      c.req.param('ruleId'),
      c.req.param('calendarEventId'),
    );
    if (!rule) return c.json({ error: 'rule_not_found' }, 404);
    if (!event) return c.json({ error: 'event_not_found' }, 404);

    await db
      .delete(taskRuleExceptions)
      .where(
        and(
          eq(taskRuleExceptions.ruleId, rule.id),
          eq(taskRuleExceptions.calendarEventId, event.id),
        ),
      );
    await rebuildEvent(c, db, member.id, event.id);
    return c.json({ ok: true });
  },
);
