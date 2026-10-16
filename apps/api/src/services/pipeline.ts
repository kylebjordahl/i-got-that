import { eq, familyMemberFeeds, feeds, getDb, type Db } from '@igt/db';
import type { Bindings } from '../env.js';
import { emailEnabled, emailLinkBase, getOutbox } from '../lib/email.js';
import { googleRefresherFor } from '../lib/google-oauth.js';
import { createGuardedFetch } from '../lib/outbound-url.js';
import { buildKekKeySet } from '../lib/secrets.js';
import { reconcileClaimEvents } from './claim.js';
import { reconcileFamilyConflicts, reconcileMemberConflicts } from './conflicts.js';
import { syncFamilyEmailOutputs } from './email-outputs.js';
import { ingestFeed, isFeedDue } from './ingest.js';
import { acquireFamilyLease, CRON_TICK_LEASE_MS, releaseFamilyLease } from './family-lease.js';
import { enqueueReconcile, getProductionRegistry, syncFamilyMirror } from './mirror.js';
import { readBackFamily } from './readback.js';
import { synthesizeFeed } from './synthesis.js';
import { buildFamilyTasks, buildMemberTasks } from './task-gen.js';

/**
 * The glue that takes a feed-config change all the way to the members' target
 * calendars, shared by every route that edits a feed, a link, or one of their
 * rules (feeds.ts) and by the routing-decision resolver (tasks.ts).
 */

/** The context slice `resynthesizeFeed` needs — a Hono context satisfies it. */
export interface PipelineContext {
  env: Bindings;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
}

/**
 * Ingest secrets (KEK + Google refresher) needed to read account-backed feeds,
 * plus the SSRF-guarded fetch every user-supplied URL must go through.
 */
export function ingestSecrets(env: Bindings) {
  return {
    kek: buildKekKeySet(env),
    googleRefresh: googleRefresherFor(env),
    fetchImpl: createGuardedFetch(env),
  };
}

/** Resynthesize a feed and regenerate its linked members' tasks, then mirror. */
export async function resynthesizeFeed(
  c: PipelineContext,
  db: Db,
  feed: typeof feeds.$inferSelect,
): Promise<void> {
  // A brand-new feed has never been ingested (lastSyncedAt is null), so
  // source_events is empty — a rule created right after setup (e.g. one meant
  // to override a near-term occurrence) would otherwise have nothing to match
  // until the next cron tick or a manual "Refresh feeds" tap. Ingest once,
  // synchronously, before the first synthesis. Best-effort: a failed ingest
  // here shouldn't block the mutation that already committed (the rule/link/
  // etc. row); it also isn't retried on every subsequent edit, since a failed
  // ingest marks the feed 'error' and cron only re-ingests 'active' feeds — an
  // 'error' feed already requires a manual "Refresh feeds" tap to recover, so
  // there's nothing this call could usefully retry once that's happened.
  if (!feed.lastSyncedAt && feed.status !== 'error') {
    try {
      await ingestFeed(db, feed, ingestSecrets(c.env));
    } catch {
      // swallow — ingestFeed already marked the feed 'error'.
    }
  }
  await synthesizeFeed(db, feed);
  const links = await db
    .select({ familyMemberId: familyMemberFeeds.familyMemberId })
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.feedId, feed.id));
  for (const familyMemberId of new Set(links.map((l) => l.familyMemberId))) {
    // Re-resolve overlaps before task-gen so a config change re-applies (or
    // clears) any splits on this member's agenda.
    await reconcileMemberConflicts(db, familyMemberId);
    await buildMemberTasks(db, familyMemberId);
  }
  enqueueReconcile(c, { kind: 'family', familyId: feed.familyId });
}

/**
 * One family's whole cron pipeline as a queue message. `scheduled()` enqueues
 * one per family (see `runFamilyTick`); the consumer in `mirror.ts` runs it.
 */
export type FamilyPipelineJob = { kind: 'family-pipeline'; familyId: string };

/**
 * One cron tick for one family — the full pipeline in dependency order:
 *
 *   1. ingest + synthesize any feed that's due — its refresh interval elapsed,
 *      or, for a feed left in 'error', its retry backoff did
 *      (feeds → source_events → calendar_events + pending_decisions)
 *   2. read back each configured target calendar (human events land as
 *      first-class unified-calendar events) — before task-gen so they get
 *      their convertible attendance tasks this tick
 *   3. resolve agenda overlaps: detect conflicts and apply resolved splits
 *      (a member can't be in two places at once) — before task-gen so the
 *      split segments spawn their own drop-off/pickup tasks
 *   4. task generation for every member (calendar_events → tasks)
 *   5. claimed-event true-up + mirror reconcile (unified calendar → target),
 *      then email invite outputs (where outbound mail is enabled)
 *
 * The mirror true-up is cheap when nothing drifted (payloadHash skips
 * unchanged events), so it's safe to run every tick.
 *
 * This runs as its own unit of work — in a queue consumer invocation with a
 * budget of its own (deployed), or inline under the cron's `waitUntil` (local
 * dev / tests) — so a failure in one stage is logged and the later ones still
 * run: each reads whatever the DB holds, and skipping the mirror because
 * read-back threw would strand claims that have nothing to do with it. Nothing
 * here is retried on failure; the next tick is the retry (an unreachable feed
 * has its own backoff on top, see `isFeedDue`). The names of the stages that
 * threw come back so a caller can tell a clean tick from a degraded one.
 *
 * Only a failure to get started at all (a misconfigured KEK) throws.
 *
 * The tick runs under the family's lease (`services/family-lease.ts`): a slow
 * tick still going when the next cron fires, or a queue redelivery of a message
 * whose consumer died, finds the lease held and skips the family rather than
 * duplicating its work and racing on remote writes. The lease expires on its
 * own (just under the cron period) if a tick dies without releasing it. Request
 * paths do not take it — they run these same stages inline, which is safe
 * because every pipeline insert is idempotent (upserts / `onConflictDoNothing`,
 * `tasks_generated_event_type_uq`).
 */
export async function runFamilyTick(
  env: Bindings,
  familyId: string,
  now = new Date(),
): Promise<{ failedStages: string[]; skipped?: true }> {
  const db = getDb(env.DB);
  const lease = await acquireFamilyLease(db, familyId, CRON_TICK_LEASE_MS, now);
  if (!lease) {
    console.log(`family ${familyId} tick skipped: a previous tick still holds the lease`);
    return { failedStages: [], skipped: true };
  }
  try {
    return await runFamilyStages(env, familyId, now);
  } finally {
    // Releases only the lease this tick took: if it outlived the TTL and a
    // newer tick holds the family now, that one is left alone. A failed release
    // is logged, not thrown, so it can't mask the tick's own error — the TTL
    // reclaims the lease regardless.
    await releaseFamilyLease(db, familyId, lease).catch((err) =>
      console.error(`releasing pipeline lease for family ${familyId} failed`, err),
    );
  }
}

async function runFamilyStages(
  env: Bindings,
  familyId: string,
  now: Date,
): Promise<{ failedStages: string[] }> {
  const db = getDb(env.DB);
  const registry = getProductionRegistry(env);
  // Every feed / read-back URL in here came from a user; the guarded fetch in
  // `ingestSecrets` re-vets each one at request time (these rows may predate
  // the policy).
  const secrets = ingestSecrets(env);
  const keys = secrets.kek;

  const failedStages: string[] = [];
  const stage = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      failedStages.push(name);
      console.error(`family ${familyId} tick: ${name} failed`, err);
    }
  };

  await stage('ingest', async () => {
    const familyFeeds = await db.select().from(feeds).where(eq(feeds.familyId, familyId));
    for (const feed of familyFeeds) {
      if (!isFeedDue(feed, now)) continue;
      try {
        await ingestFeed(db, feed, secrets);
        await synthesizeFeed(db, feed);
      } catch (err) {
        // One unreachable feed must not cost the family its whole tick: the
        // read-back, conflict, task-gen and mirror passes below don't depend on
        // it, and skipping them would strand human edits and claims that have
        // nothing to do with this feed. `ingestFeed` has already recorded why
        // the row is in 'error'.
        console.error(`feed ${feed.id} ingest failed`, err);
      }
    }
  });
  await stage('read-back', () => readBackFamily(db, familyId, secrets));
  // Resolve agenda overlaps (split/trim by priority) before task-gen so the
  // split segments drive their own drop-off/pickup tasks.
  await stage('conflicts', () => reconcileFamilyConflicts(db, familyId));
  await stage('task-gen', () => buildFamilyTasks(db, familyId));
  await stage('claims', () => reconcileClaimEvents(db, familyId));
  await stage('mirror', () => syncFamilyMirror(db, registry, keys, familyId));
  if (emailEnabled(env)) {
    await stage('email', () =>
      syncFamilyEmailOutputs(db, getOutbox(env), familyId, new Date(), emailLinkBase(env)),
    );
  }
  return { failedStages };
}
