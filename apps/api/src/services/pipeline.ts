import { eq, familyMemberFeeds, type feeds, type Db } from '@igt/db';
import type { Bindings } from '../env.js';
import { googleRefresherFor } from '../lib/google-oauth.js';
import { createGuardedFetch } from '../lib/outbound-url.js';
import { reconcileMemberConflicts } from './conflicts.js';
import { ingestFeed } from './ingest.js';
import { enqueueReconcile } from './mirror.js';
import { synthesizeFeed } from './synthesis.js';
import { buildMemberTasks } from './task-gen.js';

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
    kek: env.KEK,
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
