import {
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { eq, families, feeds, getDb, sourceEvents } from '@igt/db';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduled } from '../src/scheduled.js';
import type { Bindings } from '../src/env.js';
import type { DeliveryJob } from '../src/services/mirror.js';

const FEED_ORIGIN = 'https://feed.example.com';
const FEED_PATH = '/fanout.ics';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errorLog.mockRestore());

/** A queue that records everything sent to it, optionally failing some batches. */
function recordingQueue(failBatches: number[] = []) {
  const batches: { body: DeliveryJob }[][] = [];
  const singles: DeliveryJob[] = [];
  let calls = 0;
  const queue = {
    send: async (job: DeliveryJob) => void singles.push(job),
    sendBatch: async (messages: Iterable<{ body: DeliveryJob }>) => {
      const call = calls++;
      if (failBatches.includes(call)) throw new Error('queue unavailable');
      batches.push([...messages]);
    },
  };
  return { queue: queue as unknown as Queue<DeliveryJob>, batches, singles };
}

/** One cron tick against `bindings`, awaiting everything it schedules. */
async function runCron(bindings: Bindings): Promise<void> {
  const ctx = createExecutionContext();
  await scheduled({} as ScheduledController, bindings, ctx);
  await waitOnExecutionContext(ctx);
}

/** `count` bare families (no members) — all the cron needs to see. */
async function insertFamilies(count: number): Promise<string[]> {
  const db = getDb(env.DB);
  const ids: string[] = [];
  // A handful of rows per statement keeps each insert under D1's bound-parameter cap.
  for (let i = 0; i < count; i += 20) {
    const rows = Array.from({ length: Math.min(20, count - i) }, (_, j) => ({
      name: `Fanout ${i + j}`,
    }));
    const inserted = await db.insert(families).values(rows).returning({ id: families.id });
    ids.push(...inserted.map((r) => r.id));
  }
  return ids;
}

/** A due ICS feed in `familyId`, plus the ICS the origin serves for it. */
async function insertDueFeed(familyId: string) {
  const db = getDb(env.DB);
  const start = new Date(Date.now() + 24 * 3600_000);
  start.setUTCHours(9, 0, 0, 0);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//igt//test//EN',
    'BEGIN:VEVENT',
    'UID:fanout-event',
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(new Date(start.getTime() + 3600_000))}`,
    'SUMMARY:fanout-event',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  fetchMock.get(FEED_ORIGIN).intercept({ path: FEED_PATH, method: 'GET' }).reply(200, ics);
  return (
    await db
      .insert(feeds)
      .values({ familyId, kind: 'ics', url: `${FEED_ORIGIN}${FEED_PATH}`, mode: 'standard' })
      .returning()
  )[0]!;
}

const sourceRowsFor = (feedId: string) =>
  getDb(env.DB).select().from(sourceEvents).where(eq(sourceEvents.feedId, feedId));

describe('cron fan-out: with a delivery queue bound', () => {
  it('enqueues one family-pipeline job per family and runs none inline', async () => {
    const [a, b, c] = await insertFamilies(3);
    // A due feed that an inline run would ingest, so doing nothing is observable.
    const feed = await insertDueFeed(a!);
    const { queue, batches, singles } = recordingQueue();

    await runCron({ ...env, DELIVERY_QUEUE: queue });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]!.map((m) => m.body)).toEqual(
      expect.arrayContaining(
        [a!, b!, c!].map((familyId) => ({ kind: 'family-pipeline', familyId })),
      ),
    );
    expect(singles).toEqual([]);
    // The tick itself never touched the family: that is the consumer's job now.
    expect(await sourceRowsFor(feed.id)).toEqual([]);
    const row = (await getDb(env.DB).select().from(feeds).where(eq(feeds.id, feed.id)))[0]!;
    expect(row.lastAttemptedAt).toBeNull();
  });

  it('chunks the fan-out to at most 100 messages per sendBatch', async () => {
    const ids = await insertFamilies(205);
    const { queue, batches } = recordingQueue();

    await runCron({ ...env, DELIVERY_QUEUE: queue });

    expect(batches.map((b) => b.length)).toEqual([100, 100, 5]);
    const sent = batches.flat().map((m) => (m.body as { familyId: string }).familyId);
    expect(new Set(sent).size).toBe(205);
    expect([...sent].sort()).toEqual([...ids].sort());
  });

  it('keeps enqueueing the other chunks when one fails, and does not throw', async () => {
    const ids = new Set(await insertFamilies(250));
    const { queue, batches } = recordingQueue([1]);

    await expect(runCron({ ...env, DELIVERY_QUEUE: queue })).resolves.toBeUndefined();

    // The middle chunk is lost until the next tick; the first and last go out.
    expect(batches.map((b) => b.length)).toEqual([100, 50]);
    expect(errorLog).toHaveBeenCalledWith(
      'failed to enqueue 100 family pipeline job(s)',
      expect.any(Error),
    );
    expect(batches.flat().every((m) => ids.has((m.body as { familyId: string }).familyId))).toBe(
      true,
    );
  });

  it('sends nothing when there are no families', async () => {
    const { queue, batches } = recordingQueue();
    await runCron({ ...env, DELIVERY_QUEUE: queue });
    expect(batches).toEqual([]);
  });
});

describe('cron fan-out: with no queue (local dev + tests)', () => {
  it('runs each family’s pipeline inline', async () => {
    const [familyId] = await insertFamilies(1);
    const feed = await insertDueFeed(familyId!);

    await runCron(env); // no DELIVERY_QUEUE

    expect((await sourceRowsFor(feed.id)).map((r) => r.icalUid)).toEqual(['fanout-event']);
  });

  it('logs a tick that cannot start rather than failing the cron', async () => {
    const [a, b] = await insertFamilies(2);
    // A malformed KEK version makes every tick throw before its first stage.
    await expect(
      runCron({ ...env, KEK_CURRENT_VERSION: 'not-a-number' }),
    ).resolves.toBeUndefined();

    for (const familyId of [a, b]) {
      expect(errorLog).toHaveBeenCalledWith(
        `scheduled tick failed for family ${familyId}`,
        expect.any(Error),
      );
    }
  });
});
