import { describe, expect, it } from 'vitest';
import {
  coveredUtcDays,
  firstMatch,
  generateTaskIntents,
  resolveTaskResult,
  ruleMatches,
  synthesizeException,
  synthesizeStandard,
  taskRulesForCalendar,
  wallTimeToUtc,
  type OverrideRuleLike,
  type SourceOccurrence,
  type TaskRuleLike,
} from '../src/index.js';

// --- Helpers ---------------------------------------------------------------

let overrideSeq = 0;
function override(partial: Partial<OverrideRuleLike>): OverrideRuleLike {
  return {
    id: partial.id ?? `ov-${overrideSeq++}`,
    position: partial.position ?? 0,
    matchField: partial.matchField ?? 'summary',
    matchOp: partial.matchOp ?? 'contains',
    matchValue: partial.matchValue ?? null,
    outcome: partial.outcome ?? 'cancel_day',
    params: partial.params ?? null,
  };
}

let taskSeq = 0;
function taskRule(partial: Partial<TaskRuleLike>): TaskRuleLike {
  return {
    id: partial.id ?? `tr-${taskSeq++}`,
    position: partial.position ?? 0,
    scope: partial.scope ?? 'this_calendar',
    linkId: partial.linkId ?? null,
    matchField: partial.matchField ?? 'summary',
    matchOp: partial.matchOp ?? 'regex',
    matchValue: partial.matchValue ?? null,
    resultType: partial.resultType ?? 'transition',
    dropoffWindowMin: partial.dropoffWindowMin ?? null,
    pickupWindowMin: partial.pickupWindowMin ?? null,
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

const noSchool = override({
  position: 0,
  matchOp: 'regex',
  matchValue: '/no school|closed/i',
  outcome: 'cancel_day',
});
const earlyRelease = override({
  position: 1,
  matchValue: 'Early Dismissal',
  outcome: 'modify_day',
  params: { dayEnd: '12:00' },
});

const schoolLink = {
  id: 'link-1',
  weekdayMask: 0b0011111, // Mon–Fri
  dayStart: '08:30',
  dayEnd: '14:45',
  location: 'Lincoln Elementary',
  baselineSummary: 'School day',
};

// Mon Jul 6 2026 – Fri Jul 10 2026 (UTC).
const week = {
  start: new Date('2026-07-06T00:00:00Z'),
  end: new Date('2026-07-11T00:00:00Z'),
};

// --- Matchers --------------------------------------------------------------

describe('ruleMatches', () => {
  it('contains is case-insensitive', () => {
    expect(ruleMatches(occ({ summary: 'MCH CLOSED - Holiday' }), override({ matchValue: 'Closed' }))).toBe(true);
    expect(ruleMatches(occ({ summary: 'Back to School Night' }), override({ matchValue: 'Closed' }))).toBe(false);
  });

  it('regex supports /pattern/flags and bare forms; never throws', () => {
    const noSchoolDay = occ({ summary: 'No School - Teacher Day' });
    expect(ruleMatches(noSchoolDay, override({ matchOp: 'regex', matchValue: 'no school|closed' }))).toBe(false);
    expect(ruleMatches(noSchoolDay, override({ matchOp: 'regex', matchValue: '/no school|closed/i' }))).toBe(true);
    expect(ruleMatches(occ({ summary: 'x' }), override({ matchOp: 'regex', matchValue: '(' }))).toBe(false);
  });

  it('all_day + duration matchers', () => {
    expect(ruleMatches(occ({ allDay: true }), override({ matchField: 'all_day', matchOp: 'is_true' }))).toBe(true);
    const twoHours = occ({
      dtstart: new Date('2026-07-06T10:00:00Z'),
      dtend: new Date('2026-07-06T12:00:00Z'),
    });
    expect(ruleMatches(twoHours, override({ matchField: 'duration', matchOp: 'gte', matchValue: '90' }))).toBe(true);
  });
});

describe('firstMatch', () => {
  it('picks the lowest position, not array order', () => {
    const later = override({ position: 5, matchValue: 'School', id: 'later' });
    const earlier = override({ position: 1, matchValue: 'School', id: 'earlier' });
    expect(firstMatch(occ({ summary: 'No School' }), [later, earlier])?.id).toBe('earlier');
  });
});

// --- Stage A: standard feeds ------------------------------------------------

describe('synthesizeStandard', () => {
  it('passes every occurrence through untouched, never pends', () => {
    const soccer = occ({ summary: 'Soccer practice', location: 'Field 3' });
    const { events, pending } = synthesizeStandard(schoolLink, [soccer]);
    expect(pending).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      synthKey: `ev:link-1:${soccer.id}`,
      sourceEventId: soccer.id,
      summary: 'Soccer practice',
      location: 'Field 3',
    });
  });
});

// --- Stage A: exception feeds -----------------------------------------------

describe('synthesizeException', () => {
  it('expands the baseline over masked weekdays with tz-anchored times', () => {
    const { events, pending } = synthesizeException(schoolLink, [], [noSchool], week, 'America/Los_Angeles');
    expect(pending).toEqual([]);
    expect(events).toHaveLength(5); // Mon–Fri
    expect(events[0]).toMatchObject({ synthKey: 'bl:link-1:2026-07-06', summary: 'School day' });
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
    expect(events.map((e) => e.synthKey)).toEqual([
      'bl:link-1:2026-07-06',
      'bl:link-1:2026-07-09',
      'bl:link-1:2026-07-10',
    ]);
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
    // Untouched days keep the baseline end.
    const thu = events.find((e) => e.synthKey === 'bl:link-1:2026-07-09');
    expect(thu?.dtend?.toISOString()).toBe('2026-07-09T14:45:00.000Z');
  });

  it('ignore keeps the baseline; the lowest-position ruling wins', () => {
    const ignoreRule = override({ position: 0, matchValue: 'Spirit Day', outcome: 'ignore' });
    const spirit = occ({ summary: 'Spirit Day', allDay: true, dtstart: new Date('2026-07-07T00:00:00Z'), dtend: new Date('2026-07-08T00:00:00Z') });
    const { events, pending } = synthesizeException(schoolLink, [spirit], [ignoreRule, noSchool], week, 'UTC');
    expect(pending).toEqual([]);
    // Tuesday's baseline stands (ignore), full hours.
    const tue = events.find((e) => e.synthKey === 'bl:link-1:2026-07-07');
    expect(tue?.dtend?.toISOString()).toBe('2026-07-07T14:45:00.000Z');
  });

  it('unmatched occurrences become pending decisions; the baseline still stands', () => {
    const bookFair = occ({ summary: 'Book Fair', contentHash: 'bf-1', dtstart: new Date('2026-07-07T17:00:00Z') });
    const { events, pending } = synthesizeException(schoolLink, [bookFair], [noSchool], week, 'UTC');
    expect(pending).toEqual([{ sourceEventId: bookFair.id, contentHash: 'bf-1' }]);
    expect(events.some((e) => e.synthKey === 'bl:link-1:2026-07-07')).toBe(true);
  });
});

describe('day coverage + wall-clock conversion', () => {
  it('all-day dtend is exclusive; wall times anchor via Intl', () => {
    expect(
      coveredUtcDays({ dtstart: new Date('2026-07-06T00:00:00Z'), dtend: new Date('2026-07-08T00:00:00Z'), allDay: true }),
    ).toHaveLength(2);
    const day = new Date('2026-01-05T00:00:00Z'); // PST (UTC-8)
    expect(wallTimeToUtc(day, '08:30', 8, 'America/Los_Angeles').toISOString()).toBe('2026-01-05T16:30:00.000Z');
  });
});

// --- Stage B: task rules + generation ---------------------------------------

describe('taskRulesForCalendar + resolveTaskResult', () => {
  const fieldTrip = taskRule({ id: 'ft', position: 0, scope: 'this_calendar', linkId: 'link-1', matchValue: '/field trip/i', resultType: 'attendance' });
  const earlyEverywhere = taskRule({ id: 'ee', position: 1, scope: 'all_calendars', matchValue: '/early (pickup|dismissal)/i', resultType: 'transition', dropoffWindowMin: 20, pickupWindowMin: 10 });
  const otherCalOnly = taskRule({ id: 'oc', position: 2, scope: 'this_calendar', linkId: 'link-9', matchValue: '/xyz/', resultType: 'attendance' });
  const rules = [fieldTrip, earlyEverywhere, otherCalOnly];

  const dfault = { resultType: 'transition' as const, dropoffWindowMin: 15, pickupWindowMin: 15 };

  it('a calendar sees its own this-calendar rules + all inherited all-calendars ones, in position order', () => {
    const forLink1 = taskRulesForCalendar(rules, 'link-1').map((r) => r.id);
    expect(forLink1).toEqual(['ft', 'ee']); // link-9's rule excluded
    const forUnified = taskRulesForCalendar(rules, null).map((r) => r.id);
    expect(forUnified).toEqual(['ee']); // only the all-calendars rule inherits
  });

  it('resolves the first matching rule, else the calendar default', () => {
    const trip = resolveTaskResult(occ({ summary: 'Class field trip' }), rules, 'link-1', dfault);
    expect(trip.resultType).toBe('attendance');

    const early = resolveTaskResult(occ({ summary: 'Early pickup today' }), rules, 'link-1', dfault);
    expect(early).toEqual({ resultType: 'transition', dropoffWindowMin: 20, pickupWindowMin: 10 });

    const normal = resolveTaskResult(occ({ summary: 'Regular day' }), rules, 'link-1', dfault);
    expect(normal).toEqual(dfault);
  });
});

describe('generateTaskIntents', () => {
  const span = {
    dtstart: new Date('2026-07-06T15:30:00Z'),
    dtend: new Date('2026-07-06T21:45:00Z'),
    location: 'Lincoln Elementary',
  };

  it('attendance → one task spanning the event', () => {
    const intents = generateTaskIntents(span, { resultType: 'attendance', dropoffWindowMin: 15, pickupWindowMin: 15 });
    expect(intents).toEqual([
      { type: 'attendance', attendanceRequirement: 'any', dtstart: span.dtstart, dtend: span.dtend, location: span.location },
    ]);
  });

  it('transition → drop-off (from start) + pickup (from end), padded by their windows', () => {
    const intents = generateTaskIntents(span, { resultType: 'transition', dropoffWindowMin: 15, pickupWindowMin: 30 });
    expect(intents).toHaveLength(2);
    const [dropoff, pickup] = intents;
    expect(dropoff).toMatchObject({ type: 'dropoff', dtstart: span.dtstart });
    expect(dropoff?.dtend?.toISOString()).toBe('2026-07-06T15:45:00.000Z'); // +15m
    expect(pickup).toMatchObject({ type: 'pickup', dtstart: span.dtend });
    expect(pickup?.dtend?.toISOString()).toBe('2026-07-06T22:15:00.000Z'); // +30m
  });

  it('a zero window leaves the task a point in time', () => {
    const intents = generateTaskIntents(
      { dtstart: span.dtstart, dtend: null },
      { resultType: 'transition', dropoffWindowMin: 0, pickupWindowMin: 0 },
    );
    expect(intents[0]?.dtend).toBeNull();
    expect(intents[1]?.dtstart).toEqual(span.dtstart); // pickup falls back to start
  });
});
