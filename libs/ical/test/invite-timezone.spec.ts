import { describe, expect, it } from 'vitest';
import { buildCancelICalendar, buildInviteICalendar } from '../src/index.js';

const base = {
  uid: 'u',
  sequence: 0,
  start: new Date('2026-07-06T14:30:00Z'),
  end: new Date('2026-07-06T15:00:00Z'),
  summary: 's',
  organizerEmail: 'a@example.com',
  attendeeEmail: 'b@example.com',
};

describe('invite timezone', () => {
  it('defines the VTIMEZONE its TZID refers to', () => {
    const ics = buildInviteICalendar({ ...base, timezone: 'America/Denver' });
    expect(ics).toContain('DTSTART;TZID=America/Denver:20260706T083000');
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics).toContain('TZID:America/Denver');
  });

  it('uses the offset in force on the event date', () => {
    const summer = buildInviteICalendar({ ...base, timezone: 'America/Denver' });
    expect(summer).toContain('TZOFFSETTO:-0600');
    const winter = buildInviteICalendar({
      ...base,
      start: new Date('2027-01-11T15:30:00Z'),
      end: new Date('2027-01-11T16:00:00Z'),
      timezone: 'America/Denver',
    });
    expect(winter).toContain('TZOFFSETTO:-0700');
    const india = buildInviteICalendar({ ...base, timezone: 'Asia/Kolkata' });
    expect(india).toContain('TZOFFSETTO:+0530');
  });

  it('keeps DTSTAMP in UTC and the VTIMEZONE ahead of the VEVENT', () => {
    const ics = buildInviteICalendar({ ...base, timezone: 'America/Denver' });
    expect(ics).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
    expect(ics.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(ics.indexOf('BEGIN:VEVENT'));
  });

  it('defines it on a cancellation too', () => {
    const ics = buildCancelICalendar({ ...base, timezone: 'America/Denver' });
    expect(ics).toContain('BEGIN:VTIMEZONE');
  });

  it('stays UTC with no VTIMEZONE when there is no zone', () => {
    const ics = buildInviteICalendar(base);
    expect(ics).toContain('DTSTART:20260706T143000Z');
    expect(ics).not.toContain('VTIMEZONE');
  });

  it('handles negative half-hour offsets and CRLF line endings', () => {
    const ics = buildInviteICalendar({ ...base, timezone: 'America/St_Johns' });
    expect(ics).toContain('TZOFFSETTO:-0230');
    expect(ics).not.toMatch(/[^\r]\n/);
  });

  it('marks daylight time as DAYLIGHT and winter as STANDARD', () => {
    expect(buildInviteICalendar({ ...base, timezone: 'America/Denver' })).toContain('BEGIN:DAYLIGHT');
    const winter = buildInviteICalendar({
      ...base,
      start: new Date('2027-01-11T15:30:00Z'),
      end: new Date('2027-01-11T16:00:00Z'),
      timezone: 'America/Denver',
    });
    expect(winter).toContain('BEGIN:STANDARD');
    expect(winter).not.toContain('BEGIN:DAYLIGHT');
  });

  it('describes both offsets when a DST change falls inside the event', () => {
    // Denver falls back 2026-11-01 02:00 MDT (08:00Z).
    const ics = buildInviteICalendar({
      ...base,
      start: new Date('2026-10-31T20:00:00Z'),
      end: new Date('2026-11-01T12:00:00Z'),
      timezone: 'America/Denver',
    });
    expect(ics).toContain('DTSTART;TZID=America/Denver:20261031T140000');
    expect(ics).toContain('DTEND;TZID=America/Denver:20261101T050000');
    expect(ics).toContain('TZOFFSETFROM:-0600\r\nTZOFFSETTO:-0700');
    expect(ics).toContain('DTSTART:20261101T020000\r\nTZOFFSETFROM:-0600');
  });
});
