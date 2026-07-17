import {
  and,
  asc,
  calendarEvents,
  eq,
  familyMembers,
  feeds,
  getDb,
  gte,
  inArray,
  lt,
  pendingDecisions,
  sourceEvents,
  tasks,
} from '@igt/db';
import {
  AssignTaskInput,
  ConvertTaskInput,
  ResolvePendingDecisionInput,
  SetTaskDurationInput,
} from '@igt/domain';
import { transitionWindow, wallTimeToUtc, startOfUtcDay } from '@igt/classification';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { requireFamilyMember } from '../middleware/auth.js';
import { removeClaimEvent, upsertClaimEvent } from '../services/claim.js';
import { enqueueReconcile, getProductionRegistry, syncFamilyMirror } from '../services/mirror.js';
import { hashCalendarEvent } from '../services/synthesis.js';
import { buildMemberTasks } from '../services/task-gen.js';

/** Mounted under /families/:familyId (auth applied by parent router). */
export const taskRoutes = new Hono<HonoEnv>();
taskRoutes.use('*', requireFamilyMember);

// --- Tasks (the claim hub) -------------------------------------------------

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
 * any other claim-capable member. Works from both the unowned and an already
 * owned state (reassignment). The claimed task becomes an event on the new
 * owner's unified calendar (the recursion) and both owners' mirrors reconcile.
 */
taskRoutes.post('/tasks/:taskId/assign', async (c) => {
  const parsed = AssignTaskInput.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  const db = getDb(c.env.DB);
  const me = c.get('member');
  const targetMemberId = parsed.data.memberId ?? me.id;

  // Target must be a claim-capable member of this family.
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

  // The recursion: the claimed task lands on the owner's unified calendar
  // (reassignment moves the same event). DB writes first, then reconcile the
  // new owner's mirror; on a reassignment also the former owner's.
  await upsertClaimEvent(db, updated);
  enqueueReconcile(c, { kind: 'member', memberId: targetMemberId });
  if (formerOwner && formerOwner !== targetMemberId) {
    enqueueReconcile(c, { kind: 'member', memberId: formerOwner });
  }
  return c.json({ task: updated });
});

/** Release a task back to the unowned pool (its claimed event is removed). */
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

  await removeClaimEvent(db, task.id);
  // Reconcile the former owner's mirror (the event is no longer desired).
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
  await removeClaimEvent(db, task.id);
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
 * Convert a generated task into a chosen set of types (attendance / pickup /
 * drop-off). Reconciles the whole (calendar event, member) group to exactly the
 * requested types, marking them `manual` so a rebuild won't reclassify them.
 * Ownership is preserved on a kept type; dropped types are removed (their
 * claimed events go too) and every former owner's mirror is re-synced.
 */
taskRoutes.post('/tasks/:taskId/convert', async (c) => {
  const parsed = ConvertTaskInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  const desired = new Set(parsed.data.types);

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
  // Conversion is an event-derived concept; fully-manual tasks have no event.
  if (!task.calendarEventId) return c.json({ error: 'not_convertible' }, 400);

  const event = (
    await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, task.calendarEventId))
      .limit(1)
  )[0];
  if (!event) return c.json({ error: 'task_not_found' }, 404);

  const groupWhere = eq(tasks.calendarEventId, task.calendarEventId);
  const group = await db.select().from(tasks).where(groupWhere);

  // Owners whose mirrors must re-sync: anyone owning a group task before the
  // change (a dropped type leaves their calendar; a kept type's mirrored title
  // may change with its type).
  const affectedOwners = new Set(
    group.map((t) => t.ownerMemberId).filter((id): id is string => id != null),
  );
  const existingTypes = new Set(group.map((t) => t.type));

  for (const t of group) {
    if (desired.has(t.type)) {
      if (t.createdVia !== 'manual') {
        await db.update(tasks).set({ createdVia: 'manual' }).where(eq(tasks.id, t.id));
      }
    } else {
      await removeClaimEvent(db, t.id);
      await db.delete(tasks).where(eq(tasks.id, t.id));
    }
  }
  for (const type of desired) {
    if (existingTypes.has(type)) continue;
    const anchorStart =
      type === 'pickup' ? (event.dtend ?? event.dtstart) : event.dtstart;
    await db.insert(tasks).values({
      familyId: task.familyId,
      calendarEventId: task.calendarEventId,
      familyMemberId: task.familyMemberId,
      type,
      attendanceRequirement: 'any',
      dtstart: anchorStart,
      dtend: type === 'attendance' ? event.dtend : null,
      location: event.location,
      status: 'unowned',
      createdVia: 'manual',
    });
  }

  for (const memberId of affectedOwners) {
    enqueueReconcile(c, { kind: 'member', memberId });
  }

  const updated = await db.select().from(tasks).where(groupWhere);
  return c.json({ tasks: updated });
});

/**
 * Set a transition task's (pickup / drop-off) window length in minutes,
 * measured from its anchor — the parent event's start for a drop-off, its end
 * for a pickup. A positive value extends the window forward from the anchor; a
 * negative value reverses it, sitting before the anchor (so the drop-off/pickup
 * runs the opposite direction); 0 collapses it to a point. The override is
 * stamped on the task so a rebuild re-anchors around it rather than recomputing
 * the rule-derived window, and the whole transition pair is frozen to `manual`
 * (mirrors convert()) so reclassification can't wipe the customization. An owned
 * task's claimed mirror event is re-synced.
 */
taskRoutes.post('/tasks/:taskId/duration', async (c) => {
  const parsed = SetTaskDurationInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  const { durationMinutes } = parsed.data;

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
  if (task.type !== 'pickup' && task.type !== 'dropoff') {
    return c.json({ error: 'not_a_transition' }, 400);
  }

  // The anchor stays pinned to the source event (drop-off ⇒ start, pickup ⇒
  // end). Fall back to the task's own stored anchor when the event is gone,
  // reading the anchored end according to the current override's sign.
  let anchor: Date;
  const event = task.calendarEventId
    ? (
        await db
          .select()
          .from(calendarEvents)
          .where(eq(calendarEvents.id, task.calendarEventId))
          .limit(1)
      )[0]
    : undefined;
  if (event) {
    anchor = task.type === 'pickup' ? (event.dtend ?? event.dtstart) : event.dtstart;
  } else {
    anchor =
      task.durationOverrideMin != null && task.durationOverrideMin < 0 && task.dtend
        ? task.dtend
        : task.dtstart;
  }

  const { dtstart, dtend } = transitionWindow(anchor, durationMinutes);

  // Freeze the transition pair so a rebuild won't reclassify or drop it, then
  // stamp the new window + override on this task.
  if (task.calendarEventId) {
    await db
      .update(tasks)
      .set({ createdVia: 'manual' })
      .where(
        and(
          eq(tasks.calendarEventId, task.calendarEventId),
          inArray(tasks.type, ['pickup', 'dropoff']),
        ),
      );
  }
  const updated = (
    await db
      .update(tasks)
      .set({ dtstart, dtend, durationOverrideMin: durationMinutes, createdVia: 'manual' })
      .where(eq(tasks.id, task.id))
      .returning()
  )[0]!;

  // Owned ⇒ the claimed mirror event tracks the task's window; re-sync it.
  if (updated.status === 'owned' && updated.ownerMemberId) {
    await upsertClaimEvent(db, updated);
    enqueueReconcile(c, { kind: 'member', memberId: updated.ownerMemberId });
  }
  return c.json({ task: updated });
});

// --- Pending decisions -----------------------------------------------------

/** Open pending decisions, with the source event's payload for the card copy. */
taskRoutes.get('/pending-decisions', async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const rows = await db
    .select({
      id: pendingDecisions.id,
      feedId: pendingDecisions.feedId,
      linkId: pendingDecisions.linkId,
      familyMemberId: pendingDecisions.familyMemberId,
      sourceEventId: pendingDecisions.sourceEventId,
      status: pendingDecisions.status,
      createdAt: pendingDecisions.createdAt,
      summary: sourceEvents.summary,
      location: sourceEvents.location,
      dtstart: sourceEvents.dtstart,
      dtend: sourceEvents.dtend,
      allDay: sourceEvents.allDay,
    })
    .from(pendingDecisions)
    .innerJoin(sourceEvents, eq(sourceEvents.id, pendingDecisions.sourceEventId))
    .where(
      and(
        eq(pendingDecisions.familyId, familyId),
        eq(pendingDecisions.status, 'pending'),
      ),
    )
    .orderBy(asc(sourceEvents.dtstart));
  return c.json({ decisions: rows });
});

/**
 * Resolve a pending decision: the unmatched event becomes a synthesized event
 * (`pd:` key) on the member's unified calendar with the chosen task types, its
 * tasks are generated immediately, and the member's mirror reconciles. Optional
 * start-time/duration adjustments override the source event's own times.
 */
taskRoutes.post('/pending-decisions/:decisionId/resolve', async (c) => {
  const parsed = ResolvePendingDecisionInput.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');

  const decision = (
    await db
      .select()
      .from(pendingDecisions)
      .where(
        and(
          eq(pendingDecisions.id, c.req.param('decisionId')),
          eq(pendingDecisions.familyId, me.familyId),
        ),
      )
      .limit(1)
  )[0];
  if (!decision) return c.json({ error: 'not_found' }, 404);
  if (decision.status !== 'pending') return c.json({ error: 'not_pending' }, 409);

  const source = (
    await db
      .select()
      .from(sourceEvents)
      .where(eq(sourceEvents.id, decision.sourceEventId))
      .limit(1)
  )[0];
  if (!source) return c.json({ error: 'not_found' }, 404);

  // Adjusted times are wall-clock in the feed's zone (same as baseline times).
  const feed = (
    await db.select().from(feeds).where(eq(feeds.id, decision.feedId)).limit(1)
  )[0];
  const tz = feed?.timezone ?? 'UTC';

  // Resolving accepts the event onto the calendar as a normal scheduled day;
  // task typing then flows through the member's task rules like any event.
  // Optional adjustments override the source event's own times (wall-clock in
  // the feed's zone, matching baseline times).
  const d = parsed.data;
  let dtstart = source.dtstart;
  let dtend = source.dtend;
  let allDay = source.allDay;
  if (d.startTime) {
    dtstart = wallTimeToUtc(startOfUtcDay(source.dtstart), d.startTime, 8, tz);
    allDay = false;
    dtend = dtend && dtend.getTime() > dtstart.getTime() ? dtend : null;
  }
  if (d.endTime) {
    dtend = wallTimeToUtc(startOfUtcDay(dtstart), d.endTime, 15, tz);
    allDay = false;
  }

  const payload = {
    dtstart,
    dtend,
    allDay,
    summary: source.summary,
    location: source.location,
    description: null,
  };
  await db.insert(calendarEvents).values({
    familyId: me.familyId,
    familyMemberId: decision.familyMemberId,
    provenance: 'synthesized',
    synthKey: `pd:${decision.id}`,
    linkId: decision.linkId,
    sourceEventId: decision.sourceEventId,
    pendingDecisionId: decision.id,
    contentHash: hashCalendarEvent(payload),
    ...payload,
  });
  await db
    .update(pendingDecisions)
    .set({
      status: 'resolved',
      resolvedByMemberId: me.id,
      resolvedAt: new Date(),
    })
    .where(eq(pendingDecisions.id, decision.id));

  await buildMemberTasks(db, decision.familyMemberId);
  enqueueReconcile(c, { kind: 'member', memberId: decision.familyMemberId });
  return c.json({ ok: true });
});

/** Dismiss a pending decision — the event stays off the unified calendar. */
taskRoutes.post('/pending-decisions/:decisionId/dismiss', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const decision = (
    await db
      .select()
      .from(pendingDecisions)
      .where(
        and(
          eq(pendingDecisions.id, c.req.param('decisionId')),
          eq(pendingDecisions.familyId, me.familyId),
        ),
      )
      .limit(1)
  )[0];
  if (!decision) return c.json({ error: 'not_found' }, 404);
  if (decision.status !== 'pending') return c.json({ error: 'not_pending' }, 409);

  await db
    .update(pendingDecisions)
    .set({ status: 'dismissed', dismissedAt: new Date() })
    .where(eq(pendingDecisions.id, decision.id));
  return c.json({ ok: true });
});

// --- Unified-calendar events (Plan / member views) ---------------------------

/**
 * Unified-calendar events for the family (or one member), optionally windowed.
 * Includes provenance + taskId so the client can thread a claimed event back to
 * its task and render synthesized vs human vs claimed treatments.
 */
taskRoutes.get('/calendar-events', async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const memberId = c.req.query('memberId');
  const from = c.req.query('from');
  const to = c.req.query('to');

  const conditions = [eq(calendarEvents.familyId, familyId)];
  if (memberId) conditions.push(eq(calendarEvents.familyMemberId, memberId));
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) conditions.push(gte(calendarEvents.dtstart, d));
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) conditions.push(lt(calendarEvents.dtstart, d));
  }

  const rows = await db
    .select({
      id: calendarEvents.id,
      familyMemberId: calendarEvents.familyMemberId,
      provenance: calendarEvents.provenance,
      linkId: calendarEvents.linkId,
      taskId: calendarEvents.taskId,
      dtstart: calendarEvents.dtstart,
      dtend: calendarEvents.dtend,
      allDay: calendarEvents.allDay,
      summary: calendarEvents.summary,
      location: calendarEvents.location,
    })
    .from(calendarEvents)
    .where(and(...conditions))
    .orderBy(asc(calendarEvents.dtstart));
  return c.json({ events: rows });
});

/**
 * Source feed events for oversight — the raw calendar events behind synthesis,
 * so config screens can show what a feed carries (and dismiss bad events).
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
 * Re-mirror every member's unified calendar to their target. Use after
 * connecting a target (events synthesized earlier were never mirrored) — there
 * is no automatic backfill. Returns counts + any per-member errors.
 */
taskRoutes.post('/mirror/resync', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const result = await syncFamilyMirror(db, getProductionRegistry(c.env), c.env.KEK, me.familyId);
  return c.json(result);
});
