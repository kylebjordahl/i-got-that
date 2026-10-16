import { env, fetchMock } from 'cloudflare:test';
import { calendarEvents, eq, familyMemberFeeds, feeds, getDb } from '@igt/db';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliveryQueueConsumer } from '../src/services/mirror.js';
import { runFamilyTick } from '../src/services/pipeline.js';
import { setupFamily } from './helpers.js';

/**
 * An env whose D1 binding records every statement prepared against it and
 * throws on the first one `failOn` matches. Drizzle prepares each query, so
 * this fails exactly one stage's first query without touching the code under
 * test — and the recorded SQL says which stages still ran afterwards.
 */
function flakyDb(failOn?: RegExp) {
  const seen: string[] = [];
  let failed = false;
  const db = new Proxy(env.DB, {
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
  return { env: { ...env, DB: db } as typeof env, seen };
}

/** Position of the first recorded statement matching `re` at or after `from`. */
const indexOfSql = (seen: string[], re: RegExp, from = 0) =>
  seen.findIndex((sql, i) => i >= from && re.test(sql));

// The synthesis specs below point feeds at a URL that is never meant to answer;
// with net connect disabled an unmocked fetch fails fast instead of reaching DNS.
beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

describe('runFamilyTick', () => {
  it('runs every stage for the family and reports a clean tick', async () => {
    const fam = await setupFamily('tick-clean@example.com');
    const { env: probe, seen } = flakyDb();

    const result = await runFamilyTick(probe, fam.familyId);

    expect(result).toEqual({ failedStages: [] });
    // The stages' first reads show up in pipeline order: the feed list
    // (ingest), the member calendars (read-back)...
    const feedsAt = indexOfSql(seen, /from "feeds"/);
    const readBackAt = indexOfSql(seen, /from "member_calendars"/, feedsAt);
    // ...and, further down, the tasks the later stages work from.
    const claimsAt = indexOfSql(seen, /from "tasks"/, readBackAt);
    expect(feedsAt).toBeGreaterThanOrEqual(0);
    expect(readBackAt).toBeGreaterThan(feedsAt);
    expect(claimsAt).toBeGreaterThan(readBackAt);
  });

  it('logs a failing stage and still runs the ones after it', async () => {
    const fam = await setupFamily('tick-isolated@example.com');
    // Read-back's first query dies. Everything downstream must still get its
    // turn: each stage reads whatever the DB holds, and skipping the mirror
    // because a target calendar was unreachable would strand claims.
    const { env: probe, seen } = flakyDb(/from "member_calendars"/);

    const result = await runFamilyTick(probe, fam.familyId);

    expect(result.failedStages).toEqual(['read-back']);
    expect(errorLog).toHaveBeenCalledWith(
      `family ${fam.familyId} tick: read-back failed`,
      expect.any(Error),
    );
    const failedAt = indexOfSql(seen, /from "member_calendars"/);
    expect(indexOfSql(seen, /from "tasks"/, failedAt + 1)).toBeGreaterThan(failedAt);
  });

  it('survives losing the feed list, the first thing a tick reads', async () => {
    const fam = await setupFamily('tick-no-feeds@example.com');
    const { env: probe, seen } = flakyDb(/from "feeds"/);

    const result = await runFamilyTick(probe, fam.familyId);

    expect(result.failedStages).toEqual(['ingest']);
    expect(indexOfSql(seen, /from "tasks"/)).toBeGreaterThan(-1);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const FEED_ORIGIN = 'https://feed.example.com';
const FEED_PATH = '/down.ics';

/** `YYYY-MM-DD` of the UTC day `days` after `from`'s. */
const dayAfter = (from: Date, days: number) =>
  new Date(from.getTime() + days * DAY_MS).toISOString().slice(0, 10);

/**
 * A family whose child is on a school's exception feed: no source events at all,
 * so every calendar event is a `bl:` baseline day generated from the link's
 * config alone (all seven weekdays, so every day of the window has one).
 */
async function baselineFeed(
  email: string,
  values: Partial<typeof feeds.$inferInsert> = {},
) {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        mode: 'exception',
        url: `${FEED_ORIGIN}${FEED_PATH}`,
        sourceCalendarName: 'Lincoln Elementary',
        ...values,
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
      })
      .returning()
  )[0]!;
  const baselineDays = async (): Promise<string[]> =>
    (
      await db
        .select({ synthKey: calendarEvents.synthKey })
        .from(calendarEvents)
        .where(eq(calendarEvents.linkId, link.id))
    )
      .map((r) => r.synthKey)
      .filter((k) => k.startsWith(`bl:${link.id}:`))
      .map((k) => k.slice(`bl:${link.id}:`.length))
      .sort();
  const reloadFeed = async () =>
    (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
  return { ...fam, db, feed, link, baselineDays, reloadFeed };
}

describe('runFamilyTick: synthesis does not wait on ingest', () => {
  it('keeps rolling the window for a feed whose ingest fails every tick', async () => {
    // A feed that stays broken for days: with the retry backoff grown to hours
    // it is rarely even attempted, and when it is, the fetch throws. Synthesis
    // used to sit in the same try as the ingest, so none of that ever reached
    // it and the family's horizon shrank by a day per day.
    fetchMock
      .get(FEED_ORIGIN)
      .intercept({ path: FEED_PATH, method: 'GET' })
      .reply(503, 'down')
      .persist();
    const f = await baselineFeed('tick-synth-ingest-fails@example.com');
    const day0 = new Date();

    const first = await runFamilyTick(env, f.familyId, day0);
    // The ingest really was attempted and really failed...
    expect((await f.reloadFeed()).status).toBe('error');
    expect((await f.reloadFeed()).lastErrorMessage).toContain('503');
    // ...a dead feed is not a failed tick, and the window got its days anyway.
    expect(first.failedStages).toEqual([]);
    const before = await f.baselineDays();
    expect(before).toContain(dayAfter(day0, 0));
    expect(before).toContain(dayAfter(day0, 29));
    expect(before).not.toContain(dayAfter(day0, 30));

    // A UTC day on, the feed is still failing; the window moves with the clock.
    const day1 = new Date(day0.getTime() + DAY_MS);
    const second = await runFamilyTick(env, f.familyId, day1);
    expect((await f.reloadFeed()).consecutiveFailures).toBe(2);
    expect(second.failedStages).toEqual([]);
    expect(await f.baselineDays()).toContain(dayAfter(day0, 30));
  });

  it('synthesizes a feed that is not due, so a daily poll still rolls the window', async () => {
    const day0 = new Date();
    const f = await baselineFeed('tick-synth-not-due@example.com', {
      refreshMinutes: 1440,
      lastSyncedAt: new Date(day0.getTime() - 60 * 60_000),
    });

    await runFamilyTick(env, f.familyId, day0);
    expect(await f.baselineDays()).toContain(dayAfter(day0, 29));
    expect(await f.baselineDays()).not.toContain(dayAfter(day0, 30));

    // Synced an hour before this tick too, so it is not due this time either.
    const day1 = new Date(day0.getTime() + DAY_MS);
    await f.db
      .update(feeds)
      .set({ lastSyncedAt: new Date(day1.getTime() - 60 * 60_000) })
      .where(eq(feeds.id, f.feed.id));
    await runFamilyTick(env, f.familyId, day1);

    expect(await f.baselineDays()).toContain(dayAfter(day0, 30));
    // Never fetched: it was synthesized without being ingested.
    const row = await f.reloadFeed();
    expect(row.lastAttemptedAt).toBeNull();
    expect(row.status).toBe('active');
  });

  it('leaves a paused feed alone', async () => {
    const f = await baselineFeed('tick-synth-paused@example.com', { status: 'paused' });

    const result = await runFamilyTick(env, f.familyId, new Date());

    expect(result.failedStages).toEqual([]);
    expect(await f.baselineDays()).toEqual([]);
    expect((await f.reloadFeed()).lastAttemptedAt).toBeNull();
  });

  it("reports a feed's synthesis failure as its own stage and still synthesizes the others", async () => {
    const day0 = new Date();
    const recentlySynced = new Date(day0.getTime() - 60 * 60_000);
    const first = await baselineFeed('tick-synth-isolated@example.com', {
      lastSyncedAt: recentlySynced,
    });
    // A second feed in the same family, linked to the same child.
    const second = (
      await first.db
        .insert(feeds)
        .values({
          familyId: first.familyId,
          mode: 'exception',
          url: `${FEED_ORIGIN}/other.ics`,
          lastSyncedAt: recentlySynced,
        })
        .returning()
    )[0]!;
    await first.db.insert(familyMemberFeeds).values({
      familyId: first.familyId,
      feedId: second.id,
      familyMemberId: first.childId,
      weekdayMask: 127,
      dayStart: '08:30',
      dayEnd: '14:45',
    });
    // The first synthesis in the tick dies on its first query (a feed's links);
    // neither feed is due, so nothing before it reads that table.
    const { env: probe } = flakyDb(/from "family_member_feeds"/);

    const result = await runFamilyTick(probe, first.familyId, day0);

    expect(result.failedStages).toEqual(['synthesis']);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringMatching(/^feed .+ synthesis failed$/),
      expect.any(Error),
    );
    // Exactly one of the two feeds made it: the failure didn't end the loop.
    const withDays = await first.db
      .select({ feedId: calendarEvents.linkId })
      .from(calendarEvents)
      .where(eq(calendarEvents.familyId, first.familyId));
    expect(new Set(withDays.map((r) => r.feedId)).size).toBe(1);
  });
});

describe('family-pipeline queue messages', () => {
  const messageFor = (familyId: string) => {
    const counts = { acked: 0, retried: 0 };
    return {
      counts,
      message: {
        body: { kind: 'family-pipeline' as const, familyId },
        ack: () => void counts.acked++,
        retry: () => void counts.retried++,
      },
    };
  };

  it('acks a clean tick', async () => {
    const fam = await setupFamily('queue-clean@example.com');
    const { message, counts } = messageFor(fam.familyId);

    await deliveryQueueConsumer({ messages: [message] } as never, env);

    expect(counts).toEqual({ acked: 1, retried: 0 });
  });

  it('acks, rather than retries, a tick whose stage failed', async () => {
    const fam = await setupFamily('queue-stage-fail@example.com');
    const { message, counts } = messageFor(fam.familyId);

    // Re-running the whole pipeline because one stage hiccuped would be a
    // retry storm; the next cron tick is the retry.
    await deliveryQueueConsumer(
      { messages: [message] } as never,
      flakyDb(/from "member_calendars"/).env,
    );

    expect(counts).toEqual({ acked: 1, retried: 0 });
  });

  it('retries only the message whose tick could not start', async () => {
    const good = await setupFamily('queue-good@example.com');
    const bad = await setupFamily('queue-bad@example.com');
    const first = messageFor(bad.familyId);
    const second = messageFor(good.familyId);

    // The D1 binding is unusable for the first tick to start (throws outside
    // any stage, so it is unexpected rather than a logged stage failure) and
    // fine for the next — one family's failure must not retry the batch.
    let reads = 0;
    const batchEnv = { ...env };
    Object.defineProperty(batchEnv, 'DB', {
      get() {
        if (++reads === 1) throw new Error('D1 binding unavailable');
        return env.DB;
      },
    });

    await deliveryQueueConsumer(
      { messages: [first.message, second.message] } as never,
      batchEnv,
    );

    expect(first.counts).toEqual({ acked: 0, retried: 1 });
    expect(second.counts).toEqual({ acked: 1, retried: 0 });
  });
});
