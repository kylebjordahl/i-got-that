import {
  and,
  calendarTargets,
  type Db,
  deliveries,
  eq,
  familyMembers,
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
import type { Bindings } from '../env.js';
import { loadSecret } from './../lib/secrets.js';

type TaskRow = typeof tasks.$inferSelect;
type MemberRow = typeof familyMembers.$inferSelect;

function taskSummary(task: TaskRow, child: MemberRow | undefined): string {
  const label =
    task.type === 'pickup'
      ? 'Pickup'
      : task.type === 'dropoff'
        ? 'Drop-off'
        : 'Attendance';
  return `${label} — ${child?.relationName ?? 'child'}`;
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

/**
 * Deliver an owned task to each of the owner's active calendar targets. Creates
 * or updates one `delivery` row per (task, target); re-delivery bumps SEQUENCE.
 * No-op when the task is unowned or the owner has no targets.
 */
export async function deliverTask(
  db: Db,
  registry: DeliveryProviderRegistry,
  kek: string | undefined,
  taskId: string,
): Promise<number> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
  if (!task || !task.ownerMemberId) return 0;

  const child = (
    await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, task.familyMemberId))
      .limit(1)
  )[0];

  const targets = await db
    .select()
    .from(calendarTargets)
    .where(
      and(
        eq(calendarTargets.memberId, task.ownerMemberId),
        eq(calendarTargets.active, true),
      ),
    );

  let delivered = 0;
  for (const target of targets) {
    if (!registry.has(target.method)) continue;

    const existing = (
      await db
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.taskId, task.id),
            eq(deliveries.calendarTargetId, target.id),
          ),
        )
        .limit(1)
    )[0];

    const uid = existing?.icalUid ?? `igt-${task.id}-${target.id}`;
    const sequence = existing ? existing.sequence + 1 : 0;
    const credential = await resolveCredential(db, kek, target.credentialsRef);

    const event: DeliveryEvent = {
      uid,
      sequence,
      start: task.dtstart,
      end: task.dtend,
      summary: taskSummary(task, child),
      location: task.location ?? undefined,
    };
    const deliveryTarget: DeliveryTarget = {
      method: target.method,
      addressOrUrl: target.addressOrUrl,
      externalCalendarId: target.externalCalendarId ?? undefined,
      credential,
    };

    const result = await registry.get(target.method).upsert(event, deliveryTarget);

    if (existing) {
      await db
        .update(deliveries)
        .set({
          status: 'updated',
          sequence,
          externalRef: result.externalRef ?? existing.externalRef,
          sentAt: new Date(),
        })
        .where(eq(deliveries.id, existing.id));
    } else {
      await db.insert(deliveries).values({
        taskId: task.id,
        calendarTargetId: target.id,
        method: target.method,
        status: 'sent',
        externalRef: result.externalRef ?? null,
        icalUid: uid,
        sequence,
        sentAt: new Date(),
      });
    }
    delivered++;
  }
  return delivered;
}

/** Cancel all outstanding deliveries for a task (e.g. on unassign / decline). */
export async function cancelTaskDeliveries(
  db: Db,
  registry: DeliveryProviderRegistry,
  kek: string | undefined,
  taskId: string,
): Promise<number> {
  const rows = await db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.taskId, taskId), ne(deliveries.status, 'cancelled')));

  let cancelled = 0;
  for (const d of rows) {
    const target = (
      await db
        .select()
        .from(calendarTargets)
        .where(eq(calendarTargets.id, d.calendarTargetId))
        .limit(1)
    )[0];
    if (target && registry.has(target.method)) {
      const credential = await resolveCredential(db, kek, target.credentialsRef);
      try {
        await registry.get(target.method).cancel(
          {
            uid: d.icalUid ?? `igt-${taskId}-${target.id}`,
            sequence: d.sequence + 1,
            start: new Date(),
            end: null,
            summary: 'Cancelled',
          },
          {
            method: target.method,
            addressOrUrl: target.addressOrUrl,
            externalCalendarId: target.externalCalendarId ?? undefined,
            credential,
          },
        );
      } catch (err) {
        console.error(`cancel delivery failed for ${d.id}`, err);
      }
    }
    await db.update(deliveries).set({ status: 'cancelled' }).where(eq(deliveries.id, d.id));
    cancelled++;
  }
  return cancelled;
}

/**
 * Production provider registry. Email send is wired to Cloudflare Email Service
 * in a later step; until then the email sender throws (delivery is best-effort
 * at call sites, so assignment still succeeds).
 */
export function getProductionRegistry(env: Bindings): DeliveryProviderRegistry {
  const organizer = env.ORGANIZER_EMAIL ?? 'noreply@example.com';
  const send = async (_mime: string, _to: string): Promise<void> => {
    throw new Error('Cloudflare Email Service send not yet wired (Phase 4 prod)');
  };
  return new DeliveryProviderRegistry()
    .register(new EmailImipProvider(send, organizer))
    .register(new CalDavProvider())
    .register(new GoogleCalendarProvider());
}
