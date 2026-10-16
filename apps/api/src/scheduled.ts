import { families, getDb } from '@igt/db';
import type { Bindings } from './env.js';
import { sweepOrphanedSecrets } from './services/auth.js';
import type { DeliveryJob } from './services/mirror.js';
import { dispatchDueDigests } from './services/notifications.js';
import { runFamilyTick } from './services/pipeline.js';
import { dispatchReauthAlerts } from './services/reauth-alerts.js';

/**
 * `Queue.sendBatch` takes at most 100 messages per call (and 256 KB in total —
 * a few dozen bytes per family is nowhere near it).
 */
const SEND_BATCH_MAX = 100;

/**
 * Cron tick. Does the global sweeps itself, then hands each family's pipeline
 * (`runFamilyTick`, services/pipeline.ts) to the delivery queue as a
 * `family-pipeline` message of its own.
 *
 * Why not run the families here: a cron invocation with an interval under an
 * hour gets one 30 s CPU budget, one 10,000-subrequest budget (every D1 query
 * counts) and six simultaneous outgoing connections — shared by every family.
 * Past any of them the runtime kills the invocation and every family's
 * in-flight work dies mid-pipeline, to be retried only by the next tick. A
 * queue consumer invocation gets a budget of its own, so the cost of a tick
 * scales with one batch of families instead of all of them, and a family that
 * blows its budget can't take the others down with it. (The consumer's CPU
 * ceiling is raised in wrangler.jsonc, since it runs whole family pipelines.)
 *
 * Local dev and tests have no `DELIVERY_QUEUE`, so there each family runs
 * inline under `waitUntil`, exactly as the cron always did.
 *
 * Push-notification digests, reauth alerts and the orphaned-secret sweep are
 * dispatched alongside, not per family — a schedule belongs to a *user* and its
 * digest spans every family they're in. A digest reads whatever state the
 * pipeline has settled on, which is at most one tick stale; sequencing it
 * behind the per-family work would mean awaiting all of it, which is exactly
 * what `waitUntil` and the queue are here to avoid.
 */
export async function scheduled(
  _event: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<void> {
  const db = getDb(env.DB);
  const now = new Date();

  // Backstop for the small best-effort window in account-deletion cleanup (D1
  // has no multi-statement transactions): reclaim any user-owned `secrets`
  // row left behind by a crash mid-delete. Not per-family — this is a global
  // pass over rows that, by definition, no family can reach via cascade.
  ctx.waitUntil(
    sweepOrphanedSecrets(db)
      .then((count) => {
        if (count > 0) console.log(`swept ${count} orphaned secret(s)`);
      })
      .catch((err) => console.error('orphaned-secrets sweep failed', err)),
  );

  // Digests due this tick. Each claims its slot before enqueuing, so
  // overlapping invocations can't double-send.
  // Accounts that stopped authenticating, pushed to their owner (once per
  // failure, never overnight).
  ctx.waitUntil(
    dispatchReauthAlerts(env, new Date(now))
      .then((count) => {
        if (count > 0) console.log(`sent ${count} reauth alert(s)`);
      })
      .catch((err) => console.error('reauth alert dispatch failed', err)),
  );

  ctx.waitUntil(
    dispatchDueDigests({ env, executionCtx: ctx }, new Date(now))
      .then((count) => {
        if (count > 0) console.log(`dispatched ${count} notification digest(s)`);
      })
      .catch((err) => console.error('digest dispatch failed', err)),
  );

  const familyIds = (await db.select({ id: families.id }).from(families)).map((f) => f.id);

  const queue = env.DELIVERY_QUEUE;
  if (queue) {
    // A chunk that fails to enqueue costs those families this tick only: the
    // next one enqueues them again, and the other chunks still go out.
    // Overlapping ticks (or a redelivered message) are harmless: `runFamilyTick`
    // takes the family's lease and skips if a previous tick still holds it.
    for (let i = 0; i < familyIds.length; i += SEND_BATCH_MAX) {
      const chunk = familyIds.slice(i, i + SEND_BATCH_MAX);
      try {
        await queue.sendBatch(
          chunk.map(
            (familyId): MessageSendRequest<DeliveryJob> => ({
              body: { kind: 'family-pipeline', familyId },
            }),
          ),
        );
      } catch (err) {
        console.error(`failed to enqueue ${chunk.length} family pipeline job(s)`, err);
      }
    }
    return;
  }

  for (const familyId of familyIds) {
    ctx.waitUntil(
      runFamilyTick(env, familyId, now).catch((err) =>
        console.error(`scheduled tick failed for family ${familyId}`, err),
      ),
    );
  }
}
