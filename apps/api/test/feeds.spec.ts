import { env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authed, bearer, call, createFamily, login } from './helpers.js';

const FEED_ORIGIN = 'https://feed.example.com';
const FEED_PATH = '/cal.ics';
const FEED_URL = `${FEED_ORIGIN}${FEED_PATH}`;

/** iCalendar UTC stamp (YYYYMMDDTHHMMSSZ) for `days` from now at `hour`. */
function ical(days: number, hour: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function sampleIcs(): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mch//test//EN',
    'BEGIN:VEVENT',
    'UID:evt-closed',
    `DTSTART:${ical(2, 15)}`,
    `DTEND:${ical(2, 16)}`,
    'SUMMARY:MCH Closed - Holiday',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:evt-photos',
    `DTSTART:${ical(3, 9)}`,
    'SUMMARY:School Photos',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

function stubFeed(times: number) {
  fetchMock
    .get(FEED_ORIGIN)
    .intercept({ path: FEED_PATH, method: 'GET' })
    .reply(200, sampleIcs(), { headers: { 'content-type': 'text/calendar' } })
    .times(times);
}

describe('feed ingest', () => {
  it('creates a feed, links a child, and ingests occurrences idempotently', async () => {
    stubFeed(2); // two force-refreshes below
    const alice = await login('feedadmin@example.com');
    const familyId = await createFamily(alice.token, 'Ingest Fam');

    // Create an exception-mode feed.
    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(alice.token, { url: FEED_URL, mode: 'exception' }),
    );
    expect(feedRes.status).toBe(201);
    const { feed } = (await feedRes.json()) as { feed: { id: string; mode: string } };
    expect(feed.mode).toBe('exception');

    // Add a dependent + baseline link.
    const childRes = await call(
      `/families/${familyId}/members`,
      authed(alice.token, { relationName: 'child', requiresCaretaker: true }),
    );
    const { member } = (await childRes.json()) as { member: { id: string } };

    const linkRes = await call(
      `/families/${familyId}/feeds/${feed.id}/member-links`,
      authed(alice.token, {
        familyMemberId: member.id,
        weekdayMask: 31, // Mon–Fri
        dayStart: '08:00',
        dayEnd: '15:00',
        generatesTypes: ['dropoff', 'pickup'],
        defaultAttendance: 'any',
      }),
    );
    expect(linkRes.status).toBe(201);

    // Force-refresh → ingests the two events.
    const refresh1 = await call(
      `/families/${familyId}/feeds/${feed.id}/refresh`,
      authed(alice.token),
    );
    expect(refresh1.status).toBe(200);
    const r1 = (await refresh1.json()) as {
      ingest: { processed: number; fetched: boolean };
    };
    expect(r1.ingest.fetched).toBe(true);
    expect(r1.ingest.processed).toBe(2);

    // Re-ingest is idempotent (no duplicate source_events).
    const refresh2 = await call(
      `/families/${familyId}/feeds/${feed.id}/refresh`,
      authed(alice.token),
    );
    expect(refresh2.status).toBe(200);

    const countRow = await env.DB.prepare(
      'select count(*) as n from source_events where feed_id = ?',
    )
      .bind(feed.id)
      .first<{ n: number }>();
    expect(countRow?.n).toBe(2);
  });

  it('ingests all-day (VALUE=DATE) events and exposes them via /source-events', async () => {
    // Relative to now (within the default 90-day window), so the test doesn't
    // expire. All-day = a bare YYYYMMDD date; expect it anchored to UTC midnight.
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 5);
    day.setUTCHours(0, 0, 0, 0);
    const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const allDayIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//mch//test//EN',
      'BEGIN:VEVENT',
      'UID:evt-allday-holiday',
      `DTSTART;VALUE=DATE:${ymd(day)}`,
      `DTEND;VALUE=DATE:${ymd(next)}`,
      'SUMMARY:MCH Closed - US Holiday',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    fetchMock
      .get(FEED_ORIGIN)
      .intercept({ path: '/allday.ics', method: 'GET' })
      .reply(200, allDayIcs, { headers: { 'content-type': 'text/calendar' } });

    const admin = await login('allday-admin@example.com');
    const familyId = await createFamily(admin.token, 'AllDay Fam');
    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(admin.token, {
        url: `${FEED_ORIGIN}/allday.ics`,
        mode: 'exception',
      }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };

    await call(`/families/${familyId}/feeds/${feed.id}/refresh`, authed(admin.token));

    const res = await call(`/families/${familyId}/source-events`, bearer(admin.token));
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as {
      events: { summary: string; dtstart: number; allDay: boolean }[];
    };
    const holiday = events.find((e) => e.summary === 'MCH Closed - US Holiday');
    expect(holiday).toBeDefined();
    expect(holiday!.allDay).toBe(true);
    // UTC midnight of the calendar date — not the prior evening in a -offset tz.
    expect(new Date(holiday!.dtstart).toISOString()).toBe(day.toISOString());
  });

  it('forbids non-admins from creating feeds and non-members from refreshing', async () => {
    const alice = await login('owner2@example.com');
    const bob = await login('outsider@example.com');
    const familyId = await createFamily(alice.token, 'Guarded Fam');

    // Bob is not a member → 403 on create.
    const bobCreate = await call(
      `/families/${familyId}/feeds`,
      authed(bob.token, { url: FEED_URL, mode: 'explicit' }),
    );
    expect(bobCreate.status).toBe(403);

    // Alice (admin) creates a feed.
    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(alice.token, { url: FEED_URL, mode: 'explicit' }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };

    // Bob still not a member → 403 on refresh.
    const bobRefresh = await call(
      `/families/${familyId}/feeds/${feed.id}/refresh`,
      authed(bob.token),
    );
    expect(bobRefresh.status).toBe(403);

    // Sanity: list feeds as Alice.
    const list = await call(`/families/${familyId}/feeds`, bearer(alice.token));
    const { feeds } = (await list.json()) as { feeds: unknown[] };
    expect(feeds.length).toBe(1);
  });
});
