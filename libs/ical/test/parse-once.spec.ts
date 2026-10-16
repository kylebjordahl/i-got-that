import ICAL from 'ical.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractCalendarName,
  extractTimezone,
  parseAndExpand,
  parseCalendar,
} from '../src/index.js';

// One document that exercises everything the three readers look at: a calendar
// name + zone, a recurring master with a moved instance, a floating (zone-less)
// timed event, and an all-day event.
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//test//EN',
  'X-WR-CALNAME:  Bluebird Elementary ',
  'X-WR-TIMEZONE:America/Los_Angeles',
  'BEGIN:VEVENT',
  'UID:series-1',
  'DTSTART:20260706T090000',
  'DTEND:20260706T100000',
  'RRULE:FREQ=DAILY;COUNT=4',
  'SUMMARY:Drop off',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:series-1',
  'RECURRENCE-ID:20260707T090000',
  'DTSTART:20260707T110000',
  'DTEND:20260707T120000',
  'SUMMARY:Drop off (late start)',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:single-1',
  'DTSTART:20260710T130000',
  'DTEND:20260710T140000',
  'SUMMARY:Dentist',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:holiday-1',
  'DTSTART;VALUE=DATE:20260713',
  'DTEND;VALUE=DATE:20260714',
  'SUMMARY:Holiday',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const OPTS = {
  windowStart: new Date('2026-07-01T00:00:00Z'),
  windowEnd: new Date('2026-08-01T00:00:00Z'),
};

const VTIMEZONE_ONLY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:America/Chicago',
  'BEGIN:STANDARD',
  'DTSTART:19701101T020000',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0600',
  'END:STANDARD',
  'END:VTIMEZONE',
  'END:VCALENDAR',
].join('\r\n');

const BARE = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseCalendar: parse once, read many', () => {
  it('returns the root VCALENDAR component', () => {
    const root = parseCalendar(ICS);
    expect(root.name).toBe('vcalendar');
    expect(root.getAllSubcomponents('vevent')).toHaveLength(4);
  });

  it('throws on an unparseable document (the extractors are the ones that swallow it)', () => {
    expect(() => parseCalendar('not an ics document')).toThrow();
  });

  describe('a pre-parsed root gives the same answer as the text', () => {
    it('parseAndExpand, with and without a floating-time zone hint', () => {
      const root = parseCalendar(ICS);
      for (const defaultTimezone of [undefined, 'America/Los_Angeles']) {
        const fromText = parseAndExpand(ICS, { ...OPTS, defaultTimezone });
        const fromRoot = parseAndExpand(root, { ...OPTS, defaultTimezone });
        // 4 daily instances (one moved) + a single + an all-day.
        expect(fromRoot).toHaveLength(6);
        expect(fromRoot).toEqual(fromText);
      }
    });

    it('extractTimezone: X-WR-TIMEZONE, first VTIMEZONE, and neither', () => {
      for (const [text, expected] of [
        [ICS, 'America/Los_Angeles'],
        [VTIMEZONE_ONLY, 'America/Chicago'],
        [BARE, null],
      ] as const) {
        expect(extractTimezone(parseCalendar(text))).toBe(expected);
        expect(extractTimezone(parseCalendar(text))).toBe(extractTimezone(text));
      }
    });

    it('extractCalendarName: trimmed name, and none', () => {
      for (const [text, expected] of [
        [ICS, 'Bluebird Elementary'],
        [BARE, null],
      ] as const) {
        expect(extractCalendarName(parseCalendar(text))).toBe(expected);
        expect(extractCalendarName(parseCalendar(text))).toBe(extractCalendarName(text));
      }
    });

    it('stays the same when the readers share one root in any order', () => {
      // Expansion wraps the root's VEVENTs in ICAL.Event; the extractors must
      // not be thrown by that (or throw it off) when they run afterwards.
      const expected = parseAndExpand(ICS, OPTS);
      const root = parseCalendar(ICS);
      expect(extractTimezone(root)).toBe('America/Los_Angeles');
      expect(parseAndExpand(root, OPTS)).toEqual(expected);
      expect(extractCalendarName(root)).toBe('Bluebird Elementary');
      expect(extractTimezone(root)).toBe('America/Los_Angeles');
      expect(parseAndExpand(root, OPTS)).toEqual(expected);
    });
  });

  describe('how many times ICAL.parse runs', () => {
    it('is once per text call, and never for a pre-parsed root', () => {
      const parse = vi.spyOn(ICAL, 'parse');

      // The old shape of an ICS ingest: every helper re-parsed the whole text.
      parseAndExpand(ICS, OPTS);
      extractTimezone(ICS);
      extractCalendarName(ICS);
      expect(parse).toHaveBeenCalledTimes(3);

      parse.mockClear();
      const root = parseCalendar(ICS);
      parseAndExpand(root, OPTS);
      extractTimezone(root);
      extractCalendarName(root);
      expect(parse).toHaveBeenCalledTimes(1);
    });
  });
});
