import { describe, expect, it } from 'vitest';
import {
  CreateLinkRuleInput,
  CreateFeedInput,
  CreateTaskRuleInput,
  parseEcmaRegex,
  ResolvePendingDecisionInput,
  TimeOfDay,
} from '../src/index.js';

describe('domain schemas', () => {
  it('applies the default refresh interval (~6h)', () => {
    const parsed = CreateFeedInput.parse({
      url: 'https://example.com/cal.ics',
      mode: 'exception',
    });
    expect(parsed.refreshMinutes).toBe(360);
    expect(parsed.kind).toBe('ics');
  });

  it('rejects an invalid feed mode', () => {
    expect(() =>
      CreateFeedInput.parse({ url: 'https://x/c.ics', mode: 'nope' }),
    ).toThrow();
  });

  it("restricts mode 'busy' to google-kind feeds", () => {
    expect(
      CreateFeedInput.safeParse({
        kind: 'google',
        mode: 'busy',
        externalAccountId: 'acct-1',
        sourceCalendarId: 'kyle@work.example',
      }).success,
    ).toBe(true);
    // The intervals-only guarantee comes from freebusy.query; no other
    // transport qualifies.
    expect(
      CreateFeedInput.safeParse({
        kind: 'ics',
        mode: 'busy',
        url: 'https://x/c.ics',
      }).success,
    ).toBe(false);
    expect(
      CreateFeedInput.safeParse({
        kind: 'caldav',
        mode: 'busy',
        externalAccountId: 'acct-1',
        sourceCalendarId: 'https://caldav.example/cal/',
      }).success,
    ).toBe(false);
  });

  it('validates HH:MM times', () => {
    expect(TimeOfDay.safeParse('08:00').success).toBe(true);
    expect(TimeOfDay.safeParse('24:00').success).toBe(false);
    expect(TimeOfDay.safeParse('8:00').success).toBe(false);
  });

  it('accepts a no-school cancel-day override rule', () => {
    const rule = CreateLinkRuleInput.parse({
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'Closed',
      outcome: 'cancel_day',
    });
    expect(rule.outcome).toBe('cancel_day');
  });

  it('cross-validates matcher fields, ops, and params per outcome', () => {
    // Text field with a boolean op → invalid.
    expect(
      CreateLinkRuleInput.safeParse({
        matchField: 'summary',
        matchOp: 'is_true',
        outcome: 'cancel_day',
      }).success,
    ).toBe(false);
    // duration needs a numeric matchValue.
    expect(
      CreateLinkRuleInput.safeParse({
        matchField: 'duration',
        matchOp: 'gte',
        matchValue: 'ninety',
        outcome: 'cancel_day',
      }).success,
    ).toBe(false);
    expect(
      CreateLinkRuleInput.safeParse({
        matchField: 'duration',
        matchOp: 'gte',
        matchValue: '90',
        outcome: 'cancel_day',
      }).success,
    ).toBe(true);
    // modify_day accepts new hours; cancel_day rejects unexpected params.
    expect(
      CreateLinkRuleInput.safeParse({
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'Early',
        outcome: 'modify_day',
        params: { dayEnd: '12:00' },
      }).success,
    ).toBe(true);
    expect(
      CreateLinkRuleInput.safeParse({
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'x',
        outcome: 'cancel_day',
        params: { dayEnd: '12:00' },
      }).success,
    ).toBe(false);
    // Bad regex is rejected up front.
    expect(
      CreateLinkRuleInput.safeParse({
        matchField: 'summary',
        matchOp: 'regex',
        matchValue: '(',
        outcome: 'cancel_day',
      }).success,
    ).toBe(false);
  });

  it('parses ECMAScript regexes in both bare and /pattern/flags forms', () => {
    expect(parseEcmaRegex('/no school|closed/i').test('No School')).toBe(true);
    expect(parseEcmaRegex('no school').test('No School')).toBe(false);
    expect(() => parseEcmaRegex('(')).toThrow();
  });

  it('resolving a pending decision takes no task types (typing is via task rules)', () => {
    expect(ResolvePendingDecisionInput.safeParse({}).success).toBe(true);
    expect(
      ResolvePendingDecisionInput.safeParse({ startTime: '15:30', endTime: '16:15' }).success,
    ).toBe(true);
    expect(ResolvePendingDecisionInput.safeParse({ startTime: '25:00' }).success).toBe(false);
  });

  it('validates task rules (matcher + windows)', () => {
    expect(
      CreateTaskRuleInput.safeParse({ resultType: 'attendance', matchValue: '/field trip/i' }).success,
    ).toBe(true);
    // regex matcher with a bad pattern → invalid.
    expect(
      CreateTaskRuleInput.safeParse({ resultType: 'transition', matchOp: 'regex', matchValue: '(' }).success,
    ).toBe(false);
  });
});
