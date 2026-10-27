import {
  and,
  assignmentRules,
  calendarEvents,
  type Db,
  eq,
  familyMemberFeeds,
  familyMembers,
  feeds,
  inArray,
  isNotNull,
  isNull,
  memberCalendars,
  ne,
  or,
  sourceEvents,
  sql,
  taskRuleExceptions,
  taskRules,
  tasks,
} from '@igt/db';
import {
  firstMatch,
  generateTaskIntents,
  resolveTaskOwner,
  resolveTaskResult,
  transitionWindow,
  type AssignmentCandidate,
  type AssignmentRuleLike,
  type TaskDefault,
  type TaskIntent,
  type TaskRuleLike,
  taskRulesForCalendar,
} from '@igt/classification';
import { geoKey, type GeoLocation } from '@igt/domain';
import {
  batchChunked,
  type BatchStatement,
  chunkForD1,
  runChunked,
  selectChunked,
} from '../lib/d1.js';
import { activeHorizon, endsAtOrAfter } from './synthesis.js';
import { isRuleOwned, type OwnerRow, ownerRowsFor, setTaskOwners } from './task-owners.js';

type CalendarEventRow = typeof calendarEvents.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

export interface TaskGenResult {
  familyMemberId: string;
  tasksCreated: number;
  tasksRemoved: number;
}

export function toTaskRuleLike(r: typeof taskRules.$inferSelect): TaskRuleLike {
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

/**
 * Which of these events a `none` task rule deliberately leaves without tasks —
 * so a client showing one with nothing to claim can say "a rule skips this"
 * instead of offering to rebuild it (a rebuild would just come back empty).
 *
 * The same first-match resolution task-gen runs, but only a matching `none`
 * rule counts (a calendar's default is never `none`), and not on an event a
 * user converted, whose frozen `manual` tasks no rule touches. Descriptions (which rules
 * may match but the calendar event doesn't carry for a feed event) are read
 * only when some `none` rule actually matches on one.
 */
export async function eventsSkippedByTaskRules(
  db: Db,
  events: {
    id: string;
    familyMemberId: string;
    linkId: string | null;
    sourceEventId: string | null;
    summary: string | null;
    location: string | null;
    description: string | null;
    allDay: boolean;
    dtstart: Date;
    dtend: Date | null;
  }[],
): Promise<Set<string>> {
  const skipped = new Set<string>();
  const memberIds = [...new Set(events.map((e) => e.familyMemberId))];
  if (memberIds.length === 0) return skipped;
  // Bounded by the family's members, so one unchunked read is fine.
  const rules = (
    await db.select().from(taskRules).where(inArray(taskRules.familyMemberId, memberIds))
  ).map((r) => ({ ...toTaskRuleLike(r), familyMemberId: r.familyMemberId }));
  const skipRules = rules.filter((r) => r.resultType === 'none');
  if (skipRules.length === 0) return skipped;

  const skipMembers = new Set(skipRules.map((r) => r.familyMemberId));
  const candidates = events.filter((e) => skipMembers.has(e.familyMemberId));
  const needsDescription = skipRules.some(
    (r) => r.matchField === 'description' || r.matchField === 'any_text',
  );
  const sourceIds = needsDescription
    ? [
        ...new Set(
          candidates.flatMap((e) =>
            e.description == null && e.sourceEventId ? [e.sourceEventId] : [],
          ),
        ),
      ]
    : [];
  const sourceDescriptions = new Map(
    (
      await selectChunked(sourceIds, (chunk) =>
        db
          .select({ id: sourceEvents.id, description: sourceEvents.description })
          .from(sourceEvents)
          .where(and(inArray(sourceEvents.id, chunk), isNotNull(sourceEvents.description))),
      )
    ).map((r): [string, string | null] => [r.id, r.description]),
  );

  const rulesByMember = new Map<string, TaskRuleLike[]>();
  for (const r of rules) {
    const list = rulesByMember.get(r.familyMemberId) ?? [];
    list.push(r);
    rulesByMember.set(r.familyMemberId, list);
  }
  const omissions = await taskRuleOmissions(
    db,
    candidates.map((e) => e.id),
  );
  for (const e of candidates) {
    const omitted = omissions.get(e.id);
    const match = firstMatch(
      {
        summary: e.summary,
        location: e.location,
        description:
          e.description ??
          (e.sourceEventId ? sourceDescriptions.get(e.sourceEventId) : null) ??
          null,
        allDay: e.allDay,
        dtstart: e.dtstart,
        dtend: e.dtend,
      },
      taskRulesForCalendar(rulesByMember.get(e.familyMemberId) ?? [], e.linkId).filter(
        (r) => !omitted?.has(r.id),
      ),
    );
    if (match?.resultType === 'none') skipped.add(e.id);
  }

  // A user-converted (`manual`) task set is frozen — task-gen keeps it whatever
  // the rules say — so an event holding one isn't skipped, and a rebuild of it
  // (restoring dismissed manual rows) still has something to bring back.
  const manualEvents = await selectChunked([...skipped], (chunk) =>
    db
      .select({ calendarEventId: tasks.calendarEventId })
      .from(tasks)
      .where(and(inArray(tasks.calendarEventId, chunk), eq(tasks.createdVia, 'manual'))),
  );
  for (const t of manualEvents) skipped.delete(t.calendarEventId!);
  return skipped;
}

/**
 * The task rules each of these events has been omitted from (one-off
 * exceptions made from a rule's match list), as eventId → rule ids. Events with
 * none are absent. Chunked: the ids grow with a member's calendar.
 */
export async function taskRuleOmissions(
  db: Db,
  eventIds: string[],
): Promise<Map<string, Set<string>>> {
  const rows = await selectChunked(eventIds, (chunk) =>
    db
      .select({
        calendarEventId: taskRuleExceptions.calendarEventId,
        ruleId: taskRuleExceptions.ruleId,
      })
      .from(taskRuleExceptions)
      .where(inArray(taskRuleExceptions.calendarEventId, chunk)),
  );
  const byEvent = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byEvent.get(r.calendarEventId) ?? new Set<string>();
    set.add(r.ruleId);
    byEvent.set(r.calendarEventId, set);
  }
  return byEvent;
}

function toAssignmentRuleLike(
  r: typeof assignmentRules.$inferSelect,
): AssignmentRuleLike {
  return {
    id: r.id,
    position: r.position,
    ownerMemberId: r.ownerMemberId,
    aboutMemberId: r.aboutMemberId,
    linkId: r.linkId,
    taskType: r.taskType,
    weekdayMask: r.weekdayMask,
    cadenceWeeks: r.cadenceWeeks,
    anchorDate: r.anchorDate,
  };
}

/**
 * The IANA zones a member's events are read in, loaded once per task-gen pass:
 * each of the member's links resolves to its feed's zone (the same zone
 * synthesis reads that feed's baseline in), and everything else — a link whose
 * feed has no zone, a human read-back event, the member's own direct calendar —
 * falls back to the member's target calendar's zone, then UTC. Assignment rules
 * judge an event's weekday by the local date it starts on, so they need to know
 * where "local" is.
 */
interface MemberZones {
  byLink: Map<string, string>;
  member: string | null;
}

async function loadMemberZones(
  db: Db,
  familyId: string,
  familyMemberId: string,
): Promise<MemberZones> {
  const rows = await db
    .select({ linkId: familyMemberFeeds.id, timezone: feeds.timezone })
    .from(familyMemberFeeds)
    .innerJoin(feeds, eq(feeds.id, familyMemberFeeds.feedId))
    .where(
      and(
        eq(familyMemberFeeds.familyMemberId, familyMemberId),
        eq(feeds.familyId, familyId),
      ),
    );
  const calendar = (
    await db
      .select({ timezone: memberCalendars.timezone })
      .from(memberCalendars)
      .where(eq(memberCalendars.familyMemberId, familyMemberId))
      .limit(1)
  )[0];
  return {
    byLink: new Map(
      rows.flatMap((r): [string, string][] => (r.timezone ? [[r.linkId, r.timezone]] : [])),
    ),
    member: calendar?.timezone ?? null,
  };
}

function zoneFor(zones: MemberZones, linkId: string | null): string {
  return (linkId ? zones.byLink.get(linkId) : undefined) ?? zones.member ?? 'UTC';
}

/** Everything task-gen needs to auto-assign a member's tasks, loaded once. */
interface AssignmentContext {
  rules: AssignmentRuleLike[];
  caretakerIds: Set<string>;
}

/**
 * Reconcile one task's ownership against the family's assignment rules. A rule
 * may claim an unowned task, move a rule-owned task to a new owner, or release a
 * rule-owned task whose rule no longer matches. It never touches a task a human
 * owns or has touched (`manualOwnerOverride`) — a manual action always wins,
 * including the extra caretakers a human adds to an attendance claim, which is
 * why a rule only ever owns a task on its own.
 * Returns true when ownership changed (so the caller can reconcile mirrors).
 *
 * `preloaded` is the task's owner rows when the caller already has them (task-gen
 * reads a whole chunk of events' owners in one go; a task it just inserted has
 * none), which saves the per-task read. Left out, they are read here.
 */
async function reconcileTaskOwner(
  db: Db,
  task: TaskRow,
  cand: AssignmentCandidate,
  ctx: AssignmentContext,
  preloaded?: OwnerRow[],
): Promise<boolean> {
  if (
    task.manualOwnerOverride ||
    task.createdVia === 'manual' ||
    task.status === 'dismissed'
  ) {
    return false;
  }
  const owners = preloaded ?? (await ownerRowsFor(db, [task.id])).get(task.id) ?? [];
  const ruleOwned = isRuleOwned(owners);
  if (task.status === 'owned' && !ruleOwned) return false;

  const match = resolveTaskOwner(cand, ctx.rules);
  const owner = match && ctx.caretakerIds.has(match.ownerMemberId) ? match : null;

  if (owner) {
    if (
      owners.length === 1 &&
      owners[0]!.familyMemberId === owner.ownerMemberId &&
      owners[0]!.autoAssignedRuleId === owner.id
    ) {
      return false; // already correctly rule-owned
    }
    await setTaskOwners(db, task, [owner.ownerMemberId], {
      manual: false,
      ruleId: owner.id,
    });
    return true;
  }

  if (ruleOwned) {
    // Was rule-owned but no rule matches now → release back to the unowned pool.
    await setTaskOwners(db, task, [], { manual: false });
    return true;
  }

  return false;
}

/**
 * Heal an existing task's anchor/window/location (text *and* geocode — a place
 * re-pinned without a text change still has to reach the claimed event, which
 * is what carries travel time out) if the event moved. Callers
 * pass the task's own current `dtend` to leave it untouched (manual tasks,
 * whose window is user-set) or a freshly recomputed one to keep it in step
 * with the anchor (generated tasks) — otherwise a healed dtstart would drift
 * out of sync with a stale dtend still anchored to the event's old time.
 *
 * Returns the write (unawaited — the caller batches them) or null when the
 * task already matches.
 */
function healStatement(
  db: Db,
  task: TaskRow,
  dtstart: Date,
  dtend: Date | null,
  location: string | null,
  locationGeo: GeoLocation | null,
): BatchStatement | null {
  if (
    task.dtstart.getTime() === dtstart.getTime() &&
    (task.dtend?.getTime() ?? null) === (dtend?.getTime() ?? null) &&
    (task.location ?? null) === (location ?? null) &&
    geoKey(task.locationGeo) === geoKey(locationGeo)
  ) {
    return null;
  }
  return db
    .update(tasks)
    .set({ dtstart, dtend, location, locationGeo })
    .where(eq(tasks.id, task.id));
}

/** The start anchor a given task type takes on an event (for manual healing). */
function anchorStart(event: CalendarEventRow, type: string): Date {
  return type === 'pickup' ? (event.dtend ?? event.dtstart) : event.dtstart;
}

/**
 * How many dirty events `buildMemberTasks` reads, writes and stamps together.
 * Each chunk costs a handful of round trips whatever its size (one read of its
 * events' tasks, one of their owners, the batched writes, the batched stamps),
 * so a bigger chunk saves little past this point — while a chunk is also the
 * most work an exception can send back to square one, since its stamps are the
 * last thing it writes.
 */
const TASKGEN_EVENT_CHUNK = 50;

/** What `buildMemberTasks` loaded once and hands to every chunk. */
interface BuildPass {
  rules: TaskRuleLike[];
  linkDefault: Map<string, TaskDefault>;
  unifiedDefault: TaskDefault;
  assignCtx: AssignmentContext;
  zones: MemberZones;
}

/**
 * What is left to do for one task once the chunk's task writes have landed:
 * reconcile its owner against the assignment rules. Done after the writes, not
 * before, because a rule match goes through `setTaskOwners` and from there to
 * `syncClaimEvents`, which reads the task back from the database — it has to see
 * the healed anchor/location, not the pre-heal one.
 */
type OwnerStep =
  | { kind: 'existing'; task: TaskRow; cand: AssignmentCandidate }
  | {
      kind: 'inserted';
      event: CalendarEventRow;
      intent: TaskIntent;
      cand: AssignmentCandidate;
      /** Index of this task's INSERT in the chunk's write list. */
      at: number;
    };

/**
 * Reconcile the tasks of a chunk of dirty events (never `claimed_task`, never
 * masked): what each should have, against what it has.
 *
 * It used to be one pass per event, each with its own SELECT of the event's
 * tasks, an UPDATE/DELETE/INSERT per task and a stamp — 245 D1 round trips to
 * build ~50 events' tasks. Now the reads are shared across the chunk (its tasks,
 * then the owners of the ones that could be reconciled), the decisions are made
 * in memory, and the writes go out as `db.batch()` calls: first every undesired
 * unowned task's delete, then the heals and inserts in event order, then — after
 * ownership has been reconciled — every event's `tasksBuiltHash` stamp.
 *
 * Only an assignment-rule match writes per task from here (`setTaskOwners`
 * moves ownership, claimed events and mirrors, and has to read its own state);
 * most tasks never match one.
 */
async function buildEventTasks(
  db: Db,
  events: CalendarEventRow[],
  pass: BuildPass,
  result: TaskGenResult,
): Promise<void> {
  // Busy blocks (`fb:` — free/busy firewall intervals) are opaque availability,
  // never family logistics: they must not spawn claimable tasks even for
  // members whose events otherwise generate them. They only need their stamp,
  // so the row doesn't stay dirty forever.
  const buildable = events.filter((e) => !e.synthKey.startsWith('fb:'));

  const taskRows = await selectChunked(
    buildable.map((e) => e.id),
    (chunk) => db.select().from(tasks).where(inArray(tasks.calendarEventId, chunk)),
  );
  const tasksByEvent = new Map<string, TaskRow[]>();
  for (const t of taskRows) {
    const list = tasksByEvent.get(t.calendarEventId!) ?? [];
    list.push(t);
    tasksByEvent.set(t.calendarEventId!, list);
  }

  // The source DESCRIPTION of each feed event, which the task rules may match on
  // but which is deliberately not on the calendar event (it would reach the
  // mirror and email invites). One chunked read for the whole batch of events,
  // looked up below; an event with no description isn't returned at all.
  const sourceIds = [
    ...new Set(buildable.flatMap((e) => (e.sourceEventId ? [e.sourceEventId] : []))),
  ];
  const sourceDescriptions = new Map(
    (
      await selectChunked(sourceIds, (chunk) =>
        db
          .select({ id: sourceEvents.id, description: sourceEvents.description })
          .from(sourceEvents)
          .where(and(inArray(sourceEvents.id, chunk), isNotNull(sourceEvents.description))),
      )
    ).map((r): [string, string | null] => [r.id, r.description]),
  );

  // One-off omissions (an event excepted from a rule) — only possible when the
  // member has rules at all, so a rule-less member pays no read for them.
  const omissions =
    pass.rules.length > 0
      ? await taskRuleOmissions(
          db,
          buildable.map((e) => e.id),
        )
      : new Map<string, Set<string>>();

  // Decide what each event should have (pure: no reads or writes in here).
  const plans = buildable.map((event) => {
    const fallback =
      (event.linkId && pass.linkDefault.get(event.linkId)) || pass.unifiedDefault;
    const resolution = resolveTaskResult(
      {
        summary: event.summary,
        location: event.location,
        // A human event's own description, else the feed event's source text.
        description:
          event.description ??
          (event.sourceEventId ? sourceDescriptions.get(event.sourceEventId) : null) ??
          null,
        allDay: event.allDay,
        dtstart: event.dtstart,
        dtend: event.dtend,
      },
      pass.rules,
      event.linkId ?? null,
      fallback,
      omissions.get(event.id),
    );
    return {
      event,
      intents: generateTaskIntents(event, resolution),
      existing: tasksByEvent.get(event.id) ?? [],
    };
  });

  // The owner rows `reconcileTaskOwner` is going to ask for: tasks of an event
  // with no user-converted task (those only heal), whose type the event still
  // wants, and that the rule engine is allowed to touch at all.
  const needOwners: string[] = [];
  for (const { intents, existing } of plans) {
    if (existing.some((t) => t.createdVia === 'manual')) continue;
    const wanted = new Set(intents.map((i) => i.type));
    for (const t of existing) {
      if (wanted.has(t.type) && !t.manualOwnerOverride && t.status !== 'dismissed') {
        needOwners.push(t.id);
      }
    }
  }
  const ownersByTask = await ownerRowsFor(db, needOwners);

  const deletedIds: string[] = [];
  const writes: BatchStatement[] = [];
  const steps: OwnerStep[] = [];
  for (const { event, intents, existing } of plans) {
    // User-converted tasks freeze the type set; only heal their anchors. A
    // transition task with a user-set duration override re-derives both ends
    // from the (moved) anchor so its signed window is preserved; others keep
    // their own dtend and just re-anchor dtstart.
    const manual = existing.filter((t) => t.createdVia === 'manual');
    if (manual.length > 0) {
      for (const t of manual) {
        const anchor = anchorStart(event, t.type);
        let heal: BatchStatement | null;
        if (t.durationOverrideMin != null && t.type !== 'attendance') {
          const w = transitionWindow(anchor, t.durationOverrideMin);
          heal = healStatement(db, t, w.dtstart, w.dtend, event.location, event.locationGeo);
        } else {
          heal = healStatement(db, t, anchor, t.dtend, event.location, event.locationGeo);
        }
        if (heal) writes.push(heal);
      }
      continue;
    }

    const desiredByType = new Map(intents.map((i) => [i.type, i]));
    for (const t of existing) {
      if (!desiredByType.has(t.type) && t.status === 'unowned') {
        deletedIds.push(t.id);
        result.tasksRemoved++;
      }
    }
    const existingByType = new Map(existing.map((t) => [t.type, t]));
    for (const intent of intents) {
      // Auto-assignment reads the day/feed/child the EVENT falls on (task type
      // aside), so weekday + every-other-week patterns key off the event's
      // LOCAL date — read in the event's own zone, not UTC, or an evening
      // event is tested as the next weekday.
      const cand: AssignmentCandidate = {
        aboutMemberId: event.familyMemberId,
        linkId: event.linkId ?? null,
        type: intent.type,
        dtstart: event.dtstart,
        allDay: event.allDay,
        tz: zoneFor(pass.zones, event.linkId ?? null),
      };
      const prior = existingByType.get(intent.type);
      if (prior) {
        const heal = healStatement(
          db,
          prior,
          intent.dtstart,
          intent.dtend,
          intent.location,
          intent.locationGeo,
        );
        if (heal) writes.push(heal);
        steps.push({ kind: 'existing', task: prior, cand });
      } else {
        // Idempotent against a concurrent run: another task-gen (cron tick,
        // or a route handler's inline pipeline) may have inserted this same
        // (event, type) since our snapshot read above. The partial unique
        // index `tasks_generated_event_type_uq` turns the loser's insert
        // into a no-op instead of a permanent duplicate. No conflict target
        // on purpose: SQLite requires a partial index's WHERE to be repeated
        // in the target, and a bare DO NOTHING covers it without that.
        steps.push({ kind: 'inserted', event, intent, cand, at: writes.length });
        writes.push(
          db
            .insert(tasks)
            .values({
              familyId: event.familyId,
              calendarEventId: event.id,
              familyMemberId: event.familyMemberId,
              type: intent.type,
              attendanceRequirement: intent.attendanceRequirement,
              dtstart: intent.dtstart,
              dtend: intent.dtend,
              location: intent.location,
              locationGeo: intent.locationGeo,
              status: 'unowned',
              createdVia: 'generated',
            })
            .onConflictDoNothing()
            .returning(),
        );
      }
    }
  }

  // Deletes ahead of everything else, so `at` (an index into `writes`) shifts by
  // however many delete statements there are.
  const deletes = chunkForD1(deletedIds).map((chunk) =>
    db.delete(tasks).where(inArray(tasks.id, chunk)),
  );
  const results = await batchChunked(db, [...deletes, ...writes]);

  for (const step of steps) {
    if (step.kind === 'existing') {
      await reconcileTaskOwner(
        db,
        step.task,
        step.cand,
        pass.assignCtx,
        ownersByTask.get(step.task.id) ?? [],
      );
      continue;
    }
    let row = (results[deletes.length + step.at] as TaskRow[] | undefined)?.[0];
    // A task this chunk just inserted has no owners yet. One that lost the race
    // (the insert came back empty) is the winner's row, and *is* the task: it
    // may have been mid-flight (inserted but not yet auto-assigned) when it
    // read, so its owners are read fresh by `reconcileTaskOwner`.
    let owners: OwnerRow[] | undefined = [];
    if (row) {
      result.tasksCreated++;
    } else {
      owners = undefined;
      row = (
        await db
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.calendarEventId, step.event.id),
              eq(tasks.type, step.intent.type),
              eq(tasks.createdVia, 'generated'),
            ),
          )
          .limit(1)
      )[0];
    }
    if (row) await reconcileTaskOwner(db, row, step.cand, pass.assignCtx, owners);
  }

  // Stamp last: an event is only "built" once everything above landed. The
  // stamp is the hash this pass read, not the row's current one, so an event
  // that changed underneath us stays dirty for the next pass.
  await batchChunked(
    db,
    events.map((e) =>
      db
        .update(calendarEvents)
        .set({ tasksBuiltHash: e.contentHash })
        .where(eq(calendarEvents.id, e.id)),
    ),
  );
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

  // Generation paused for this member: drop their unowned event-derived tasks
  // (owned tasks + their calendar defaults/rules are kept) and stop.
  if (!member.generatesFamilyTasks) {
    const removed = await db
      .delete(tasks)
      .where(
        and(
          eq(tasks.familyMemberId, familyMemberId),
          eq(tasks.status, 'unowned'),
          sql`${tasks.calendarEventId} IS NOT NULL`,
        ),
      )
      .returning({ id: tasks.id });
    result.tasksRemoved = removed.length;
    return result;
  }

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

  // The family's assignment-rule pipeline that could apply to this member's
  // tasks (about-any or about-this-member), plus who may own a task, loaded once.
  const assignCtx: AssignmentContext = {
    rules: (
      await db
        .select()
        .from(assignmentRules)
        .where(
          and(
            eq(assignmentRules.familyId, member.familyId),
            or(
              isNull(assignmentRules.aboutMemberId),
              eq(assignmentRules.aboutMemberId, familyMemberId),
            ),
          ),
        )
    ).map(toAssignmentRuleLike),
    caretakerIds: new Set(
      (
        await db
          .select({ id: familyMembers.id })
          .from(familyMembers)
          .where(
            and(
              eq(familyMembers.familyId, member.familyId),
              eq(familyMembers.isCaretaker, true),
            ),
          )
      ).map((r) => r.id),
    ),
  };

  const zones = await loadMemberZones(db, member.familyId, familyMemberId);

  const dirty = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.familyMemberId, familyMemberId),
        ne(calendarEvents.provenance, 'claimed_task'),
        // A conflict-masked event is stood in for by its cf: split segments; it
        // must not spawn its own tasks (the segments do). Its stale tasks are
        // swept below alongside vanished events.
        isNull(calendarEvents.maskedAt),
        or(
          isNull(calendarEvents.tasksBuiltHash),
          ne(calendarEvents.tasksBuiltHash, calendarEvents.contentHash),
        ),
      ),
    );

  // Reconcile the dirty events a chunk at a time: each chunk reads its events'
  // tasks (and their owners) in a couple of queries, sends its task writes as
  // batches, and stamps its events together. A chunk is also the unit that is
  // redone if something in it throws — the stamps come last, so an event whose
  // tasks didn't all land stays dirty for the next pass.
  const pass: BuildPass = { rules, linkDefault, unifiedDefault, assignCtx, zones };
  for (let i = 0; i < dirty.length; i += TASKGEN_EVENT_CHUNK) {
    await buildEventTasks(db, dirty.slice(i, i + TASKGEN_EVENT_CHUNK), pass, result);
  }

  // Orphan sweep: unowned event-derived tasks (generated OR converted) whose
  // event no longer exists — or has been conflict-masked (its cf: segments
  // carry the tasks now). Fully-manual tasks (null calendarEventId) and owned
  // tasks are left alone.
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
            AND ${calendarEvents.maskedAt} IS NULL
        )`,
      ),
    );
  if (orphans.length > 0) {
    // Chunked: an orphan sweep after a bulk change can name more ids than D1
    // will bind in one statement.
    await runChunked(
      orphans.map((o) => o.id),
      (chunk) => db.delete(tasks).where(inArray(tasks.id, chunk)),
    );
    result.tasksRemoved += orphans.length;
  }

  return result;
}

/**
 * Rebuild a member's tasks after a task-rule/default change. Task rules don't
 * touch event content hashes, so force reconsideration by clearing the
 * `tasksBuiltHash` of every (non-claimed) event on the active horizon first,
 * then run task-gen. Events that finished before the horizon keep theirs: a
 * rule edit shouldn't regenerate tasks for the family's entire history.
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
        endsAtOrAfter(calendarEvents.dtstart, calendarEvents.dtend, activeHorizon().start),
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

/**
 * Rebuild every member's tasks after an assignment-rule change. Assignment rules
 * are family-scoped and their owner is a different member than the task is
 * about, so a change can affect any child's tasks — force reconsideration by
 * clearing the `tasksBuiltHash` of every (non-claimed) event on the active
 * horizon (as `rebuildMemberTasks`), then run family task-gen.
 */
export async function rebuildFamilyTasks(
  db: Db,
  familyId: string,
): Promise<TaskGenResult[]> {
  await db
    .update(calendarEvents)
    .set({ tasksBuiltHash: null })
    .where(
      and(
        eq(calendarEvents.familyId, familyId),
        ne(calendarEvents.provenance, 'claimed_task'),
        endsAtOrAfter(calendarEvents.dtstart, calendarEvents.dtend, activeHorizon().start),
      ),
    );
  return buildFamilyTasks(db, familyId);
}
