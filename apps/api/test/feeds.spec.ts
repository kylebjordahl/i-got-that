import { env, fetchMock } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  externalAccounts,
  getDb,
  memberCalendars,
  tasks,
} from '@igt/db';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { storeSecret } from '../src/lib/secrets.js';
import { authed, bearer, call, createFamily, login, patched, setupFamily } from './helpers.js';

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
    stubFeed(3); // implicit first-link ingest, then two explicit force-refreshes below
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
      authed(bob.token, { url: FEED_URL, mode: 'standard' }),
    );
    expect(bobCreate.status).toBe(403);

    // Alice (admin) creates a feed.
    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(alice.token, { url: FEED_URL, mode: 'standard' }),
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

  it('a manual timezone override re-ingests and corrects floating (zone-less) event times', async () => {
    // Reproduces a provider invite (e.g. Vagaro booking software) whose
    // DTSTART/DTEND carry a bare local wall-clock time with no TZID/Z and
    // whose document never advertises X-WR-TIMEZONE/VTIMEZONE either — RFC
    // 5545 "floating" time. Without a hint, it's misread as UTC.
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 5);
    const floatingStamp = `${day.toISOString().slice(0, 10).replace(/-/g, '')}T110000`; // 11:00, no Z
    const floatingIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-West Coast Wellness//test',
      'BEGIN:VEVENT',
      'UID:appt-1',
      `DTSTART:${floatingStamp}`,
      'SUMMARY:Chiropractic - Follow-Up Visit',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    fetchMock
      .get(FEED_ORIGIN)
      .intercept({ path: '/floating.ics', method: 'GET' })
      .reply(200, floatingIcs, { headers: { 'content-type': 'text/calendar' } })
      .times(2); // initial ingest + the PATCH-triggered re-ingest

    const admin = await login('tz-admin@example.com');
    const familyId = await createFamily(admin.token, 'TZ Fam');
    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(admin.token, { url: `${FEED_ORIGIN}/floating.ics`, mode: 'standard' }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string; timezone: string | null } };
    expect(feed.timezone).toBeNull();
    await call(`/families/${familyId}/feeds/${feed.id}/refresh`, authed(admin.token));

    // Hono serializes the D1 timestamp as an ISO string over JSON.
    const dtstartOf = async (): Promise<string> => {
      const res = await call(`/families/${familyId}/source-events`, bearer(admin.token));
      const { events } = (await res.json()) as { events: { summary: string; dtstart: string }[] };
      return events.find((e) => e.summary === 'Chiropractic - Follow-Up Visit')!.dtstart;
    };
    const beforeFix = await dtstartOf();
    // No timezone hint yet ⇒ resolved as if the wall-clock time were UTC.
    expect(new Date(beforeFix).toISOString()).toBe(`${floatingStamp.slice(0, 4)}-${floatingStamp.slice(4, 6)}-${floatingStamp.slice(6, 8)}T11:00:00.000Z`);

    // Manually set the feed's timezone — the fix for a source that never
    // advertises one — which must re-ingest (not just resynthesize) so the
    // already-stored (wrong) source_events get reinterpreted.
    const patchRes = await call(
      `/families/${familyId}/feeds/${feed.id}`,
      patched(admin.token, { timezone: 'America/Los_Angeles' }),
    );
    expect(patchRes.status).toBe(200);
    const { feed: patchedFeed } = (await patchRes.json()) as { feed: { timezone: string | null } };
    expect(patchedFeed.timezone).toBe('America/Los_Angeles');

    const afterFix = await dtstartOf();
    expect(afterFix).not.toBe(beforeFix);
    // Independently derive the expected instant (not by reusing production
    // code) — 11:00 wall-clock in America/Los_Angeles, whatever that day's
    // DST offset is — to confirm the correction lands on the right instant.
    const beforeFixMs = new Date(beforeFix).getTime();
    const parts: Record<string, number> = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(beforeFixMs))) {
      if (p.type !== 'literal') parts[p.type] = Number(p.value);
    }
    const renderedAsUtc = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour === 24 ? 0 : parts.hour!,
      parts.minute!,
      parts.second!,
    );
    const expectedMs = beforeFixMs - (renderedAsUtc - beforeFixMs);
    expect(new Date(afterFix).getTime()).toBe(expectedMs);
  });

  it('refresh-all reads back a human edit on a member target calendar (not just the next cron tick)', async () => {
    // Regression: /refresh-all used to only re-run ingest+synthesis+task-gen,
    // skipping the read-back step the cron tick does — so an edit made
    // directly on a member's target calendar (a 'human' calendar_event) sat
    // stale until the next cron ran read-back for you.
    const f = await setupFamily('refresh-readback@example.com');
    const db = getDb(env.DB);
    const credRef = await storeSecret(
      db,
      env.KEK,
      null,
      // A pre-resolved access token — no live Google OAuth refresh needed.
      JSON.stringify({ kind: 'oauth', accessToken: 'test-access-token' }),
    );
    const account = (
      await db
        .insert(externalAccounts)
        .values({ userId: f.admin.userId, kind: 'google', name: 'G', credentialsRef: credRef })
        .returning()
    )[0]!;
    await db.insert(memberCalendars).values({
      familyId: f.familyId,
      familyMemberId: f.childId,
      targetExternalAccountId: account.id,
      targetMethod: 'google',
      targetCalendarId: 'kid-calendar-id',
    });

    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 2);
    day.setUTCHours(16, 0, 0, 0);
    const dayEnd = new Date(day.getTime() + 2 * 60 * 60 * 1000);
    const googleEvent = (summary: string) => ({
      iCalUID: 'playdate@google.com',
      status: 'confirmed',
      summary,
      start: { dateTime: day.toISOString() },
      end: { dateTime: dayEnd.toISOString() },
    });

    const stubGoogleEvents = (summary: string) =>
      fetchMock
        .get('https://www.googleapis.com')
        .intercept({
          path: (p: string) => p.startsWith('/calendar/v3/calendars/kid-calendar-id/events'),
          method: 'GET',
        })
        .reply(200, JSON.stringify({ items: [googleEvent(summary)] }), {
          headers: { 'content-type': 'application/json' },
        });

    // First refresh: picks up the manual event and generates its attendance task.
    stubGoogleEvents('Playdate with Sam');
    const r1 = await call(
      `/families/${f.familyId}/feeds/refresh-all`,
      authed(f.admin.token),
    );
    expect(r1.status).toBe(200);

    const humanBefore = await db
      .select()
      .from(calendarEvents)
      .where(
        and(eq(calendarEvents.familyMemberId, f.childId), eq(calendarEvents.provenance, 'human')),
      );
    expect(humanBefore).toHaveLength(1);
    expect(humanBefore[0]!.summary).toBe('Playdate with Sam');
    const taskBefore = await db
      .select()
      .from(tasks)
      .where(eq(tasks.calendarEventId, humanBefore[0]!.id));
    expect(taskBefore).toHaveLength(1);
    expect(taskBefore[0]!.type).toBe('attendance');

    // The user edits the manual event directly on the target calendar, then
    // hits refresh — a single /refresh-all call must reflect the edit, with
    // no separate cron tick.
    stubGoogleEvents('Playdate with Sam (moved to Rec Center)');
    const r2 = await call(
      `/families/${f.familyId}/feeds/refresh-all`,
      authed(f.admin.token),
    );
    expect(r2.status).toBe(200);

    const humanAfter = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, humanBefore[0]!.id));
    expect(humanAfter[0]!.summary).toBe('Playdate with Sam (moved to Rec Center)');
  });
});
