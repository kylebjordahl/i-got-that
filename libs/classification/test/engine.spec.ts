import { describe, expect, it } from 'vitest';
import {
  classifyExplicit,
  resolveExceptionDay,
  ruleMatches,
  type RuleLike,
} from '../src/index.js';

// Rules modeled on the real Children's House PDX feed (exception mode).
const noSchool: RuleLike = {
  feedId: 'school',
  priority: 10,
  matchField: 'summary',
  matchOp: 'contains',
  matchValue: 'Closed',
  effect: 'cancel',
};
const earlyDismissal: RuleLike = {
  feedId: 'school',
  priority: 10,
  matchField: 'summary',
  matchOp: 'contains',
  matchValue: 'Early Dismissal',
  effect: 'shift',
  shiftToTime: '12:00',
};

const baseline = { types: ['dropoff', 'pickup'] as const, pickupTime: '15:00' };

describe('rule matching', () => {
  it('is case-insensitive for contains', () => {
    expect(ruleMatches({ summary: 'MCH CLOSED - Holiday', location: null }, noSchool)).toBe(true);
    expect(ruleMatches({ summary: 'Back to School Night', location: null }, noSchool)).toBe(false);
  });
});

describe('exception/inverted resolution', () => {
  it('cancels the day on a "Closed" event', () => {
    const r = resolveExceptionDay(
      { types: [...baseline.types], pickupTime: baseline.pickupTime },
      [{ summary: 'MCH Closed - Spring Break', location: null }],
      [noSchool, earlyDismissal],
    );
    expect(r.cancelled).toBe(true);
    expect(r.types).toEqual([]);
    expect(r.appliedEffect).toBe('cancel');
  });

  it('shifts pickup on early dismissal', () => {
    const r = resolveExceptionDay(
      { types: [...baseline.types], pickupTime: baseline.pickupTime },
      [{ summary: 'Early Dismissal - Conferences', location: null }],
      [noSchool, earlyDismissal],
    );
    expect(r.cancelled).toBe(false);
    expect(r.pickupTime).toBe('12:00');
    expect(r.appliedEffect).toBe('shift');
  });

  it('leaves picture day / fundraiser as a normal school day', () => {
    const r = resolveExceptionDay(
      { types: [...baseline.types], pickupTime: baseline.pickupTime },
      [
        { summary: 'School Photos - Mark Pratt Russum', location: null },
        { summary: 'MCH Fundraiser at Pizzario Otto!', location: null },
      ],
      [noSchool, earlyDismissal],
    );
    expect(r.cancelled).toBe(false);
    expect(r.types).toEqual(['dropoff', 'pickup']);
    expect(r.appliedEffect).toBe('none');
  });
});

describe('explicit classification', () => {
  it('creates tasks from a matching create rule', () => {
    const rule: RuleLike = {
      feedId: null,
      priority: 100,
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Soccer',
      effect: 'create',
      producesTypes: ['pickup', 'dropoff'],
      defaultAttendance: 'any',
    };
    const intents = classifyExplicit({ summary: 'Soccer practice', location: 'Field 3' }, [rule]);
    expect(intents).not.toBeNull();
    expect(intents).toHaveLength(2);
    expect(intents?.[0]?.attendanceRequirement).toBe('any');
  });

  it('falls back to an any-1 attendance task when nothing matches', () => {
    const intents = classifyExplicit({ summary: 'Random', location: null }, []);
    expect(intents).toEqual([
      { type: 'attendance', attendanceRequirement: 'any', defaultOwnerMemberId: null },
    ]);
  });
});
