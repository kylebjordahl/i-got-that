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
  // etc. row), and `ingestFeed` has already recorded why on the row. A feed
  // already in 'error' is skipped: the cron retries it on its own backoff
  // (`isFeedDue`) and a person can force it with Refresh, so an edit shouldn't
  // add one more fetch of a source that's known to be failing. Either way the
  // synthesis below still runs, off whatever `source_events` already holds.
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
 *   1. ingest any feed that's due — its refresh interval elapsed, or, for a
 *      feed left in 'error', its retry backoff did (feeds → source_events)
 *   2. synthesize every feed that isn't paused — due or not, and whether or
 *      not its ingest worked, so the 30-day window keeps rolling
 *      (source_events → calendar_events + pending_decisions)
 *   3. read back each configured target calendar (human events land as
 *      first-class unified-calendar events) — before task-gen so they get
 *      their convertible attendance tasks this tick
 *   4. resolve agenda overlaps: detect conflicts and apply resolved splits
 *      (a member can't be in two places at once) — before task-gen so the
 *      split segments spawn their own drop-off/pickup tasks
 *   5. task generation for every member (calendar_events → tasks)
 *   6. claimed-event true-up + mirror reconcile (unified calendar → target),
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
 * NOTE: nothing stops two runs of one family overlapping — a slow tick still
 * going when the next cron fires, or a queue redelivery of a message whose
 * consumer died after doing the work. Every stage tolerates a re-run (the
 * contentHash / payloadHash skips), but until the per-family lease in #264
 * lands the overlap costs duplicated work and can race on remote writes.
 */
export async function runFamilyTick(
  env: Bindings,
  familyId: string,
  now = new Date(),
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
  // Synthesis is what turns time into calendar days — the 30-day window rolls
  // forward, an exception feed's `bl:` baseline days are generated from the
  // link's config alone, and dated baseline-hour changes get folded in — so it
  // can't wait on a feed being readable or due. It works off the
  // `source_events` already stored, and an unchanged synthesis is reads only
  // (the contentHash skips), so running it for every feed every tick is cheap
  // and keeps the horizon growing a day per day even when a feed is stuck in
  // 'error' on a retry backoff that has grown to hours, or only polls daily.
  // Only `paused`, a user's decision, is skipped. The feed list is re-read so
  // synthesis sees what ingest just stamped on the rows (a newly discovered
  // timezone, say).
  await stage('synthesis', async () => {
    const familyFeeds = await db.select().from(feeds).where(eq(feeds.familyId, familyId));
    let failed = 0;
    for (const feed of familyFeeds) {
      if (feed.status === 'paused') continue;
      try {
        await synthesizeFeed(db, feed, { windowStart: now });
      } catch (err) {
        // As with ingest, one feed's failure must not starve the others of
        // their window roll. The stage still reports it, below.
        failed++;
        console.error(`feed ${feed.id} synthesis failed`, err);
      }
    }
    if (failed > 0) throw new Error(`${failed} feed(s) failed to synthesize`);
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
