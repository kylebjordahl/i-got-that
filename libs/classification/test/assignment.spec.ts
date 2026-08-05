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
