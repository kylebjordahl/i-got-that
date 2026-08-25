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
  isNull,
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
import { estimateTravelMinutes } from '@igt/classification';
import { geoKey, type GeoLocation } from '@igt/domain';
import type { Bindings } from '../env.js';
import { googleRefresherFor } from '../lib/google-oauth.js';
import { createGuardedFetch } from '../lib/outbound-url.js';
import { resolveAccountCredential } from '../lib/account-credentials.js';
import { buildKekKeySet, type KekKeySet } from '../lib/secrets.js';
import { deliverDigest, type PushDigestJob } from './notifications.js';

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
export type MirrorJob =
  | { kind: 'member'; memberId: string }
  | { kind: 'family'; familyId: string };

/**
 * Everything the delivery queue carries. Push digests ride the same queue as
 * mirror reconciles rather than getting their own: they want the identical
 * retry/backoff/DLQ behaviour, and sharing it means no new Terraform-managed
 * queue and no new binding to keep in sync.
 */
export type DeliveryJob = MirrorJob | PushDigestJob;

type ReconcileCtx = {
  env: Bindings;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
};

function runJob(env: Bindings, job: MirrorJob): Promise<SyncResult> {
  const db = getDb(env.DB);
  const registry = getProductionRegistry(env);
  const keys = buildKekKeySet(env);
  return job.kind === 'member'
    ? syncMemberMirror(db, registry, keys, job.memberId)
    : syncFamilyMirror(db, registry, keys, job.familyId);
}

/**
 * Schedule a reconcile. When a Cloudflare Queue is bound (deployed envs) the job
 * is enqueued for durable, retry-backed processing by the consumer. Otherwise
 * (local dev / tests, no queue) it runs inline in the background via waitUntil —
 * so behaviour is identical, just not durable. Never await a reconcile in a
 * request path.
 */
export function enqueueReconcile(c: ReconcileCtx, job: MirrorJob): void {
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
      if (message.body.kind === 'push-digest') {
        const { retry } = await deliverDigest(env, message.body);
        if (retry) message.retry();
        else message.ack();
        continue;
      }
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

/**
 * A gap this long before the trip means the caretaker isn't coming from
 * whatever was last on their calendar any more — the school run at 08:30 isn't
 * launched from last night's dinner. Past it we measure from home instead,
 * which also covers the first thing in the morning (nothing precedes it).
 */
const HOME_GAP_MIN = 90;
/**
 * Last-resort travel block when we can't measure a trip at all — no home on
 * file and nothing geocoded to leave from. Same shape as before this estimate
 * existed: the family's own transition window, or this when that's a point in
 * time. Deliberately kept, so travel time doesn't vanish for anyone who hasn't
 * set a home address.
 */
const DEFAULT_TRAVEL_MIN = 15;
/** Ceiling on the window-derived fallback, so an odd window can't reserve a whole day. */
const MAX_WINDOW_TRAVEL_MIN = 120;

/**
 * Where the caretaker is coming *from* for a trip starting at `tripStart`: the
 * last place they're accounted for beforehand, else home.
 *
 * `events` is the member's own calendar, ascending by start. The candidate is
 * the latest event that has already ended when the trip starts — the meeting
 * they're driving from. All-day events are skipped: they say what the day is
 * about, not where the person physically is at 3pm. A candidate close enough in
 * time but with no coordinates means we genuinely don't know where they'll be,
 * and guessing "home" would be worse than not estimating at all.
 */
function tripOrigin(
  events: CalendarEventRow[],
  trip: CalendarEventRow,
  home: GeoLocation | null,
): GeoLocation | null {
  const tripStart = trip.dtstart.getTime();
  let preceding: CalendarEventRow | null = null;
  for (const e of events) {
    if (e.id === trip.id || e.allDay) continue;
    const end = (e.dtend ?? e.dtstart).getTime();
    if (end > tripStart) continue;
    if (!preceding || end > (preceding.dtend ?? preceding.dtstart).getTime()) preceding = e;
  }
  if (preceding) {
    const gapMin =
      (tripStart - (preceding.dtend ?? preceding.dtstart).getTime()) / 60_000;
    if (gapMin < HOME_GAP_MIN) return preceding.locationGeo ?? null;
  }
  return home;
}

/**
 * The travel-time block (minutes) to mirror out with an event, 0 for none.
 *
 * A human's own answer wins outright. Someone who knows the run takes 25
 * minutes has better information than any estimate we can make without a
 * routing service, and `0` is them saying this trip needs no block at all. It
 * still needs somewhere to be going — travel time on an event with no location
 * would be a block to nowhere — but free text is enough here, because the
 * duration no longer has to be computed from coordinates.
 *
 * Failing that, only claimed drop-off/pickup events get one: a transition is a
 * trip to a place at a fixed moment, which is exactly what Apple's travel time
 * is for (an attendance claim spans its event, and a synthesized event is the
 * child's own day, not a caretaker's journey). The estimate needs coordinates
 * on the destination — free text gives Apple nothing dependable to route to —
 * and can't apply to an all-day block.
 *
 * With an origin (see `tripOrigin`) the length is an actual distance estimate.
 * Without one it falls back to the family's own transition window, which is at
 * least their answer to "how much slack does this handoff need". Either way
 * it's a seed: Apple recomputes the leave-by time from live traffic against the
 * destination's coordinates.
 */
function travelTimeMinutes(
  event: CalendarEventRow,
  taskType: string | undefined,
  resolveOrigin: () => GeoLocation | null,
): number {
  const hasSomewhereToGo = !!event.location || !!event.locationGeo;
  if (event.travelTimeOverrideMin != null) {
    return hasSomewhereToGo ? event.travelTimeOverrideMin : 0;
  }
  if (event.provenance !== 'claimed_task') return 0;
  if (taskType !== 'dropoff' && taskType !== 'pickup') return 0;
  if (!event.locationGeo || event.allDay) return 0;
  // Only now is the calendar worth scanning for where they're coming from.
  const origin = resolveOrigin();
  if (origin) return estimateTravelMinutes(origin, event.locationGeo);
  const windowMin = event.dtend
    ? Math.round((event.dtend.getTime() - event.dtstart.getTime()) / 60_000)
    : 0;
  return Math.min(windowMin > 0 ? windowMin : DEFAULT_TRAVEL_MIN, MAX_WINDOW_TRAVEL_MIN);
}

/** djb2 over the meaningful mirrored fields; cheap + synchronous. */
function hashMirrorPayload(
  summary: string,
  event: CalendarEventRow,
  alertMinutes: number[],
  timezone: string | undefined,
  travelMinutes: number,
): string {
  const parts = [
    summary,
    event.dtstart.toISOString(),
    event.dtend ? event.dtend.toISOString() : '',
    event.allDay ? '1' : '0',
    event.location ?? '',
    // Re-mirror when only the geocode changes (same display text).
    geoKey(event.locationGeo),
    event.description ?? '',
    alertMinutes.join(','),
    timezone ?? '',
    String(travelMinutes),
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
  keys: KekKeySet | undefined,
  cal: MemberCalendarRow,
): Promise<DeliveryTarget | null> {
  const credential = await resolveAccountCredential(db, keys, cal.targetExternalAccountId);
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

/** What a `claimed_task` event needs from the task behind it. */
interface ClaimedTaskMeta {
  /** 'dropoff' | 'pickup' | 'attendance' — decides whether travel time applies. */
  type: string;
  /**
   * IANA timezone, for `claimed_task` events — those have no `linkId` of their
   * own (they're on the CLAIMER's calendar, not the source calendar's), so
   * they'd otherwise always mirror in bare UTC. Undefined when the task's
   * originating event is gone or isn't feed-derived (`tasks.calendarEventId` is
   * deliberately not an FK), which is no worse than the UTC fallback.
   */
  timezone?: string;
}

/** Task type + source timezone per task id, for the family's claimed events. */
async function claimedTaskMeta(
  db: Db,
  familyId: string,
): Promise<Map<string, ClaimedTaskMeta>> {
  const rows = await db
    .select({ taskId: tasks.id, type: tasks.type, timezone: feeds.timezone })
    .from(tasks)
    .leftJoin(calendarEvents, eq(calendarEvents.id, tasks.calendarEventId))
    .leftJoin(familyMemberFeeds, eq(familyMemberFeeds.id, calendarEvents.linkId))
    .leftJoin(feeds, eq(feeds.id, familyMemberFeeds.feedId))
    .where(eq(tasks.familyId, familyId));
  const map = new Map<string, ClaimedTaskMeta>();
  for (const r of rows) {
    map.set(r.taskId, { type: r.type, ...(r.timezone ? { timezone: r.timezone } : {}) });
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
  keys: KekKeySet | undefined,
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

  const target = await mirrorTarget(db, keys, cal);
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
            // A conflict-masked event is mirrored as its cf: split segments, not
            // as its own full span.
            isNull(calendarEvents.maskedAt),
          ),
        )
    : [];
  const desiredById = new Map(desired.map((e) => [e.id, e]));
  const timezones = await linkTimezones(db, cal.familyId);
  const claimedTasks = await claimedTaskMeta(db, cal.familyId);

  // Everything on this member's own calendar — human read-back events included,
  // since a meeting they added by hand is exactly the kind of thing a school
  // run leaves from. Only used to place the caretaker before each trip.
  const ownCalendar = await db
    .select()
    .from(calendarEvents)
    .where(
      and(eq(calendarEvents.familyMemberId, memberId), isNull(calendarEvents.maskedAt)),
    );
  const home =
    (
      await db
        .select({ homeLocationGeo: familyMembers.homeLocationGeo })
        .from(familyMembers)
        .where(eq(familyMembers.id, memberId))
        .limit(1)
    )[0]?.homeLocationGeo ?? null;

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
    const taskMeta = event.taskId ? claimedTasks.get(event.taskId) : undefined;
    const timezone = event.linkId ? timezones.get(event.linkId) : taskMeta?.timezone;
    const travelMinutes = travelTimeMinutes(event, taskMeta?.type, () =>
      tripOrigin(ownCalendar, event, home),
    );
    const hash = hashMirrorPayload(summary, event, alertMinutes, timezone, travelMinutes);
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
      locationGeo: event.locationGeo ?? undefined,
      travelTimeMinutes: travelMinutes > 0 ? travelMinutes : undefined,
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
  keys: KekKeySet | undefined,
  familyId: string,
): Promise<SyncResult> {
  const result = emptyResult();
  const rows = await db
    .select({ memberId: memberCalendars.familyMemberId })
    .from(memberCalendars)
    .where(eq(memberCalendars.familyId, familyId));
  for (const { memberId } of rows) {
    const r = await syncMemberMirror(db, registry, keys, memberId);
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
  keys: KekKeySet | undefined,
  cal: MemberCalendarRow,
): Promise<void> {
  const rows = await db
    .select()
    .from(eventMirrors)
    .where(eq(eventMirrors.familyMemberId, cal.familyMemberId));
  if (rows.length === 0) return;

  if (registry.has(cal.targetMethod)) {
    const target = await mirrorTarget(db, keys, cal);
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
  // Both providers get the SSRF-guarded fetch: the CalDAV one writes to a
  // user-supplied collection URL (with the account credential attached), and
  // it costs the Google one nothing to share the timeout/size bounds.
  const guardedFetch = createGuardedFetch(env);
  return new DeliveryProviderRegistry()
    .register(new CalDavProvider(guardedFetch))
    .register(new GoogleCalendarProvider(guardedFetch, googleRefresher));
}
