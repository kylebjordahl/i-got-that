import { env } from 'cloudflare:test';
import { eq, externalAccounts, feeds, getDb, sourceEvents } from '@igt/db';
import { describe, expect, it } from 'vitest';
import { storeSecret } from '../src/lib/secrets.js';
import { ingestFeed } from '../src/services/ingest.js';
import { createFamily, login } from './helpers.js';

describe('ingest: account-backed input feeds', () => {
  it('reads a Google calendar feed into source_events (credential from the account)', async () => {
    const user = await login('ingest-google@example.com');
    const familyId = await createFamily(user.token, 'Ingest G');
    const db = getDb(env.DB);

    // A connected Google account owned by the user, with an encrypted refresh token.
    const credRef = await storeSecret(
      db,
      env.KEK,
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
      kek: env.KEK,
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
      kek: env.KEK,
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
      env.KEK,
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
      kek: env.KEK,
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

    await expect(ingestFeed(db, feed, { kek: env.KEK })).rejects.toThrow();
    const after = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    expect(after.status).toBe('error');
  });
});
