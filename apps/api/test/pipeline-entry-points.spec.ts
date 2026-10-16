import {
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext,
} from 'cloudflare:test';
import {
  and,
  calendarEvents,
  conflicts,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  tasks,
} from '@igt/db';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index.js';
import { reconcileMemberConflicts } from '../src/services/conflicts.js';
import type { DeliveryJob } from '../src/services/mirror.js';
import { runFamilyTick, runPipeline } from '../src/services/pipeline.js';
import { hashCalendarEvent, synthesizeFeed } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { authed, call, patched, setupFamily } from './helpers.js';

/**
 * #269 — every path that turns feeds into tasks and mirrored calendars is a thin
 * call to `runPipeline`. These specs pin what each entry point does with it:
 * the stages it reaches (through their observable effects), what it hands the
 * mirror, and that one failing stage / member / feed costs the others nothing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const FEED_ORIGIN = 'https://feed.example.com';

/** `YYYY-MM-DD` of the UTC day `days` after now. */
const dayFromNow = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

/** A day a few days out (inside the default 30-day synthesis window) at hh:mm. */
function futureAt(offsetDays: number, hour: number, min = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, min, 0, 0);
  return d;
}

// Feeds below point at URLs that answer 503: with net connect disabled an
// unmocked fetch would fail just as fast, but this way the failure is a real
// HTTP one, as in production.
beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
const downFeed = (path: string) =>
  fetchMock.get(FEED_ORIGIN).intercept({ path, method: 'GET' }).reply(503, 'down').persist();

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

/**
 * `env.DB` behind a proxy that records every statement prepared against it and
 * throws on the first one `failOn` matches — one stage's (or one member's) first
 * query dies without touching the code under test.
 */
function flakyDb(failOn?: RegExp) {
  const seen: string[] = [];
  let failed = false;
  const proxy = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          seen.push(sql);
          if (failOn && !failed && failOn.test(sql)) {
            failed = true;
            throw new Error('injected D1 failure');
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { DB: proxy as typeof env.DB, db: getDb(proxy as typeof env.DB), seen };
}

/** A DELIVERY_QUEUE stand-in that records what was enqueued. */
function recordingQueue() {
  const sent: DeliveryJob[] = [];
  return {
    sent,
    queue: { send: async (job: DeliveryJob) => void sent.push(job) },
  };
}

/** Call the app with `e` as its bindings (the shared `call` always uses the plain `env`). */
async function callWith(e: typeof env, path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://api.test${path}`, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/**
 * A family whose child is on a school's exception feed (all seven weekdays, so
 * every day of the window has a `bl:` baseline day) with the day three days out's
 * pickup *claimed* by the admin — the setup in which a pipeline that forgets the
 * claim true-up shows: a schedule change moves the task, and the claimed event
 * on the caretaker's calendar has to follow.
 */
async function claimFixture(
  email: string,
  feedValues: Partial<typeof feeds.$inferInsert> = {},
) {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const path = `/${email.split('@')[0]}.ics`;
  downFeed(path);
  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        mode: 'exception',
        url: `${FEED_ORIGIN}${path}`,
        sourceCalendarName: 'Lincoln Elementary',
        // Synced a moment ago: not due for the tick, and no first-ingest guard.
        lastSyncedAt: new Date(),
        ...feedValues,
      })
      .returning()
  )[0]!;
  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({
        familyId: fam.familyId,
        feedId: feed.id,
        familyMemberId: fam.childId,
        weekdayMask: 127,
        dayStart: '08:30',
        dayEnd: '14:45',
        defaultTaskType: 'transition',
      })
      .returning()
  )[0]!;
  await synthesizeFeed(db, feed);
  await buildMemberTasks(db, fam.childId);

  const event = (
    await db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.linkId, link.id),
          eq(calendarEvents.synthKey, `bl:${link.id}:${dayFromNow(3)}`),
        ),
      )
  )[0]!;
  const pickup = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.calendarEventId, event.id), eq(tasks.type, 'pickup')))
  )[0]!;
  const claim = await call(
    `/families/${fam.familyId}/tasks/${pickup.id}/assign`,
    authed(fam.admin.token, {}),
  );
  expect(claim.status).toBe(200);

  const reloadFeed = async () =>
    (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
  return {
    ...fam,
    db,
    feed,
    link,
    event,
    /** The pickup task's start and the start of the claimed event standing in for it. */
    claimState: async () => {
      const task = (await db.select().from(tasks).where(eq(tasks.id, pickup.id)))[0]!;
      const claimed = (
        await db
          .select()
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.taskId, pickup.id),
              eq(calendarEvents.provenance, 'claimed_task'),
            ),
          )
      )[0]!;
      return { taskStart: task.dtstart.getTime(), claimedStart: claimed.dtstart.getTime() };
    },
    /** Move the end of the school day (and so the pickup) without running any pipeline. */
    setDayEnd: (dayEnd: string) =>
      db.update(familyMemberFeeds).set({ dayEnd }).where(eq(familyMemberFeeds.id, link.id)),
    baselineDays: async () =>
      (
        await db
          .select({ synthKey: calendarEvents.synthKey })
          .from(calendarEvents)
          .where(eq(calendarEvents.linkId, link.id))
      ).filter((r) => r.synthKey.startsWith('bl:')).length,
    reloadFeed,
  };
}
type ClaimFixture = Awaited<ReturnType<typeof claimFixture>>;

interface EntryPoint {
  name: string;
  /** Does the entry point hand the mirror to the queue (every request path), or run it inline (the tick)? */
  enqueues: boolean;
  /** Needs an overlapping manual event + a pending conflict on the claimed day. */
  withConflict?: boolean;
  /** Change the schedule and invoke the entry point, so its own stages have to heal the claim. */
  run: (f: ClaimFixture, e: typeof env) => Promise<Response | void>;
}

const entryPoints: EntryPoint[] = [
  {
    name: 'runFamilyTick',
    enqueues: false,
    run: async (f, e) => {
      await f.setDayEnd('15:30');
      const result = await runFamilyTick(e, f.familyId);
      expect(result.failedStages).toEqual([]);
    },
  },
  {
    name: 'resynthesizeFeed (a rule/link edit route: PATCH member-link)',
    enqueues: true,
    // The edit itself is the schedule change; resynthesizeFeed has to carry it
    // all the way to the claimed event.
    run: (f, e) =>
      callWith(
        e,
        `/families/${f.familyId}/feeds/${f.feed.id}/member-links/${f.link.id}`,
        patched(f.admin.token, { dayEnd: '15:30' }),
      ),
  },
  {
    name: 'POST /feeds/:feedId/refresh',
    enqueues: true,
    run: async (f, e) => {
      await f.setDayEnd('15:30');
      return callWith(
        e,
        `/families/${f.familyId}/feeds/${f.feed.id}/refresh`,
        authed(f.admin.token),
      );
    },
  },
  {
    name: 'POST /feeds/refresh-all',
    enqueues: true,
    run: async (f, e) => {
      await f.setDayEnd('15:30');
      return callWith(e, `/families/${f.familyId}/feeds/refresh-all`, authed(f.admin.token));
    },
  },
  {
    name: 'POST /conflicts/:conflictId/dismiss (routes/tasks.ts)',
    enqueues: true,
    withConflict: true,
    // This path never synthesizes, so the new hours reach the calendar by an
    // earlier synthesis (as if a previous run died before task-gen); the route's
    // own conflicts → task-gen → claims has to finish the job.
    run: async (f, e) => {
      const [conflict] = await f.db
        .select()
        .from(conflicts)
        .where(eq(conflicts.familyMemberId, f.childId));
      await f.setDayEnd('15:30');
      await synthesizeFeed(f.db, f.feed);
      return callWith(
        e,
        `/families/${f.familyId}/conflicts/${conflict!.id}/dismiss`,
        authed(f.admin.token),
      );
    },
  },
];

describe('entry points: a schedule change reaches the claimed event at once', () => {
  it.each(entryPoints)('$name', async (entry) => {
    const f = await claimFixture(`entry-${entry.name.replace(/\W+/g, '-').toLowerCase()}@example.com`);
    if (entry.withConflict) {
      // A doctor's appointment in the middle of the claimed school day.
      await f.db.insert(calendarEvents).values({
        familyId: f.familyId,
        familyMemberId: f.childId,
        provenance: 'human',
        synthKey: 'ext:doctor:',
        externalUid: 'doctor',
        dtstart: futureAt(3, 10, 0),
        dtend: futureAt(3, 11, 0),
        summary: 'Doctor appointment',
        contentHash: 'doc-hash',
      });
      await reconcileMemberConflicts(f.db, f.childId);
      expect(await f.db.select().from(conflicts)).toHaveLength(1);
    }
    const { sent, queue } = recordingQueue();
    const probe = { ...env, DELIVERY_QUEUE: queue } as unknown as typeof env;

    const before = await f.claimState();
    expect(before.claimedStart).toBe(before.taskStart);

    const res = await entry.run(f, probe);
    if (res) expect(res.status).toBe(200);

    const after = await f.claimState();
    // The edit really did move the pickup...
    expect(after.taskStart).not.toBe(before.taskStart);
    // ...and the claim on the caretaker's calendar moved with it, now, not on
    // the next cron tick.
    expect(after.claimedStart).toBe(after.taskStart);
    // A request path schedules the mirror and returns; it never runs it inline.
    expect(sent).toEqual(entry.enqueues ? [{ kind: 'family', familyId: f.familyId }] : []);
  });
});

describe('the refresh routes', () => {
  it('keep their { ingest, synthesis } shape, with no failedStages on a clean run', async () => {
    const f = await claimFixture('refresh-shape@example.com');

    const one = await call(
      `/families/${f.familyId}/feeds/${f.feed.id}/refresh`,
      authed(f.admin.token),
    );
    expect(one.status).toBe(200);
    const single = (await one.json()) as Record<string, unknown>;
    expect(Object.keys(single).sort()).toEqual(['ingest', 'synthesis']);
    // The source is down: reported per feed, not thrown.
    expect(single.ingest).toMatchObject({ feedId: f.feed.id, fetched: false, processed: 0 });
    expect((single.ingest as { error: string }).error).toContain('503');
    expect(single.synthesis).toMatchObject({ feedId: f.feed.id });

    // Clear the cooldown the first refresh started.
    await f.db
      .update(feeds)
      .set({ lastRefreshRequestedAt: new Date(Date.now() - 2 * 60_000) });
    const all = await call(`/families/${f.familyId}/feeds/refresh-all`, authed(f.admin.token));
    expect(all.status).toBe(200);
    const family = (await all.json()) as Record<string, unknown>;
    expect(Object.keys(family).sort()).toEqual(['ingest', 'synthesis']);
    expect(family.ingest).toEqual([expect.objectContaining({ feedId: f.feed.id })]);
    expect(family.synthesis).toEqual([expect.objectContaining({ feedId: f.feed.id })]);
  });

  it('report a stage that threw, in a 200, and still finish and mirror', async () => {
    const f = await claimFixture('refresh-degraded@example.com');
    const { sent, queue } = recordingQueue();
    // Read-back's first query dies; everything after it must still run.
    const flaky = flakyDb(/from "member_calendars"/);
    const probe = { ...env, DB: flaky.DB, DELIVERY_QUEUE: queue } as unknown as typeof env;
    await f.setDayEnd('15:30');

    const res = await callWith(
      probe,
      `/families/${f.familyId}/feeds/${f.feed.id}/refresh`,
      authed(f.admin.token),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.failedStages).toEqual(['read-back']);
    expect(body.synthesis).toMatchObject({ feedId: f.feed.id });
    const after = await f.claimState();
    expect(after.claimedStart).toBe(after.taskStart);
    expect(sent).toEqual([{ kind: 'family', familyId: f.familyId }]);
  });
});

describe('paused feeds', () => {
  it('refresh-all does not synthesize a paused feed', async () => {
    const f = await claimFixture('paused-refresh-all@example.com');
    // Pause it, and drop the days it already has so any synthesis would show.
    await f.db.update(feeds).set({ status: 'paused' }).where(eq(feeds.id, f.feed.id));
    await f.db.delete(calendarEvents).where(eq(calendarEvents.linkId, f.link.id));

    const res = await call(`/families/${f.familyId}/feeds/refresh-all`, authed(f.admin.token));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { synthesis: unknown[] };
    expect(body.synthesis).toEqual([]);
    expect(await f.baselineDays()).toBe(0);
  });

  it.each([
    [
      'POST /feeds/:feedId/refresh',
      (f: ClaimFixture) =>
        call(`/families/${f.familyId}/feeds/${f.feed.id}/refresh`, authed(f.admin.token)),
    ],
    [
      'a link edit (resynthesizeFeed)',
      (f: ClaimFixture) =>
        call(
          `/families/${f.familyId}/feeds/${f.feed.id}/member-links/${f.link.id}`,
          patched(f.admin.token, { dayEnd: '15:30' }),
        ),
    ],
  ])('%s still processes the one feed it names, paused or not', async (name, act) => {
    const f = await claimFixture(
      `paused-named-${name.replace(/\W+/g, '-').toLowerCase()}@example.com`,
    );
    await f.db.update(feeds).set({ status: 'paused' }).where(eq(feeds.id, f.feed.id));
    await f.db.delete(calendarEvents).where(eq(calendarEvents.linkId, f.link.id));

    expect((await act(f)).status).toBe(200);

    // Someone acted on this feed directly: it is synthesized.
    expect(await f.baselineDays()).toBeGreaterThan(0);
  });
});

describe('runPipeline: what the options reach', () => {
  /** Everything a run can report, for a family with one never-due feed. */
  async function run(
    f: ClaimFixture,
    scope: { feedIds?: string[]; memberIds?: string[] },
    opts: Parameters<typeof runPipeline>[3],
  ) {
    const ctx = createExecutionContext();
    const result = await runPipeline(
      { env, executionCtx: ctx },
      f.db,
      { familyId: f.familyId, ...scope },
      opts,
    );
    await waitOnExecutionContext(ctx);
    return result;
  }
  const base = { readBack: false, mirror: 'none' } as const;

  it("'due' ingests only a feed whose interval has elapsed; 'force' always does; 'none' never", async () => {
    const f = await claimFixture('opts-ingest@example.com');

    expect((await run(f, {}, { ...base, ingest: 'due' })).ingest).toEqual([]);
    expect((await run(f, {}, { ...base, ingest: 'none' })).ingest).toEqual([]);
    const forced = await run(f, {}, { ...base, ingest: 'force' });
    expect(forced.ingest).toEqual([expect.objectContaining({ feedId: f.feed.id })]);
    // A feed that couldn't be read is reported on its entry, not as a failed stage.
    expect(forced.ingest[0]!.error).toContain('503');
    expect(forced.failedStages).toEqual([]);

    // Backoff elapsed for the 'error' status the failed read just left it in.
    await f.db
      .update(feeds)
      .set({ lastAttemptedAt: new Date(Date.now() - 24 * 60 * 60_000) })
      .where(eq(feeds.id, f.feed.id));
    expect((await run(f, {}, { ...base, ingest: 'due' })).ingest).toHaveLength(1);
  });

  it('synthesizes by default for a feed scope or an ingesting run, not for a bare member scope', async () => {
    const f = await claimFixture('opts-synth@example.com');
    const feedScope = await run(f, { feedIds: [f.feed.id] }, { ...base, ingest: 'none' });
    expect(feedScope.synthesis).toHaveLength(1);
    const tick = await run(f, {}, { ...base, ingest: 'due' });
    expect(tick.synthesis).toHaveLength(1);
    const members = await run(f, { memberIds: [f.childId] }, { ...base, ingest: 'none' });
    expect(members.synthesis).toEqual([]);
    expect(members.taskGen).toHaveLength(1);
    const off = await run(f, {}, { ...base, ingest: 'due', synthesize: false });
    expect(off.synthesis).toEqual([]);
  });

  it('refuses mirror: enqueue without an executionCtx', async () => {
    const f = await claimFixture('opts-enqueue@example.com');
    await expect(
      runPipeline({ env }, f.db, { familyId: f.familyId }, { ingest: 'none', readBack: false, mirror: 'enqueue' }),
    ).rejects.toThrow(/executionCtx/);
  });

  it('skips the claim true-up when the scope has no members to generate for', async () => {
    const f = await claimFixture('opts-no-members@example.com');
    const bare = (
      await f.db
        .insert(feeds)
        .values({
          familyId: f.familyId,
          mode: 'exception',
          url: `${FEED_ORIGIN}/unlinked.ics`,
          lastSyncedAt: new Date(),
        })
        .returning()
    )[0]!;
    const flaky = flakyDb();

    const result = await runPipeline(
      { env },
      flaky.db,
      { familyId: f.familyId, feedIds: [bare.id] },
      { ingest: 'none', readBack: false, mirror: 'none' },
    );

    expect(result).toMatchObject({ taskGen: [], conflicts: [], failedStages: [], errors: [] });
    // Nothing owned was looked at: task-gen had nobody, so the true-up had nothing to follow.
    expect(flaky.seen.some((sql) => /from "tasks"/.test(sql))).toBe(false);
  });
});

describe('runPipeline: one failure costs the others nothing', () => {
  /** Two children on one school feed, each with a synthesized school day that wants drop-off + pickup. */
  async function twoChildren(email: string) {
    const fam = await setupFamily(email);
    const db = getDb(env.DB);
    const second = (await (
      await call(
        `/families/${fam.familyId}/members`,
        authed(fam.admin.token, { relationName: 'child two', requiresCaretaker: true }),
      )
    ).json()) as { member: { id: string } };
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          mode: 'exception',
          url: `${FEED_ORIGIN}/two-children.ics`,
          lastSyncedAt: new Date(),
        })
        .returning()
    )[0]!;
    const childIds = [fam.childId, second.member.id];
    const eventIds = new Map<string, string>();
    for (const childId of childIds) {
      const link = (
        await db
          .insert(familyMemberFeeds)
          .values({
            familyId: fam.familyId,
            feedId: feed.id,
            familyMemberId: childId,
            weekdayMask: 31,
            dayStart: '08:30',
            dayEnd: '14:45',
            defaultTaskType: 'transition',
          })
          .returning()
      )[0]!;
      const payload = {
        dtstart: futureAt(2, 8, 30),
        dtend: futureAt(2, 15, 0),
        allDay: false,
        summary: 'School day',
        location: 'Lincoln Elementary',
        locationGeo: null,
        description: null,
      };
      const event = (
        await db
          .insert(calendarEvents)
          .values({
            familyId: fam.familyId,
            familyMemberId: childId,
            provenance: 'synthesized',
            synthKey: `bl:${link.id}:d2`,
            linkId: link.id,
            contentHash: hashCalendarEvent(payload),
            ...payload,
          })
          .returning()
      )[0]!;
      eventIds.set(childId, event.id);
    }
    const taskTypes = async (memberId: string) =>
      (await db.select().from(tasks).where(eq(tasks.familyMemberId, memberId)))
        .map((t) => t.type)
        .sort();
    /**
     * Give `childId` a claimed pickup, then move the end of their school day
     * without running anything: the pipeline under test has to heal the task
     * and carry the claim along, which is how a test can see that task-gen and
     * the claim true-up both ran.
     */
    const claimAndShift = async (childId: string) => {
      await buildMemberTasks(db, childId);
      const pickup = (
        await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.familyMemberId, childId), eq(tasks.type, 'pickup')))
      )[0]!;
      const claim = await call(
        `/families/${fam.familyId}/tasks/${pickup.id}/assign`,
        authed(fam.admin.token, {}),
      );
      expect(claim.status).toBe(200);
      const eventId = eventIds.get(childId)!;
      const event = (await db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId)))[0]!;
      const dtend = futureAt(2, 16, 0);
      await db
        .update(calendarEvents)
        .set({ dtend, contentHash: hashCalendarEvent({ ...event, dtend }) })
        .where(eq(calendarEvents.id, eventId));
      return async () => {
        const task = (await db.select().from(tasks).where(eq(tasks.id, pickup.id)))[0]!;
        const claimed = (
          await db
            .select()
            .from(calendarEvents)
            .where(
              and(
                eq(calendarEvents.taskId, pickup.id),
                eq(calendarEvents.provenance, 'claimed_task'),
              ),
            )
        )[0]!;
        return { taskStart: task.dtstart.getTime(), claimedStart: claimed.dtstart.getTime() };
      };
    };
    return { ...fam, db, childIds: childIds as [string, string], taskTypes, claimAndShift };
  }

  async function runScoped(f: Awaited<ReturnType<typeof twoChildren>>, failOn: RegExp) {
    const flaky = flakyDb(failOn);
    const { sent, queue } = recordingQueue();
    const ctx = createExecutionContext();
    const result = await runPipeline(
      { env: { ...env, DELIVERY_QUEUE: queue } as unknown as typeof env, executionCtx: ctx },
      flaky.db,
      { familyId: f.familyId, memberIds: f.childIds },
      { ingest: 'none', synthesize: false, readBack: false, mirror: 'enqueue' },
    );
    await waitOnExecutionContext(ctx);
    return { result, sent };
  }

  it("one member's conflicts reconcile throwing leaves task-gen for both members and the mirror enqueue intact", async () => {
    const f = await twoChildren('isolate-conflicts@example.com');
    const [first, second] = f.childIds;
    const secondClaim = await f.claimAndShift(second);
    const before = await secondClaim();

    // The first member's reconcile dies reading its conflicts table.
    const { result, sent } = await runScoped(f, /from "conflicts"/);

    expect(result.failedStages).toEqual(['conflicts']);
    expect(result.errors).toEqual([
      { stage: 'conflicts', id: first, message: 'injected D1 failure' },
    ]);
    expect(errorLog).toHaveBeenCalledWith(`member ${first} conflicts failed`, expect.any(Error));
    // The other member's reconcile ran...
    expect(result.conflicts.map((r) => r.familyMemberId)).toEqual([second]);
    // ...task-gen ran for both, including the member whose conflicts failed...
    expect(result.taskGen.map((r) => r.familyMemberId)).toEqual([first, second]);
    expect(await f.taskTypes(first)).toEqual(['dropoff', 'pickup']);
    expect(await f.taskTypes(second)).toEqual(['dropoff', 'pickup']);
    // ...the claim true-up still ran after it (the healed pickup's claim followed)...
    const after = await secondClaim();
    expect(after.taskStart).not.toBe(before.taskStart);
    expect(after.claimedStart).toBe(after.taskStart);
    // ...and so did the mirror.
    expect(sent).toEqual([{ kind: 'family', familyId: f.familyId }]);
  });

  it("one member's task-gen throwing leaves the other member's tasks, the claims and the mirror enqueue intact", async () => {
    const f = await twoChildren('isolate-taskgen@example.com');
    const [first, second] = f.childIds;
    const secondClaim = await f.claimAndShift(second);
    const before = await secondClaim();

    // Task-gen's first read of a member's task rules dies — the first member's.
    const { result, sent } = await runScoped(f, /from "task_rules"/);

    expect(result.failedStages).toEqual(['task-gen']);
    expect(result.errors).toEqual([
      { stage: 'task-gen', id: first, message: 'injected D1 failure' },
    ]);
    expect(result.conflicts.map((r) => r.familyMemberId)).toEqual([first, second]);
    expect(result.taskGen.map((r) => r.familyMemberId)).toEqual([second]);
    expect(await f.taskTypes(first)).toEqual([]);
    expect(await f.taskTypes(second)).toEqual(['dropoff', 'pickup']);
    const after = await secondClaim();
    expect(after.taskStart).not.toBe(before.taskStart);
    expect(after.claimedStart).toBe(after.taskStart);
    expect(sent).toEqual([{ kind: 'family', familyId: f.familyId }]);
  });

  it('a stage that cannot even list its members fails alone', async () => {
    const f = await claimFixture('isolate-members@example.com');
    const flaky = flakyDb(/from "family_members"/);

    // Whole-family scope reads the member list for conflicts; it dies once.
    const result = await runPipeline(
      { env },
      flaky.db,
      { familyId: f.familyId },
      { ingest: 'none', synthesize: false, readBack: false, mirror: 'none' },
    );

    expect(result.failedStages).toEqual(['conflicts']);
    // Task-gen looked the members up again and got on with it.
    expect(result.taskGen).toHaveLength(2);
  });
});
