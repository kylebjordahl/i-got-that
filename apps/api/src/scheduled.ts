import { and, eq, families, feeds, getDb } from '@igt/db';
import type { Bindings } from './env.js';
import { googleRefresherFor } from './lib/google-oauth.js';
import { reconcileClaimEvents } from './services/claim.js';
import { getProductionRegistry, syncFamilyMirror } from './services/mirror.js';
import { ingestFeed } from './services/ingest.js';
import { readBackFamily } from './services/readback.js';
import { synthesizeFeed } from './services/synthesis.js';
import { buildFamilyTasks } from './services/task-gen.js';

/**
 * Cron tick, per family — the full pipeline in dependency order:
 *
 *   1. ingest + synthesize any feed whose refresh interval elapsed
 *      (feeds → source_events → calendar_events + pending_decisions)
 *   2. read back each configured target calendar (human events land as
 *      first-class unified-calendar events) — before task-gen so they get
 *      their convertible attendance tasks this tick
 *   3. task generation for every member (calendar_events → tasks)
 *   4. claimed-event true-up + mirror reconcile (unified calendar → target)
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
  const secrets = { kek: env.KEK, googleRefresh: googleRefresherFor(env) };
  const now = Date.now();

  const allFamilies = await db.select().from(families);
  for (const fam of allFamilies) {
    ctx.waitUntil(
      (async () => {
        try {
          const familyFeeds = await db
            .select()
            .from(feeds)
            .where(and(eq(feeds.familyId, fam.id), eq(feeds.status, 'active')));
          for (const feed of familyFeeds) {
            const last = feed.lastSyncedAt?.getTime() ?? 0;
            if (now - last >= feed.refreshMinutes * 60 * 1000) {
              await ingestFeed(db, feed, secrets);
              await synthesizeFeed(db, feed);
            }
          }
          await readBackFamily(db, fam.id, secrets);
          await buildFamilyTasks(db, fam.id);
          await reconcileClaimEvents(db, fam.id);
          await syncFamilyMirror(db, registry, env.KEK, fam.id);
        } catch (err) {
          console.error(`scheduled tick failed for family ${fam.id}`, err);
        }
      })(),
    );
  }
}
