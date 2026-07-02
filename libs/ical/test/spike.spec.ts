import { describe, expect, it } from 'vitest';
import {
  buildCancelICalendar,
  buildInviteICalendar,
  buildStoredEventICalendar,
  createCalDavClient,
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

    const occ = await fetchGoogleOccurrences(
      'access-token',
      'primary',
      {
        windowStart: new Date('2026-08-01T00:00:00Z'),
        windowEnd: new Date('2026-09-01T00:00:00Z'),
      },
      fetchImpl,
    );

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
