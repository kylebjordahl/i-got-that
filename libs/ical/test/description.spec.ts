import { describe, expect, it } from 'vitest';
import {
  fetchGoogleOccurrences,
  hashOccurrence,
  MAX_DESCRIPTION_CHARS,
  normalizeDescription,
  parseAndExpand,
} from '../src/index.js';

/**
 * Rules can match on an event's DESCRIPTION (`matchField: 'description'` /
 * `any_text`), so every reader has to carry it. It is for matching only — see
 * `Occurrence.description`.
 */

const OPTS = {
  windowStart: new Date('2026-07-01T00:00:00Z'),
  windowEnd: new Date('2026-08-01T00:00:00Z'),
};

const wrap = (...vevents: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//test//EN', ...vevents, 'END:VCALENDAR'].join(
    '\r\n',
  );

describe('VEVENT DESCRIPTION', () => {
  it('is read off a standalone event, unescaped', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:single-1',
      'DTSTART:20260710T130000Z',
      'DTEND:20260710T140000Z',
      'SUMMARY:Staff development day',
      'DESCRIPTION:Early release\\, 12:30 pickup.\\nBring a lunch\\; no hot meals.',
      'END:VEVENT',
    );
    const [occ] = parseAndExpand(ics, OPTS);
    expect(occ!.description).toBe('Early release, 12:30 pickup.\nBring a lunch; no hot meals.');
  });

  it('is null when the event has none, or only blanks', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:none-1',
      'DTSTART:20260710T130000Z',
      'SUMMARY:No body',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:blank-1',
      'DTSTART:20260711T130000Z',
      'SUMMARY:Blank body',
      'DESCRIPTION:   ',
      'END:VEVENT',
    );
    const occ = parseAndExpand(ics, OPTS);
    expect(occ).toHaveLength(2);
    expect(occ.map((o) => o.description)).toEqual([null, null]);
  });

  it('rides every expansion of a recurring master', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:series-1',
      'DTSTART:20260706T090000Z',
      'DTEND:20260706T100000Z',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Practice',
      'DESCRIPTION:Bring cleats',
      'END:VEVENT',
    );
    const occ = parseAndExpand(ics, OPTS);
    expect(occ).toHaveLength(3);
    expect(occ.map((o) => o.description)).toEqual([
      'Bring cleats',
      'Bring cleats',
      'Bring cleats',
    ]);
  });

  it('takes a RECURRENCE-ID override’s own description for its slot, the master’s for the rest', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:series-1',
      'DTSTART:20260706T090000Z',
      'DTEND:20260706T100000Z',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Practice',
      'DESCRIPTION:Bring cleats',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series-1',
      'RECURRENCE-ID:20260707T090000Z',
      'DTSTART:20260707T110000Z',
      'DTEND:20260707T120000Z',
      'SUMMARY:Practice (late)',
      'DESCRIPTION:Early release - indoors today',
      'END:VEVENT',
    );
    const occ = parseAndExpand(ics, OPTS);
    expect(occ).toHaveLength(3);
    const byDay = new Map(occ.map((o) => [o.start.toISOString().slice(0, 10), o.description]));
    expect(byDay.get('2026-07-06')).toBe('Bring cleats');
    expect(byDay.get('2026-07-07')).toBe('Early release - indoors today');
    expect(byDay.get('2026-07-08')).toBe('Bring cleats');
  });

  it('is read off an override whose master is not in the document', () => {
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:series-1',
      'RECURRENCE-ID:20260707T090000Z',
      'DTSTART:20260707T110000Z',
      'DTEND:20260707T120000Z',
      'SUMMARY:Practice (late)',
      'DESCRIPTION:Early release',
      'END:VEVENT',
    );
    const [occ] = parseAndExpand(ics, OPTS);
    expect(occ!.recurrenceId).not.toBeNull();
    expect(occ!.description).toBe('Early release');
  });

  it(`is cut to ${MAX_DESCRIPTION_CHARS} characters`, () => {
    const long = `${'a'.repeat(MAX_DESCRIPTION_CHARS)}TAIL`;
    const ics = wrap(
      'BEGIN:VEVENT',
      'UID:long-1',
      'DTSTART:20260710T130000Z',
      'SUMMARY:Newsletter',
      `DESCRIPTION:${long}`,
      'END:VEVENT',
    );
    const [occ] = parseAndExpand(ics, OPTS);
    expect(occ!.description).toHaveLength(MAX_DESCRIPTION_CHARS);
    expect(occ!.description).toBe('a'.repeat(MAX_DESCRIPTION_CHARS));
  });
});

describe('normalizeDescription', () => {
  it('keeps text at the limit and cuts past it', () => {
    expect(normalizeDescription('x'.repeat(MAX_DESCRIPTION_CHARS))).toHaveLength(
      MAX_DESCRIPTION_CHARS,
    );
    expect(normalizeDescription('x'.repeat(MAX_DESCRIPTION_CHARS + 50))).toHaveLength(
      MAX_DESCRIPTION_CHARS,
    );
  });

  it('treats anything that is not text, or is blank, as none', () => {
    expect(normalizeDescription(undefined)).toBeNull();
    expect(normalizeDescription(null)).toBeNull();
    expect(normalizeDescription('')).toBeNull();
    expect(normalizeDescription(' \n ')).toBeNull();
    expect(normalizeDescription(42)).toBeNull();
  });
});

describe('Google description', () => {
  const read = async (items: unknown[]) => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items }),
    })) as unknown as typeof fetch;
    const { occurrences } = await fetchGoogleOccurrences('token', 'primary', OPTS, fetchImpl);
    return occurrences;
  };
  const event = (extra: Record<string, unknown>) => ({
    iCalUID: 'g@g',
    status: 'confirmed',
    summary: 'Concert',
    start: { dateTime: '2026-07-10T18:00:00Z' },
    end: { dateTime: '2026-07-10T19:00:00Z' },
    ...extra,
  });

  it('is mapped from events.list', async () => {
    const [occ] = await read([event({ description: 'Early release at noon' })]);
    expect(occ!.description).toBe('Early release at noon');
  });

  it('is null when Google sends none, and cut to the limit when it sends a lot', async () => {
    const [none] = await read([event({})]);
    expect(none!.description).toBeNull();
    const [long] = await read([event({ description: 'b'.repeat(MAX_DESCRIPTION_CHARS * 2) })]);
    expect(long!.description).toHaveLength(MAX_DESCRIPTION_CHARS);
  });
});

describe('content hash', () => {
  it('changes when only the description does', () => {
    const base = parseAndExpand(
      wrap(
        'BEGIN:VEVENT',
        'UID:h-1',
        'DTSTART:20260710T130000Z',
        'DTEND:20260710T140000Z',
        'SUMMARY:Concert',
        'DESCRIPTION:Doors at 6',
        'END:VEVENT',
      ),
      OPTS,
    )[0]!;
    const edited = { ...base, description: 'Early release - doors at 5' };
    expect(hashOccurrence(edited)).not.toBe(hashOccurrence(base));
    expect(hashOccurrence({ ...base })).toBe(hashOccurrence(base));
    // Gaining a description counts too, not just editing one.
    expect(hashOccurrence({ ...base, description: null })).not.toBe(hashOccurrence(base));
  });
});
