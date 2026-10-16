import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
