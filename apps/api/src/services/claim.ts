import {
  and,
  calendarEvents,
  type Db,
  eq,
  familyMembers,
  inArray,
  taskOwners,
  tasks,
} from '@igt/db';
import { runChunked, selectChunked } from '../lib/d1.js';
import { activeHorizon, endsAtOrAfter, hashCalendarEvent } from './synthesis.js';

type TaskRow = typeof tasks.$inferSelect;
type CalendarEventRow = typeof calendarEvents.$inferSelect;

/**
 * What `syncClaimEvents` would otherwise look up for itself, for a caller that
 * is syncing many tasks and has loaded it for all of them in one query each
 * (`reconcileClaimEvents`). A single-task caller omits it.
 */
export interface ClaimPreload {
  /** The task's current `claimed_task` events. */
  existing: CalendarEventRow[];
  /** `relationName` by family member id — the "about" name in a drop-off/pickup. */
  names: Map<string, string>;
  /** Calendar events by id — an attendance task's source event. */
  sources: Map<string, CalendarEventRow>;
}

export function taskSummary(task: TaskRow, aboutName: string): string {
  if (task.type === 'attendance') return `Attend: ${aboutName}`;
  const label = task.type === 'pickup' ? 'Pickup' : 'Drop-off';
  return `${label} — ${aboutName}`;
}

async function memberName(db: Db, memberId: string): Promise<string> {
  const row = (
    await db
      .select({ relationName: familyMembers.relationName })
      .from(familyMembers)
      .where(eq(familyMembers.id, memberId))
      .limit(1)
  )[0];
  return row?.relationName ?? 'child';
}

/** The event a task was generated from, if it still exists. */
async function sourceEvent(
  db: Db,
  calendarEventId: string | null,
): Promise<typeof calendarEvents.$inferSelect | undefined> {
  if (!calendarEventId) return undefined;
  return (
    await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, calendarEventId))
      .limit(1)
  )[0];
}

/** The caretakers currently covering a task, oldest claim first. */
export async function ownersOf(db: Db, taskId: string): Promise<string[]> {
  return (
    await db
      .select({ familyMemberId: taskOwners.familyMemberId })
      .from(taskOwners)
      .where(eq(taskOwners.taskId, taskId))
      .orderBy(taskOwners.createdAt)
  ).map((r) => r.familyMemberId);
}

/**
 * The event body a task's claim carries onto its owners' calendars.
 *
 * An `attendance` task spans its whole source event, so its claimed event is
 * an exact mirror of that event (summary/location/description/all-day) —
 * otherwise the caretaker's calendar loses the metadata (e.g. LOCATION) that
 * drives client features like Apple's travel time. A `dropoff`/`pickup` task
 * is only a windowed slice of the event, so it keeps its synthesized
 * "Pickup — <name>"-style summary and the task's own location — including its
 * geocode, which is what makes travel time work on a transition claim too
 * (free text alone leaves Apple nothing reliable to route to).
 */
async function claimPayload(db: Db, task: TaskRow, preload?: ClaimPreload) {
  const source =
    task.type !== 'attendance'
      ? undefined
      : preload
        ? preload.sources.get(task.calendarEventId ?? '')
        : await sourceEvent(db, task.calendarEventId);
  return {
    dtstart: task.dtstart,
    dtend: task.dtend,
    allDay: source?.allDay ?? false,
    summary:
      source?.summary ??
      taskSummary(
        task,
        preload
          ? (preload.names.get(task.familyMemberId) ?? 'child')
          : await memberName(db, task.familyMemberId),
      ),
    location: source?.location ?? task.location,
    locationGeo: source?.locationGeo ?? task.locationGeo,
    description: source?.description ?? null,
  };
}

/**
 * The recursion (§3.1): a claimed task becomes an event on each CLAIMING
 * member's unified calendar (`task:<taskId>` synthKey, provenance
 * `claimed_task`), from where the mirror writes it out to the calendar they
 * already use. Task-gen never generates tasks from these events.
 *
 * Ownership is a SET — an attendance task is regularly covered by several
 * caretakers at once — so the claim is a set of events too: one per owner, all
 * sharing the `task:` key, which is unique per (member, synthKey). This
 * reconciles that set against the task's current owners, and is idempotent.
 * Owners who dropped off lose their copy; where a departing owner can be paired
 * with an arriving one the row is *moved* rather than recreated, so the everyday
 * single-owner reassignment keeps the same event (and its travel-time override)
 * instead of cancelling and re-creating it on the target calendar.
 *
 * Callers pass the owner set they just wrote (see `ownersOf`), do their DB
 * writes first, then `enqueueReconcile` for every affected member — never
 * awaiting the reconcile in a request path.
 */
export async function syncClaimEvents(
  db: Db,
  task: TaskRow,
  ownerIds: string[],
  preload?: ClaimPreload,
): Promise<void> {
  // A task that isn't owned has no claim, whatever the caller passed.
  const owners = task.status === 'owned' ? ownerIds : [];

  const existing =
    preload?.existing ??
    (await db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.taskId, task.id),
          eq(calendarEvents.provenance, 'claimed_task'),
        ),
      ));

  const byMember = new Map(existing.map((e) => [e.familyMemberId, e]));
  const stale = existing.filter((e) => !owners.includes(e.familyMemberId));
  const missing = owners.filter((m) => !byMember.has(m));

  // Pair each departing owner with an arriving one (a reassignment) so the row
  // moves calendars; whatever is left over is a genuine add or drop.
  while (stale.length > 0 && missing.length > 0) {
    const row = stale.pop()!;
    const memberId = missing.shift()!;
    byMember.delete(row.familyMemberId);
    byMember.set(memberId, { ...row, familyMemberId: memberId });
    await db
      .update(calendarEvents)
      .set({ familyMemberId: memberId })
      .where(eq(calendarEvents.id, row.id));
  }
  if (stale.length > 0) {
    await db.delete(calendarEvents).where(
      inArray(
        calendarEvents.id,
        stale.map((e) => e.id),
      ),
    );
  }
  if (owners.length === 0) return;

  const payload = await claimPayload(db, task, preload);
  const contentHash = hashCalendarEvent(payload);
  for (const memberId of owners) {
    const prior = byMember.get(memberId);
    if (prior) {
      if (prior.contentHash === contentHash) continue;
      await db
        .update(calendarEvents)
        .set({ ...payload, contentHash })
        .where(eq(calendarEvents.id, prior.id));
      continue;
    }
    await db.insert(calendarEvents).values({
      familyId: task.familyId,
      familyMemberId: memberId,
      provenance: 'claimed_task',
      synthKey: `task:${task.id}`,
      taskId: task.id,
      contentHash,
      // Claimed events never generate tasks; stamp them pre-built so task-gen's
      // dirty query skips them without special-casing.
      tasksBuiltHash: contentHash,
      ...payload,
    });
  }
}

/**
 * Remove a task's claimed events (unclaim / dismiss / delete) — all of them, or
 * just one caretaker's copy when they step off a task others still cover.
 */
export async function removeClaimEvent(
  db: Db,
  taskId: string,
  memberId?: string,
): Promise<void> {
  await db
    .delete(calendarEvents)
    .where(
      and(
        eq(calendarEvents.taskId, taskId),
        eq(calendarEvents.provenance, 'claimed_task'),
        ...(memberId ? [eq(calendarEvents.familyMemberId, memberId)] : []),
      ),
    );
}

/**
 * True-up the claimed events in a family (cron safety net): owned tasks get
 * their owner set's events upserted/healed; stray claimed events whose task is
 * no longer owned are removed by cascade when the task went away, or here when
 * it was unowned without cleanup.
 *
 * Only the active horizon: a task that finished before it began, and the claimed
 * event standing for it, are left alone — nothing about an old claim is still
 * changing, and trueing up every task a family ever owned made each cron tick
 * and queue job cost more with every month of history. What the pass does read
 * is loaded in one query per kind (owners, existing claims, names, source
 * events) and handed to `syncClaimEvents`, rather than looked up per task.
 */
export async function reconcileClaimEvents(db: Db, familyId: string): Promise<void> {
  const horizon = activeHorizon();
  const owned = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.familyId, familyId),
        eq(tasks.status, 'owned'),
        endsAtOrAfter(tasks.dtstart, tasks.dtend, horizon.start),
      ),
    );

  // The claimed events standing on the horizon. Each is accounted for by an
  // owned task (healed below) or is a stray. A task can be owned yet reach the
  // horizon only through its claim — pull those in rather than mistake the
  // claim for a stray and delete it, along with its travel-time override.
  const horizonClaims = await db
    .select({ id: calendarEvents.id, taskId: calendarEvents.taskId })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.familyId, familyId),
        eq(calendarEvents.provenance, 'claimed_task'),
        endsAtOrAfter(calendarEvents.dtstart, calendarEvents.dtend, horizon.start),
      ),
    );
  const ownedIds = new Set(owned.map((t) => t.id));
  const claimedOnly = [
    ...new Set(
      horizonClaims.flatMap((c) => (c.taskId && !ownedIds.has(c.taskId) ? [c.taskId] : [])),
    ),
  ];
  if (claimedOnly.length > 0) {
    const extra = await selectChunked(
      claimedOnly,
      (chunk) =>
        db
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.familyId, familyId),
              eq(tasks.status, 'owned'),
              inArray(tasks.id, chunk),
            ),
          ),
      2,
    );
    for (const t of extra) {
      owned.push(t);
      ownedIds.add(t.id);
    }
  }

  if (owned.length > 0) {
    // Chunked throughout: a family's owned-task list outgrows D1's parameter cap.
    const taskIds = owned.map((t) => t.id);
    const ownersByTask = new Map<string, string[]>();
    for (const r of await selectChunked(taskIds, (chunk) =>
      db
        .select({ taskId: taskOwners.taskId, familyMemberId: taskOwners.familyMemberId })
        .from(taskOwners)
        .where(inArray(taskOwners.taskId, chunk))
        .orderBy(taskOwners.createdAt),
    )) {
      const list = ownersByTask.get(r.taskId) ?? [];
      list.push(r.familyMemberId);
      ownersByTask.set(r.taskId, list);
    }

    const existingByTask = new Map<string, CalendarEventRow[]>();
    for (const e of await selectChunked(
      taskIds,
      (chunk) =>
        db
          .select()
          .from(calendarEvents)
          .where(
            and(
              inArray(calendarEvents.taskId, chunk),
              eq(calendarEvents.provenance, 'claimed_task'),
            ),
          ),
      1,
    )) {
      const list = existingByTask.get(e.taskId!) ?? [];
      list.push(e);
      existingByTask.set(e.taskId!, list);
    }

    // A family's members are few; the source events are one per attendance task.
    const names = new Map(
      (
        await db
          .select({ id: familyMembers.id, relationName: familyMembers.relationName })
          .from(familyMembers)
          .where(eq(familyMembers.familyId, familyId))
      ).map((m) => [m.id, m.relationName]),
    );
    const sourceIds = [
      ...new Set(
        owned.flatMap((t) =>
          t.type === 'attendance' && t.calendarEventId ? [t.calendarEventId] : [],
        ),
      ),
    ];
    const sources = new Map(
      (
        await selectChunked(sourceIds, (chunk) =>
          db.select().from(calendarEvents).where(inArray(calendarEvents.id, chunk)),
        )
      ).map((e) => [e.id, e]),
    );

    for (const task of owned) {
      const owners = ownersByTask.get(task.id) ?? [];
      // A caretaker leaving the family takes their `task_owners` rows with them
      // (they cascade), which can leave a task about someone else marked `owned`
      // with nobody on it. Put it back in the claim queue rather than leaving it
      // looking covered.
      if (owners.length === 0) {
        await db.update(tasks).set({ status: 'unowned' }).where(eq(tasks.id, task.id));
      }
      await syncClaimEvents(db, task, owners, {
        existing: existingByTask.get(task.id) ?? [],
        names,
        sources,
      });
    }
  }

  await runChunked(
    horizonClaims.filter((c) => !c.taskId || !ownedIds.has(c.taskId)).map((c) => c.id),
    (chunk) => db.delete(calendarEvents).where(inArray(calendarEvents.id, chunk)),
  );
}
