import { describe, expect, it } from 'vitest';
import {
  resolveTaskOwner,
  weekParityMatches,
  type AssignmentCandidate,
  type AssignmentRuleLike,
} from '../src/index.js';

// 2026-07-06 is a Monday; 2026-07-07 a Tuesday; 2026-07-13 the next Monday.
const MON = new Date('2026-07-06T15:30:00Z');
const TUE = new Date('2026-07-07T15:30:00Z');
const NEXT_MON = new Date('2026-07-13T15:30:00Z');

function rule(partial: Partial<AssignmentRuleLike>): AssignmentRuleLike {
  return {
    id: 'r1',
    position: 0,
    ownerMemberId: 'parentA',
    aboutMemberId: null,
    linkId: null,
    taskType: null,
    weekdayMask: 0,
    cadenceWeeks: 1,
    anchorDate: null,
    ...partial,
  };
}

function cand(partial: Partial<AssignmentCandidate>): AssignmentCandidate {
  return { aboutMemberId: 'childB', linkId: null, type: 'pickup', dtstart: MON, ...partial };
}

describe('resolveTaskOwner', () => {
  it('matches an unfiltered rule and returns its owner', () => {
    expect(resolveTaskOwner(cand({}), [rule({})])?.ownerMemberId).toBe('parentA');
  });

  it('filters by weekday mask', () => {
    const monRule = rule({ weekdayMask: 1 }); // Monday
    expect(resolveTaskOwner(cand({ dtstart: MON }), [monRule])).not.toBeNull();
    expect(resolveTaskOwner(cand({ dtstart: TUE }), [monRule])).toBeNull();
  });

  it('filters by about-member, feed link and task type', () => {
    expect(resolveTaskOwner(cand({ aboutMemberId: 'childC' }), [rule({ aboutMemberId: 'childB' })])).toBeNull();
    expect(resolveTaskOwner(cand({ linkId: null }), [rule({ linkId: 'feed1' })])).toBeNull();
    expect(resolveTaskOwner(cand({ type: 'dropoff' }), [rule({ taskType: 'pickup' })])).toBeNull();
    expect(resolveTaskOwner(cand({ type: 'pickup' }), [rule({ taskType: 'pickup' })])).not.toBeNull();
  });

  it('first matching rule (by position) wins', () => {
    const a = rule({ id: 'a', position: 1, ownerMemberId: 'parentA' });
    const b = rule({ id: 'b', position: 0, ownerMemberId: 'parentB' });
    expect(resolveTaskOwner(cand({}), [a, b])?.ownerMemberId).toBe('parentB');
  });

  it('honours every-other-week cadence anchored to a week', () => {
    // Anchor in the Monday-of week of MON: MON matches (week 0), NEXT_MON is off.
    const biweekly = rule({ weekdayMask: 1, cadenceWeeks: 2, anchorDate: MON });
    expect(resolveTaskOwner(cand({ dtstart: MON }), [biweekly])).not.toBeNull();
    expect(resolveTaskOwner(cand({ dtstart: NEXT_MON }), [biweekly])).toBeNull();
  });
});

// A rule's weekday is the day the family lives the event on — the local date of
// its start in its own zone — not the UTC date of the instant. Bit 0 = Monday.
describe('resolveTaskOwner — local days', () => {
  const PT = 'America/Los_Angeles';
  const SYDNEY = 'Australia/Sydney';
  const MON_BIT = 1;
  const TUE_BIT = 2;
  const SUN_BIT = 64;
  const matches = (c: Partial<AssignmentCandidate>, r: Partial<AssignmentRuleLike>) =>
    resolveTaskOwner(cand(c), [rule(r)]) !== null;

  // Mon 2026-07-06 19:00 PDT = Tue 2026-07-07 02:00Z.
  const MON_EVENING_PT = new Date('2026-07-07T02:00:00Z');
  // Tue 2026-07-07 07:00 AEST = Mon 2026-07-06 21:00Z.
  const TUE_MORNING_SYDNEY = new Date('2026-07-06T21:00:00Z');

  it('a Monday-evening Pacific event matches a Monday rule, not a Tuesday one', () => {
    expect(matches({ dtstart: MON_EVENING_PT, tz: PT }, { weekdayMask: MON_BIT })).toBe(true);
    expect(matches({ dtstart: MON_EVENING_PT, tz: PT }, { weekdayMask: TUE_BIT })).toBe(false);
  });

  it('without a zone the day is read in UTC', () => {
    expect(matches({ dtstart: MON_EVENING_PT }, { weekdayMask: MON_BIT })).toBe(false);
    expect(matches({ dtstart: MON_EVENING_PT }, { weekdayMask: TUE_BIT })).toBe(true);
    expect(matches({ dtstart: MON_EVENING_PT, tz: 'UTC' }, { weekdayMask: TUE_BIT })).toBe(true);
  });

  it('a Tuesday-morning Sydney event matches a Tuesday rule, not a Monday one', () => {
    expect(matches({ dtstart: TUE_MORNING_SYDNEY, tz: SYDNEY }, { weekdayMask: TUE_BIT })).toBe(true);
    expect(matches({ dtstart: TUE_MORNING_SYDNEY, tz: SYDNEY }, { weekdayMask: MON_BIT })).toBe(false);
  });

  it('a multi-day mask still matches any of its days', () => {
    expect(matches({ dtstart: MON_EVENING_PT, tz: PT }, { weekdayMask: MON_BIT | SUN_BIT })).toBe(true);
    expect(matches({ dtstart: MON_EVENING_PT, tz: PT }, { weekdayMask: TUE_BIT | SUN_BIT })).toBe(false);
  });

  it('a DST-transition Sunday flips to Monday exactly at local midnight', () => {
    // US spring-forward Sun 2026-03-08 (a 23-hour day: 08:00Z → 07:00Z next day).
    const sundayStart = new Date('2026-03-08T08:00:00Z'); // 00:00 PST
    const sundayLast = new Date('2026-03-09T06:59:00Z'); // 23:59 PDT
    const mondayStart = new Date('2026-03-09T07:00:00Z'); // 00:00 PDT
    const saturdayLast = new Date('2026-03-08T07:59:00Z'); // 23:59 PST, the day before
    for (const dtstart of [sundayStart, sundayLast]) {
      expect(matches({ dtstart, tz: PT }, { weekdayMask: SUN_BIT })).toBe(true);
      expect(matches({ dtstart, tz: PT }, { weekdayMask: MON_BIT })).toBe(false);
    }
    expect(matches({ dtstart: mondayStart, tz: PT }, { weekdayMask: MON_BIT })).toBe(true);
    expect(matches({ dtstart: mondayStart, tz: PT }, { weekdayMask: SUN_BIT })).toBe(false);
    expect(matches({ dtstart: saturdayLast, tz: PT }, { weekdayMask: 32 })).toBe(true); // Saturday
  });

  it('cadence weeks follow the local date at a week boundary (Sunday evening Pacific)', () => {
    // Biweekly from the week of Mon 2026-07-06, any day of the week.
    const biweekly = { cadenceWeeks: 2, anchorDate: MON };
    // Sun 2026-07-12 20:00 PDT = Mon 07-13 03:00Z: still the anchor's week locally
    // (on), though its UTC date is already the next, off, week.
    const sundayOn = new Date('2026-07-13T03:00:00Z');
    expect(matches({ dtstart: sundayOn, tz: PT }, biweekly)).toBe(true);
    expect(matches({ dtstart: sundayOn }, biweekly)).toBe(false);
    // Sun 2026-07-19 20:00 PDT = Mon 07-20 03:00Z: locally the off week, though
    // its UTC date is already the next on week.
    const sundayOff = new Date('2026-07-20T03:00:00Z');
    expect(matches({ dtstart: sundayOff, tz: PT }, biweekly)).toBe(false);
    expect(matches({ dtstart: sundayOff }, biweekly)).toBe(true);
    // And the weekday filter agrees with the cadence on the same instant.
    expect(matches({ dtstart: sundayOn, tz: PT }, { ...biweekly, weekdayMask: SUN_BIT })).toBe(true);
  });

  it('cadence weeks follow the local date in the east, too (Monday morning Sydney)', () => {
    // Mon 2026-07-13 07:00 AEST = Sun 07-12 21:00Z: the off week locally, though
    // its UTC date is still the anchor's (on) week.
    const mondayMorning = new Date('2026-07-12T21:00:00Z');
    const biweekly = { cadenceWeeks: 2, anchorDate: MON };
    expect(matches({ dtstart: mondayMorning, tz: SYDNEY }, biweekly)).toBe(false);
    expect(matches({ dtstart: mondayMorning }, biweekly)).toBe(true);
  });

  it('an all-day event is a date already: its zone never shifts it', () => {
    const mondayAllDay = new Date('2026-07-06T00:00:00Z'); // the date Mon 2026-07-06
    for (const tz of [undefined, 'UTC', PT, SYDNEY]) {
      const c = { dtstart: mondayAllDay, allDay: true, tz };
      expect(matches(c, { weekdayMask: MON_BIT })).toBe(true);
      expect(matches(c, { weekdayMask: SUN_BIT })).toBe(false);
    }
    const nextMondayAllDay = new Date('2026-07-13T00:00:00Z');
    const biweekly = { weekdayMask: MON_BIT, cadenceWeeks: 2, anchorDate: MON };
    expect(matches({ dtstart: mondayAllDay, allDay: true, tz: PT }, biweekly)).toBe(true);
    expect(matches({ dtstart: nextMondayAllDay, allDay: true, tz: PT }, biweekly)).toBe(false);
  });
});

describe('weekParityMatches', () => {
  it('cadence 1 always matches', () => {
    expect(weekParityMatches(null, MON, 1)).toBe(true);
    expect(weekParityMatches(MON, NEXT_MON, 1)).toBe(true);
  });

  it('cadence 2 alternates weeks from the anchor week', () => {
    expect(weekParityMatches(MON, MON, 2)).toBe(true);
    expect(weekParityMatches(MON, TUE, 2)).toBe(true); // same week as anchor
    expect(weekParityMatches(MON, NEXT_MON, 2)).toBe(false);
    expect(weekParityMatches(MON, new Date('2026-07-20T00:00:00Z'), 2)).toBe(true); // 2 weeks on
  });

  it('is symmetric for weeks before the anchor', () => {
    const prevMon = new Date('2026-06-29T09:00:00Z');
    expect(weekParityMatches(MON, prevMon, 2)).toBe(false); // 1 week before → off
  });
});
