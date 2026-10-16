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
  lte,
  memberCalendars,
  or,
  sql,
  tasks,
} from '@igt/db';
import {
  CalDavProvider,
  DeliveryHttpError,
  type DeliveryEvent,
  type DeliveryProvider,
  DeliveryProviderRegistry,
  type DeliveryTarget,
  GoogleCalendarProvider,
} from '@igt/delivery';
import { estimateTravelMinutes } from '@igt/classification';
import { geoKey, type GeoLocation } from '@igt/domain';
import type { Bindings } from '../env.js';
import { emailEnabled, emailLinkBase, getOutbox } from '../lib/email.js';
import { googleRefresherFor } from '../lib/google-oauth.js';
import { createGuardedFetch } from '../lib/outbound-url.js';
import { resolveAccountCredential } from '../lib/account-credentials.js';
import {
  errorMessage,
  needsReauth,
  recordAccountAuthFailure,
  truncateError,
} from '../lib/account-health.js';
import { selectChunked } from '../lib/d1.js';
import { buildKekKeySet, type KekKeySet } from '../lib/secrets.js';
import { syncFamilyEmailOutputs, syncMemberEmailOutputs } from './email-outputs.js';
import { deliverDigest, type PushDigestJob } from './notifications.js';
import { type FamilyPipelineJob, runFamilyTick } from './pipeline.js';
import { activeHorizon, endsAtOrAfter } from './synthesis.js';

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
 * Everything the delivery queue carries. Push digests and the cron's per-family
 * pipeline runs ride the same queue as mirror reconciles rather than getting
 * their own: they want the identical retry/backoff/DLQ behaviour, and sharing
 * it means no new Terraform-managed queue and no new binding to keep in sync.
 */
export type DeliveryJob = MirrorJob | PushDigestJob | FamilyPipelineJob;

type ReconcileCtx = {
  env: Bindings;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
};

/**
 * A mirror job reconciles both kinds of output: the member's target calendar,
 * then their email invite outputs — the latter only where mail can actually
 * leave (see `syncMemberEmailOutputs`).
 */
async function runJob(env: Bindings, job: MirrorJob): Promise<SyncResult> {
  const db = getDb(env.DB);
  const registry = getProductionRegistry(env);
  const keys = buildKekKeySet(env);
  const mirrored =
    job.kind === 'member'
      ? await syncMemberMirror(db, registry, keys, job.memberId)
      : await syncFamilyMirror(db, registry, keys, job.familyId);
  if (!emailEnabled(env)) return mirrored;
  const outbox = getOutbox(env);
  const emailed =
    job.kind === 'member'
      ? await syncMemberEmailOutputs(db, outbox, job.memberId, new Date(), emailLinkBase(env))
      : await syncFamilyEmailOutputs(db, outbox, job.familyId, new Date(), emailLinkBase(env));
  return mergeResults(mirrored, emailed);
}

export function mergeResults(a: SyncResult, b: SyncResult): SyncResult {
  return {
    targets: a.targets + b.targets,
    created: a.created + b.created,
    updated: a.updated + b.updated,
    removed: a.removed + b.removed,
    errors: [...a.errors, ...b.errors],
  };
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
 * Queue consumer: process delivery jobs, acking on success and asking Cloudflare
 * to retry (with its built-in backoff, up to max_retries → dead-letter) on
 * failure. Each message is acked or retried on its own, so one failing job
 * never re-queues the rest of its batch. Bound to the DELIVERY_QUEUE consumer
 * in wrangler.jsonc.
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
      if (message.body.kind === 'family-pipeline') {
        // A stage that throws is logged inside `runFamilyTick` and not retried
        // — re-running a whole family pipeline because its mirror hiccuped
        // would be a retry storm, and the next cron tick is the retry anyway.
        // Only a tick that couldn't start at all lands in the catch below.
        await runFamilyTick(env, message.body.familyId);
        message.ack();
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
      console.error('delivery job threw', message.body, err);
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

/** When an event ends, as a timestamp — an event with no end is an instant. */
function endMs(e: CalendarEventRow): number {
  return (e.dtend ?? e.dtstart).getTime();
}

/**
 * Where the caretaker is coming *from* for a trip starting at `tripStart`: the
 * last place they're accounted for beforehand, else home.
 *
 * `events` is the member's own timed calendar, ascending by END time (see
 * `travelContext`), so the candidate is found by binary search rather than a
 * scan per trip. The candidate is the latest event that has already ended when
 * the trip starts — the meeting they're driving from — never the trip itself.
 * (Of several ending together, the earliest in `events` order wins.) All-day
 * events never get this far: they say what the day is about, not where the
 * person physically is at 3pm. A candidate close enough in time but with no
 * coordinates means we genuinely don't know where they'll be, and guessing
 * "home" would be worse than not estimating at all.
 */
function tripOrigin(
  events: CalendarEventRow[],
  trip: CalendarEventRow,
  home: GeoLocation | null,
): GeoLocation | null {
  const tripStart = trip.dtstart.getTime();
  // First index of an event still running when the trip starts; everything
  // before it has ended by then.
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (endMs(events[mid]!) <= tripStart) lo = mid + 1;
    else hi = mid;
  }
  let preceding: CalendarEventRow | null = null;
  for (let i = lo - 1; i >= 0; i--) {
    const e = events[i]!;
    if (preceding && endMs(e) < endMs(preceding)) break;
    if (e.id !== trip.id) preceding = e;
  }
  if (preceding) {
    const gapMin = (tripStart - endMs(preceding)) / 60_000;
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
 * Failing that, every claim a caretaker took on gets one — drop-off, pickup and
 * attendance alike. All three are a journey the caretaker makes to a place for
 * a time they can't miss, which is exactly what Apple's travel time is for; a
 * *synthesized* event never does, because that's the child's own day, not
 * anyone's journey. The estimate needs coordinates on the destination — free
 * text gives Apple nothing dependable to route to — and can't apply to an
 * all-day block.
 *
 * With an origin (see `tripOrigin`) the length is an actual distance estimate.
 * Without one a transition falls back to the family's own drop-off/pickup
 * window, which is at least their answer to "how much slack does this handoff
 * need". An attendance claim has no such answer to borrow — its span is the
 * event it covers, not the trip there, and reserving a two-hour travel block
 * for a two-hour game would be worse than saying nothing — so it takes the flat
 * default instead. Either way it's a seed: Apple recomputes the leave-by time
 * from live traffic against the destination's coordinates.
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
  if (taskType !== 'dropoff' && taskType !== 'pickup' && taskType !== 'attendance') {
    return 0;
  }
  if (!event.locationGeo || event.allDay) return 0;
  // Only now is the calendar worth scanning for where they're coming from.
  const origin = resolveOrigin();
  if (origin) return estimateTravelMinutes(origin, event.locationGeo);
  const windowMin =
    taskType !== 'attendance' && event.dtend
      ? Math.round((event.dtend.getTime() - event.dtstart.getTime()) / 60_000)
      : 0;
  return Math.min(windowMin > 0 ? windowMin : DEFAULT_TRAVEL_MIN, MAX_WINDOW_TRAVEL_MIN);
}

/** What a travel estimate needs to know about the member making the trips. */
export interface TravelContext {
  /**
   * The member's own timed events, ascending by end time — human read-back
   * events included, since a meeting they added by hand is exactly the kind of
   * thing a school run leaves from. Only used to place the caretaker before a
   * trip, and only the stretch that can precede one (see `travelContext`).
   */
  ownCalendar: CalendarEventRow[];
  home: GeoLocation | null;
}

/**
 * How far before the first trip we look for what precedes it. Only an event
 * ending less than `HOME_GAP_MIN` before a trip can be its origin, so this is
 * generous; it exists so the lookup is bounded by the trips being estimated
 * rather than by the member's whole history.
 */
const TRAVEL_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Load what `eventTravelMinutes` needs for trips STARTING from `trips.start`
 * (default: the active horizon's start, which is every event the mirror sends —
 * it reconciles from there forward, so there is no upper bound unless a caller
 * with a closed range, like email invites, passes `end`): the member's unmasked
 * timed events that end after that point, less a day of lead-in. Sorted once by
 * end time so each trip's predecessor is a binary search, not a pass over the
 * whole calendar.
 */
export async function travelContext(
  db: Db,
  memberId: string,
  trips: { start: Date; end?: Date } = { start: activeHorizon().start },
): Promise<TravelContext> {
  const ownCalendar = (
    await db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.familyMemberId, memberId),
          isNull(calendarEvents.maskedAt),
          eq(calendarEvents.allDay, false),
          endsAtOrAfter(
            calendarEvents.dtstart,
            calendarEvents.dtend,
            new Date(trips.start.getTime() - TRAVEL_LOOKBACK_MS),
          ),
          ...(trips.end ? [lte(calendarEvents.dtstart, trips.end)] : []),
        ),
      )
  ).sort((a, b) => endMs(a) - endMs(b));
  const home =
    (
      await db
        .select({ homeLocationGeo: familyMembers.homeLocationGeo })
        .from(familyMembers)
        .where(eq(familyMembers.id, memberId))
        .limit(1)
    )[0]?.homeLocationGeo ?? null;
  return { ownCalendar, home };
}

/**
 * The travel block (minutes, 0 for none) for one of the member's events — the
 * same answer the calendar mirror sends, so email outputs that pad for travel
 * agree with it. See `travelTimeMinutes` for the rules.
 */
export function eventTravelMinutes(
  ctx: TravelContext,
  event: CalendarEventRow,
  taskType: string | undefined,
): number {
  return travelTimeMinutes(event, taskType, () =>
    tripOrigin(ctx.ownCalendar, event, ctx.home),
  );
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
    // Payload format version: bumping it re-sends every mirrored event once.
    // v2 stamps Google events with the deployment that wrote them, which the
    // orphan sweep relies on (see `sweepOrphanedRemoteEvents`).
    'v2',
  ].join('|');
  let h = 5381;
  for (let i = 0; i < parts.length; i++) h = ((h << 5) + h) ^ parts.charCodeAt(i);
  return (h >>> 0).toString(16);
}

/** Our own mirrored events' UID prefix (also read-back's recursion guard). */
const MIRROR_UID_PREFIX = 'igt-';

function mirrorUid(calendarEventId: string): string {
  return `${MIRROR_UID_PREFIX}${calendarEventId}`;
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
export async function linkTimezones(db: Db, familyId: string): Promise<Map<string, string>> {
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
export interface ClaimedTaskMeta {
  /** 'dropoff' | 'pickup' | 'attendance' — shapes the travel-time estimate. */
  type: string;
  /**
   * IANA timezone, for `claimed_task` events — those have no `linkId` of their
   * own (they're on the CLAIMER's calendar, not the source calendar's), so
   * they'd otherwise always mirror in bare UTC. Undefined when the task's
   * originating event is gone or isn't feed-derived (`tasks.calendarEventId` is
   * deliberately not an FK), which is no worse than the UTC fallback.
   */
  timezone?: string;
  /**
   * The linked calendar the task's originating event came from, for filtering
   * email outputs by source. Null when that event is gone or isn't feed-derived.
   */
  sourceLinkId: string | null;
}

/**
 * Task type, source timezone + source link for the given tasks — the ones the
 * caller's claimed events actually reference. Not the family's whole task list:
 * that grows with every day of history and is three joins wide.
 */
export async function claimedTaskMeta(
  db: Db,
  taskIds: readonly string[],
): Promise<Map<string, ClaimedTaskMeta>> {
  // Chunked: the ids come from a calendar's worth of claimed events.
  const rows = await selectChunked([...new Set(taskIds)], (chunk) =>
    db
      .select({
        taskId: tasks.id,
        type: tasks.type,
        timezone: feeds.timezone,
        sourceLinkId: calendarEvents.linkId,
      })
      .from(tasks)
      .leftJoin(calendarEvents, eq(calendarEvents.id, tasks.calendarEventId))
      .leftJoin(familyMemberFeeds, eq(familyMemberFeeds.id, calendarEvents.linkId))
      .leftJoin(feeds, eq(feeds.id, familyMemberFeeds.feedId))
      .where(inArray(tasks.id, chunk)),
  );
  const map = new Map<string, ClaimedTaskMeta>();
  for (const r of rows) {
    map.set(r.taskId, {
      type: r.type,
      sourceLinkId: r.sourceLinkId ?? null,
      ...(r.timezone ? { timezone: r.timezone } : {}),
    });
  }
  return map;
}

/**
 * How many times in a row the target may refuse the exact same payload before
 * the mirror stops sending it. Without a bound, one event a target permanently
 * rejects (a Google 400) fails the member's mirror job on every cron tick and
 * every queue retry for as long as the event exists, re-running the whole
 * member each time. Past the limit the event is *held back*: not sent, not an
 * error that retries the job, but still reported on the member calendar's
 * `lastMirrorError`. A changed payload has a new hash and is sent at once.
 */
export const MIRROR_REJECTION_LIMIT = 3;

/** What one reconcile pass learned that `SyncResult` doesn't carry. */
interface MirrorPass {
  /** The pass finished its reconcile (as opposed to bailing at setup). */
  completed: boolean;
  /** The target can't be used at all (no provider, no credential). */
  problem?: string;
  /** Events not sent this pass because the target keeps refusing their content. */
  held: { calendarEventId: string; error: string }[];
  /** The account the target is drawn from, for the reconnect prompt. */
  accountId: string | null;
  /** A failure only reconnecting the account fixes, if the pass hit one. */
  authError?: unknown;
}

/** An event whose first write failed: a row exists only to hold the failure. */
function neverDelivered(m: Pick<typeof eventMirrors.$inferSelect, 'status' | 'sentAt'>): boolean {
  return m.status === 'failed' && m.sentAt == null;
}

/**
 * Record on the event's mirror row that writing it just failed.
 *
 * The count only advances for a *rejection* of the payload (the target read it
 * and said no — see `DeliveryHttpError.rejectedPayload`), and restarts at 1
 * when the content differs from the last rejected content. A network error, a
 * 5xx or a dead credential is the target's state, not the event's: counting it
 * would hold every unchanged event back after a few bad ticks and leave the
 * calendar stale long after the target recovers.
 *
 * A new event has no row yet, so one is created with status 'failed' and no
 * `sentAt`/`externalRef`: the failure needs somewhere to live, and the next
 * pass finds the row and treats the event as the first send of a never-sent
 * one. Cancelling it is harmless — both providers treat "not there" as success.
 * Never throws: bookkeeping must not turn into a second failure.
 */
async function recordEventFailure(
  db: Db,
  memberId: string,
  event: { id: string },
  uid: string,
  prior: typeof eventMirrors.$inferSelect | undefined,
  hash: string,
  err: unknown,
): Promise<void> {
  const rejected = err instanceof DeliveryHttpError && err.rejectedPayload;
  const lastError = errorMessage(err);
  try {
    if (prior) {
      await db
        .update(eventMirrors)
        .set({
          status: 'failed',
          lastError,
          ...(rejected
            ? {
                // In SQL: overlapping reconciles both read the old count.
                failureCount: sql`case when ${eventMirrors.failedPayloadHash} = ${hash} then ${eventMirrors.failureCount} + 1 else 1 end`,
                failedPayloadHash: hash,
              }
            : {}),
        })
        .where(eq(eventMirrors.id, prior.id));
    } else {
      await db
        .insert(eventMirrors)
        .values({
          familyMemberId: memberId,
          calendarEventId: event.id,
          icalUid: uid,
          sequence: 0,
          payloadHash: null,
          externalRef: null,
          status: 'failed',
          sentAt: null,
          lastError,
          ...(rejected ? { failureCount: 1, failedPayloadHash: hash } : {}),
        })
        .onConflictDoNothing();
    }
  } catch (bookkeepingErr) {
    console.error(`mirror: couldn't record failure for event ${event.id}`, bookkeepingErr);
  }
}

/** The one-line summary a pass leaves on the member calendar, or null if it was clean. */
function summarizeMirrorPass(pass: MirrorPass, errors: SyncResult['errors']): string | null {
  if (pass.problem) return truncateError(pass.problem);
  const parts: string[] = [];
  const tidy = (e: string) => e.replace(/^\w*Error: /, '');
  if (errors.length > 0) {
    const more = errors.length - 1;
    parts.push(tidy(errors[0]!.error) + (more > 0 ? ` (and ${more} more)` : ''));
  }
  if (pass.held.length > 0) {
    const n = pass.held.length;
    parts.push(
      `${n} event${n === 1 ? '' : 's'} not sent: the target keeps rejecting ${n === 1 ? 'it' : 'them'} (${pass.held[0]!.error}); will retry once edited`,
    );
  }
  return parts.length > 0 ? truncateError(parts.join('; ')) : null;
}

/**
 * Reconcile one member's target calendar so it reflects exactly their
 * unified calendar's synthesized + claimed events. Mirror rows deliberately
 * outlive their events (no FK): a vanished event is remote-cancelled here,
 * then its row is dropped.
 *
 * Every pass is stamped on the member calendar (`mirrorAttemptedAt`,
 * `mirrorFailures`, `lastMirrorError`) so a target that has stopped taking
 * writes can say why. A pass counts as failed if any event errored, any event
 * is being held back (`MIRROR_REJECTION_LIMIT`), or the target couldn't be used
 * at all; one clean pass clears it.
 */
export async function syncMemberMirror(
  db: Db,
  registry: DeliveryProviderRegistry,
  keys: KekKeySet | undefined,
  memberId: string,
): Promise<SyncResult> {
  const attemptedAt = new Date();
  const pass: MirrorPass = { completed: false, held: [], accountId: null };
  let result: SyncResult;
  try {
    result = await reconcileMemberMirror(db, registry, keys, memberId, pass);
  } catch (err) {
    pass.problem = errorMessage(err);
    await recordMirrorPass(db, memberId, attemptedAt, pass, emptyResult());
    throw err;
  }
  // `targets` is 0 when the member has no target calendar: nothing to stamp.
  if (result.targets > 0) await recordMirrorPass(db, memberId, attemptedAt, pass, result);
  return result;
}

/** Stamp a pass's outcome on the member calendar. Never throws. */
async function recordMirrorPass(
  db: Db,
  memberId: string,
  attemptedAt: Date,
  pass: MirrorPass,
  result: SyncResult,
): Promise<void> {
  try {
    const problem = summarizeMirrorPass(pass, result.errors);
    await db
      .update(memberCalendars)
      .set({
        mirrorAttemptedAt: attemptedAt,
        ...(pass.completed ? { lastMirroredAt: new Date() } : {}),
        ...(problem
          ? {
              // In SQL, not from a stale read: overlapping passes both hold the old count.
              mirrorFailures: sql`${memberCalendars.mirrorFailures} + 1`,
              lastMirrorError: problem,
            }
          : { mirrorFailures: 0, lastMirrorError: null }),
      })
      .where(eq(memberCalendars.familyMemberId, memberId));
    await recordAccountAuthFailure(db, pass.accountId, pass.authError, attemptedAt);
  } catch (err) {
    console.error(`mirror: couldn't record outcome for member ${memberId}`, err);
  }
}

async function reconcileMemberMirror(
  db: Db,
  registry: DeliveryProviderRegistry,
  keys: KekKeySet | undefined,
  memberId: string,
  pass: MirrorPass,
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
  pass.accountId = cal.targetExternalAccountId;
  if (!registry.has(cal.targetMethod)) {
    pass.problem = `no delivery provider is registered for ${cal.targetMethod} targets`;
    return result;
  }

  const target = await mirrorTarget(db, keys, cal);
  if (!target) {
    // Account gone / no KEK — leave remote state alone, but say so: this is not
    // a retryable job error (it would never succeed), yet not a healthy target.
    pass.problem =
      "the target account's credential is unavailable (account removed, no stored secret, or no encryption key configured)";
    return result;
  }
  const provider = registry.get(cal.targetMethod);

  // Desired = the member's synthesized + claimed events from the active
  // horizon's start forward (none when paused). Events that finished before it
  // were mirrored when they were current and are left exactly as they are:
  // re-hashing a family's whole history on every tick is the cost, and the
  // remote copy of a finished event needs no upkeep. Only the past is cut — a
  // claim for something far ahead is mirrored at once, and an event moved far
  // ahead is updated in place, not left stale at its old time.
  const horizon = activeHorizon();
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
            endsAtOrAfter(calendarEvents.dtstart, calendarEvents.dtend, horizon.start),
          ),
        )
    : [];
  const desiredById = new Map(desired.map((e) => [e.id, e]));
  const timezones = await linkTimezones(db, cal.familyId);
  const claimedTasks = await claimedTaskMeta(
    db,
    desired.flatMap((e) => (e.taskId ? [e.taskId] : [])),
  );

  const travel = await travelContext(db, memberId, { start: horizon.start });

  // The mirror rows worth reconsidering: those whose event has left this
  // member's calendar (deleted, or moved to another caretaker), and those whose
  // event hasn't finished before the horizon's start — desired ones to compare,
  // the rest (masked, calendar paused, no longer synthesized/claimed) to cancel.
  // A row whose event finished before the horizon is skipped by the query and
  // never touched, so a finished event isn't cancelled just because it fell out
  // of `desired`. That includes a paused calendar: pausing cancels what's
  // current and upcoming, and what's already behind us stays where it was.
  const existing = (
    await db
      .select()
      .from(eventMirrors)
      .leftJoin(
        calendarEvents,
        and(
          eq(calendarEvents.id, eventMirrors.calendarEventId),
          eq(calendarEvents.familyMemberId, eventMirrors.familyMemberId),
        ),
      )
      .where(
        and(
          eq(eventMirrors.familyMemberId, memberId),
          or(
            isNull(calendarEvents.id),
            endsAtOrAfter(calendarEvents.dtstart, calendarEvents.dtend, horizon.start),
          ),
        ),
      )
  ).map((r) => r.event_mirrors);
  const existingByEvent = new Map(existing.map((m) => [m.calendarEventId, m]));

  // Cancel remote copies of vanished events, then drop their rows. A failed
  // cancel keeps its row so the next pass retries it: the row is the only
  // record that the remote copy exists, and dropping it on failure is how
  // Google busy blocks used to outlive the meetings behind them.
  for (const m of existing) {
    if (desiredById.has(m.calendarEventId)) continue;
    try {
      await provider.cancel(
        {
          uid: m.icalUid,
          externalRef: m.externalRef,
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
      if (needsReauth(err)) pass.authError ??= err;
      continue;
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
    const travelMinutes = eventTravelMinutes(travel, event, taskMeta?.type);
    const hash = hashMirrorPayload(summary, event, alertMinutes, timezone, travelMinutes);
    const prior = existingByEvent.get(event.id);
    if (prior && prior.payloadHash === hash) continue;
    if (
      prior &&
      prior.failureCount >= MIRROR_REJECTION_LIMIT &&
      prior.failedPayloadHash === hash
    ) {
      // The target has refused exactly this content enough times. Sending it
      // again is a request that fails the same way and, as an error, retries
      // the whole job; hold it until the payload changes (a new hash).
      pass.held.push({
        calendarEventId: event.id,
        error: prior.lastError ?? 'rejected by the target',
      });
      continue;
    }

    const uid = prior?.icalUid ?? mirrorUid(event.id);
    // A row left by a first write that failed has delivered nothing: the
    // event's first real send is still sequence 0.
    const firstSend = !prior || neverDelivered(prior);
    const sequence = firstSend ? 0 : prior!.sequence + 1;
    const deliveryEvent: DeliveryEvent = {
      uid,
      externalRef: prior?.externalRef,
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
            status: firstSend ? 'sent' : 'updated',
            sequence,
            externalRef: res.externalRef ?? prior.externalRef,
            payloadHash: hash,
            sentAt: new Date(),
            failureCount: 0,
            lastError: null,
            failedPayloadHash: null,
          })
          .where(eq(eventMirrors.id, prior.id));
        if (firstSend) result.created++;
        else result.updated++;
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
      if (needsReauth(err)) pass.authError ??= err;
      await recordEventFailure(db, memberId, event, uid, prior, hash, err);
    }
  }

  if (provider.listOwned) {
    try {
      result.removed += await sweepOrphanedRemoteEvents(db, provider, target);
    } catch (err) {
      result.errors.push({ memberId, calendarEventId: '', error: String(err) });
    }
  }

  pass.completed = true;
  return result;
}

/**
 * A remote event touched this recently may belong to a mirror pass still in
 * flight — one that has written the event but not yet its `event_mirrors` row —
 * so the sweep leaves it for a later pass.
 */
const ORPHAN_GRACE_MS = 15 * 60_000;

/**
 * Exactly a mirror UID — `igt-<calendarEventId uuid>`. The bare `igt-` prefix
 * is shared with email-output invites (`igt-em-…`), which a person may have
 * accepted onto this same calendar and which no `event_mirrors` row tracks.
 */
const MIRROR_UID_PATTERN = /^igt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete our own (`igt-`) events on a target that no `event_mirrors` row
 * accounts for. The row is the mirror's only memory of a remote copy; until
 * the Google provider deleted by Google's event id, every cancel 404'd
 * silently and its row was dropped anyway, stranding the copy for good (a
 * week of busy blocks still standing after the meetings behind them were
 * cancelled). This finds those and any future strays.
 *
 * Checked against every member's rows, not just this one's: two members can
 * share one target calendar, and `igt-<calendarEventId>` UIDs are globally
 * unique, so an event some other row owns is never touched. Bounded to the
 * active horizon (the synthesis window plus the 30 days behind it), so the
 * recent past is cleaned too without listing a calendar's whole history every
 * pass.
 */
async function sweepOrphanedRemoteEvents(
  db: Db,
  provider: DeliveryProvider,
  target: DeliveryTarget,
): Promise<number> {
  const horizon = activeHorizon();
  const remote = await provider.listOwned!(target, {
    uidPrefix: MIRROR_UID_PREFIX,
    start: horizon.start,
    end: horizon.end,
  });
  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  const candidates = remote.filter(
    (r) =>
      MIRROR_UID_PATTERN.test(r.uid) && r.updatedAt != null && r.updatedAt.getTime() < cutoff,
  );
  if (candidates.length === 0) return 0;
  const known = new Set(
    (
      await selectChunked(candidates, (chunk) =>
        db
          .select({ icalUid: eventMirrors.icalUid })
          .from(eventMirrors)
          .where(inArray(eventMirrors.icalUid, chunk.map((c) => c.uid))),
      )
    ).map((r) => r.icalUid),
  );
  let removed = 0;
  for (const orphan of candidates) {
    if (known.has(orphan.uid)) continue;
    await provider.cancel(
      {
        uid: orphan.uid,
        externalRef: orphan.externalRef,
        sequence: 0,
        start: new Date(),
        end: null,
        summary: 'Cancelled',
      },
      target,
    );
    removed++;
  }
  return removed;
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
              externalRef: m.externalRef,
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
 * Production provider registry: CalDAV + Google — the target-calendar methods.
 * Email/iMIP isn't registered here: it isn't a target calendar (nothing is read
 * back from an inbox) but a separate, filtered output with its own reconcile
 * (`services/email-outputs.ts`).
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
    .register(new GoogleCalendarProvider(guardedFetch, googleRefresher, env.ENVIRONMENT));
}
