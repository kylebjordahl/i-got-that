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
});
