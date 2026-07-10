import {
  and,
  calendarEvents,
  type Db,
  eq,
  eventMirrors,
  familyMemberFeeds,
  familyMembers,
  feeds,
  getDb,
  inArray,
  memberCalendars,
  tasks,
} from '@igt/db';
import {
  CalDavProvider,
  type DeliveryEvent,
  DeliveryProviderRegistry,
  type DeliveryTarget,
  GoogleCalendarProvider,
} from '@igt/delivery';
import type { Bindings } from '../env.js';
import { googleRefresherFor } from '../lib/google-oauth.js';
import { resolveAccountCredential } from '../lib/account-credentials.js';

type CalendarEventRow = typeof calendarEvents.$inferSelect;
type MemberCalendarRow = typeof memberCalendars.$inferSelect;

/**
 * Mirror model: a member's unified calendar (synthesized + claimed events in
 * the DB — the source of truth) is continuously reflected onto their one
 * designated external target calendar. `event_mirrors.payloadHash` lets a
 * true-up skip unchanged events (no network). Human events live on the target
 * already and are never written back to it (read-back is `readback.ts`).
 */

export interface SyncResult {
  targets: number;
  created: number;
  updated: number;
  removed: number;
  errors: { memberId: string; calendarEventId?: string; error: string }[];
}

/**
 * Run a reconcile in the background so the HTTP response returns immediately —
 * CalDAV/Google writes are slow and would otherwise block the request. In
 * tests, `waitOnExecutionContext` awaits this, keeping assertions
 * deterministic. Errors are logged, never thrown.
 */
export function deferSync(
  ctx: { waitUntil(p: Promise<unknown>): void },
  work: Promise<unknown>,
): void {
  ctx.waitUntil(work.catch((err) => console.error('deferred reconcile failed', err)));
}

/** A unit of mirror work placed on the queue (or run inline as a fallback). */
export type DeliveryJob =
  | { kind: 'member'; memberId: string }
  | { kind: 'family'; familyId: string };

type ReconcileCtx = {
  env: Bindings;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
};

function runJob(env: Bindings, job: DeliveryJob): Promise<SyncResult> {
  const db = getDb(env.DB);
  const registry = getProductionRegistry(env);
  return job.kind === 'member'
    ? syncMemberMirror(db, registry, env.KEK, job.memberId)
    : syncFamilyMirror(db, registry, env.KEK, job.familyId);
}

/**
 * Schedule a reconcile. When a Cloudflare Queue is bound (deployed envs) the job
 * is enqueued for durable, retry-backed processing by the consumer. Otherwise
 * (local dev / tests, no queue) it runs inline in the background via waitUntil —
 * so behaviour is identical, just not durable. Never await a reconcile in a
 * request path.
 */
export function enqueueReconcile(c: ReconcileCtx, job: DeliveryJob): void {
  const queue = c.env.DELIVERY_QUEUE;
  if (queue) {
    c.executionCtx.waitUntil(
      queue.send(job).catch((err) => console.error('failed to enqueue delivery job', err)),
    );
    return;
  }
  deferSync(c.executionCtx, runJob(c.env, job));
}

/**
 * Queue consumer: process mirror jobs, acking on success and asking Cloudflare
 * to retry (with its built-in backoff, up to max_retries → dead-letter) on
 * failure. Bound to the DELIVERY_QUEUE consumer in wrangler.jsonc.
 */
export async function deliveryQueueConsumer(
  batch: MessageBatch<DeliveryJob>,
  env: Bindings,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const result = await runJob(env, message.body);
      if (result.errors.length > 0) {
        // A per-target failure (e.g. iCloud briefly unreachable) → retry later.
        console.error('mirror job had errors', message.body, result.errors);
        message.retry();
      } else {
        message.ack();
      }
    } catch (err) {
      console.error('mirror job threw', message.body, err);
      message.retry();
    }
  }
}

function emptyResult(): SyncResult {
  return { targets: 0, created: 0, updated: 0, removed: 0, errors: [] };
}

/** The summary as mirrored out. */
export function mirroredSummary(event: CalendarEventRow): string {
  return event.summary ?? 'Event';
}

/** djb2 over the meaningful mirrored fields; cheap + synchronous. */
function hashMirrorPayload(
  summary: string,
  event: CalendarEventRow,
  alertMinutes: number[],
  timezone: string | undefined,
): string {
  const parts = [
    summary,
    event.dtstart.toISOString(),
    event.dtend ? event.dtend.toISOString() : '',
    event.allDay ? '1' : '0',
    event.location ?? '',
    event.description ?? '',
    alertMinutes.join(','),
    timezone ?? '',
  ].join('|');
  let h = 5381;
  for (let i = 0; i < parts.length; i++) h = ((h << 5) + h) ^ parts.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function mirrorUid(calendarEventId: string): string {
  return `igt-${calendarEventId}`;
}

async function mirrorTarget(
  db: Db,
  kek: string | undefined,
  cal: MemberCalendarRow,
): Promise<DeliveryTarget | null> {
  const credential = await resolveAccountCredential(db, kek, cal.targetExternalAccountId);
  if (!credential) return null;
  return {
    method: cal.targetMethod,
    addressOrUrl: cal.targetCalendarId,
    externalCalendarId: cal.targetCalendarId,
    credential,
  };
}

/** IANA timezone per link id, so mirrored events render in the source zone. */
async function linkTimezones(db: Db, familyId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ linkId: familyMemberFeeds.id, timezone: feeds.timezone })
    .from(familyMemberFeeds)
    .innerJoin(feeds, eq(feeds.id, familyMemberFeeds.feedId))
    .where(eq(familyMemberFeeds.familyId, familyId));
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.timezone) map.set(r.linkId, r.timezone);
  }
  return map;
}

/**
 * IANA timezone per task id, for `claimed_task` events — those have no
 * `linkId` of their own (they're on the CLAIMER's calendar, not the source
 * calendar's), so they'd otherwise always mirror in bare UTC. Resolved via
 * the task's originating event (`tasks.calendarEventId` is deliberately not
 * an FK, so a vanished source just means the task is absent from this map —
 * no worse than the UTC fallback it'd otherwise get).
 */
async function claimedTaskTimezones(db: Db, familyId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ taskId: tasks.id, timezone: feeds.timezone })
    .from(tasks)
    .innerJoin(calendarEvents, eq(calendarEvents.id, tasks.calendarEventId))
    .innerJoin(familyMemberFeeds, eq(familyMemberFeeds.id, calendarEvents.linkId))
    .innerJoin(feeds, eq(feeds.id, familyMemberFeeds.feedId))
    .where(eq(tasks.familyId, familyId));
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.timezone) map.set(r.taskId, r.timezone);
  }
  return map;
}

/**
 * Reconcile one member's target calendar so it reflects exactly their
 * unified calendar's synthesized + claimed events. Mirror rows deliberately
 * outlive their events (no FK): a vanished event is remote-cancelled here,
 * then its row is dropped.
 */
export async function syncMemberMirror(
  db: Db,
  registry: DeliveryProviderRegistry,
  kek: string | undefined,
  memberId: string,
): Promise<SyncResult> {
  const result = emptyResult();
  const cal = (
    await db
      .select()
      .from(memberCalendars)
      .where(eq(memberCalendars.familyMemberId, memberId))
      .limit(1)
  )[0];
  if (!cal) return result;
  result.targets++;
  if (!registry.has(cal.targetMethod)) return result;

  const target = await mirrorTarget(db, kek, cal);
  if (!target) return result; // account gone / no KEK — leave remote state alone
  const provider = registry.get(cal.targetMethod);

  // Desired = the member's synthesized + claimed events (none when paused).
  const desired = cal.active
    ? await db
        .select()
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.familyMemberId, memberId),
            inArray(calendarEvents.provenance, ['synthesized', 'claimed_task']),
          ),
        )
    : [];
  const desiredById = new Map(desired.map((e) => [e.id, e]));
  const timezones = await linkTimezones(db, cal.familyId);
  const claimedTimezones = await claimedTaskTimezones(db, cal.familyId);

  const existing = await db
    .select()
    .from(eventMirrors)
    .where(eq(eventMirrors.familyMemberId, memberId));
  const existingByEvent = new Map(existing.map((m) => [m.calendarEventId, m]));

  // Cancel remote copies of vanished events, then drop their rows.
  for (const m of existing) {
    if (desiredById.has(m.calendarEventId)) continue;
    try {
      await provider.cancel(
        {
          uid: m.icalUid,
          sequence: m.sequence + 1,
          start: new Date(),
          end: null,
          summary: 'Cancelled',
        },
        target,
      );
    } catch (err) {
      result.errors.push({
        memberId,
        calendarEventId: m.calendarEventId,
        error: String(err),
      });
    }
    await db.delete(eventMirrors).where(eq(eventMirrors.id, m.id));
    result.removed++;
  }

  // Create/update desired events (skip unchanged via payloadHash).
  const alertMinutes = cal.alertMinutes ?? [];
  for (const event of desired) {
    const summary = mirroredSummary(event);
    const timezone = event.linkId
      ? timezones.get(event.linkId)
      : event.taskId
        ? claimedTimezones.get(event.taskId)
        : undefined;
    const hash = hashMirrorPayload(summary, event, alertMinutes, timezone);
    const prior = existingByEvent.get(event.id);
    if (prior && prior.payloadHash === hash) continue;

    const uid = prior?.icalUid ?? mirrorUid(event.id);
    const sequence = prior ? prior.sequence + 1 : 0;
    const deliveryEvent: DeliveryEvent = {
      uid,
      sequence,
      start: event.dtstart,
      end: event.dtend,
      summary,
      description: event.description ?? undefined,
      location: event.location ?? undefined,
      alertMinutes: alertMinutes.length > 0 ? alertMinutes : undefined,
      timezone,
    };
    try {
      const res = await provider.upsert(deliveryEvent, target);
      if (prior) {
        await db
          .update(eventMirrors)
          .set({
            status: 'updated',
            sequence,
            externalRef: res.externalRef ?? prior.externalRef,
            payloadHash: hash,
            sentAt: new Date(),
          })
          .where(eq(eventMirrors.id, prior.id));
        result.updated++;
      } else {
        await db.insert(eventMirrors).values({
          familyMemberId: memberId,
          calendarEventId: event.id,
          icalUid: uid,
          sequence,
          payloadHash: hash,
          externalRef: res.externalRef ?? null,
          status: 'sent',
          sentAt: new Date(),
        });
        result.created++;
      }
    } catch (err) {
      result.errors.push({ memberId, calendarEventId: event.id, error: String(err) });
    }
  }

  await db
    .update(memberCalendars)
    .set({ lastMirroredAt: new Date() })
    .where(eq(memberCalendars.id, cal.id));
  return result;
}

/** Periodic true-up: reconcile every configured target in a family. */
export async function syncFamilyMirror(
  db: Db,
  registry: DeliveryProviderRegistry,
  kek: string | undefined,
  familyId: string,
): Promise<SyncResult> {
  const result = emptyResult();
  const rows = await db
    .select({ memberId: memberCalendars.familyMemberId })
    .from(memberCalendars)
    .where(eq(memberCalendars.familyId, familyId));
  for (const { memberId } of rows) {
    const r = await syncMemberMirror(db, registry, kek, memberId);
    result.targets += r.targets;
    result.created += r.created;
    result.updated += r.updated;
    result.removed += r.removed;
    result.errors.push(...r.errors);
  }
  return result;
}

/**
 * Remove all remote events we mirrored to a member's target (before the target
 * is changed or removed). Best-effort per event; rows are always dropped so a
 * replacement target starts clean.
 */
export async function purgeMemberMirror(
  db: Db,
  registry: DeliveryProviderRegistry,
  kek: string | undefined,
  cal: MemberCalendarRow,
): Promise<void> {
  const rows = await db
    .select()
    .from(eventMirrors)
    .where(eq(eventMirrors.familyMemberId, cal.familyMemberId));
  if (rows.length === 0) return;

  if (registry.has(cal.targetMethod)) {
    const target = await mirrorTarget(db, kek, cal);
    if (target) {
      const provider = registry.get(cal.targetMethod);
      for (const m of rows) {
        try {
          await provider.cancel(
            {
              uid: m.icalUid,
              sequence: m.sequence + 1,
              start: new Date(),
              end: null,
              summary: 'Cancelled',
            },
            target,
          );
        } catch {
          // best-effort; the row is dropped below regardless
        }
      }
    }
  }
  await db
    .delete(eventMirrors)
    .where(eq(eventMirrors.familyMemberId, cal.familyMemberId));
}

/**
 * Production provider registry: CalDAV + Google. (Email/iMIP delivery is
 * parked with the round-6 model — `libs/delivery/src/email.ts` remains for a
 * future helper-delivery feature but is not registered.)
 */
export function getProductionRegistry(env: Bindings): DeliveryProviderRegistry {
  // Google provider can refresh a stored refresh token into an access token
  // (the OAuth client secret lives here, not in libs/delivery).
  const googleRefresher = googleRefresherFor(env);
  return new DeliveryProviderRegistry()
    .register(new CalDavProvider())
    // Bind fetch to the global scope — a bare `fetch` reference throws "Illegal
    // invocation" when the provider calls it as `this.fetchImpl(...)` on Workers.
    .register(new GoogleCalendarProvider(fetch.bind(globalThis), googleRefresher));
}
