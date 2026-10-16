import {
  and,
  eq,
  familyMemberFeeds,
  familyMembers,
  feeds,
  getDb,
  inArray,
  type Db,
} from '@igt/db';
import type { Bindings } from '../env.js';
import { emailEnabled, emailLinkBase, getOutbox } from '../lib/email.js';
import { googleRefresherFor } from '../lib/google-oauth.js';
import { createGuardedFetch } from '../lib/outbound-url.js';
import { buildKekKeySet } from '../lib/secrets.js';
import { reconcileClaimEvents } from './claim.js';
import { type ConflictReconcileResult, reconcileMemberConflicts } from './conflicts.js';
import { syncFamilyEmailOutputs } from './email-outputs.js';
import { type IngestResult, ingestFeed, isFeedDue } from './ingest.js';
import { acquireFamilyLease, CRON_TICK_LEASE_MS, releaseFamilyLease } from './family-lease.js';
import {
  enqueueReconcile,
  getProductionRegistry,
  syncFamilyMirror,
  type SyncResult,
} from './mirror.js';
import { type ReadBackResult, readBackFamily } from './readback.js';
import { type SynthesizeResult, synthesizeFeed } from './synthesis.js';
import { buildMemberTasks, type TaskGenResult } from './task-gen.js';

/**
 * The glue that takes a feed-config change all the way to the members' target
 * calendars, shared by every route that edits a feed, a link, or one of their
 * rules (feeds.ts) and by the routing-decision resolver (tasks.ts) — all of it
 * a thin call to `runPipeline`, below.
 */

/** The context slice `resynthesizeFeed` needs — a Hono context satisfies it. */
export interface PipelineContext {
  env: Bindings;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
}

/**
 * What `runPipeline` needs from its caller. `executionCtx` is only read for
 * `mirror: 'enqueue'` (the request paths); the cron tick has none and mirrors
 * inline.
 */
export interface PipelineRunContext {
  env: Bindings;
  executionCtx?: PipelineContext['executionCtx'];
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

/**
 * The stages of the pipeline, in the one order `runPipeline` runs them. Also
 * the names a `PipelineResult` reports failures under.
 */
export const PIPELINE_STAGES = [
  'ingest',
  'synthesis',
  'read-back',
  'conflicts',
  'task-gen',
  'claims',
  'mirror',
  'email',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** What a `runPipeline` call works on. */
export interface PipelineScope {
  familyId: string;
  /**
   * Narrow ingest + synthesis to these feeds (and default `memberIds` to the
   * members linked to them). Omitted: every feed in the family.
   */
  feedIds?: string[];
  /**
   * Narrow conflicts + task-gen to these members (they must belong to
   * `familyId`). Omitted: the members linked to `feedIds` when that is given,
   * else every member of the family.
   */
  memberIds?: string[];
}

export interface PipelineOptions {
  /**
   * - `'due'`: ingest the feeds `isFeedDue` says are due (the background poll —
   *   never a paused feed, and an 'error' feed only once its backoff elapsed);
   *   uses the stored ETag.
   * - `'force'`: a person pressed Refresh — ingest every feed in scope
   *   unconditionally, dropping the ETag (see `IngestOptions.force`). A
   *   family-wide run (no `scope.feedIds`) skips a paused feed, as `'due'` does;
   *   a feed the caller names is read even if paused.
   * - `'none'`: don't touch the network for feeds.
   */
  ingest: 'due' | 'force' | 'none';
  /**
   * Run `synthesizeFeed` for the feeds in scope. Defaults to true when
   * `scope.feedIds` is given or anything is being ingested, false for a bare
   * member-scoped re-run (the conflict routes).
   */
  synthesize?: boolean;
  /** Read back the family's target calendars (remote CalDAV/Google reads). */
  readBack: boolean;
  /**
   * - `'enqueue'`: schedule one family-wide reconcile (queue when bound, else
   *   `waitUntil`) and return — the only choice for a request path, where a full
   *   reconcile must never be awaited. Needs `ctx.executionCtx`.
   * - `'inline'`: run the mirror reconcile (and the email outputs, where mail is
   *   enabled) in-process — for a unit of work that has its own budget (the
   *   queue consumer / cron).
   * - `'none'`.
   */
  mirror: 'enqueue' | 'inline' | 'none';
  /** The clock: for `'due'` and the synthesis window. Defaults to real time. */
  now?: Date;
  /** Prefix for stage-failure log lines (`family <id> <label>: <stage> failed`). */
  label?: string;
}

/** One thing that threw inside a stage, kept so a caller can say what degraded. */
export interface PipelineError {
  stage: PipelineStage;
  /** The feed or member the failure belongs to; absent when the whole stage threw. */
  id?: string;
  message: string;
}

export interface PipelineResult {
  /**
   * One entry per feed ingested. A feed that couldn't be read still gets an
   * entry — with `error` set (`ingestFeed` has already recorded why on the
   * feed row) — and is deliberately NOT a failed stage: an unreachable source
   * is data, and the rest of the pipeline works off what is already stored.
   */
  ingest: IngestResult[];
  synthesis: SynthesizeResult[];
  readBack: ReadBackResult[];
  conflicts: ConflictReconcileResult[];
  taskGen: TaskGenResult[];
  /** Only for `mirror: 'inline'`. */
  mirror?: SyncResult;
  /** Stages in which something threw (or, for the feed/member loops, a unit did), in run order. */
  failedStages: PipelineStage[];
  errors: PipelineError[];
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * THE pipeline: every path that turns feeds into tasks and mirrored calendars
 * runs these stages, in this order, through this function. Add a stage here, not
 * in a caller.
 *
 *   1. ingest      — feeds → source_events (`opts.ingest`)
 *   2. synthesis   — source_events + link config → calendar_events +
 *                    pending_decisions, per feed (`opts.synthesize`). Does not
 *                    wait on ingest: it is what rolls the 30-day window, an
 *                    exception feed's `bl:` baseline days and dated baseline-hour
 *                    changes forward, so it runs for a feed whose ingest failed
 *                    or wasn't due
 *   3. read-back   — each target calendar's human events → calendar_events
 *                    (`opts.readBack`), before task-gen so they get their
 *                    convertible attendance tasks
 *   4. conflicts   — detect overlaps and apply resolved splits, per member,
 *                    before task-gen so split segments spawn their own
 *                    drop-off/pickup tasks
 *   5. task-gen    — calendar_events → tasks, per member
 *   6. claims      — true-up every claimed_task event against the (possibly
 *                    just-healed) owned tasks. Always runs after task-gen when
 *                    there were members to generate for: task-gen moves an owned
 *                    task when its event moves, and only this puts the owner's
 *                    claimed event at the new time
 *   7. mirror      — calendar_events → each member's target calendar, then
 *                    (inline, where outbound mail is enabled) the email invite
 *                    outputs (`opts.mirror`)
 *
 * Who calls it, and with what:
 *
 *   | entry point                                   | scope                  | ingest  | synthesize | readBack | mirror    |
 *   |-----------------------------------------------|------------------------|---------|------------|----------|-----------|
 *   | `runFamilyTick` (cron / queue, under a lease) | family                 | 'due'   | yes        | yes      | 'inline'  |
 *   | `resynthesizeFeed` (feed / link / rule edits) | feedIds: [feed]        | 'force' once if never synced and not in 'error', else 'none' | yes | no | 'enqueue' |
 *   | `POST .../feeds/:feedId/refresh`              | feedIds: [feed]        | 'force' | yes        | yes      | 'enqueue' |
 *   | `POST .../feeds/refresh-all`                  | family                 | 'force' | yes        | yes      | 'enqueue' |
 *   | conflict resolve / dismiss / revert, routing-decision resolve (no rule) | memberIds | 'none' | no | no | 'enqueue' |
 *
 * Isolation: each stage, and each feed / member inside the ones that loop over
 * them, runs in its own try/catch. A throw is logged, recorded in
 * `PipelineResult.errors` / `failedStages`, and the later stages still run —
 * they read whatever the DB holds, and skipping the mirror because one member's
 * conflicts reconcile threw would strand claims that have nothing to do with it.
 * Nothing is retried; the next tick is the retry. Only a failure to get started
 * at all (a misconfigured KEK) throws, as does asking for `mirror: 'enqueue'`
 * without an `executionCtx`.
 *
 * Scope rules:
 *  - `feedIds` names feeds the caller has acted on, so they are processed even
 *    if paused. A family-wide run never ingests (`'due'` or `'force'`) or
 *    synthesizes a paused feed: only `paused`, a user's decision, is skipped
 *    outright. (A read of a paused feed would flip it back to 'active' or
 *    'error', silently undoing the pause — so Refresh all must not make one.)
 *  - Read-back and the mirror are always family-wide; `memberIds` only narrows
 *    conflicts and task-gen. The claim true-up is family-wide too, so the
 *    `'enqueue'` job is a family reconcile: it has to reach any caretaker whose
 *    claimed event the true-up moved, who needn't be in `memberIds`.
 *  - Every path here is lease-free except the tick (see `runFamilyTick`); that
 *    is safe because every pipeline insert is idempotent.
 */
export async function runPipeline(
  ctx: PipelineRunContext,
  db: Db,
  scope: PipelineScope,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const { env } = ctx;
  const { familyId, feedIds } = scope;
  const label = opts.label ?? 'pipeline';
  const synthesize = opts.synthesize ?? (feedIds !== undefined || opts.ingest !== 'none');
  const now = opts.now ?? new Date();
  if (opts.mirror === 'enqueue' && !ctx.executionCtx) {
    throw new Error("runPipeline: mirror 'enqueue' needs an executionCtx");
  }

  // Every feed / read-back URL in here came from a user; the guarded fetch in
  // `ingestSecrets` re-vets each one at request time (these rows may predate
  // the policy). Built up front, outside any stage, so a misconfigured KEK fails
  // the run before it starts rather than as a "failed" stage.
  const secrets =
    opts.ingest !== 'none' || opts.readBack || opts.mirror === 'inline'
      ? ingestSecrets(env)
      : undefined;

  const result: PipelineResult = {
    ingest: [],
    synthesis: [],
    readBack: [],
    conflicts: [],
    taskGen: [],
    failedStages: [],
    errors: [],
  };
  const fail = (stage: PipelineStage, err: unknown, id?: string): void => {
    if (!result.failedStages.includes(stage)) result.failedStages.push(stage);
    result.errors.push({ stage, ...(id ? { id } : {}), message: messageOf(err) });
  };
  const stage = async (name: PipelineStage, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      fail(name, err);
      console.error(`family ${familyId} ${label}: ${name} failed`, err);
    }
  };
  /** One feed's / member's share of a stage: its failure must not cost the others theirs. */
  const unit = async (
    name: PipelineStage,
    kind: 'feed' | 'member',
    id: string,
    run: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await run();
    } catch (err) {
      fail(name, err, id);
      console.error(`${kind} ${id} ${name} failed`, err);
    }
  };

  /** The feeds in scope, as the DB holds them right now. */
  const loadFeeds = async () =>
    db
      .select()
      .from(feeds)
      .where(
        feedIds
          ? and(eq(feeds.familyId, familyId), inArray(feeds.id, feedIds))
          : eq(feeds.familyId, familyId),
      );

  // Members for conflicts + task-gen. Resolved lazily and only cached on
  // success, so a failed lookup in one stage doesn't doom the next.
  let members: string[] | undefined;
  const memberIds = async (): Promise<string[]> => {
    if (members) return members;
    if (scope.memberIds) return (members = scope.memberIds);
    if (feedIds) {
      const links = await db
        .select({ familyMemberId: familyMemberFeeds.familyMemberId })
        .from(familyMemberFeeds)
        .where(
          and(eq(familyMemberFeeds.familyId, familyId), inArray(familyMemberFeeds.feedId, feedIds)),
        );
      return (members = [...new Set(links.map((l) => l.familyMemberId))]);
    }
    // All members, not just those with events: the orphan sweep in task-gen
    // must reach a member whose last event vanished.
    const rows = await db
      .select({ id: familyMembers.id })
      .from(familyMembers)
      .where(eq(familyMembers.familyId, familyId));
    return (members = rows.map((r) => r.id));
  };

  // --- 1. ingest ---------------------------------------------------------------
  if (opts.ingest !== 'none') {
    await stage('ingest', async () => {
      for (const feed of await loadFeeds()) {
        if (!feedIds && feed.status === 'paused') continue;
        if (opts.ingest === 'due' && !isFeedDue(feed, now)) continue;
        try {
          result.ingest.push(
            await ingestFeed(
              db,
              feed,
              opts.ingest === 'force' ? { ...secrets!, force: true } : secrets!,
            ),
          );
        } catch (err) {
          // One unreachable feed must not cost the family the rest of its run:
          // the read-back, conflict, task-gen and mirror passes below don't
          // depend on it, and skipping them would strand human edits and claims
          // that have nothing to do with this feed. `ingestFeed` has already
          // recorded why the row is in 'error'; the entry here is the shape the
          // refresh routes report per feed.
          console.error(`feed ${feed.id} ingest failed`, err);
          result.ingest.push({
            feedId: feed.id,
            fetched: false,
            processed: 0,
            error: messageOf(err),
          });
        }
      }
    });
  }

  // --- 2. synthesis ------------------------------------------------------------
  // The feed list is re-read so synthesis sees what ingest just stamped on the
  // rows (a newly discovered timezone, say).
  if (synthesize) {
    await stage('synthesis', async () => {
      for (const feed of await loadFeeds()) {
        if (!feedIds && feed.status === 'paused') continue;
        await unit('synthesis', 'feed', feed.id, async () => {
          result.synthesis.push(
            await synthesizeFeed(db, feed, opts.now ? { windowStart: opts.now } : {}),
          );
        });
      }
    });
  }

  // --- 3. read-back ------------------------------------------------------------
  if (opts.readBack) {
    await stage('read-back', async () => {
      result.readBack = await readBackFamily(db, familyId, secrets!);
    });
  }

  // --- 4. conflicts ------------------------------------------------------------
  // Resolve agenda overlaps (split/trim by priority) before task-gen so the
  // split segments drive their own drop-off/pickup tasks.
  await stage('conflicts', async () => {
    for (const id of await memberIds()) {
      await unit('conflicts', 'member', id, async () => {
        result.conflicts.push(await reconcileMemberConflicts(db, id));
      });
    }
  });

  // --- 5. task-gen -------------------------------------------------------------
  let membersInScope = true;
  await stage('task-gen', async () => {
    const ids = await memberIds();
    membersInScope = ids.length > 0;
    for (const id of ids) {
      await unit('task-gen', 'member', id, async () => {
        result.taskGen.push(await buildMemberTasks(db, id));
      });
    }
  });

  // --- 6. claims ---------------------------------------------------------------
  if (membersInScope) {
    await stage('claims', () => reconcileClaimEvents(db, familyId));
  }

  // --- 7. mirror (+ email) -----------------------------------------------------
  if (opts.mirror === 'enqueue') {
    await stage('mirror', async () => {
      enqueueReconcile(
        { env, executionCtx: ctx.executionCtx! },
        { kind: 'family', familyId },
      );
    });
  } else if (opts.mirror === 'inline') {
    await stage('mirror', async () => {
      result.mirror = await syncFamilyMirror(
        db,
        getProductionRegistry(env),
        secrets!.kek,
        familyId,
      );
    });
    if (emailEnabled(env)) {
      await stage('email', () =>
        syncFamilyEmailOutputs(db, getOutbox(env), familyId, new Date(), emailLinkBase(env)),
      );
    }
  }

  return result;
}

/**
 * Resynthesize a feed and regenerate its linked members' tasks, then mirror —
 * `runPipeline` scoped to the one feed, for the routes that edit it, its links
 * or their rules.
 */
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
  // synthesis still runs, off whatever `source_events` already holds.
  const firstIngest = !feed.lastSyncedAt && feed.status !== 'error';
  await runPipeline(
    c,
    db,
    { familyId: feed.familyId, feedIds: [feed.id] },
    // 'force': a never-synced feed has no ETag for the conditional request to
    // use, so it only asks intermediaries to revalidate.
    { ingest: firstIngest ? 'force' : 'none', readBack: false, mirror: 'enqueue' },
  );
}

/**
 * One family's whole cron pipeline as a queue message. `scheduled()` enqueues
 * one per family (see `runFamilyTick`); the consumer in `mirror.ts` runs it.
 */
export type FamilyPipelineJob = { kind: 'family-pipeline'; familyId: string };

/**
 * One cron tick for one family — `runPipeline` over the whole family (see its
 * docblock for the stage order and what each stage does), ingesting the feeds
 * that are due — their refresh interval elapsed, or, for a feed left in
 * 'error', their retry backoff did — and mirroring inline.
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
  const { failedStages } = await runPipeline(
    { env },
    getDb(env.DB),
    { familyId },
    { ingest: 'due', synthesize: true, readBack: true, mirror: 'inline', now, label: 'tick' },
  );
  return { failedStages };
}
