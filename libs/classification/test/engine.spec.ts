import { describe, expect, it } from 'vitest';
import {
  coveredUtcDays,
  firstMatch,
  generateTaskIntents,
  ruleMatches,
  synthesizeException,
  synthesizeStandard,
  wallTimeToUtc,
  type OverrideRuleLike,
  type SourceOccurrence,
} from '../src/index.js';

// --- Helpers ---------------------------------------------------------------

let ruleSeq = 0;
function rule(partial: Partial<OverrideRuleLike>): OverrideRuleLike {
  return {
    id: partial.id ?? `rule-${ruleSeq++}`,
    position: partial.position ?? 0,
    matchField: partial.matchField ?? 'summary',
    matchOp: partial.matchOp ?? 'contains',
    matchValue: partial.matchValue ?? null,
    outcome: partial.outcome ?? 'annotate',
    params: partial.params ?? null,
    generatesTypes: partial.generatesTypes ?? null,
    defaultAttendance: partial.defaultAttendance ?? null,
  };
}

let occSeq = 0;
function occ(partial: Partial<SourceOccurrence>): SourceOccurrence {
  return {
    id: partial.id ?? `occ-${occSeq++}`,
    contentHash: partial.contentHash ?? 'hash',
    summary: partial.summary ?? null,
    location: partial.location ?? null,
    description: partial.description ?? null,
    allDay: partial.allDay ?? false,
    dtstart: partial.dtstart ?? new Date('2026-07-06T10:00:00Z'),
    dtend: partial.dtend ?? null,
  };
}

// Rules modeled on the real Children's House PDX feed (exception mode).
const noSchool = rule({
  position: 0,
  matchOp: 'regex',
  matchValue: '/no school|closed/i',
  outcome: 'cancel_day',
});
const earlyRelease = rule({
  position: 1,
  matchValue: 'Early Dismissal',
  outcome: 'modify_day',
  params: { dayEnd: '12:00' },
});
const photoDay = rule({
  position: 2,
  matchValue: 'Photos',
  outcome: 'annotate',
  params: { text: 'Photo Day' },
});

const schoolLink = {
  id: 'link-1',
  weekdayMask: 0b0011111, // Mon–Fri
  dayStart: '08:30',
  dayEnd: '14:45',
  durationMinutes: null,
  location: 'Lincoln Elementary',
  generatesTypes: ['dropoff', 'pickup'] as ('dropoff' | 'pickup')[],
  defaultAttendance: null,
  baselineSummary: 'School day',
};

// Mon Jul 6 2026 – Fri Jul 10 2026 (UTC).
const week = {
  start: new Date('2026-07-06T00:00:00Z'),
  end: new Date('2026-07-11T00:00:00Z'),
};

// --- Matchers ----------------------------------------------------------------

describe('ruleMatches', () => {
  it('contains is case-insensitive', () => {
    expect(ruleMatches(occ({ summary: 'MCH CLOSED - Holiday' }), rule({ matchValue: 'Closed' }))).toBe(true);
    expect(ruleMatches(occ({ summary: 'Back to School Night' }), rule({ matchValue: 'Closed' }))).toBe(false);
  });

  it('starts_with is case-insensitive and anchored', () => {
    const r = rule({ matchOp: 'starts_with', matchValue: 'early' });
    expect(ruleMatches(occ({ summary: 'Early Release' }), r)).toBe(true);
    expect(ruleMatches(occ({ summary: 'School Early Release' }), r)).toBe(false);
  });

  it('regex supports /pattern/flags and bare (flagless) forms; never throws', () => {
    const noSchoolDay = occ({ summary: 'No School - Teacher Day' });
    // Bare pattern = no flags = case-sensitive.
    expect(ruleMatches(noSchoolDay, rule({ matchOp: 'regex', matchValue: 'no school|closed' }))).toBe(false);
    expect(ruleMatches(noSchoolDay, rule({ matchOp: 'regex', matchValue: '[nN]o [sS]chool' }))).toBe(true);
    // Slash form carries flags (the form the rule editor documents).
    expect(ruleMatches(noSchoolDay, rule({ matchOp: 'regex', matchValue: '/no school|closed/i' }))).toBe(true);
    expect(ruleMatches(occ({ summary: 'x' }), rule({ matchOp: 'regex', matchValue: '(' }))).toBe(false);
  });

  it('any_text sweeps summary + location + description', () => {
    const r = rule({ matchField: 'any_text', matchValue: 'gym' });
    expect(ruleMatches(occ({ summary: 'Assembly', location: 'Main Gym' }), r)).toBe(true);
    expect(ruleMatches(occ({ summary: 'Assembly', description: 'meet in the gym' }), r)).toBe(true);
    expect(ruleMatches(occ({ summary: 'Assembly' }), r)).toBe(false);
  });

  it('all_day matches on the flag', () => {
    expect(ruleMatches(occ({ allDay: true }), rule({ matchField: 'all_day', matchOp: 'is_true' }))).toBe(true);
    expect(ruleMatches(occ({ allDay: false }), rule({ matchField: 'all_day', matchOp: 'is_true' }))).toBe(false);
    expect(ruleMatches(occ({ allDay: false }), rule({ matchField: 'all_day', matchOp: 'is_false' }))).toBe(true);
  });

  it('duration compares minutes (missing dtend = 0)', () => {
    const twoHours = occ({
      dtstart: new Date('2026-07-06T10:00:00Z'),
      dtend: new Date('2026-07-06T12:00:00Z'),
    });
    expect(ruleMatches(twoHours, rule({ matchField: 'duration', matchOp: 'gte', matchValue: '90' }))).toBe(true);
    expect(ruleMatches(twoHours, rule({ matchField: 'duration', matchOp: 'lte', matchValue: '90' }))).toBe(false);
    expect(ruleMatches(occ({}), rule({ matchField: 'duration', matchOp: 'lte', matchValue: '30' }))).toBe(true);
  });
});

describe('firstMatch', () => {
  it('picks the lowest position, not array order', () => {
    const later = rule({ position: 5, matchValue: 'School', id: 'later' });
    const earlier = rule({ position: 1, matchValue: 'School', id: 'earlier' });
    expect(firstMatch(occ({ summary: 'No School' }), [later, earlier])?.id).toBe('earlier');
  });

  it('returns null when nothing matches', () => {
    expect(firstMatch(occ({ summary: 'Book Fair' }), [noSchool, earlyRelease])).toBeNull();
  });
});

// --- Stage A: standard feeds ---------------------------------------------------

describe('synthesizeStandard', () => {
  it('passes unmatched occurrences through untouched with null generatesTypes', () => {
    const soccer = occ({ summary: 'Soccer practice', location: 'Field 3' });
    const { events, pending } = synthesizeStandard(schoolLink, [soccer], [], 'UTC');
    expect(pending).toEqual([]); // standard feeds never pend
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      synthKey: `ev:link-1:${soccer.id}`,
      sourceEventId: soccer.id,
      matchedRuleId: null,
      summary: 'Soccer practice',
      generatesTypes: null,
    });
  });

  it('a matched rule stamps generatesTypes and the rule id', () => {
    const r = rule({ matchValue: 'Soccer', outcome: 'set_event', generatesTypes: ['pickup', 'dropoff'] });
    const { events } = synthesizeStandard(schoolLink, [occ({ summary: 'Soccer practice' })], [r], 'UTC');
    expect(events[0]?.generatesTypes).toEqual(['pickup', 'dropoff']);
    expect(events[0]?.matchedRuleId).toBe(r.id);
  });

  it('set_event can suppress, retime, and relabel', () => {
    const suppress = rule({ position: 0, matchValue: 'Lunch menu', outcome: 'set_event', params: { suppress: true } });
    const retime = rule({
      position: 1,
      matchValue: 'Practice',
      outcome: 'set_event',
      params: { summary: 'Soccer', startTime: '16:00', durationMinutes: 60 },
    });
    const { events } = synthesizeStandard(
      schoolLink,
      [
        occ({ summary: 'Lunch menu: pizza' }),
        occ({ summary: 'Practice', dtstart: new Date('2026-07-06T00:00:00Z'), allDay: true }),
      ],
      [suppress, retime],
      'UTC',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ summary: 'Soccer', allDay: false });
    expect(events[0]?.dtstart.toISOString()).toBe('2026-07-06T16:00:00.000Z');
    expect(events[0]?.dtend?.toISOString()).toBe('2026-07-06T17:00:00.000Z');
  });

  it('annotate keeps the event and stamps the note', () => {
    const { events } = synthesizeStandard(
      schoolLink,
      [occ({ summary: 'School Photos' })],
      [photoDay],
      'UTC',
    );
    expect(events[0]?.annotation).toBe('Photo Day');
    expect(events[0]?.summary).toBe('School Photos');
  });

  it('ignores baseline-only outcomes (cancel_day / modify_day)', () => {
    const { events } = synthesizeStandard(
      schoolLink,
      [occ({ summary: 'MCH Closed' })],
      [rule({ matchValue: 'Closed', outcome: 'cancel_day' })],
      'UTC',
    );
    expect(events).toHaveLength(1); // passed through, not cancelled
    expect(events[0]?.matchedRuleId).toBeNull();
  });
});

// --- Stage A: exception feeds ---------------------------------------------------

describe('synthesizeException', () => {
  it('expands the baseline over masked weekdays with tz-anchored times', () => {
    const { events, pending } = synthesizeException(schoolLink, [], [noSchool], week, 'America/Los_Angeles');
    expect(pending).toEqual([]);
    expect(events).toHaveLength(5); // Mon–Fri
    expect(events[0]).toMatchObject({ synthKey: 'bl:link-1:2026-07-06', summary: 'School day', generatesTypes: ['dropoff', 'pickup'] });
    // 08:30 PDT = 15:30 UTC.
    expect(events[0]?.dtstart.toISOString()).toBe('2026-07-06T15:30:00.000Z');
    expect(events[0]?.dtend?.toISOString()).toBe('2026-07-06T21:45:00.000Z');
  });

  it('cancel_day drops the covered baseline days (multi-day span covers all)', () => {
    const closure = occ({
      summary: 'MCH Closed - Break',
      allDay: true,
      dtstart: new Date('2026-07-07T00:00:00Z'),
      dtend: new Date('2026-07-09T00:00:00Z'), // exclusive ⇒ Tue+Wed
    });
    const { events } = synthesizeException(schoolLink, [closure], [noSchool, earlyRelease], week, 'UTC');
    const keys = events.map((e) => e.synthKey);
    expect(keys).toEqual(['bl:link-1:2026-07-06', 'bl:link-1:2026-07-09', 'bl:link-1:2026-07-10']);
  });

  it('modify_day patches the day end (early release)', () => {
    const early = occ({
      summary: 'Early Dismissal - Conferences',
      allDay: true,
      dtstart: new Date('2026-07-08T00:00:00Z'),
      dtend: new Date('2026-07-09T00:00:00Z'),
    });
    const { events } = synthesizeException(schoolLink, [early], [noSchool, earlyRelease], week, 'UTC');
    const wed = events.find((e) => e.synthKey === 'bl:link-1:2026-07-08');
    expect(wed?.dtend?.toISOString()).toBe('2026-07-08T12:00:00.000Z');
    expect(wed?.matchedRuleId).toBe(earlyRelease.id);
    // Other days untouched.
    const thu = events.find((e) => e.synthKey === 'bl:link-1:2026-07-09');
    expect(thu?.dtend?.toISOString()).toBe('2026-07-09T14:45:00.000Z');
  });

  it('annotate keeps the day and stamps the note', () => {
    const photos = occ({
      summary: 'School Photos',
      allDay: true,
      dtstart: new Date('2026-07-07T00:00:00Z'),
      dtend: new Date('2026-07-08T00:00:00Z'),
    });
    const { events } = synthesizeException(schoolLink, [photos], [noSchool, earlyRelease, photoDay], week, 'UTC');
    const tue = events.find((e) => e.synthKey === 'bl:link-1:2026-07-07');
    expect(tue?.annotation).toBe('Photo Day');
    expect(tue?.generatesTypes).toEqual(['dropoff', 'pickup']);
  });

  it('the lowest-position ruling wins when a day has several matches', () => {
    const closed = occ({ summary: 'Closed for staff day', allDay: true, dtstart: new Date('2026-07-08T00:00:00Z'), dtend: new Date('2026-07-09T00:00:00Z') });
    const early = occ({ summary: 'Early Dismissal', allDay: true, dtstart: new Date('2026-07-08T00:00:00Z'), dtend: new Date('2026-07-09T00:00:00Z') });
    const { events } = synthesizeException(schoolLink, [early, closed], [noSchool, earlyRelease], week, 'UTC');
    expect(events.some((e) => e.synthKey === 'bl:link-1:2026-07-08')).toBe(false); // cancel (position 0) beat modify (position 1)
  });

  it('unmatched occurrences become pending decisions and leave the baseline standing', () => {
    const bookFair = occ({ summary: 'Book Fair', contentHash: 'bf-1', dtstart: new Date('2026-07-07T17:00:00Z') });
    const { events, pending } = synthesizeException(schoolLink, [bookFair], [noSchool, earlyRelease], week, 'UTC');
    expect(pending).toEqual([{ sourceEventId: bookFair.id, contentHash: 'bf-1' }]);
    expect(events.some((e) => e.synthKey === 'bl:link-1:2026-07-07')).toBe(true);
  });

  it('set_event synthesizes an extra event without touching the baseline', () => {
    const concert = occ({ summary: 'Winter Concert', dtstart: new Date('2026-07-09T18:00:00Z'), dtend: new Date('2026-07-09T19:00:00Z') });
    const concertRule = rule({ position: 3, matchValue: 'Concert', outcome: 'set_event', generatesTypes: ['attendance'] });
    const { events, pending } = synthesizeException(schoolLink, [concert], [noSchool, concertRule], week, 'UTC');
    expect(pending).toEqual([]);
    expect(events.filter((e) => e.synthKey.startsWith('bl:'))).toHaveLength(5);
    const extra = events.find((e) => e.synthKey === `ev:link-1:${concert.id}`);
    expect(extra).toMatchObject({ summary: 'Winter Concert', generatesTypes: ['attendance'] });
  });

  it('no baseline (null weekdayMask) still routes occurrences to rules/pending', () => {
    const link = { ...schoolLink, weekdayMask: null };
    const mystery = occ({ summary: 'Mystery event' });
    const { events, pending } = synthesizeException(link, [mystery], [noSchool], week, 'UTC');
    expect(events).toEqual([]);
    expect(pending).toHaveLength(1);
  });
});

// --- tz / day helpers -----------------------------------------------------------

describe('day coverage + wall-clock conversion', () => {
  it('all-day dtend is exclusive; timed spans cover through their end day', () => {
    expect(
      coveredUtcDays({ dtstart: new Date('2026-07-06T00:00:00Z'), dtend: new Date('2026-07-08T00:00:00Z'), allDay: true }),
    ).toHaveLength(2);
    expect(
      coveredUtcDays({ dtstart: new Date('2026-07-06T22:00:00Z'), dtend: new Date('2026-07-07T02:00:00Z'), allDay: false }),
    ).toHaveLength(2);
    expect(coveredUtcDays({ dtstart: new Date('2026-07-06T10:00:00Z'), dtend: null, allDay: false })).toHaveLength(1);
  });

  it('wallTimeToUtc anchors via Intl (host-independent)', () => {
    const day = new Date('2026-01-05T00:00:00Z'); // PST (UTC-8)
    expect(wallTimeToUtc(day, '08:30', 8, 'America/Los_Angeles').toISOString()).toBe('2026-01-05T16:30:00.000Z');
    expect(wallTimeToUtc(day, null, 9, 'UTC').toISOString()).toBe('2026-01-05T09:00:00.000Z');
  });
});

// --- Stage B: task generation -----------------------------------------------------

describe('generateTaskIntents', () => {
  const span = {
    dtstart: new Date('2026-07-06T15:30:00Z'),
    dtend: new Date('2026-07-06T21:45:00Z'),
    location: 'Lincoln Elementary',
  };

  it('claimed_task events generate nothing (the recursion guard)', () => {
    expect(generateTaskIntents({ provenance: 'claimed_task', generatesTypes: ['attendance'], ...span })).toEqual([]);
  });

  it('human events default to one convertible any-caretaker attendance', () => {
    const intents = generateTaskIntents({ provenance: 'human', ...span });
    expect(intents).toEqual([
      { type: 'attendance', attendanceRequirement: 'any', dtstart: span.dtstart, dtend: span.dtend, location: span.location },
    ]);
  });

  it('synthesized without generatesTypes gets the same convertible default', () => {
    const intents = generateTaskIntents({ provenance: 'synthesized', generatesTypes: null, ...span });
    expect(intents).toHaveLength(1);
    expect(intents[0]?.type).toBe('attendance');
  });

  it('an empty generatesTypes is an explicit "nothing"', () => {
    expect(generateTaskIntents({ provenance: 'synthesized', generatesTypes: [], ...span })).toEqual([]);
  });

  it('dropoff anchors to dtstart, pickup to dtend, attendance spans', () => {
    const intents = generateTaskIntents({
      provenance: 'synthesized',
      generatesTypes: ['dropoff', 'pickup', 'attendance'],
      defaultAttendance: 'both',
      ...span,
    });
    expect(intents).toHaveLength(3);
    const [dropoff, pickup, attendance] = intents;
    expect(dropoff).toMatchObject({ type: 'dropoff', dtstart: span.dtstart, dtend: null });
    expect(pickup).toMatchObject({ type: 'pickup', dtstart: span.dtend, dtend: null });
    expect(attendance).toMatchObject({ type: 'attendance', dtstart: span.dtstart, dtend: span.dtend, attendanceRequirement: 'both' });
  });

  it('pickup falls back to dtstart when the event has no end', () => {
    const intents = generateTaskIntents({
      provenance: 'synthesized',
      generatesTypes: ['pickup'],
      dtstart: span.dtstart,
      dtend: null,
    });
    expect(intents[0]?.dtstart).toEqual(span.dtstart);
  });
});
