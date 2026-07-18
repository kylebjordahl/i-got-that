import { env, fetchMock } from 'cloudflare:test';
import {
  calendarEvents,
  eq,
  externalAccounts,
  familyMemberFeeds,
  familyMembers,
  feeds,
  getDb,
  sourceEvents,
  tasks,
} from '@igt/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { storeSecret } from '../src/lib/secrets.js';
import { ingestFeed } from '../src/services/ingest.js';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { authed, call, patched, setupFamily } from './helpers.js';

/**
 * Busy-mode feeds — the free/busy "calendar firewall" input. A work calendar
 * shared to the personal account as "see only free/busy" is read via Google
 * freebusy.query; only opaque intervals ever reach the platform.
 */

const WORK_CAL = 'kyle@work.example';

/** ISO instant `days` from now at `hour` UTC (inside the 30-day synthesis window). */
function at(days: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

/** A fetchImpl answering freebusy.query with the given busy intervals. */
function freeBusyFetch(busy: { start: Date; end: Date }[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    expect(String(url)).toContain('/calendar/v3/freeBusy');
    const body = JSON.parse(String(init.body));
    expect(body.items).toEqual([{ id: WORK_CAL }]);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        calendars: {
          [WORK_CAL]: {
            busy: busy.map((b) => ({
              start: b.start.toISOString(),
              end: b.end.toISOString(),
            })),
          },
        },
      }),
    };
  }) as unknown as typeof fetch;
}

/** Family + connected google account (stored access token) + busy feed + link. */
async function setupBusyFeed(email: string) {
  const fam = await setupFamily(email, 'Busy Fam');
  const db = getDb(env.DB);
  const credRef = await storeSecret(
    db,
    env.KEK,
    null,
    JSON.stringify({ kind: 'oauth', accessToken: 'at-busy' }),
  );
  const account = (
    await db
      .insert(externalAccounts)
      .values({
        userId: fam.admin.userId,
        kind: 'google',
        name: 'Personal G',
        credentialsRef: credRef,
      })
      .returning()
  )[0]!;
  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        kind: 'google',
        externalAccountId: account.id,
        sourceCalendarId: WORK_CAL,
        sourceCalendarName: 'Busy (work)',
        mode: 'busy',
      })
      .returning()
  )[0]!;
  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({
        familyId: fam.familyId,
        feedId: feed.id,
        familyMemberId: fam.adminMemberId,
      })
      .returning()
  )[0]!;
  return { ...fam, db, account, feed, link };
}

describe('busy feeds: ingest', () => {
  it('lands intervals as fb: source rows, idempotently, with no text fields', async () => {
    const t = await setupBusyFeed('busy-ingest@example.com');
    const intervals = [
      { start: at(2, 15), end: at(2, 16, 30) },
      { start: at(3, 9), end: at(3, 9, 30) },
    ];

    const res = await ingestFeed(t.db, t.feed, {
      fetchImpl: freeBusyFetch(intervals),
      kek: env.KEK,
    });
    expect(res.fetched).toBe(true);
    expect(res.processed).toBe(2);

    const rows = await t.db
      .select()
      .from(sourceEvents)
      .where(eq(sourceEvents.feedId, t.feed.id));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.icalUid.startsWith('fb:')).toBe(true);
      expect(row.summary).toBeNull();
      expect(row.location).toBeNull();
      expect(row.allDay).toBe(false);
    }

    // Same intervals again → same keys, no duplicates.
    await ingestFeed(t.db, t.feed, {
      fetchImpl: freeBusyFetch(intervals),
      kek: env.KEK,
    });
    const rows2 = await t.db
      .select()
      .from(sourceEvents)
      .where(eq(sourceEvents.feedId, t.feed.id));
    expect(rows2).toHaveLength(2);

    const after = (
      await t.db.select().from(feeds).where(eq(feeds.id, t.feed.id)).limit(1)
    )[0]!;
    expect(after.status).toBe('active');
    expect(after.lastSyncedAt).not.toBeNull();
  });

  it('deletes stale interval rows when a block moves (interval keys have no identity)', async () => {
    const t = await setupBusyFeed('busy-moved@example.com');
    const original = { start: at(2, 15), end: at(2, 16) };
    await ingestFeed(t.db, t.feed, {
      fetchImpl: freeBusyFetch([original]),
      kek: env.KEK,
    });
    await synthesizeFeed(t.db, t.feed);
    const before = await t.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.linkId, t.link.id));
    expect(before).toHaveLength(1);

    // The meeting moves an hour later: new key arrives, old key must go.
    const moved = { start: at(2, 16), end: at(2, 17) };
    await ingestFeed(t.db, t.feed, {
      fetchImpl: freeBusyFetch([moved]),
      kek: env.KEK,
    });
    const rows = await t.db
      .select()
      .from(sourceEvents)
      .where(eq(sourceEvents.feedId, t.feed.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dtstart.toISOString()).toBe(moved.start.toISOString());

    // The stale source row's synthesized event went with it (FK cascade), and
    // resynthesis materializes the moved block.
    await synthesizeFeed(t.db, t.feed);
    const after = await t.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.linkId, t.link.id));
    expect(after).toHaveLength(1);
    expect(after[0]!.dtstart.toISOString()).toBe(moved.start.toISOString());
  });

  it('treats an empty busy list as a valid sync that clears the window', async () => {
    const t = await setupBusyFeed('busy-empty@example.com');
    await ingestFeed(t.db, t.feed, {
      fetchImpl: freeBusyFetch([{ start: at(2, 15), end: at(2, 16) }]),
      kek: env.KEK,
    });

    const res = await ingestFeed(t.db, t.feed, {
      fetchImpl: freeBusyFetch([]),
      kek: env.KEK,
    });
    expect(res.processed).toBe(0);
    const rows = await t.db
      .select()
      .from(sourceEvents)
      .where(eq(sourceEvents.feedId, t.feed.id));
    expect(rows).toHaveLength(0);
    const after = (
      await t.db.select().from(feeds).where(eq(feeds.id, t.feed.id)).limit(1)
    )[0]!;
    expect(after.status).toBe('active');
  });

  it("marks the feed 'error' when the calendar stops answering freebusy (share revoked)", async () => {
    const t = await setupBusyFeed('busy-revoked@example.com');
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        calendars: {
          [WORK_CAL]: { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] },
        },
      }),
    })) as unknown as typeof fetch;

    await expect(
      ingestFeed(t.db, t.feed, { fetchImpl, kek: env.KEK }),
    ).rejects.toThrow(/notFound/);
    const after = (
      await t.db.select().from(feeds).where(eq(feeds.id, t.feed.id)).limit(1)
    )[0]!;
    expect(after.status).toBe('error');
  });
});

describe('busy feeds: synthesis + task-gen', () => {
  it('synthesizes opaque fb: blocks labeled with the feed name and spawns NO tasks', async () => {
    const t = await setupBusyFeed('busy-synth@example.com');
    // Force task generation ON for the linked member to prove the fb: guard is
    // what suppresses tasks, not the caretaker default.
    await t.db
      .update(familyMembers)
      .set({ generatesFamilyTasks: true })
      .where(eq(familyMembers.id, t.adminMemberId));

    await ingestFeed(t.db, t.feed, {
      fetchImpl: freeBusyFetch([{ start: at(2, 15), end: at(2, 16, 30) }]),
      kek: env.KEK,
    });
    await synthesizeFeed(t.db, t.feed);

    const events = await t.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.linkId, t.link.id));
    expect(events).toHaveLength(1);
    const block = events[0]!;
    expect(block.synthKey.startsWith('fb:')).toBe(true);
    expect(block.provenance).toBe('synthesized');
    expect(block.summary).toBe('Busy (work)');
    expect(block.location).toBeNull();
    expect(block.description).toBeNull();

    const gen = await buildMemberTasks(t.db, t.adminMemberId);
    expect(gen.tasksCreated).toBe(0);
    const memberTasks = await t.db
      .select()
      .from(tasks)
      .where(eq(tasks.familyMemberId, t.adminMemberId));
    expect(memberTasks).toHaveLength(0);

    // The guard stamped the event, so it isn't perpetually dirty.
    const stamped = (
      await t.db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.id, block.id))
        .limit(1)
    )[0]!;
    expect(stamped.tasksBuiltHash).toBe(stamped.contentHash);
  });

  it('resynthesis is idempotent and drops blocks whose source vanished', async () => {
    const t = await setupBusyFeed('busy-resynth@example.com');
    await ingestFeed(t.db, t.feed, {
      fetchImpl: freeBusyFetch([
        { start: at(2, 15), end: at(2, 16) },
        { start: at(4, 10), end: at(4, 11) },
      ]),
      kek: env.KEK,
    });
    await synthesizeFeed(t.db, t.feed);
    await synthesizeFeed(t.db, t.feed);
    const events = await t.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.linkId, t.link.id));
    expect(events).toHaveLength(2);

    // One meeting cancelled: its interval disappears from the next sync.
    await ingestFeed(t.db, t.feed, {
      fetchImpl: freeBusyFetch([{ start: at(2, 15), end: at(2, 16) }]),
      kek: env.KEK,
    });
    await synthesizeFeed(t.db, t.feed);
    const after = await t.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.linkId, t.link.id));
    expect(after).toHaveLength(1);
  });
});

describe('busy feeds: routes', () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  /** Connected google account (stored access token) for the given user. */
  async function connectAccount(userId: string) {
    const db = getDb(env.DB);
    const credRef = await storeSecret(
      db,
      env.KEK,
      null,
      JSON.stringify({ kind: 'oauth', accessToken: 'at-routes' }),
    );
    return (
      await db
        .insert(externalAccounts)
        .values({ userId, kind: 'google', name: 'Personal G', credentialsRef: credRef })
        .returning()
    )[0]!;
  }

  function stubFreeBusy(reply: unknown) {
    fetchMock
      .get('https://www.googleapis.com')
      .intercept({ path: '/calendar/v3/freeBusy', method: 'POST' })
      .reply(200, JSON.stringify(reply), {
        headers: { 'content-type': 'application/json' },
      });
  }

  it('creates a busy feed when the probe succeeds', async () => {
    const fam = await setupFamily('busy-route-ok@example.com');
    const account = await connectAccount(fam.admin.userId);
    stubFreeBusy({ calendars: { [WORK_CAL]: { busy: [] } } });

    const res = await call(
      `/families/${fam.familyId}/feeds`,
      authed(fam.admin.token, {
        kind: 'google',
        mode: 'busy',
        externalAccountId: account.id,
        sourceCalendarId: WORK_CAL,
        sourceCalendarName: 'Busy (work)',
      }),
    );
    expect(res.status).toBe(201);
    const { feed } = (await res.json()) as { feed: { mode: string } };
    expect(feed.mode).toBe('busy');
  });

  it('rejects creation with setup guidance when the calendar is not shared (probe fails)', async () => {
    const fam = await setupFamily('busy-route-unshared@example.com');
    const account = await connectAccount(fam.admin.userId);
    stubFreeBusy({
      calendars: {
        [WORK_CAL]: { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] },
      },
    });

    const res = await call(
      `/families/${fam.familyId}/feeds`,
      authed(fam.admin.token, {
        kind: 'google',
        mode: 'busy',
        externalAccountId: account.id,
        sourceCalendarId: WORK_CAL,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe('freebusy_unavailable');
    expect(body.detail).toContain('notFound');
  });

  it("rejects mode 'busy' on a non-google feed at validation", async () => {
    const fam = await setupFamily('busy-route-ics@example.com');
    const res = await call(
      `/families/${fam.familyId}/feeds`,
      authed(fam.admin.token, {
        kind: 'ics',
        mode: 'busy',
        url: 'https://feed.example.com/cal.ics',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('refuses mode transitions into or out of busy (recreate instead)', async () => {
    const fam = await setupFamily('busy-route-immutable@example.com');
    const account = await connectAccount(fam.admin.userId);
    stubFreeBusy({ calendars: { [WORK_CAL]: { busy: [] } } });
    const createRes = await call(
      `/families/${fam.familyId}/feeds`,
      authed(fam.admin.token, {
        kind: 'google',
        mode: 'busy',
        externalAccountId: account.id,
        sourceCalendarId: WORK_CAL,
      }),
    );
    const { feed } = (await createRes.json()) as { feed: { id: string } };

    const patchRes = await call(
      `/families/${fam.familyId}/feeds/${feed.id}`,
      patched(fam.admin.token, { mode: 'standard' }),
    );
    expect(patchRes.status).toBe(400);
    expect(((await patchRes.json()) as { error: string }).error).toBe(
      'busy_mode_immutable',
    );

    // And the reverse: a standard feed can't become busy.
    const db = getDb(env.DB);
    const standard = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          kind: 'google',
          externalAccountId: account.id,
          sourceCalendarId: 'primary',
          mode: 'standard',
        })
        .returning()
    )[0]!;
    const patch2 = await call(
      `/families/${fam.familyId}/feeds/${standard.id}`,
      patched(fam.admin.token, { mode: 'busy' }),
    );
    expect(patch2.status).toBe(400);
    expect(((await patch2.json()) as { error: string }).error).toBe(
      'busy_mode_immutable',
    );

    // refreshMinutes alone is still editable on a busy feed.
    const patch3 = await call(
      `/families/${fam.familyId}/feeds/${feed.id}`,
      patched(fam.admin.token, { refreshMinutes: 30 }),
    );
    expect(patch3.status).toBe(200);
  });
});
