import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  externalAccounts,
  familyMemberFeeds,
  feeds,
  getDb,
  sourceEvents,
  taskOwners,
  tasks,
} from '@igt/db';
import ICAL from 'ical.js';
import { describe, expect, it, vi } from 'vitest';
import { storeSecret } from '../src/lib/secrets.js';
import { reconcileClaimEvents } from '../src/services/claim.js';
import { ingestFamilyFeeds, ingestFeed } from '../src/services/ingest.js';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { setTaskOwners } from '../src/services/task-owners.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { createFamily, login, setupFamily, testKeys } from './helpers.js';

describe('ingest: account-backed input feeds', () => {
  it('reads a Google calendar feed into source_events (credential from the account)', async () => {
    const user = await login('ingest-google@example.com');
    const familyId = await createFamily(user.token, 'Ingest G');
    const db = getDb(env.DB);

    // A connected Google account owned by the user, with an encrypted refresh token.
    const credRef = await storeSecret(
      db,
      testKeys(),
      null,
      JSON.stringify({ kind: 'oauth', refreshToken: 'rt-123' }),
    );
    const account = (
      await db
        .insert(externalAccounts)
        .values({ userId: user.userId, kind: 'google', name: 'G', credentialsRef: credRef })
        .returning()
    )[0]!;

    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId,
          kind: 'google',
          externalAccountId: account.id,
          sourceCalendarId: 'primary',
          mode: 'standard',
        })
        .returning()
    )[0]!;

    const listJson = {
      items: [
        {
          iCalUID: 'a@g',
          status: 'confirmed',
          summary: 'Timed',
          location: 'Gym',
          start: { dateTime: '2026-08-01T15:00:00Z' },
          end: { dateTime: '2026-08-01T16:00:00Z' },
        },
        {
          iCalUID: 'b@g',
          status: 'confirmed',
          summary: 'Holiday',
          start: { date: '2026-08-04' },
          end: { date: '2026-08-05' },
        },
        { iCalUID: 'c@g', status: 'cancelled', start: { dateTime: '2026-08-02T10:00:00Z' } },
      ],
    };
    let refreshed = false;
    const fetchImpl = (async (url: string) => {
      expect(String(url)).toContain('/calendars/primary/events');
      return { ok: true, status: 200, json: async () => listJson };
    }) as unknown as typeof fetch;

    const res = await ingestFeed(db, feed, {
      fetchImpl,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-09-01T00:00:00Z'),
      kek: testKeys(),
      googleRefresh: async (rt) => {
        expect(rt).toBe('rt-123');
        refreshed = true;
        return 'access-token';
      },
    });

    expect(refreshed).toBe(true);
    expect(res.fetched).toBe(true);
    expect(res.processed).toBe(2); // the cancelled event is skipped

    const rows = await db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id));
    expect(rows).toHaveLength(2);
    const holiday = rows.find((r) => r.icalUid === 'b@g')!;
    expect(holiday.allDay).toBe(true);
    expect(holiday.summary).toBe('Holiday');

    // Re-ingest with the same data is idempotent (unchanged content hash).
    await ingestFeed(db, feed, {
      fetchImpl,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-09-01T00:00:00Z'),
      kek: testKeys(),
      googleRefresh: async () => 'access-token',
    });
    const rows2 = await db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id));
    expect(rows2).toHaveLength(2);
  });

  it('persists the calendar timezone from a Google feed (so exception baselines use it, not UTC)', async () => {
    const user = await login('ingest-google-tz@example.com');
    const familyId = await createFamily(user.token, 'Ingest G TZ');
    const db = getDb(env.DB);

    const credRef = await storeSecret(
      db,
      testKeys(),
      null,
      JSON.stringify({ kind: 'oauth', refreshToken: 'rt-tz' }),
    );
    const account = (
      await db
        .insert(externalAccounts)
        .values({ userId: user.userId, kind: 'google', name: 'G', credentialsRef: credRef })
        .returning()
    )[0]!;
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId,
          kind: 'google',
          externalAccountId: account.id,
          sourceCalendarId: 'primary',
          mode: 'exception',
        })
        .returning()
    )[0]!;

    const listJson = {
      timeZone: 'America/Denver',
      items: [
        {
          iCalUID: 'closure@g',
          status: 'confirmed',
          summary: 'Closed',
          start: { date: '2026-08-04' },
          end: { date: '2026-08-05' },
        },
      ],
    };
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => listJson,
    })) as unknown as typeof fetch;

    await ingestFeed(db, feed, {
      fetchImpl,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-09-01T00:00:00Z'),
      kek: testKeys(),
      googleRefresh: async () => 'access-token',
    });

    const after = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    expect(after.timezone).toBe('America/Denver');
  });

  it('marks a feed errored when its account credential is missing', async () => {
    const user = await login('ingest-broken@example.com');
    const familyId = await createFamily(user.token, 'Ingest B');
    const db = getDb(env.DB);

    // Account with no stored credential → ingest should fail + flag the feed.
    const account = (
      await db
        .insert(externalAccounts)
        .values({ userId: user.userId, kind: 'google', name: 'NoCred' })
        .returning()
    )[0]!;
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId,
          kind: 'google',
          externalAccountId: account.id,
          sourceCalendarId: 'primary',
          mode: 'standard',
        })
        .returning()
    )[0]!;

    await expect(ingestFeed(db, feed, { kek: testKeys() })).rejects.toThrow();
    const after = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    expect(after.status).toBe('error');
  });

  it('ingestFamilyFeeds keeps ingesting the rest of a family after one feed throws (refresh-all must not 500 for a broken sibling feed)', async () => {
    const user = await login('ingest-family-partial@example.com');
    const familyId = await createFamily(user.token, 'Ingest Partial');
    const db = getDb(env.DB);

    // Broken: account with no stored credential, like the test above.
    const account = (
      await db
        .insert(externalAccounts)
        .values({ userId: user.userId, kind: 'google', name: 'NoCred' })
        .returning()
    )[0]!;
    const brokenFeed = (
      await db
        .insert(feeds)
        .values({
          familyId,
          kind: 'google',
          externalAccountId: account.id,
          sourceCalendarId: 'primary',
          mode: 'standard',
        })
        .returning()
    )[0]!;

    // Healthy: a plain ICS feed.
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:keep@example.com',
      'DTSTART:20260801T150000Z',
      'DTEND:20260801T160000Z',
      'SUMMARY:Keeps',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => ics,
    })) as unknown as typeof fetch;
    const workingFeed = (
      await db
        .insert(feeds)
        .values({ familyId, kind: 'ics', url: 'https://example.invalid/cal.ics', mode: 'standard' })
        .returning()
    )[0]!;

    const results = await ingestFamilyFeeds(db, familyId, {
      fetchImpl,
      kek: testKeys(),
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-09-01T00:00:00Z'),
    });

    const broken = results.find((r) => r.feedId === brokenFeed.id)!;
    expect(broken.fetched).toBe(false);
    expect(broken.error).toBeTruthy();

    const working = results.find((r) => r.feedId === workingFeed.id)!;
    expect(working.fetched).toBe(true);
    expect(working.processed).toBe(1);

    const brokenAfter = (
      await db.select().from(feeds).where(eq(feeds.id, brokenFeed.id)).limit(1)
    )[0]!;
    expect(brokenAfter.status).toBe('error');

    const workingRows = await db
      .select()
      .from(sourceEvents)
      .where(eq(sourceEvents.feedId, workingFeed.id));
    expect(workingRows).toHaveLength(1);
  });

  it('deletes a source event whose UID no longer appears in a re-fetched ICS feed', async () => {
    // Regression: only busy (free/busy) feeds ever reconciled deletions —
    // a UID-keyed feed (e.g. an iCloud calendar's public ICS URL) only ever
    // upserted, so an event removed upstream lingered in source_events
    // forever and kept being synthesized back onto the unified calendar and
    // mirrored right back out to the target calendar.
    const user = await login('ingest-ics-delete@example.com');
    const familyId = await createFamily(user.token, 'Ingest ICS Delete');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({ familyId, kind: 'ics', url: 'https://example.invalid/cal.ics', mode: 'standard' })
        .returning()
    )[0]!;

    const icsWithTwo = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:keep@example.com',
      'DTSTART:20260801T150000Z',
      'DTEND:20260801T160000Z',
      'SUMMARY:Keeps',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:removed@example.com',
      'DTSTART:20260802T150000Z',
      'DTEND:20260802T160000Z',
      'SUMMARY:Removed upstream',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const icsWithOne = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:keep@example.com',
      'DTSTART:20260801T150000Z',
      'DTEND:20260801T160000Z',
      'SUMMARY:Keeps',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    let body = icsWithTwo;
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => body,
    })) as unknown as typeof fetch;

    const window = {
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-09-01T00:00:00Z'),
    };
    await ingestFeed(db, feed, { fetchImpl, ...window });
    const afterFirst = await db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id));
    expect(afterFirst.map((r) => r.icalUid).sort()).toEqual(['keep@example.com', 'removed@example.com']);

    // The upstream calendar drops the second event; re-ingesting should
    // reconcile it away, not leave it as a ghost.
    body = icsWithOne;
    await ingestFeed(db, feed, { fetchImpl, ...window });
    const afterSecond = await db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id));
    expect(afterSecond.map((r) => r.icalUid)).toEqual(['keep@example.com']);
  });

  it('marks an ICS feed errored on a connection-level failure (not just a bad HTTP status)', async () => {
    // Regression: a thrown fetch (DNS/TLS/timeout) used to bypass the
    // status='error' update entirely — only a non-ok *response* set it —
    // so callers gating on feed.status kept retrying a permanently
    // unreachable feed on every call instead of backing off like cron does.
    const user = await login('ingest-unreachable@example.com');
    const familyId = await createFamily(user.token, 'Ingest U');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({ familyId, kind: 'ics', url: 'https://unreachable.example.invalid/cal.ics', mode: 'standard' })
        .returning()
    )[0]!;

    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND unreachable.example.invalid');
    }) as unknown as typeof fetch;

    await expect(ingestFeed(db, feed, { fetchImpl })).rejects.toThrow();
    const after = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    expect(after.status).toBe('error');
  });
});

describe('ingest: an ICS feed is read in its own timezone, parsed once', () => {
  // Fixed window so the assertions don't depend on today's date.
  const window = {
    windowStart: new Date('2026-07-01T00:00:00Z'),
    windowEnd: new Date('2026-08-01T00:00:00Z'),
  };

  /** A booking-style export: floating (zone-less) times, zone only in X-WR-TIMEZONE. */
  const floatingIcs = (zoneLines: string[] = ['X-WR-TIMEZONE:America/Los_Angeles']) =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//test//EN',
      ...zoneLines,
      'X-WR-CALNAME:Floating Co',
      'BEGIN:VEVENT',
      'UID:single@example.com',
      'DTSTART:20260707T090000',
      'DTEND:20260707T100000',
      'SUMMARY:Single',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:daily@example.com',
      'DTSTART:20260708T170000',
      'DTEND:20260708T180000',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Daily',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

  const serving = (body: () => string) =>
    (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => body(),
    })) as unknown as typeof fetch;

  async function setupIcsFeed(email: string, extra: Partial<typeof feeds.$inferInsert> = {}) {
    const user = await login(email);
    const familyId = await createFamily(user.token, 'Ingest ICS TZ');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({ familyId, kind: 'ics', url: 'https://example.invalid/tz.ics', mode: 'standard', ...extra })
        .returning()
    )[0]!;
    const reload = async () =>
      (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    const rows = () =>
      db
        .select()
        .from(sourceEvents)
        .where(eq(sourceEvents.feedId, feed.id))
        .then((r) => r.sort((a, b) => a.dtstart.getTime() - b.dtstart.getTime()));
    return { db, feed, reload, rows };
  }

  it("resolves floating times in the document's own zone on the very first sync, and the second sync changes nothing", async () => {
    // Regression: the document's X-WR-TIMEZONE was read only *after* expansion,
    // so a first sync (no stored zone yet) resolved 09:00 as 09:00 UTC on
    // workerd — hours off — and the next sync, now knowing the zone, flipped
    // every row's contentHash (full resynthesis + re-mirror).
    const { db, feed, reload, rows } = await setupIcsFeed('ingest-ics-first-sync-tz@example.com');
    expect(feed.timezone).toBeNull();
    const fetchImpl = serving(() => floatingIcs());

    await ingestFeed(db, feed, { fetchImpl, ...window });
    const first = await rows();
    expect(first.map((r) => [r.icalUid, r.dtstart.toISOString()])).toEqual([
      // 09:00 PDT (UTC-7) — not 09:00Z.
      ['single@example.com', '2026-07-07T16:00:00.000Z'],
      ['daily@example.com', '2026-07-09T00:00:00.000Z'],
      ['daily@example.com', '2026-07-10T00:00:00.000Z'],
      ['daily@example.com', '2026-07-11T00:00:00.000Z'],
    ]);
    const stored = await reload();
    expect(stored.timezone).toBe('America/Los_Angeles');
    expect(stored.sourceCalendarName).toBe('Floating Co');

    // Second sync: against the stale in-memory row (no zone) and the reloaded
    // one (zone known) — either way the same rows with the same hashes.
    for (const row of [feed, stored]) {
      await ingestFeed(db, row, { fetchImpl, ...window });
      const again = await rows();
      expect(again.map((r) => [r.id, r.icalUid, r.recurrenceId, r.contentHash])).toEqual(
        first.map((r) => [r.id, r.icalUid, r.recurrenceId, r.contentHash]),
      );
    }
  });

  it("falls back to the feed's stored zone when the document carries none", async () => {
    const { db, feed, reload, rows } = await setupIcsFeed('ingest-ics-stored-tz@example.com', {
      timezone: 'America/New_York',
    });
    await ingestFeed(db, feed, { fetchImpl: serving(() => floatingIcs([])), ...window });
    // 09:00 EDT (UTC-4).
    expect((await rows())[0]!.dtstart.toISOString()).toBe('2026-07-07T13:00:00.000Z');
    expect((await reload()).timezone).toBe('America/New_York');
  });

  it("prefers the document's zone over a stale stored one", async () => {
    const { db, feed, reload, rows } = await setupIcsFeed('ingest-ics-doc-tz-wins@example.com', {
      timezone: 'America/New_York',
    });
    await ingestFeed(db, feed, { fetchImpl: serving(() => floatingIcs()), ...window });
    expect((await rows())[0]!.dtstart.toISOString()).toBe('2026-07-07T16:00:00.000Z');
    expect((await reload()).timezone).toBe('America/Los_Angeles');
  });

  it('parses the document once per sync, not once per helper', async () => {
    const { db, feed } = await setupIcsFeed('ingest-ics-parse-count@example.com');
    const parse = vi.spyOn(ICAL, 'parse');
    try {
      await ingestFeed(db, feed, { fetchImpl: serving(() => floatingIcs()), ...window });
      // parseAndExpand + extractTimezone + extractCalendarName used to be three.
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });
});

describe('ingest: a rescheduled recurring instance keeps its identity', () => {
  // Fixed window so the assertions don't depend on today's date.
  const window = {
    windowStart: new Date('2026-08-01T00:00:00Z'),
    windowEnd: new Date('2026-09-01T00:00:00Z'),
  };

  /** One Google recurring instance. `originalStartTime` is the series slot it
   *  occupies (RECURRENCE-ID); `start`/`end` are where it happens right now. */
  const practice = (start: string, end: string) => ({
    iCalUID: 'practice@g',
    recurringEventId: 'practice',
    status: 'confirmed',
    summary: 'Swim practice',
    location: 'Aquatic Center',
    start: { dateTime: start },
    end: { dateTime: end },
    originalStartTime: { dateTime: '2026-08-05T17:00:00Z' },
  });
  const listFetch = (item: unknown) =>
    (async () => ({ ok: true, status: 200, json: async () => ({ items: [item] }) })) as unknown as typeof fetch;

  it('moving one instance updates source_events + calendar_events in place and heals an owned task', async () => {
    const fam = await setupFamily('ingest-moved-instance@example.com', 'Moved Fam');
    const db = getDb(env.DB);
    const credRef = await storeSecret(
      db,
      testKeys(),
      null,
      JSON.stringify({ kind: 'oauth', accessToken: 'at-moved' }),
    );
    const account = (
      await db
        .insert(externalAccounts)
        .values({ userId: fam.admin.userId, kind: 'google', name: 'G', credentialsRef: credRef })
        .returning()
    )[0]!;
    const feed = (
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
    const link = (
      await db
        .insert(familyMemberFeeds)
        .values({
          familyId: fam.familyId,
          feedId: feed.id,
          familyMemberId: fam.childId,
          defaultTaskType: 'transition', // drop-off + pickup
        })
        .returning()
    )[0]!;

    const run = async (item: unknown) => {
      await ingestFeed(db, feed, { fetchImpl: listFetch(item), kek: testKeys(), ...window });
      await synthesizeFeed(db, feed, window);
      await buildMemberTasks(db, fam.childId);
      await reconcileClaimEvents(db, fam.familyId);
    };
    const sourceRows = () =>
      db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id));
    const scheduleEvents = () =>
      db
        .select()
        .from(calendarEvents)
        .where(
          and(eq(calendarEvents.linkId, link.id), eq(calendarEvents.provenance, 'synthesized')),
        );
    const childTasks = () =>
      db.select().from(tasks).where(eq(tasks.familyMemberId, fam.childId));
    const claimEvents = () =>
      db
        .select()
        .from(calendarEvents)
        .where(eq(calendarEvents.provenance, 'claimed_task'));

    // 17:00Z-18:30Z on the original slot.
    await run(practice('2026-08-05T17:00:00Z', '2026-08-05T18:30:00Z'));
    const [srcBefore] = await sourceRows();
    const [evBefore] = await scheduleEvents();
    expect(srcBefore!.recurrenceId).toBe('2026-08-05T17:00:00.000Z');
    expect(evBefore!.dtstart.toISOString()).toBe('2026-08-05T17:00:00.000Z');
    const tasksBefore = await childTasks();
    expect(tasksBefore.map((t) => t.type).sort()).toEqual(['dropoff', 'pickup']);
    const pickupBefore = tasksBefore.find((t) => t.type === 'pickup')!;
    expect(pickupBefore.dtstart.toISOString()).toBe('2026-08-05T18:30:00.000Z');

    // A caretaker takes the pickup, and sets a travel-time override on their claim.
    await setTaskOwners(db, pickupBefore, [fam.adminMemberId], { manual: true });
    const [claimBefore] = await claimEvents();
    expect(claimBefore!.taskId).toBe(pickupBefore.id);
    await db
      .update(calendarEvents)
      .set({ travelTimeOverrideMin: 25 })
      .where(eq(calendarEvents.id, claimBefore!.id));

    // The coach moves this one practice an hour later; the series slot
    // (originalStartTime) is unchanged.
    await run(practice('2026-08-05T18:00:00Z', '2026-08-05T19:30:00Z'));

    // Same source row, same calendar event — updated, not deleted + re-added.
    const srcAfter = await sourceRows();
    expect(srcAfter).toHaveLength(1);
    expect(srcAfter[0]!.id).toBe(srcBefore!.id);
    expect(srcAfter[0]!.recurrenceId).toBe('2026-08-05T17:00:00.000Z');
    expect(srcAfter[0]!.dtstart.toISOString()).toBe('2026-08-05T18:00:00.000Z');
    const evAfter = await scheduleEvents();
    expect(evAfter).toHaveLength(1);
    expect(evAfter[0]!.id).toBe(evBefore!.id);
    expect(evAfter[0]!.dtstart.toISOString()).toBe('2026-08-05T18:00:00.000Z');
    expect(evAfter[0]!.dtend?.toISOString()).toBe('2026-08-05T19:30:00.000Z');

    // The owned pickup is healed to the new time — still the same task, still
    // owned, no stale orphan at the old time and no unclaimed twin beside it.
    const tasksAfter = await childTasks();
    expect(tasksAfter).toHaveLength(2);
    expect(tasksAfter.map((t) => t.id).sort()).toEqual(tasksBefore.map((t) => t.id).sort());
    const pickupAfter = tasksAfter.find((t) => t.type === 'pickup')!;
    expect(pickupAfter.id).toBe(pickupBefore.id);
    expect(pickupAfter.calendarEventId).toBe(evBefore!.id);
    expect(pickupAfter.status).toBe('owned');
    expect(pickupAfter.dtstart.toISOString()).toBe('2026-08-05T19:30:00.000Z');
    const owners = await db
      .select()
      .from(taskOwners)
      .where(eq(taskOwners.taskId, pickupBefore.id));
    expect(owners.map((o) => o.familyMemberId)).toEqual([fam.adminMemberId]);

    // The claim moved with it rather than being cancelled and re-created, so the
    // caretaker's travel-time override survives.
    const claimsAfter = await claimEvents();
    expect(claimsAfter).toHaveLength(1);
    expect(claimsAfter[0]!.id).toBe(claimBefore!.id);
    expect(claimsAfter[0]!.dtstart.toISOString()).toBe('2026-08-05T19:30:00.000Z');
    expect(claimsAfter[0]!.travelTimeOverrideMin).toBe(25);
  });
});

describe('ingest: the stale sweep does not trust a fetch that looks like a bad read', () => {
  // Fixed window so the assertions don't depend on today's date.
  const window = {
    windowStart: new Date('2026-07-01T00:00:00Z'),
    windowEnd: new Date('2026-09-01T00:00:00Z'),
  };
  const uidsOf = (n: number) => Array.from({ length: n }, (_, i) => `ev-${i}@example.com`);
  const dayOf = (i: number) => String((i % 27) + 1).padStart(2, '0');

  /** A VCALENDAR with one hour-long August event per uid. */
  function icsOf(uids: string[]): string {
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      ...uids.flatMap((uid, i) => [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTART:202608${dayOf(i)}T150000Z`,
        `DTEND:202608${dayOf(i)}T160000Z`,
        `SUMMARY:${uid}`,
        'END:VEVENT',
      ]),
      'END:VCALENDAR',
    ].join('\r\n');
  }

  /** An ICS feed whose upstream document (and ETag) the test steers. */
  async function icsFeedFixture(email: string) {
    const user = await login(email);
    const familyId = await createFamily(user.token, 'Sweep Guard');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({ familyId, kind: 'ics', url: 'https://example.invalid/guard.ics', mode: 'standard' })
        .returning()
    )[0]!;
    const upstream = { body: '', etag: null as string | null, notModified: false };
    const requests: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      requests.push({ ...(init?.headers ?? {}) });
      if (upstream.notModified) return { ok: false, status: 304, headers: { get: () => null } };
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? upstream.etag : null) },
        text: async () => upstream.body,
      };
    }) as unknown as typeof fetch;
    const reload = async () =>
      (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    /** One poll, the way the cron does it: from the row as it is now. */
    const sync = async () => ingestFeed(db, await reload(), { fetchImpl, ...window });
    const storedUids = async () =>
      (await db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id)))
        .map((r) => r.icalUid)
        .sort();
    return { db, feed, upstream, requests, fetchImpl, reload, sync, storedUids };
  }

  it('keeps every row and warns when a populated feed comes back empty, then deletes on the third in a row', async () => {
    const f = await icsFeedFixture('sweep-guard-empty@example.com');
    const all = uidsOf(5);
    f.upstream.body = icsOf(all);
    await f.sync();
    expect(await f.storedUids()).toEqual(all);
    expect((await f.reload()).suspiciousSweepCount).toBe(0);

    // An outage page that still parses: a VCALENDAR with nothing in it.
    f.upstream.body = icsOf([]);
    const first = await f.sync();
    expect(first.fetched).toBe(true);
    expect(await f.storedUids()).toEqual(all);
    const held1 = await f.reload();
    expect(held1.suspiciousSweepCount).toBe(1);
    expect(held1.lastErrorMessage).toBe(
      'suspicious fetch: 5 of 5 in-window events missing — holding them (1/3)',
    );
    // Not a failed read: the feed stays active and unpaced by the error backoff.
    expect(held1.status).toBe('active');
    expect(held1.consecutiveFailures).toBe(0);

    await f.sync();
    expect(await f.storedUids()).toEqual(all);
    const held2 = await f.reload();
    expect(held2.suspiciousSweepCount).toBe(2);
    expect(held2.lastErrorMessage).toContain('(2/3)');

    // The third consecutive time, believe it.
    await f.sync();
    expect(await f.storedUids()).toEqual([]);
    const done = await f.reload();
    expect(done.suspiciousSweepCount).toBe(0);
    expect(done.lastErrorMessage).toBeNull();
    expect(done.status).toBe('active');
  });

  it("holds the sweep from the count stored on the feed, not from the caller's copy of the row", async () => {
    const f = await icsFeedFixture('sweep-guard-stale-row@example.com');
    const all = uidsOf(4);
    f.upstream.body = icsOf(all);
    await ingestFeed(f.db, f.feed, { fetchImpl: f.fetchImpl, ...window });

    f.upstream.body = icsOf([]);
    // `f.feed` still says suspiciousSweepCount: 0 on every call.
    await ingestFeed(f.db, f.feed, { fetchImpl: f.fetchImpl, ...window });
    await ingestFeed(f.db, f.feed, { fetchImpl: f.fetchImpl, ...window });
    expect(await f.storedUids()).toEqual(all);
    await ingestFeed(f.db, f.feed, { fetchImpl: f.fetchImpl, ...window });
    expect(await f.storedUids()).toEqual([]);
  });

  it('a normal fetch in between resets the count and clears the warning', async () => {
    const f = await icsFeedFixture('sweep-guard-reset@example.com');
    const all = uidsOf(5);
    f.upstream.body = icsOf(all);
    await f.sync();

    f.upstream.body = icsOf([]);
    await f.sync();
    await f.sync();
    expect((await f.reload()).suspiciousSweepCount).toBe(2);

    // The publisher recovers.
    f.upstream.body = icsOf(all);
    await f.sync();
    const recovered = await f.reload();
    expect(recovered.suspiciousSweepCount).toBe(0);
    expect(recovered.lastErrorMessage).toBeNull();
    expect(await f.storedUids()).toEqual(all);

    // Two more empty fetches start from scratch, so they still delete nothing.
    f.upstream.body = icsOf([]);
    await f.sync();
    await f.sync();
    expect(await f.storedUids()).toEqual(all);
    expect((await f.reload()).suspiciousSweepCount).toBe(2);
  });

  it('still deletes a small genuine removal (1 of 10) immediately, with no warning', async () => {
    const f = await icsFeedFixture('sweep-guard-small@example.com');
    const all = uidsOf(10);
    f.upstream.body = icsOf(all);
    await f.sync();

    f.upstream.body = icsOf(all.slice(1));
    await f.sync();
    expect(await f.storedUids()).toEqual(all.slice(1));
    const row = await f.reload();
    expect(row.suspiciousSweepCount).toBe(0);
    expect(row.lastErrorMessage).toBeNull();
  });

  // [rows before, rows still served upstream, whether the sweep is held back]
  it.each([
    [2, 0, false], // too few rows to tell an outage from a real clear-out
    [3, 0, true], // every row of a feed with at least three
    [9, 4, false], // more than half, but under ten rows
    [10, 5, false], // exactly half is not "more than half"
    [10, 4, true], // six of ten
    [10, 0, true],
  ])('a feed of %i events that now serves %i: held back = %s', async (before, kept, held) => {
    const f = await icsFeedFixture(`sweep-guard-threshold-${before}-${kept}@example.com`);
    const all = uidsOf(before);
    f.upstream.body = icsOf(all);
    await f.sync();

    f.upstream.body = icsOf(all.slice(0, kept));
    await f.sync();
    expect(await f.storedUids()).toEqual(held ? all : all.slice(0, kept).sort());
    expect((await f.reload()).suspiciousSweepCount).toBe(held ? 1 : 0);
  });

  it("does not record a held document's ETag, and a 304 afterwards clears the warning", async () => {
    const f = await icsFeedFixture('sweep-guard-etag@example.com');
    const all = uidsOf(5);
    f.upstream.body = icsOf(all);
    f.upstream.etag = '"good"';
    await f.sync();
    expect((await f.reload()).etag).toBe('"good"');

    // The empty document arrives with its own ETag. Storing it would make the
    // next poll a 304 — skipping the sweep — so the count could never advance.
    f.upstream.body = icsOf([]);
    f.upstream.etag = '"empty"';
    await f.sync();
    expect((await f.reload()).etag).toBe('"good"');
    await f.sync();
    expect(f.requests.at(-1)).toMatchObject({ 'If-None-Match': '"good"' });
    expect((await f.reload()).suspiciousSweepCount).toBe(2);

    // Upstream reverts to the document we accepted: "not modified" is all clear.
    f.upstream.notModified = true;
    await f.sync();
    const row = await f.reload();
    expect(row.suspiciousSweepCount).toBe(0);
    expect(row.lastErrorMessage).toBeNull();
    expect(await f.storedUids()).toEqual(all);
  });
});

describe('ingest: a CalDAV object we could not read is not an event the server deleted', () => {
  const window = {
    windowStart: new Date('2026-07-01T00:00:00Z'),
    windowEnd: new Date('2026-09-01T00:00:00Z'),
  };
  const COLLECTION = 'https://caldav.example.com/calendars/user/home/';

  const goodObject = (uid: string, day: number) => ({
    href: `/calendars/user/home/${uid}.ics`,
    etag: `e-${uid}`,
    data: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:202608${String(day).padStart(2, '0')}T150000Z\r\nDTEND:202608${String(day).padStart(2, '0')}T160000Z\r\nSUMMARY:${uid}\r\nEND:VEVENT\r\nEND:VCALENDAR`,
  });
  /** A VEVENT that never closes: the parser rejects the whole object. */
  const brokenObject = (uid: string | null) => ({
    href: `/calendars/user/home/${uid ?? 'anonymous'}.ics`,
    etag: `bad-${uid}`,
    data: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n${uid ? `UID:${uid}\r\n` : ''}DTSTART:20260806T150000Z\r\nSUMMARY:Broken\r\n`,
  });

  function multistatusXml(entries: { href: string; etag: string; data?: string }[]): string {
    const responses = entries
      .map(
        (e) => `<D:response>
  <D:href>${e.href}</D:href>
  <D:propstat>
    <D:prop>
      <D:getetag>"${e.etag}"</D:getetag>
      ${e.data !== undefined ? `<C:calendar-data>${e.data.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</C:calendar-data>` : ''}
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`,
      )
      .join('\n');
    return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">\n${responses}\n</D:multistatus>`;
  }

  async function caldavFixture(email: string) {
    const user = await login(email);
    const familyId = await createFamily(user.token, 'CalDAV Sweep');
    const db = getDb(env.DB);
    const credRef = await storeSecret(
      db,
      testKeys(),
      null,
      JSON.stringify({ kind: 'basic', username: 'u', password: 'p' }),
    );
    const account = (
      await db
        .insert(externalAccounts)
        .values({ userId: user.userId, kind: 'caldav', name: 'CalDAV', credentialsRef: credRef })
        .returning()
    )[0]!;
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId,
          kind: 'caldav',
          externalAccountId: account.id,
          sourceCalendarId: COLLECTION,
          mode: 'standard',
        })
        .returning()
    )[0]!;
    // What the server's REPORT returns next (tsdav asks twice: hrefs, then multiget).
    let objects: { href: string; etag: string; data: string }[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      const xml = body.includes('calendar-multiget')
        ? multistatusXml(objects)
        : multistatusXml(objects.map(({ href, etag }) => ({ href, etag })));
      return new Response(xml, {
        status: 207,
        headers: { 'content-type': 'application/xml; charset=utf-8' },
      });
    }) as unknown as typeof fetch;
    const reload = async () =>
      (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    return {
      serve: (next: typeof objects) => {
        objects = next;
      },
      sync: async () => ingestFeed(db, await reload(), { fetchImpl, kek: testKeys(), ...window }),
      reload,
      storedUids: async () =>
        (await db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id)))
          .map((r) => r.icalUid)
          .sort(),
    };
  }

  it("keeps a source row whose object fails to parse, while still sweeping what the server really dropped", async () => {
    const f = await caldavFixture('sweep-caldav-parse@example.com');
    const four = [goodObject('c1', 3), goodObject('c2', 4), goodObject('c3', 5), goodObject('c4', 6)];
    f.serve(four);
    await f.sync();
    expect(await f.storedUids()).toEqual(['c1', 'c2', 'c3', 'c4']);

    // c3 is now served in a form we can't parse; c4 was genuinely deleted.
    f.serve([four[0]!, four[1]!, brokenObject('c3')]);
    const res = await f.sync();
    expect(res.fetched).toBe(true);
    expect(await f.storedUids()).toEqual(['c1', 'c2', 'c3']);
    const warned = await f.reload();
    expect(warned.status).toBe('active');
    expect(warned.lastErrorMessage).toBe(
      "1 calendar object couldn't be parsed — events already stored for them are kept",
    );

    // Readable again: the warning goes, and c3 is an ordinary row once more.
    f.serve(four.slice(0, 3));
    await f.sync();
    expect(await f.storedUids()).toEqual(['c1', 'c2', 'c3']);
    expect((await f.reload()).lastErrorMessage).toBeNull();
  });

  it("skips the sweep entirely when a failed object can't even be identified", async () => {
    const f = await caldavFixture('sweep-caldav-anon@example.com');
    const four = [goodObject('c1', 3), goodObject('c2', 4), goodObject('c3', 5), goodObject('c4', 6)];
    f.serve(four);
    await f.sync();

    // c4 is genuinely gone, but we can't rule out that the unreadable object
    // was c4 — so nothing is removed this time.
    f.serve([four[0]!, four[1]!, four[2]!, brokenObject(null)]);
    await f.sync();
    expect(await f.storedUids()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect((await f.reload()).lastErrorMessage).toBe(
      "1 calendar object couldn't be parsed — not removing any events this sync",
    );

    // A clean read sweeps normally again.
    f.serve(four.slice(0, 3));
    await f.sync();
    expect(await f.storedUids()).toEqual(['c1', 'c2', 'c3']);
    expect((await f.reload()).lastErrorMessage).toBeNull();
  });

  it('holds a 207 with no objects at all (an auth/ACL blip) like any other empty read', async () => {
    const f = await caldavFixture('sweep-caldav-empty@example.com');
    const four = [goodObject('c1', 3), goodObject('c2', 4), goodObject('c3', 5), goodObject('c4', 6)];
    f.serve(four);
    await f.sync();

    f.serve([]);
    await f.sync();
    expect(await f.storedUids()).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect((await f.reload()).lastErrorMessage).toBe(
      'suspicious fetch: 4 of 4 in-window events missing — holding them (1/3)',
    );
  });
});
