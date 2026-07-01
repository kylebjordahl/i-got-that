import { describe, expect, it } from 'vitest';
import {
  buildCancelICalendar,
  buildInviteICalendar,
  createCalDavClient,
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

  it('instantiates a CalDAV client (tsdav importable in workerd)', () => {
    // Don't hit the network — just prove the factory is callable here.
    const client = createCalDavClient({
      serverUrl: 'https://caldav.icloud.com',
      username: 'someone@icloud.com',
      password: 'app-specific-password',
    });
    expect(client).toBeInstanceOf(Promise);
  });
});
