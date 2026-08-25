import { eq, families, feeds, getDb } from '@igt/db';
import type { Bindings } from './env.js';
import { googleRefresherFor } from './lib/google-oauth.js';
import { createGuardedFetch } from './lib/outbound-url.js';
import { sweepOrphanedSecrets } from './services/auth.js';
import { reconcileClaimEvents } from './services/claim.js';
import { reconcileFamilyConflicts } from './services/conflicts.js';
import { getProductionRegistry, syncFamilyMirror } from './services/mirror.js';
import { ingestFeed, isFeedDue } from './services/ingest.js';
import { readBackFamily } from './services/readback.js';
import { buildKekKeySet } from './lib/secrets.js';
import { synthesizeFeed } from './services/synthesis.js';
import { buildFamilyTasks } from './services/task-gen.js';

/**
 * Cron tick, per family — the full pipeline in dependency order:
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
 *   5. claimed-event true-up + mirror reconcile (unified calendar → target)
 *
 * The mirror true-up is cheap when nothing drifted (payloadHash skips
 * unchanged events), so it's safe to run every tick.
 */
export async function scheduled(
  _event: ScheduledController,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<void> {
  const db = getDb(env.DB);
  const registry = getProductionRegistry(env);
  const keys = buildKekKeySet(env);
  const secrets = {
    kek: keys,
    googleRefresh: googleRefresherFor(env),
    // Every feed / read-back URL in here came from a user; the guard re-vets
    // each one at request time (these rows may predate the policy).
    fetchImpl: createGuardedFetch(env),
  };
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

  const allFamilies = await db.select().from(families);
  for (const fam of allFamilies) {
    ctx.waitUntil(
      (async () => {
        try {
          const familyFeeds = await db
            .select()
            .from(feeds)
            .where(eq(feeds.familyId, fam.id));
          for (const feed of familyFeeds) {
            if (!isFeedDue(feed, now)) continue;
            try {
              await ingestFeed(db, feed, secrets);
              await synthesizeFeed(db, feed);
            } catch (err) {
              // One unreachable feed must not cost the family its whole tick:
              // the read-back, conflict, task-gen and mirror passes below don't
              // depend on it, and skipping them would strand human edits and
              // claims that have nothing to do with this feed. `ingestFeed` has
              // already recorded why the row is in 'error'.
              console.error(`feed ${feed.id} ingest failed`, err);
            }
          }
          await readBackFamily(db, fam.id, secrets);
          // Resolve agenda overlaps (split/trim by priority) before task-gen so
          // the split segments drive their own drop-off/pickup tasks.
          await reconcileFamilyConflicts(db, fam.id);
          await buildFamilyTasks(db, fam.id);
          await reconcileClaimEvents(db, fam.id);
          await syncFamilyMirror(db, registry, keys, fam.id);
        } catch (err) {
          console.error(`scheduled tick failed for family ${fam.id}`, err);
        }
      })(),
    );
  }
}
