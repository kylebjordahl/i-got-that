import { describe, expect, it } from 'vitest';
import {
  buildCancelICalendar,
  buildInviteICalendar,
  buildStoredEventICalendar,
  createCalDavClient,
  extractTimezone,
  fetchGoogleOccurrences,
  hashOccurrence,
  parseAndExpand,
  type InviteEventInput,
} from '../src/index.js';

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//test//EN
BEGIN:VEVENT
UID:weekly-1
DTSTART:20260105T150000Z
DTEND:20260105T153000Z
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6
SUMMARY:School pickup
LOCATION:Children's House
END:VEVENT
BEGIN:VEVENT
UID:single-1
DTSTART:20260110T180000Z
DTEND:20260110T190000Z
SUMMARY:Dentist
END:VEVENT
END:VCALENDAR`;

describe('ical OSS libs under workerd', () => {
  it('parses + expands RRULE within a window (ical.js)', () => {
    const occ = parseAndExpand(SAMPLE_ICS, {
      windowStart: new Date('2026-01-01T00:00:00Z'),
      windowEnd: new Date('2026-03-01T00:00:00Z'),
    });
    const recurring = occ.filter((o) => o.uid === 'weekly-1');
    const single = occ.filter((o) => o.uid === 'single-1');

    expect(recurring).toHaveLength(6);
    expect(single).toHaveLength(1);
    expect(recurring[0]?.recurrenceId).not.toBeNull();
    expect(single[0]?.recurrenceId).toBeNull();
    expect(single[0]?.summary).toBe('Dentist');
  });

  it('gives each RECURRENCE-ID override of a series its own distinct key', () => {
    // A daily series with two overridden instances (e.g. "Drop Off Poppy"
    // rescheduled on two different days). Both overrides have a RECURRENCE-ID
    // but no RRULE of their own, so isRecurring() is false for each — without
    // relating them to the master as exceptions, both would fall through to
    // recurrenceId: null and collide on (uid, recurrenceId).
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//test//EN
BEGIN:VEVENT
UID:daily-1
DTSTART:20260105T150000Z
DTEND:20260105T153000Z
RRULE:FREQ=DAILY;COUNT=5
SUMMARY:Drop Off Poppy
END:VEVENT
BEGIN:VEVENT
UID:daily-1
RECURRENCE-ID:20260106T150000Z
DTSTART:20260106T170000Z
DTEND:20260106T173000Z
SUMMARY:Drop Off Poppy (late)
END:VEVENT
BEGIN:VEVENT
UID:daily-1
RECURRENCE-ID:20260107T150000Z
DTSTART:20260107T160000Z
DTEND:20260107T163000Z
SUMMARY:Drop Off Poppy (moved)
END:VEVENT
END:VCALENDAR`;
    const occ = parseAndExpand(ics, {
      windowStart: new Date('2026-01-01T00:00:00Z'),
      windowEnd: new Date('2026-03-01T00:00:00Z'),
    });

    expect(occ).toHaveLength(5);
    const keys = occ.map((o) => `${o.uid}:${o.recurrenceId ?? ''}`);
    expect(new Set(keys).size).toBe(5); // every occurrence has a unique key

    const overridden = occ.find((o) => o.summary === 'Drop Off Poppy (late)');
    expect(overridden?.start.toISOString()).toBe('2026-01-06T17:00:00.000Z');
    const moved = occ.find((o) => o.summary === 'Drop Off Poppy (moved)');
    expect(moved?.start.toISOString()).toBe('2026-01-07T16:00:00.000Z');

    const unmodified = occ.filter(
      (o) => o.summary === 'Drop Off Poppy' && o.uid === 'daily-1',
    );
    expect(unmodified).toHaveLength(3); // 5 total, 2 overridden
  });

  it('anchors all-day (VALUE=DATE) events to UTC midnight, tz-independently', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//test//EN
BEGIN:VEVENT
UID:holiday-1
DTSTART;VALUE=DATE:20260703
DTEND;VALUE=DATE:20260704
SUMMARY:MCH Closed - US Holiday
END:VEVENT
END:VCALENDAR`;
    const [occ] = parseAndExpand(ics, {
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-10T00:00:00Z'),
    });
    expect(occ).toBeDefined();
    expect(occ!.allDay).toBe(true);
    // Friday July 3 at UTC midnight — never the prior evening in a negative
    // offset, regardless of the runtime timezone that runs this test.
    expect(occ!.start.toISOString()).toBe('2026-07-03T00:00:00.000Z');
    expect(occ!.end?.toISOString()).toBe('2026-07-04T00:00:00.000Z');
    // Timed events keep allDay=false.
    const [timed] = parseAndExpand(SAMPLE_ICS, {
      windowStart: new Date('2026-01-10T00:00:00Z'),
      windowEnd: new Date('2026-01-11T00:00:00Z'),
    });
    expect(timed?.allDay).toBe(false);
  });

  it('keeps an in-progress multi-day/all-day occurrence whose span already started before "now"', () => {
    // A closure spanning today through tomorrow (DTEND is exclusive, so this
    // covers Jul 16 and Jul 17). windowStart sits mid-day on the 16th — after
    // the event's own start but still within its coverage — reproducing an
    // ingest that runs partway through a multi-day event's first day. Without
    // also checking `end`, a start-only window filter drops this occurrence
    // entirely, taking its (still-future) coverage of tomorrow down with it.
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//test//EN
BEGIN:VEVENT
UID:closure-1
DTSTART;VALUE=DATE:20260716
DTEND;VALUE=DATE:20260718
SUMMARY:MCH Closed - Staff Training
END:VEVENT
END:VCALENDAR`;
    const occ = parseAndExpand(ics, {
      windowStart: new Date('2026-07-16T14:00:00Z'),
      windowEnd: new Date('2026-07-20T00:00:00Z'),
    });
    expect(occ).toHaveLength(1);
    expect(occ[0]?.start.toISOString()).toBe('2026-07-16T00:00:00.000Z');
    expect(occ[0]?.end?.toISOString()).toBe('2026-07-18T00:00:00.000Z');

    // A same-shaped event that fully ended before windowStart stays excluded.
    const pastIcs = ics.replace(/20260716/g, '20260710').replace(/20260718/g, '20260712');
    const pastOcc = parseAndExpand(pastIcs, {
      windowStart: new Date('2026-07-16T14:00:00Z'),
      windowEnd: new Date('2026-07-20T00:00:00Z'),
    });
    expect(pastOcc).toHaveLength(0);
  });

  it('keeps an in-progress occurrence of a recurring multi-day event alongside a far-future one', () => {
    // Mirrors the reported bug: a recurring closure whose *next* occurrence
    // started today (still covers tomorrow) alongside ones weeks out — both
    // must be ingested so a cancel_day override rule can match either.
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//test//EN
BEGIN:VEVENT
UID:recurring-closure-1
DTSTART;VALUE=DATE:20260716
DTEND;VALUE=DATE:20260718
RRULE:FREQ=WEEKLY;COUNT=4
SUMMARY:Late start
END:VEVENT
END:VCALENDAR`;
    const occ = parseAndExpand(ics, {
      windowStart: new Date('2026-07-16T14:00:00Z'),
      windowEnd: new Date('2026-08-15T00:00:00Z'),
    });
    // All 4 weekly occurrences ingested, including today's in-progress one —
    // not just the ones starting cleanly in the future.
    expect(occ).toHaveLength(4);
    expect(occ[0]?.start.toISOString()).toBe('2026-07-16T00:00:00.000Z');
  });

  it('folds all-day into the content hash', () => {
    const [a] = parseAndExpand(SAMPLE_ICS, {
      windowStart: new Date('2026-01-10T00:00:00Z'),
      windowEnd: new Date('2026-01-11T00:00:00Z'),
    });
    expect(a).toBeDefined();
    expect(hashOccurrence(a!)).not.toBe(hashOccurrence({ ...a!, allDay: true }));
  });

  it('produces stable, change-sensitive content hashes', () => {
    const [a] = parseAndExpand(SAMPLE_ICS, {
      windowStart: new Date('2026-01-01T00:00:00Z'),
      windowEnd: new Date('2026-01-07T00:00:00Z'),
    });
    expect(a).toBeDefined();
    const h1 = hashOccurrence(a!);
    const h2 = hashOccurrence(a!);
    const h3 = hashOccurrence({ ...a!, summary: 'changed' });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('generates a full-detail invite + cancellation (ical-generator)', () => {
    const input: InviteEventInput = {
      uid: 'task-123',
      sequence: 0,
      start: new Date('2026-01-05T15:00:00Z'),
      end: new Date('2026-01-05T15:30:00Z'),
      summary: 'Pickup — School',
      location: "Children's House",
      alertMinutes: [30, 10],
      organizerEmail: 'noreply@igt.example',
      attendeeEmail: 'parent@example.com',
    };
    const invite = buildInviteICalendar(input);
    expect(invite).toContain('METHOD:REQUEST');
    expect(invite).toContain('BEGIN:VEVENT');
    expect(invite).toContain('UID:task-123');
    // Two display alarms, firing 30 and 10 minutes before start.
    expect(invite.match(/BEGIN:VALARM/g)).toHaveLength(2);
    expect(invite).toContain('TRIGGER:-PT30M');
    expect(invite).toContain('TRIGGER:-PT10M');

    // Cancellations carry no alarms.
    const cancel = buildCancelICalendar({ ...input, sequence: 1 });
    expect(cancel).toContain('METHOD:CANCEL');
    expect(cancel).not.toContain('BEGIN:VALARM');
  });

  it('renders a stored event in its source timezone (not GMT), host-independently', () => {
    // 22:30 UTC == 15:30 in Los Angeles (PDT). The wall-clock + TZID must be the
    // same no matter what timezone the test runtime is in — we anchor to the
    // zoned wall clock rather than trusting ical-generator's local getters.
    const ics = buildStoredEventICalendar({
      uid: 'task-tz',
      sequence: 0,
      start: new Date('2026-07-02T22:30:00Z'),
      end: new Date('2026-07-02T23:00:00Z'),
      summary: 'Pickup — School',
      location: '123 Main St, Springfield',
      timezone: 'America/Los_Angeles',
    });
    expect(ics).toContain('DTSTART;TZID=America/Los_Angeles:20260702T153000');
    expect(ics).toContain('DTEND;TZID=America/Los_Angeles:20260702T160000');
    // No bare-UTC stamp on the timed value (that's the "GMT" bug).
    expect(ics).not.toMatch(/DTSTART:20260702T\d+Z/);
  });

  it('falls back to UTC when no timezone is given', () => {
    const ics = buildStoredEventICalendar({
      uid: 'task-utc',
      sequence: 0,
      start: new Date('2026-07-02T22:30:00Z'),
      end: new Date('2026-07-02T23:00:00Z'),
      summary: 'Pickup — School',
    });
    expect(ics).toContain('DTSTART:20260702T223000Z');
    expect(ics).not.toContain('TZID=');
  });

  it('opts a located stored event into Apple automatic travel time', () => {
    const withLocation = buildStoredEventICalendar({
      uid: 'task-loc',
      sequence: 0,
      start: new Date('2026-07-02T22:30:00Z'),
      end: null,
      summary: 'Pickup — School',
      location: '123 Main St, Springfield',
    });
    expect(withLocation).toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC');
    // No location ⇒ nothing to route to, so no travel-advisory flag.
    const noLocation = buildStoredEventICalendar({
      uid: 'task-noloc',
      sequence: 0,
      start: new Date('2026-07-02T22:30:00Z'),
      end: null,
      summary: 'Attendance — School',
    });
    expect(noLocation).not.toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR');
  });

  // iCalendar folds long lines (CRLF + space at 75 octets); unfold before
  // asserting on structured-location params that can straddle a fold boundary.
  const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '');

  it('emits GEO + X-APPLE-STRUCTURED-LOCATION for a geocoded stored event', () => {
    const ics = unfold(
      buildStoredEventICalendar({
        uid: 'task-geo',
        sequence: 0,
        start: new Date('2026-07-02T22:30:00Z'),
        end: null,
        summary: 'Pickup — School',
        location: 'Springfield Elementary',
        locationGeo: {
          lat: 37.331686,
          lon: -122.030656,
          title: 'Springfield Elementary',
          address: '123 Main St, Springfield',
          radius: 72,
        },
      }),
    );
    // Structured location gives Apple the coordinates directly, so travel time
    // works without it having to geocode the free text.
    expect(ics).toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC');
    expect(ics).toContain('GEO:37.331686;-122.030656');
    expect(ics).toContain('X-APPLE-STRUCTURED-LOCATION');
    expect(ics).toContain('geo:37.331686,-122.030656');
    expect(ics).toContain('X-TITLE=Springfield Elementary');
  });

  it('uses the display text as the structured title when geo omits one', () => {
    const ics = unfold(
      buildStoredEventICalendar({
        uid: 'task-geo-notitle',
        sequence: 0,
        start: new Date('2026-07-02T22:30:00Z'),
        end: null,
        summary: 'Pickup',
        location: "Children's House",
        locationGeo: { lat: 40.7128, lon: -74.006 },
      }),
    );
    expect(ics).toContain('GEO:40.7128;-74.006');
    expect(ics).toContain("X-TITLE=Children's House");
  });

  it('reads the calendar timezone from X-WR-TIMEZONE when present', () => {
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-TIMEZONE:America/Los_Angeles\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260105T150000Z\r\nDTEND:20260105T153000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    expect(extractTimezone(ics)).toBe('America/Los_Angeles');
  });

  it('falls back to the first VTIMEZONE TZID when X-WR-TIMEZONE is absent (CalDAV per-object payloads)', () => {
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:America/Chicago\r\nBEGIN:STANDARD\r\nDTSTART:19701101T020000\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0600\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=America/Chicago:20260105T090000\r\nDTEND;TZID=America/Chicago:20260105T093000\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    expect(extractTimezone(ics)).toBe('America/Chicago');
  });

  it('returns null when neither X-WR-TIMEZONE nor a VTIMEZONE is present', () => {
    expect(extractTimezone(SAMPLE_ICS)).toBeNull();
  });

  it('instantiates a CalDAV client (tsdav importable in workerd)', () => {
    // Don't hit the network — just prove the factory is callable here.
    const client = createCalDavClient({
      serverUrl: 'https://caldav.icloud.com',
      username: 'someone@icloud.com',
      password: 'app-specific-password',
    });
    expect(client).toBeInstanceOf(Promise);
  });

  it('maps Google events.list into occurrences (timed, all-day, recurrence, cancelled)', async () => {
    const page = {
      timeZone: 'America/Chicago',
      items: [
        {
          iCalUID: 'timed@g',
          status: 'confirmed',
          summary: 'Pickup',
          location: 'Gym',
          start: { dateTime: '2026-08-03T15:00:00Z' },
          end: { dateTime: '2026-08-03T16:00:00Z' },
        },
        {
          iCalUID: 'holiday@g',
          status: 'confirmed',
          summary: 'Closed',
          start: { date: '2026-08-04' },
          end: { date: '2026-08-05' },
        },
        {
          iCalUID: 'series@g',
          recurringEventId: 'series@g',
          status: 'confirmed',
          summary: 'Class',
          start: { dateTime: '2026-08-05T09:00:00Z' },
          end: { dateTime: '2026-08-05T10:00:00Z' },
        },
        { iCalUID: 'gone@g', status: 'cancelled', start: { dateTime: '2026-08-06T09:00:00Z' } },
      ],
    };
    const fetchImpl = (async (url: string) => {
      expect(String(url)).toContain('/calendars/primary/events');
      return { ok: true, status: 200, json: async () => page };
    }) as unknown as typeof fetch;

    const { occurrences: occ, timezone } = await fetchGoogleOccurrences(
      'access-token',
      'primary',
      {
        windowStart: new Date('2026-08-01T00:00:00Z'),
        windowEnd: new Date('2026-09-01T00:00:00Z'),
      },
      fetchImpl,
    );

    expect(timezone).toBe('America/Chicago');
    expect(occ).toHaveLength(3); // cancelled dropped
    const holiday = occ.find((o) => o.uid === 'holiday@g')!;
    expect(holiday.allDay).toBe(true);
    expect(holiday.start.toISOString()).toBe('2026-08-04T00:00:00.000Z');
    const timed = occ.find((o) => o.uid === 'timed@g')!;
    expect(timed.allDay).toBe(false);
    expect(timed.recurrenceId).toBeNull();
    // A recurrence instance carries a recurrenceId so (uid, recurrenceId) stays unique.
    expect(occ.find((o) => o.uid === 'series@g')!.recurrenceId).toBe('2026-08-05T09:00:00.000Z');
  });
});
