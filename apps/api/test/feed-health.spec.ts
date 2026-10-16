import {
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext,
} from 'cloudflare:test';
import {
  calendarEvents,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  sourceEvents,
  tasks,
} from '@igt/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { scheduled } from '../src/scheduled.js';
import { ingestFeed, isFeedDue } from '../src/services/ingest.js';
import { authed, call, createFamily, login, setupFamily } from './helpers.js';

const MINUTE = 60_000;
const FEED_ORIGIN = 'https://feed.example.com';
const FEED_PATH = '/health.ics';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

/** An ICS document holding `uids`, each an hour long, `days` out at 09:00Z. */
function ics(uids: string[], days = 1): string {
  const at = (hour: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  };
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//igt//test//EN',
    ...uids.flatMap((uid) => [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTART:${at(9)}`,
      `DTEND:${at(10)}`,
      `SUMMARY:${uid}`,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');
}

/** A family with one standard ICS feed linked to one child. */
async function setupFeed(email: string) {
  const admin = await login(email);
  const familyId = await createFamily(admin.token, 'Health Fam');
  const db = getDb(env.DB);
  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId,
        kind: 'ics',
        url: `${FEED_ORIGIN}${FEED_PATH}`,
        mode: 'standard',
      })
      .returning()
  )[0]!;
  const childRes = await call(
    `/families/${familyId}/members`,
    authed(admin.token, { relationName: 'child', requiresCaretaker: true }),
  );
  const { member } = (await childRes.json()) as { member: { id: string } };
  await db
    .insert(familyMemberFeeds)
    .values({ familyId, feedId: feed.id, familyMemberId: member.id });
  return { admin, familyId, feed, memberId: member.id, db };
}

const reload = async (db: ReturnType<typeof getDb>, feedId: string) =>
  (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0]!;

describe('feed health: recording why a feed is stuck', () => {
  it('stamps the failure on the row, and clears it on the next success', async () => {
    const { feed, db } = await setupFeed('feed-health-stamp@example.com');

    let fail = true;
    const fetchImpl = (async () => {
      if (fail) throw new Error('getaddrinfo ENOTFOUND feed.example.com');
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => ics(['after-recovery']),
      };
    }) as unknown as typeof fetch;

    await expect(ingestFeed(db, feed, { fetchImpl })).rejects.toThrow();
    const failed = await reload(db, feed.id);
    expect(failed.status).toBe('error');
    expect(failed.consecutiveFailures).toBe(1);
    expect(failed.lastErrorMessage).toContain('ENOTFOUND');
    expect(failed.lastAttemptedAt).not.toBeNull();
    // Only a *successful* read moves lastSyncedAt — it's what paces the poll.
    expect(failed.lastSyncedAt).toBeNull();

    await expect(ingestFeed(db, failed, { fetchImpl })).rejects.toThrow();
    expect((await reload(db, feed.id)).consecutiveFailures).toBe(2);

    fail = false;
    await ingestFeed(db, await reload(db, feed.id), { fetchImpl });
    const healthy = await reload(db, feed.id);
    expect(healthy.status).toBe('active');
    expect(healthy.consecutiveFailures).toBe(0);
    expect(healthy.lastErrorMessage).toBeNull();
    expect(healthy.lastSyncedAt).not.toBeNull();
  });

  it('counts every failure when attempts overlap (cron + a refresh both holding the same row)', async () => {
    // Both attempts start from the same in-memory row (consecutiveFailures: 0).
    // Writing `row.consecutiveFailures + 1` back from it makes them both store 1;
    // the increment has to happen in SQL so each one lands.
    const { feed, db } = await setupFeed('feed-health-concurrent@example.com');
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND feed.example.com');
    }) as unknown as typeof fetch;

    const outcomes = await Promise.allSettled([
      ingestFeed(db, feed, { fetchImpl }),
      ingestFeed(db, feed, { fetchImpl }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);

    const failed = await reload(db, feed.id);
    expect(failed.status).toBe('error');
    expect(failed.consecutiveFailures).toBe(2);
  });

  it('surfaces the failure message on the feeds list', async () => {
    const { admin, familyId, feed, db } = await setupFeed('feed-health-list@example.com');
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expect(ingestFeed(db, feed, { fetchImpl })).rejects.toThrow();

    const res = await call(`/families/${familyId}/feeds`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    const { feeds: rows } = (await res.json()) as {
      feeds: { id: string; status: string; lastErrorMessage: string | null }[];
    };
    const row = rows.find((r) => r.id === feed.id)!;
    expect(row.status).toBe('error');
    expect(row.lastErrorMessage).toBe('boom');
  });

  it('clears the failure state when an admin takes the feed out of error', async () => {
    const { admin, familyId, feed, db } = await setupFeed('feed-health-clear@example.com');
    const fetchImpl = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expect(ingestFeed(db, feed, { fetchImpl })).rejects.toThrow();

    const res = await call(`/families/${familyId}/feeds/${feed.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${admin.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ status: 'active' }),
    });
    expect(res.status).toBe(200);
    const cleared = await reload(db, feed.id);
    expect(cleared.consecutiveFailures).toBe(0);
    expect(cleared.lastErrorMessage).toBeNull();
  });
});

describe('feed health: a forced refresh is unconditional', () => {
  it('drops If-None-Match (and asks intermediaries to revalidate) when forced', async () => {
    // The background poll is happy to be told "nothing changed". A person
    // pressing "Refresh feeds" has just changed something and is watching for
    // it, so that request must not be answerable from a cached copy — a CDN in
    // front of the feed will answer our conditional GET from its own snapshot.
    const { feed, db } = await setupFeed('feed-health-force@example.com');
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ ...(init?.headers ?? {}) });
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? '"v1"' : null) },
        text: async () => ics(['an-event']),
      };
    }) as unknown as typeof fetch;

    await ingestFeed(db, feed, { fetchImpl });
    expect(seen[0]).not.toHaveProperty('If-None-Match');

    // The background poll now has an etag and uses it.
    const synced = await reload(db, feed.id);
    expect(synced.etag).toBe('"v1"');
    await ingestFeed(db, synced, { fetchImpl });
    expect(seen[1]!['If-None-Match']).toBe('"v1"');

    await ingestFeed(db, await reload(db, feed.id), { fetchImpl, force: true });
    expect(seen[2]).not.toHaveProperty('If-None-Match');
    expect(seen[2]!['cache-control']).toBe('no-cache');
  });
});

describe('feed health: refreshing a feed that cannot be read', () => {
  it('reports the ingest failure in a 200 and still synthesizes, reads back and generates tasks', async () => {
    // The source is down, but everything after ingest works off the rows already
    // there. Synthesis in particular is what rolls the 30-day window and
    // generates an exception feed's baseline days from the link's config alone,
    // so a person pressing Refresh on a broken feed used to get a 500 and none
    // of it.
    const fam = await setupFamily('feed-health-refresh-down@example.com');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          kind: 'ics',
          url: `${FEED_ORIGIN}/refresh-down.ics`,
          mode: 'exception',
          sourceCalendarName: 'Lincoln Elementary',
        })
        .returning()
    )[0]!;
    await db.insert(familyMemberFeeds).values({
      familyId: fam.familyId,
      feedId: feed.id,
      familyMemberId: fam.childId,
      weekdayMask: 127,
      dayStart: '08:30',
      dayEnd: '14:45',
    });
    fetchMock
      .get(FEED_ORIGIN)
      .intercept({ path: '/refresh-down.ics', method: 'GET' })
      .reply(503, 'down');

    const res = await call(
      `/families/${fam.familyId}/feeds/${feed.id}/refresh`,
      authed(fam.admin.token),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ingest: { feedId: string; fetched: boolean; processed: number; error?: string };
      synthesis: { eventsUpserted: number };
    };
    // The same per-feed shape `/refresh-all` reports.
    expect(body.ingest).toMatchObject({ feedId: feed.id, fetched: false, processed: 0 });
    expect(body.ingest.error).toContain('503');
    // ingestFeed still recorded the failure on the row.
    const failed = await reload(db, feed.id);
    expect(failed.status).toBe('error');
    expect(failed.lastErrorMessage).toContain('503');
    // Synthesis ran: baseline days exist...
    expect(body.synthesis.eventsUpserted).toBeGreaterThan(0);
    const days = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.familyMemberId, fam.childId));
    expect(days.length).toBeGreaterThanOrEqual(30);
    // ...and so did task-gen, off them.
    const generated = await db.select().from(tasks).where(eq(tasks.familyMemberId, fam.childId));
    expect(generated.map((t) => t.type)).toEqual(expect.arrayContaining(['dropoff', 'pickup']));
  });
});

describe('feed health: when the cron polls a feed', () => {
  const base = {
    status: 'active' as const,
    refreshMinutes: 360,
    lastSyncedAt: null as Date | null,
    lastAttemptedAt: null as Date | null,
    consecutiveFailures: 0,
  };
  const now = new Date('2026-08-25T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('paces a healthy feed off its own refresh interval', () => {
    expect(isFeedDue({ ...base, lastSyncedAt: ago(359 * MINUTE) }, now)).toBe(false);
    expect(isFeedDue({ ...base, lastSyncedAt: ago(361 * MINUTE) }, now)).toBe(true);
    // Never synced ⇒ due immediately.
    expect(isFeedDue(base, now)).toBe(true);
  });

  it('never polls a paused feed', () => {
    expect(isFeedDue({ ...base, status: 'paused', lastSyncedAt: ago(30 * 60 * MINUTE) }, now)).toBe(
      false,
    );
  });

  it('retries an errored feed on a backoff, growing with the failure count', () => {
    const errored = (failures: number, attemptedMinutesAgo: number) =>
      isFeedDue(
        {
          ...base,
          status: 'error',
          consecutiveFailures: failures,
          lastAttemptedAt: ago(attemptedMinutesAgo * MINUTE),
        },
        now,
      );
    // First failure: the very next 15-minute tick tries again.
    expect(errored(1, 10)).toBe(false);
    expect(errored(1, 20)).toBe(true);
    // Third: half an hour more.
    expect(errored(3, 45)).toBe(false);
    expect(errored(3, 75)).toBe(true);
    // A long-dead feed is still retried, just rarely — never abandoned.
    expect(errored(50, 300)).toBe(false);
    expect(errored(50, 400)).toBe(true);
  });
});

describe('feed health: recovering from a failed sync', () => {
  it('re-ingests a feed left in error, so events added after the blip still land', async () => {
    // The bug this covers: the cron only ever selected feeds with
    // status='active', so a single transient failure froze a feed for good.
    // Everything already in source_events kept synthesizing — the calendar
    // looked healthy — while every event added upstream afterwards was
    // invisible until somebody happened to press "Refresh feeds".
    const { familyId, feed, memberId, db } = await setupFeed('feed-health-cron@example.com');

    let body = ics(['before-the-blip']);
    fetchMock
      .get(FEED_ORIGIN)
      .intercept({ path: FEED_PATH, method: 'GET' })
      .reply(() => ({ statusCode: 200, data: body }))
      .persist();
    await runCron();

    // A blip: the feed goes to 'error' and its last attempt is now.
    const boom = (async () => {
      throw new Error('503 from the school district');
    }) as unknown as typeof fetch;
    await expect(ingestFeed(db, await reload(db, feed.id), { fetchImpl: boom })).rejects.toThrow();
    expect((await reload(db, feed.id)).status).toBe('error');

    // Meanwhile someone adds tomorrow morning's event to the source calendar.
    body = ics(['before-the-blip', 'added-after-the-blip']);

    // A tick inside the backoff leaves it alone...
    await runCron();
    expect(
      (await db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id))).map(
        (r) => r.icalUid,
      ),
    ).toEqual(['before-the-blip']);

    // ...and once the backoff has elapsed, the retry picks the new event up
    // and synthesizes it onto the member's unified calendar.
    await db
      .update(feeds)
      .set({ lastAttemptedAt: new Date(Date.now() - 60 * MINUTE) })
      .where(eq(feeds.id, feed.id));
    await runCron();

    const recovered = await reload(db, feed.id);
    expect(recovered.status).toBe('active');
    expect(recovered.consecutiveFailures).toBe(0);
    const summaries = (
      await db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.familyMemberId, memberId))
    ).map((e) => e.summary);
    expect(summaries).toContain('added-after-the-blip');
    expect(familyId).toBeTruthy();
  });
});

/** One cron tick, awaiting the per-family work it schedules. */
async function runCron(): Promise<void> {
  const ctx = createExecutionContext();
  await scheduled({} as ScheduledController, env, ctx);
  await waitOnExecutionContext(ctx);
}
