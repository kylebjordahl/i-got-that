import {
  and,
  calendarTargets,
  type Db,
  deliveries,
  eq,
  familyMembers,
  getDb,
  ne,
  tasks,
} from '@igt/db';
import {
  CalDavProvider,
  type DeliveryCredential,
  type DeliveryEvent,
  DeliveryProviderRegistry,
  type DeliveryTarget,
  EmailImipProvider,
  GoogleCalendarProvider,
} from '@igt/delivery';
import { EmailMessage } from 'cloudflare:email';
import type { Bindings } from '../env.js';
import { googleOAuthConfigured, refreshGoogleAccessToken } from '../lib/google-oauth.js';
import { loadSecret } from './../lib/secrets.js';

type TaskRow = typeof tasks.$inferSelect;
type TargetRow = typeof calendarTargets.$inferSelect;

/**
 * Reconcile model: a caretaker's owned tasks form their "generated calendar".
 * We continuously reflect that onto each of their configured outputs (targets) —
 * creating, updating, and removing events so the output always matches intent.
 * `delivery.payloadHash` lets a true-up skip unchanged events (no network).
 */

export interface SyncResult {
  targets: number;
  created: number;
  updated: number;
  removed: number;
  errors: { targetId: string; taskId?: string; error: string }[];
}

/**
 * Run a reconcile in the background so the HTTP response returns immediately —
 * CalDAV/Google writes are slow and would otherwise block the request (e.g. a
 * rename re-pushing every event). In tests, `waitOnExecutionContext` awaits
 * this, keeping assertions deterministic. Errors are logged, never thrown.
 */
export function deferSync(
  ctx: { waitUntil(p: Promise<unknown>): void },
  work: Promise<unknown>,
): void {
  ctx.waitUntil(work.catch((err) => console.error('deferred reconcile failed', err)));
}

/** A unit of delivery work placed on the queue (or run inline as a fallback). */
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
    ? syncMember(db, registry, env.KEK, job.memberId)
    : syncFamily(db, registry, env.KEK, job.familyId);
}

/**
 * Schedule a reconcile. When a Cloudflare Queue is bound (deployed envs) the job
 * is enqueued for durable, retry-backed processing by the consumer. Otherwise
 * (local dev / tests, no queue) it runs inline in the background via waitUntil —
 * so behaviour is identical, just not durable.
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
 * Queue consumer: process delivery jobs, acking on success and asking Cloudflare
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
        console.error('delivery job had errors', message.body, result.errors);
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

function taskSummary(task: TaskRow, childName: string): string {
  const label =
    task.type === 'pickup'
      ? 'Pickup'
      : task.type === 'dropoff'
        ? 'Drop-off'
        : 'Attendance';
  return `${label} — ${childName}`;
}

/** djb2 over the meaningful event fields; cheap + synchronous. */
function hashEvent(summary: string, task: TaskRow, alertMinutes: number[]): string {
  const parts = [
    summary,
    task.dtstart.toISOString(),
    task.dtend ? task.dtend.toISOString() : '',
    task.location ?? '',
    alertMinutes.join(','),
  ].join('|');
  let h = 5381;
  for (let i = 0; i < parts.length; i++) h = ((h << 5) + h) ^ parts.charCodeAt(i);
  return (h >>> 0).toString(16);
}

async function resolveCredential(
  db: Db,
  kek: string | undefined,
  credentialsRef: string | null,
): Promise<DeliveryCredential | undefined> {
  if (!credentialsRef || !kek) return undefined;
  const raw = await loadSecret(db, kek, credentialsRef);
  return raw ? (JSON.parse(raw) as DeliveryCredential) : undefined;
}

async function familyMemberNames(db: Db, familyId: string): Promise<Map<string, string>> {
  const members = await db
    .select()
    .from(familyMembers)
    .where(eq(familyMembers.familyId, familyId));
  return new Map(members.map((m) => [m.id, m.relationName]));
}

/** Reconcile a single target so it reflects exactly its owner's owned tasks. */
async function syncTarget(
  db: Db,
  registry: DeliveryProviderRegistry,
  kek: string | undefined,
  target: TargetRow,
  childNames: Map<string, string>,
  result: SyncResult,
): Promise<void> {
  result.targets++;
  if (!registry.has(target.method)) return; // provider unavailable (e.g. email off)

  const credential = await resolveCredential(db, kek, target.credentialsRef);
  const deliveryTarget: DeliveryTarget = {
    method: target.method,
    addressOrUrl: target.addressOrUrl,
    externalCalendarId: target.externalCalendarId ?? undefined,
    credential,
  };
  const provider = registry.get(target.method);

  // Desired = owner's owned tasks (none when the target is paused).
  const desired = target.active
    ? await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.ownerMemberId, target.memberId), eq(tasks.status, 'owned')))
    : [];
  const desiredById = new Map(desired.map((t) => [t.id, t]));

  const existing = await db
    .select()
    .from(deliveries)
    .where(
      and(eq(deliveries.calendarTargetId, target.id), ne(deliveries.status, 'cancelled')),
    );
  const existingByTask = new Map(existing.map((d) => [d.taskId, d]));

  // Remove events whose task is no longer desired.
  for (const d of existing) {
    if (desiredById.has(d.taskId)) continue;
    try {
      await provider.cancel(
        {
          uid: d.icalUid ?? `igt-${d.taskId}-${target.id}`,
          sequence: d.sequence + 1,
          start: new Date(),
          end: null,
          summary: 'Cancelled',
        },
        deliveryTarget,
      );
    } catch (err) {
      result.errors.push({ targetId: target.id, taskId: d.taskId, error: String(err) });
    }
    await db.delete(deliveries).where(eq(deliveries.id, d.id));
    result.removed++;
  }

  // Create/update desired events (skip unchanged via payloadHash).
  const alertMinutes = target.alertMinutes ?? [];
  for (const task of desired) {
    const summary = taskSummary(task, childNames.get(task.familyMemberId) ?? 'child');
    const hash = hashEvent(summary, task, alertMinutes);
    const prior = existingByTask.get(task.id);
    if (prior && prior.payloadHash === hash) continue;

    const uid = prior?.icalUid ?? `igt-${task.id}-${target.id}`;
    const sequence = prior ? prior.sequence + 1 : 0;
    const event: DeliveryEvent = {
      uid,
      sequence,
      start: task.dtstart,
      end: task.dtend,
      summary,
      location: task.location ?? undefined,
      alertMinutes: alertMinutes.length > 0 ? alertMinutes : undefined,
    };
    try {
      const res = await provider.upsert(event, deliveryTarget);
      if (prior) {
        await db
          .update(deliveries)
          .set({
            status: 'updated',
            sequence,
            externalRef: res.externalRef ?? prior.externalRef,
            payloadHash: hash,
            sentAt: new Date(),
          })
          .where(eq(deliveries.id, prior.id));
        result.updated++;
      } else {
        await db.insert(deliveries).values({
          taskId: task.id,
          calendarTargetId: target.id,
          method: target.method,
          status: 'sent',
          externalRef: res.externalRef ?? null,
          icalUid: uid,
          sequence,
          payloadHash: hash,
          sentAt: new Date(),
        });
        result.created++;
      }
    } catch (err) {
      result.errors.push({ targetId: target.id, taskId: task.id, error: String(err) });
    }
  }
}

/** Sync all of a caretaker's targets (active + paused). */
export async function syncMember(
  db: Db,
  registry: DeliveryProviderRegistry,
  kek: string | undefined,
  memberId: string,
): Promise<SyncResult> {
  const result = emptyResult();
  const member = (
    await db.select().from(familyMembers).where(eq(familyMembers.id, memberId)).limit(1)
  )[0];
  if (!member) return result;

  const childNames = await familyMemberNames(db, member.familyId);
  const targets = await db
    .select()
    .from(calendarTargets)
    .where(eq(calendarTargets.memberId, memberId));
  for (const target of targets) {
    await syncTarget(db, registry, kek, target, childNames, result);
  }
  return result;
}

/** Periodic true-up: reconcile every target in a family. */
export async function syncFamily(
  db: Db,
  registry: DeliveryProviderRegistry,
  kek: string | undefined,
  familyId: string,
): Promise<SyncResult> {
  const result = emptyResult();
  const childNames = await familyMemberNames(db, familyId);
  const rows = await db
    .select({ target: calendarTargets })
    .from(calendarTargets)
    .innerJoin(familyMembers, eq(familyMembers.id, calendarTargets.memberId))
    .where(eq(familyMembers.familyId, familyId));
  for (const { target } of rows) {
    await syncTarget(db, registry, kek, target, childNames, result);
  }
  return result;
}

/** Remove all remote events for a target (before deleting it). */
export async function purgeTargetRemote(
  db: Db,
  registry: DeliveryProviderRegistry,
  kek: string | undefined,
  target: TargetRow,
): Promise<void> {
  if (!registry.has(target.method)) return;
  const credential = await resolveCredential(db, kek, target.credentialsRef);
  const deliveryTarget: DeliveryTarget = {
    method: target.method,
    addressOrUrl: target.addressOrUrl,
    externalCalendarId: target.externalCalendarId ?? undefined,
    credential,
  };
  const provider = registry.get(target.method);
  const rows = await db
    .select()
    .from(deliveries)
    .where(
      and(eq(deliveries.calendarTargetId, target.id), ne(deliveries.status, 'cancelled')),
    );
  for (const d of rows) {
    try {
      await provider.cancel(
        {
          uid: d.icalUid ?? `igt-${d.taskId}-${target.id}`,
          sequence: d.sequence + 1,
          start: new Date(),
          end: null,
          summary: 'Cancelled',
        },
        deliveryTarget,
      );
    } catch {
      // best-effort; rows are removed by the target's cascade delete
    }
  }
}

/**
 * Production provider registry. CalDAV + Google are always available; email is
 * opt-in on the Cloudflare Email Service `send_email` binding (a paid feature).
 * When unavailable, email targets are skipped by the reconciler.
 */
export function getProductionRegistry(env: Bindings): DeliveryProviderRegistry {
  // Google provider can refresh a stored refresh token into an access token
  // (the OAuth client secret lives here, not in libs/delivery).
  const googleRefresher = googleOAuthConfigured(env)
    ? (refreshToken: string) => refreshGoogleAccessToken(env, refreshToken)
    : undefined;
  const registry = new DeliveryProviderRegistry()
    .register(new CalDavProvider())
    // Bind fetch to the global scope — a bare `fetch` reference throws "Illegal
    // invocation" when the provider calls it as `this.fetchImpl(...)` on Workers.
    .register(new GoogleCalendarProvider(fetch.bind(globalThis), googleRefresher));

  if (env.EMAIL) {
    const organizer = env.ORGANIZER_EMAIL ?? 'noreply@example.com';
    const emailBinding = env.EMAIL;
    const send = async (mime: string, to: string): Promise<void> => {
      await emailBinding.send(new EmailMessage(organizer, to, mime));
    };
    registry.register(new EmailImipProvider(send, organizer));
  }
  return registry;
}
