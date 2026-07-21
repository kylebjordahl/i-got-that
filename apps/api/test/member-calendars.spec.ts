import { env, fetchMock } from 'cloudflare:test';
import { and, calendarEvents, eq, getDb, memberCalendars } from '@igt/db';
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

// Reproduces the reported bug via the read-back path: a provider invite
// (Vagaro-style) manually added to a member's personal iCloud target
// calendar, with DTSTART carrying a bare local wall-clock time — no TZID, no
// trailing Z, and the object's own VCALENDAR has no VTIMEZONE either.
const FLOATING_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:appt-1',
  'DTSTART:20260722T110000',
  'DTEND:20260722T113000',
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
    // no timezone known yet, so the floating time is misread as UTC.
    await readBackMember(db, cal, {
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-08-01T00:00:00Z'),
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
    expect(before!.dtstart.toISOString()).toBe('2026-07-22T11:00:00.000Z'); // misread as UTC

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
    // 11:00 AM PDT == 18:00Z — corrected in place by the PUT-triggered read-back.
    expect(after!.dtstart.toISOString()).toBe('2026-07-22T18:00:00.000Z');
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
