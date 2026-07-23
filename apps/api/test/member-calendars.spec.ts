import { env, fetchMock } from 'cloudflare:test';
import { and, calendarEvents, eq, getDb, memberCalendars } from '@igt/db';
import { wallTimeToUtc } from '@igt/classification';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readBackMember } from '../src/services/readback.js';
import { authed, bearer, call, patched, setupFamily } from './helpers.js';

const CALDAV_ORIGIN = 'https://dav.example.com';
const COLLECTION_PATH = '/calendars/child/home/';
const COLLECTION_URL = `${CALDAV_ORIGIN}${COLLECTION_PATH}`;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

/** A day a few days out (inside the default 30-day read-back window) at UTC midnight. */
function futureDay(offsetDays: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** `day` formatted as a bare (zoneless) ICS local date-time stamp. */
function icsStamp(day: Date, hour: number, minute = 0): string {
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, '0');
  const d = String(day.getUTCDate()).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${y}${m}${d}T${hh}${mm}00`;
}

// Reproduces the reported bug via the read-back path: a provider invite
// (Vagaro-style) manually added to a member's personal iCloud target
// calendar, with DTSTART carrying a bare local wall-clock time — no TZID, no
// trailing Z, and the object's own VCALENDAR has no VTIMEZONE either.
// The appointment day is relative to "now" (not a hardcoded calendar date) —
// read-back only looks forward from today, so a fixed past-tense date would
// eventually fall outside its window and the fixture would stop exercising
// the bug at all.
const APPT_DAY = futureDay(3);
const FLOATING_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:appt-1',
  `DTSTART:${icsStamp(APPT_DAY, 11, 0)}`,
  `DTEND:${icsStamp(APPT_DAY, 11, 30)}`,
  'SUMMARY:Chiropractic - Follow-Up Visit',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

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

/** Fakes tsdav's two-step REPORT (query for hrefs, then multiget for data) for a direct `fetchImpl`. */
function caldavFetchImpl(objects: { href: string; etag: string; data: string }[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    const xml = body.includes('calendar-multiget')
      ? multistatusXml(objects)
      : multistatusXml(objects.map(({ href, etag }) => ({ href, etag })));
    return new Response(xml, {
      status: 207,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    });
  }) as unknown as typeof fetch;
}

/** Same two-step REPORT dance, stubbed on the global fetch (undici MockAgent) for real HTTP routes. */
function stubCaldavReport(objects: { href: string; etag: string; data: string }[]): void {
  fetchMock
    .get(CALDAV_ORIGIN)
    .intercept({
      path: COLLECTION_PATH,
      method: 'REPORT',
      body: (b) => typeof b === 'string' && !b.includes('calendar-multiget'),
    })
    .reply(207, multistatusXml(objects.map(({ href, etag }) => ({ href, etag }))), {
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    });
  fetchMock
    .get(CALDAV_ORIGIN)
    .intercept({
      path: COLLECTION_PATH,
      method: 'REPORT',
      body: (b) => typeof b === 'string' && b.includes('calendar-multiget'),
    })
    .reply(207, multistatusXml(objects), {
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    });
}

async function createCalDavAccount(token: string) {
  const res = await call(
    '/accounts',
    authed(token, { kind: 'caldav', name: 'iCloud', serverUrl: CALDAV_ORIGIN, username: 'u', password: 'p' }),
  );
  const { account } = (await res.json()) as { account: { id: string } };
  return account.id;
}

describe("member target calendar timezone (read-back's floating-time fix)", () => {
  it('setting the target timezone re-reads-back and corrects an already-imported floating-time event', async () => {
    const f = await setupFamily('member-tz-admin@example.com');
    const accountId = await createCalDavAccount(f.admin.token);

    const putRes = await call(
      `/families/${f.familyId}/members/${f.childId}/calendar-target`,
      { method: 'PUT', headers: { Authorization: `Bearer ${f.admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ externalAccountId: accountId, targetCalendarId: COLLECTION_URL }) },
    );
    expect(putRes.status).toBe(201);
    const { target } = (await putRes.json()) as { target: { id: string; timezone: string | null } };
    expect(target.timezone).toBeNull();

    const db = getDb(env.DB);
    const cal = (
      await db.select().from(memberCalendars).where(eq(memberCalendars.id, target.id)).limit(1)
    )[0]!;

    // Seed the initial (wrong) read-back directly, bypassing the HTTP route —
    // no timezone known yet, so the floating time is misread as UTC. No
    // explicit window: the default (today forward 30 days) already covers
    // APPT_DAY and matches what the route below uses.
    await readBackMember(db, cal, {
      kek: env.KEK,
      fetchImpl: caldavFetchImpl([
        { href: '/calendars/child/home/floating-event.ics', etag: 'e1', data: FLOATING_ICS },
      ]),
    });

    const eventRow = async () =>
      (
        await db
          .select()
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.familyMemberId, f.childId),
              eq(calendarEvents.provenance, 'human'),
            ),
          )
      )[0];

    const before = await eventRow();
    expect(before).toBeDefined();
    // Misread as UTC: the bare wall-clock stamp taken literally as 11:00Z.
    const misreadAsUtc = new Date(Date.UTC(
      APPT_DAY.getUTCFullYear(), APPT_DAY.getUTCMonth(), APPT_DAY.getUTCDate(), 11, 0, 0,
    ));
    expect(before!.dtstart.toISOString()).toBe(misreadAsUtc.toISOString());

    // Same source data — the fix is a manual timezone correction, not an
    // upstream change — so the multistatus REPORT the route triggers below
    // returns the identical floating event.
    stubCaldavReport([
      { href: '/calendars/child/home/floating-event.ics', etag: 'e1', data: FLOATING_ICS },
    ]);

    const patchRes = await call(
      `/families/${f.familyId}/members/${f.childId}/calendar-target`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${f.admin.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          externalAccountId: accountId,
          targetCalendarId: COLLECTION_URL,
          timezone: 'America/Los_Angeles',
        }),
      },
    );
    expect(patchRes.status).toBe(200);
    const { target: patchedTarget } = (await patchRes.json()) as { target: { timezone: string | null } };
    expect(patchedTarget.timezone).toBe('America/Los_Angeles');

    const after = await eventRow();
    // 11:00 AM America/Los_Angeles — corrected in place by the PUT-triggered
    // read-back (PDT/PST offset resolved for whichever day APPT_DAY lands on).
    const correctedInstant = wallTimeToUtc(APPT_DAY, '11:00', 11, 'America/Los_Angeles');
    expect(after!.dtstart.toISOString()).toBe(correctedInstant.toISOString());
  });

  it('lists as a caretaker without a target so read-back skips it', async () => {
    const f = await setupFamily('member-tz-none@example.com');
    const res = await call(
      `/families/${f.familyId}/members/${f.childId}/calendar-target`,
      bearer(f.admin.token),
    );
    expect(res.status).toBe(200);
    const { target } = (await res.json()) as { target: unknown };
    expect(target).toBeNull();
  });
});
