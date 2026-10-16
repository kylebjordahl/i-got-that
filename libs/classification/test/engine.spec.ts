import { describe, expect, it } from 'vitest';
import {
  coveredLocalDays,
  detectConflicts,
  estimateTravelMinutes,
  firstMatch,
  haversineKm,
  generateTaskIntents,
  intervalsOverlap,
  localDay,
  resolveTaskResult,
  ruleMatches,
  subtractIntervals,
  synthesizeBusy,
  synthesizeException,
  synthesizeStandard,
  taskRulesForCalendar,
  transitionWindow,
  wallTimeToUtc,
  type OverrideRuleLike,
  type PriorityInterval,
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
    locationGeo: partial.locationGeo ?? null,
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
      locationGeo: null,
    });
  });

  it("keeps the source event's own geocode (what carries travel time out)", () => {
    const geo = { lat: 37.331686, lon: -122.030656, title: 'Field 3' };
    const soccer = occ({ summary: 'Soccer practice', location: 'Field 3', locationGeo: geo });
    const { events } = synthesizeStandard(schoolLink, [soccer]);
    expect(events[0]?.locationGeo).toEqual(geo);
  });

  it("falls back to the link's geocode when both name the same place", () => {
    const linkGeo = { lat: 42.36, lon: -71.06, title: 'Lincoln Elementary' };
    const link = { ...schoolLink, locationGeo: linkGeo };
    // Same place, spelled the same, only the link has it pinned.
    const assembly = occ({ summary: 'Assembly', location: 'lincoln elementary  ' });
    expect(synthesizeStandard(link, [assembly]).events[0]?.locationGeo).toEqual(linkGeo);

    // A different place must never inherit the link's coordinates — the map pin
    // would then contradict the text the event displays.
    const away = occ({ summary: 'Away game', location: 'Field 3' });
    expect(synthesizeStandard(link, [away]).events[0]?.locationGeo).toBeNull();

    // Nor may an event with no location of its own borrow one.
    const tbd = occ({ summary: 'Practice' });
    expect(synthesizeStandard(link, [tbd]).events[0]?.locationGeo).toBeNull();
  });
});

// --- Stage A: busy feeds ------------------------------------------------------

describe('synthesizeBusy', () => {
  // A busy link says nothing about place unless the family fills one in.
  const busyLink = { ...schoolLink, location: null, baselineSummary: 'Busy (work)' };

  it('emits detail-free fb: blocks labeled with the link summary, never pends', () => {
    const interval = occ({
      dtstart: new Date('2026-07-06T15:00:00Z'),
      dtend: new Date('2026-07-06T16:30:00Z'),
    });
    const { events, pending } = synthesizeBusy(busyLink, [interval]);
    expect(pending).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      synthKey: `fb:link-1:${interval.id}`,
      sourceEventId: interval.id,
      summary: 'Busy (work)',
      location: null,
      locationGeo: null,
      description: null,
      allDay: false,
    });
    expect(events[0]!.dtstart.toISOString()).toBe('2026-07-06T15:00:00.000Z');
    expect(events[0]!.dtend!.toISOString()).toBe('2026-07-06T16:30:00.000Z');
  });

  it('defaults the label to "Busy" and never leaks source text fields', () => {
    // Even if a source row somehow carried text, busy synthesis drops it.
    const interval = occ({ summary: 'should never appear', location: 'nor this' });
    const { events } = synthesizeBusy({ ...busyLink, baselineSummary: null }, [interval]);
    expect(events[0]!.summary).toBe('Busy');
    expect(events[0]!.location).toBeNull();
  });

  it("stamps the family's declared place on the block, source text still dropped", () => {
    // "My work calendar's busy time happens at the office" — declared on the
    // link, so a following school run can be measured from there.
    const office = { lat: 37.7896, lon: -122.4, title: 'Acme HQ' };
    const link = { ...busyLink, location: 'Acme HQ', locationGeo: office };
    const interval = occ({ summary: 'should never appear', location: 'nor this' });
    const { events } = synthesizeBusy(link, [interval]);
    expect(events[0]).toMatchObject({
      summary: 'Busy (work)',
      location: 'Acme HQ',
      locationGeo: office,
      description: null,
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

  it('a baseline day is never tied to the exception event that shaped it (the DB cascades on that link)', () => {
    // The matched rule is recorded — that FK is SET NULL — but not the event:
    // `calendar_events.source_event_id` is ON DELETE CASCADE, so naming the
    // exception event would delete the day when the feed dropped the event.
    const early = occ({
      summary: 'Early Dismissal - Conferences',
      allDay: true,
      dtstart: new Date('2026-07-08T00:00:00Z'),
      dtend: new Date('2026-07-09T00:00:00Z'),
    });
    const spirit = occ({
      summary: 'Spirit Day',
      allDay: true,
      dtstart: new Date('2026-07-09T00:00:00Z'),
      dtend: new Date('2026-07-10T00:00:00Z'),
    });
    const ignoreRule = override({ position: 2, matchValue: 'Spirit Day', outcome: 'ignore' });
    const { events } = synthesizeException(
      schoolLink,
      [early, spirit],
      [noSchool, earlyRelease, ignoreRule],
      week,
      'UTC',
    );
    const baselineDays = events.filter((e) => e.synthKey.startsWith('bl:'));
    expect(baselineDays).toHaveLength(5);
    expect(baselineDays.map((e) => e.sourceEventId)).toEqual([null, null, null, null, null]);
    const byKey = new Map(baselineDays.map((e) => [e.synthKey, e]));
    expect(byKey.get('bl:link-1:2026-07-08')?.matchedRuleId).toBe(earlyRelease.id);
    expect(byKey.get('bl:link-1:2026-07-09')?.matchedRuleId).toBe(ignoreRule.id);
    expect(byKey.get('bl:link-1:2026-07-07')?.matchedRuleId).toBeNull();
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

  it('add_event puts the event on the calendar and leaves the baseline day alone', () => {
    const dinnerRule = override({ position: 0, matchValue: 'Community Dinner', outcome: 'add_event' });
    const dinner = occ({
      summary: 'Community Dinner',
      location: 'Lincoln Cafeteria',
      dtstart: new Date('2026-07-07T22:00:00Z'),
      dtend: new Date('2026-07-08T00:00:00Z'),
    });
    const { events, pending } = synthesizeException(schoolLink, [dinner], [dinnerRule, noSchool], week, 'UTC');
    expect(pending).toEqual([]);

    // The event itself, with its own times/summary/location — not a baseline day.
    const added = events.find((e) => e.synthKey === `ev:link-1:${dinner.id}`)!;
    expect(added).toMatchObject({
      sourceEventId: dinner.id,
      matchedRuleId: dinnerRule.id,
      summary: 'Community Dinner',
      location: 'Lincoln Cafeteria',
    });
    expect(added.dtstart.toISOString()).toBe('2026-07-07T22:00:00.000Z');
    // Tuesday's school day is untouched (full hours), and every weekday stands.
    const tue = events.find((e) => e.synthKey === 'bl:link-1:2026-07-07')!;
    expect(tue.dtend?.toISOString()).toBe('2026-07-07T14:45:00.000Z');
    expect(tue.matchedRuleId).toBeNull();
    expect(events.filter((e) => e.synthKey.startsWith('bl:'))).toHaveLength(5);
  });

  it("an add_event occurrence sits out the day's ruling — another event can still cancel it", () => {
    const dinnerRule = override({ position: 0, matchValue: 'Community Dinner', outcome: 'add_event' });
    const dinner = occ({
      summary: 'Community Dinner',
      dtstart: new Date('2026-07-07T22:00:00Z'),
      dtend: new Date('2026-07-08T00:00:00Z'),
    });
    const closure = occ({
      summary: 'No School - Teacher Day',
      allDay: true,
      dtstart: new Date('2026-07-07T00:00:00Z'),
      dtend: new Date('2026-07-08T00:00:00Z'),
    });
    // The lower-positioned add_event rule must not shield Tuesday from the
    // (higher-positioned) cancel_day the closure matches.
    const { events } = synthesizeException(schoolLink, [dinner, closure], [dinnerRule, noSchool], week, 'UTC');
    expect(events.some((e) => e.synthKey === 'bl:link-1:2026-07-07')).toBe(false);
    expect(events.some((e) => e.synthKey === `ev:link-1:${dinner.id}`)).toBe(true);
  });

  it('add_event lands on non-baseline days and on links with no baseline at all', () => {
    const dinnerRule = override({ position: 0, matchValue: 'Community Dinner', outcome: 'add_event' });
    const saturday = occ({
      summary: 'Community Dinner',
      dtstart: new Date('2026-07-11T22:00:00Z'),
      dtend: new Date('2026-07-12T00:00:00Z'),
    });
    const weekend = { start: new Date('2026-07-06T00:00:00Z'), end: new Date('2026-07-13T00:00:00Z') };
    const withBaseline = synthesizeException(schoolLink, [saturday], [dinnerRule], weekend, 'UTC');
    expect(withBaseline.events.some((e) => e.synthKey === `ev:link-1:${saturday.id}`)).toBe(true);

    const noBaseline = synthesizeException(
      { ...schoolLink, weekdayMask: null },
      [saturday],
      [dinnerRule],
      weekend,
      'UTC',
    );
    expect(noBaseline.events.map((e) => e.synthKey)).toEqual([`ev:link-1:${saturday.id}`]);
  });

  it('unmatched occurrences become pending decisions; the baseline still stands', () => {
    const bookFair = occ({ summary: 'Book Fair', contentHash: 'bf-1', dtstart: new Date('2026-07-07T17:00:00Z') });
    const { events, pending } = synthesizeException(schoolLink, [bookFair], [noSchool], week, 'UTC');
    expect(pending).toEqual([{ sourceEventId: bookFair.id, contentHash: 'bf-1' }]);
    expect(events.some((e) => e.synthKey === 'bl:link-1:2026-07-07')).toBe(true);
  });
});

describe('synthesizeException — dated baseline changes', () => {
  // From Wed Jul 8 the day runs to 17:00 (after-care added).
  const changingLink = {
    ...schoolLink,
    baselineChanges: [{ effectiveFrom: '2026-07-08', dayStart: '08:30', dayEnd: '17:00' }],
  };
  const ends = (events: { synthKey: string; dtend: Date | null }[]) =>
    Object.fromEntries(events.map((e) => [e.synthKey.slice(-10), e.dtend?.toISOString().slice(11, 16)]));

  it('switches hours on the effective date, keeping the same bl: keys', () => {
    const { events } = synthesizeException(changingLink, [], [], week, 'UTC');
    expect(ends(events)).toEqual({
      '2026-07-06': '14:45',
      '2026-07-07': '14:45',
      '2026-07-08': '17:00',
      '2026-07-09': '17:00',
      '2026-07-10': '17:00',
    });
  });

  it('the latest change on or before the day wins, in any order', () => {
    const { events } = synthesizeException(
      {
        ...schoolLink,
        baselineChanges: [
          { effectiveFrom: '2026-07-10', dayStart: '09:00', dayEnd: '13:00' },
          { effectiveFrom: '2026-07-07', dayStart: '08:30', dayEnd: '17:00' },
        ],
      },
      [],
      [],
      week,
      'UTC',
    );
    expect(ends(events)).toMatchObject({
      '2026-07-06': '14:45',
      '2026-07-07': '17:00',
      '2026-07-09': '17:00',
      '2026-07-10': '13:00',
    });
    const fri = events.find((e) => e.synthKey === 'bl:link-1:2026-07-10');
    expect(fri?.dtstart.toISOString()).toBe('2026-07-10T09:00:00.000Z');
  });

  it('a change dated on a non-school day takes effect from the next school day', () => {
    const { events } = synthesizeException(
      {
        ...schoolLink,
        baselineChanges: [{ effectiveFrom: '2026-07-04', dayStart: '08:30', dayEnd: '17:00' }],
      },
      [],
      [],
      week,
      'UTC',
    );
    expect(Object.values(ends(events))).toEqual(['17:00', '17:00', '17:00', '17:00', '17:00']);
  });

  it('a change after the window leaves the window on the link hours', () => {
    const { events } = synthesizeException(
      {
        ...schoolLink,
        baselineChanges: [{ effectiveFrom: '2026-08-01', dayStart: '08:30', dayEnd: '17:00' }],
      },
      [],
      [],
      week,
      'UTC',
    );
    expect(Object.values(ends(events))).toEqual(['14:45', '14:45', '14:45', '14:45', '14:45']);
  });

  it('modify_day still wins over the changed hours; a partial patch inherits them', () => {
    const noCare = override({
      position: 0,
      matchValue: 'No PM Care',
      outcome: 'modify_day',
      params: { dayEnd: '14:45' },
    });
    const lateStart = override({
      position: 1,
      matchValue: 'Late Start',
      outcome: 'modify_day',
      params: { dayStart: '10:00' },
    });
    const thu = occ({ summary: 'No PM Care', allDay: true, dtstart: new Date('2026-07-09T00:00:00Z'), dtend: new Date('2026-07-10T00:00:00Z') });
    const fri = occ({ summary: 'Late Start', allDay: true, dtstart: new Date('2026-07-10T00:00:00Z'), dtend: new Date('2026-07-11T00:00:00Z') });
    const { events } = synthesizeException(changingLink, [thu, fri], [noCare, lateStart], week, 'UTC');
    expect(ends(events)).toMatchObject({ '2026-07-08': '17:00', '2026-07-09': '14:45', '2026-07-10': '17:00' });
    const friEvent = events.find((e) => e.synthKey === 'bl:link-1:2026-07-10');
    expect(friEvent?.dtstart.toISOString()).toBe('2026-07-10T10:00:00.000Z');
  });

  it('change dates are local to the feed timezone', () => {
    const { events } = synthesizeException(changingLink, [], [], week, 'America/Los_Angeles');
    const tue = events.find((e) => e.synthKey === 'bl:link-1:2026-07-07');
    const wed = events.find((e) => e.synthKey === 'bl:link-1:2026-07-08');
    // 14:45 / 17:00 PDT.
    expect(tue?.dtend?.toISOString()).toBe('2026-07-07T21:45:00.000Z');
    expect(wed?.dtend?.toISOString()).toBe('2026-07-09T00:00:00.000Z');
  });
});

describe('day coverage + wall-clock conversion', () => {
  it('all-day dtend is exclusive; wall times anchor via Intl', () => {
    expect(
      coveredLocalDays(
        { dtstart: new Date('2026-07-06T00:00:00Z'), dtend: new Date('2026-07-08T00:00:00Z'), allDay: true },
        'UTC',
      ),
    ).toHaveLength(2);
    const day = new Date('2026-01-05T00:00:00Z'); // PST (UTC-8)
    expect(wallTimeToUtc(day, '08:30', 8, 'America/Los_Angeles').toISOString()).toBe('2026-01-05T16:30:00.000Z');
  });
});

// A local date is represented as that date's UTC midnight (baseline days, all-day
// events); a timed instant has to be read in its zone before it can be compared
// with one. These are the cases where local time and UTC straddle midnight.
describe('localDay', () => {
  const PT = 'America/Los_Angeles';
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  it('is the UTC date in UTC (and for an unknown zone)', () => {
    expect(ymd(localDay(new Date('2026-07-07T02:00:00Z'), 'UTC'))).toBe('2026-07-07');
    expect(ymd(localDay(new Date('2026-07-07T02:00:00Z'), 'Not/AZone'))).toBe('2026-07-07');
  });

  it('west of UTC, an evening instant is still that day (Mon 7pm PDT is Tuesday in UTC)', () => {
    const d = localDay(new Date('2026-07-07T02:00:00Z'), PT);
    expect(d.toISOString()).toBe('2026-07-06T00:00:00.000Z');
  });

  it('east of UTC, a morning instant is already that day (Tue 7am AEST is Monday in UTC)', () => {
    const d = localDay(new Date('2026-07-06T21:00:00Z'), 'Australia/Sydney');
    expect(d.toISOString()).toBe('2026-07-07T00:00:00.000Z');
  });

  it('flips exactly at local midnight, either side of a DST change', () => {
    // US spring-forward 2026-03-08: PST (UTC-8) until 02:00, PDT (UTC-7) after.
    expect(ymd(localDay(new Date('2026-03-08T07:59:00Z'), PT))).toBe('2026-03-07'); // 23:59 PST
    expect(ymd(localDay(new Date('2026-03-08T08:00:00Z'), PT))).toBe('2026-03-08'); // 00:00 PST
    expect(ymd(localDay(new Date('2026-03-09T06:59:00Z'), PT))).toBe('2026-03-08'); // 23:59 PDT
    expect(ymd(localDay(new Date('2026-03-09T07:00:00Z'), PT))).toBe('2026-03-09'); // 00:00 PDT
    // Fall-back 2026-11-01: the 25-hour day.
    expect(ymd(localDay(new Date('2026-11-01T06:59:00Z'), PT))).toBe('2026-10-31'); // 23:59 PDT
    expect(ymd(localDay(new Date('2026-11-01T07:00:00Z'), PT))).toBe('2026-11-01'); // 00:00 PDT
    expect(ymd(localDay(new Date('2026-11-02T07:59:00Z'), PT))).toBe('2026-11-01'); // 23:59 PST
    expect(ymd(localDay(new Date('2026-11-02T08:00:00Z'), PT))).toBe('2026-11-02'); // 00:00 PST
  });
});

describe('coveredLocalDays', () => {
  const PT = 'America/Los_Angeles';
  const ymds = (days: number[]) => days.map((d) => new Date(d).toISOString().slice(0, 10));

  it('a timed event covers the local day it starts on, not its UTC day', () => {
    // Mon 2026-07-06 18:30–19:30 PDT = Tue 01:30–02:30Z.
    const evening = { dtstart: new Date('2026-07-07T01:30:00Z'), dtend: new Date('2026-07-07T02:30:00Z'), allDay: false };
    expect(ymds(coveredLocalDays(evening, PT))).toEqual(['2026-07-06']);
    expect(ymds(coveredLocalDays(evening, 'UTC'))).toEqual(['2026-07-07']);
  });

  it('a timed span covers every local day through the one its last instant is in', () => {
    // Mon 20:00 PDT → Wed 06:00 PDT.
    const span = { dtstart: new Date('2026-07-07T03:00:00Z'), dtend: new Date('2026-07-08T13:00:00Z'), allDay: false };
    expect(ymds(coveredLocalDays(span, PT))).toEqual(['2026-07-06', '2026-07-07', '2026-07-08']);
  });

  it('an end exactly at local midnight does not spill into the next day', () => {
    // Mon 20:00 PDT → Tue 00:00 PDT.
    const span = { dtstart: new Date('2026-07-07T03:00:00Z'), dtend: new Date('2026-07-07T07:00:00Z'), allDay: false };
    expect(ymds(coveredLocalDays(span, PT))).toEqual(['2026-07-06']);
  });

  it('a missing or non-positive end covers only the start day', () => {
    const at = new Date('2026-07-07T02:00:00Z');
    expect(ymds(coveredLocalDays({ dtstart: at, dtend: null, allDay: false }, PT))).toEqual(['2026-07-06']);
    expect(ymds(coveredLocalDays({ dtstart: at, dtend: at, allDay: false }, PT))).toEqual(['2026-07-06']);
  });

  it('the 23-hour spring-forward day is one day, not two', () => {
    // 2026-03-08 00:00 PST → 2026-03-09 00:00 PDT.
    const dstDay = { dtstart: new Date('2026-03-08T08:00:00Z'), dtend: new Date('2026-03-09T07:00:00Z'), allDay: false };
    expect(ymds(coveredLocalDays(dstDay, PT))).toEqual(['2026-03-08']);
  });

  it('the 25-hour fall-back day is one day, not two', () => {
    // 2026-11-01 00:00 PDT → 2026-11-02 00:00 PST.
    const dstDay = { dtstart: new Date('2026-11-01T07:00:00Z'), dtend: new Date('2026-11-02T08:00:00Z'), allDay: false };
    expect(ymds(coveredLocalDays(dstDay, PT))).toEqual(['2026-11-01']);
  });

  it('all-day spans are dates already: unchanged by the zone', () => {
    const allDay = { dtstart: new Date('2026-07-06T00:00:00Z'), dtend: new Date('2026-07-08T00:00:00Z'), allDay: true };
    for (const tz of ['UTC', PT, 'Australia/Sydney']) {
      expect(ymds(coveredLocalDays(allDay, tz))).toEqual(['2026-07-06', '2026-07-07']);
    }
  });
});

describe('synthesizeException — timed events rule the local day', () => {
  const keys = (events: { synthKey: string }[]) => events.map((e) => e.synthKey.slice(-10));

  it('Pacific: a Monday-evening cancel cancels Monday, not Tuesday', () => {
    // "No School Night" Mon 2026-07-06 18:30–19:30 PDT = Tue 01:30–02:30Z.
    const evening = occ({
      summary: 'No School Night',
      dtstart: new Date('2026-07-07T01:30:00Z'),
      dtend: new Date('2026-07-07T02:30:00Z'),
    });
    const { events, pending } = synthesizeException(schoolLink, [evening], [noSchool], week, 'America/Los_Angeles');
    expect(pending).toEqual([]);
    expect(keys(events)).toEqual(['2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10']);
    // Read in UTC the same instant is Tuesday — the zone is what moves the ruling.
    const inUtc = synthesizeException(schoolLink, [evening], [noSchool], week, 'UTC');
    expect(keys(inUtc.events)).toEqual(['2026-07-06', '2026-07-08', '2026-07-09', '2026-07-10']);
  });

  it('Sydney: a Tuesday-morning cancel cancels Tuesday, not Monday', () => {
    // Tue 2026-07-07 07:00–09:00 AEST = Mon 21:00–23:00Z.
    const morning = occ({
      summary: 'No School - staff training',
      dtstart: new Date('2026-07-06T21:00:00Z'),
      dtend: new Date('2026-07-06T23:00:00Z'),
    });
    const { events } = synthesizeException(schoolLink, [morning], [noSchool], week, 'Australia/Sydney');
    expect(keys(events)).toEqual(['2026-07-06', '2026-07-08', '2026-07-09', '2026-07-10']);
  });

  it('a modify_day from a timed Pacific event patches the right baseline day', () => {
    // Tue 2026-07-07 18:00–18:30 PDT = Wed 01:00–01:30Z, which must still be Tuesday.
    const evening = occ({
      summary: 'Early Dismissal reminder',
      dtstart: new Date('2026-07-08T01:00:00Z'),
      dtend: new Date('2026-07-08T01:30:00Z'),
    });
    const { events } = synthesizeException(schoolLink, [evening], [earlyRelease], week, 'America/Los_Angeles');
    const tue = events.find((e) => e.synthKey === 'bl:link-1:2026-07-07');
    const wed = events.find((e) => e.synthKey === 'bl:link-1:2026-07-08');
    expect(tue?.matchedRuleId).toBe(earlyRelease.id);
    expect(tue?.dtend?.toISOString()).toBe('2026-07-07T19:00:00.000Z'); // 12:00 PDT
    expect(wed?.matchedRuleId).toBeNull();
  });

  it('a multi-day timed closure cancels each local day it touches', () => {
    // Mon 20:00 PDT → Wed 06:00 PDT.
    const closure = occ({
      summary: 'Closed - water main',
      dtstart: new Date('2026-07-07T03:00:00Z'),
      dtend: new Date('2026-07-08T13:00:00Z'),
    });
    const { events } = synthesizeException(schoolLink, [closure], [noSchool], week, 'America/Los_Angeles');
    expect(keys(events)).toEqual(['2026-07-09', '2026-07-10']);
  });

  it('a DST-transition day is ruled as one day', () => {
    // All of Sun 2026-03-08 (the 23-hour spring-forward day), as a timed closure.
    const everyDay = { ...schoolLink, weekdayMask: 0b1111111 };
    const marWindow = { start: new Date('2026-03-07T00:00:00Z'), end: new Date('2026-03-10T00:00:00Z') };
    const closed = occ({
      summary: 'Closed',
      dtstart: new Date('2026-03-08T08:00:00Z'),
      dtend: new Date('2026-03-09T07:00:00Z'),
    });
    const { events } = synthesizeException(everyDay, [closed], [noSchool], marWindow, 'America/Los_Angeles');
    expect(keys(events)).toEqual(['2026-03-07', '2026-03-09']);
  });

  it('all-day events rule the date they name, in any zone', () => {
    const tuesday = occ({
      summary: 'No School',
      allDay: true,
      dtstart: new Date('2026-07-07T00:00:00Z'),
      dtend: new Date('2026-07-08T00:00:00Z'),
    });
    for (const tz of ['UTC', 'America/Los_Angeles', 'Australia/Sydney']) {
      const { events } = synthesizeException(schoolLink, [tuesday], [noSchool], week, tz);
      expect(keys(events)).toEqual(['2026-07-06', '2026-07-08', '2026-07-09', '2026-07-10']);
    }
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
      {
        type: 'attendance',
        attendanceRequirement: 'any',
        dtstart: span.dtstart,
        dtend: span.dtend,
        location: span.location,
        locationGeo: null,
      },
    ]);
  });

  it("carries the event's geocode onto every task it spawns", () => {
    const geo = { lat: 37.331686, lon: -122.030656, title: 'Lincoln Elementary' };
    const intents = generateTaskIntents(
      { ...span, locationGeo: geo },
      { resultType: 'transition', dropoffWindowMin: 15, pickupWindowMin: 30 },
    );
    // Both halves of a transition are trips to the same place — the geocode is
    // what lets the claimed event drive Apple's travel time.
    expect(intents.map((i) => i.locationGeo)).toEqual([geo, geo]);
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

describe('transitionWindow', () => {
  const anchor = new Date('2026-07-06T15:30:00Z');

  it('a positive length extends forward from the anchor', () => {
    const w = transitionWindow(anchor, 30);
    expect(w.dtstart).toEqual(anchor);
    expect(w.dtend?.toISOString()).toBe('2026-07-06T16:00:00.000Z');
  });

  it('a negative length reverses the window before the anchor, keeping it ordered', () => {
    const w = transitionWindow(anchor, -20);
    expect(w.dtstart.toISOString()).toBe('2026-07-06T15:10:00.000Z');
    expect(w.dtend).toEqual(anchor);
    expect(w.dtstart.getTime()).toBeLessThan(w.dtend!.getTime());
  });

  it('zero collapses to a point in time', () => {
    const w = transitionWindow(anchor, 0);
    expect(w.dtstart).toEqual(anchor);
    expect(w.dtend).toBeNull();
  });
});

// --- Stage C: conflict detection & masking ---------------------------------

describe('intervalsOverlap', () => {
  const d = (s: string) => new Date(s);
  it('true when two timed intervals share an instant', () => {
    expect(
      intervalsOverlap(
        { dtstart: d('2026-07-06T08:30:00Z'), dtend: d('2026-07-06T15:00:00Z') },
        { dtstart: d('2026-07-06T10:00:00Z'), dtend: d('2026-07-06T11:00:00Z') },
      ),
    ).toBe(true);
  });
  it('false when intervals only touch at an edge (half-open)', () => {
    expect(
      intervalsOverlap(
        { dtstart: d('2026-07-06T08:00:00Z'), dtend: d('2026-07-06T10:00:00Z') },
        { dtstart: d('2026-07-06T10:00:00Z'), dtend: d('2026-07-06T11:00:00Z') },
      ),
    ).toBe(false);
  });
  it('false when either event is a point (no end)', () => {
    expect(
      intervalsOverlap(
        { dtstart: d('2026-07-06T10:00:00Z'), dtend: null },
        { dtstart: d('2026-07-06T08:00:00Z'), dtend: d('2026-07-06T15:00:00Z') },
      ),
    ).toBe(false);
  });
});

describe('detectConflicts', () => {
  const d = (s: string) => new Date(s);
  let seq = 0;
  function ev(p: Partial<PriorityInterval>): PriorityInterval {
    return {
      key: p.key ?? `ev-${seq++}`,
      dtstart: p.dtstart ?? d('2026-07-06T08:30:00Z'),
      dtend: p.dtend ?? d('2026-07-06T15:00:00Z'),
      priority: p.priority ?? 0,
      maskable: p.maskable ?? true,
    };
  }

  it('flags a maskable baseline overlapped by a higher-priority manual event', () => {
    const baseline = ev({ key: 'bl:x', priority: 5, maskable: true });
    const appt = ev({
      key: 'ext:doctor',
      priority: -1, // manual/human beats every feed
      maskable: false,
      dtstart: d('2026-07-06T10:00:00Z'),
      dtend: d('2026-07-06T11:00:00Z'),
    });
    expect(detectConflicts([baseline, appt])).toEqual([
      { loserKey: 'bl:x', winnerKey: 'ext:doctor' },
    ]);
  });

  it('the lower-priority feed loses to the higher-priority feed (soccer vs doctor)', () => {
    // Doctor feed ranks above the soccer feed → soccer is the maskable loser.
    const soccer = ev({ key: 'ev:soccer', priority: 3 });
    const doctor = ev({
      key: 'ev:doctor',
      priority: 1,
      dtstart: d('2026-07-06T08:00:00Z'),
      dtend: d('2026-07-06T10:00:00Z'),
    });
    expect(detectConflicts([soccer, doctor])).toEqual([
      { loserKey: 'ev:soccer', winnerKey: 'ev:doctor' },
    ]);
  });

  it('does not flag equal-priority overlaps (no clear winner)', () => {
    const a = ev({ key: 'a', priority: 2 });
    const b = ev({ key: 'b', priority: 2, dtstart: d('2026-07-06T10:00:00Z') });
    expect(detectConflicts([a, b])).toEqual([]);
  });

  it('never masks a non-maskable loser, even when outranked', () => {
    const human = ev({ key: 'ext:a', priority: -1, maskable: false });
    const higher = ev({ key: 'ext:b', priority: -2, maskable: false, dtstart: d('2026-07-06T10:00:00Z') });
    expect(detectConflicts([human, higher])).toEqual([]);
  });

  it('reports one pair per overlapping winner for a loser hit twice', () => {
    const baseline = ev({ key: 'bl:x', priority: 5 });
    const w1 = ev({ key: 'ext:a', priority: -1, maskable: false, dtstart: d('2026-07-06T09:00:00Z'), dtend: d('2026-07-06T10:00:00Z') });
    const w2 = ev({ key: 'ext:b', priority: -1, maskable: false, dtstart: d('2026-07-06T13:00:00Z'), dtend: d('2026-07-06T14:00:00Z') });
    expect(detectConflicts([baseline, w1, w2])).toEqual([
      { loserKey: 'bl:x', winnerKey: 'ext:a' },
      { loserKey: 'bl:x', winnerKey: 'ext:b' },
    ]);
  });
});

describe('subtractIntervals', () => {
  const d = (s: string) => new Date(s);
  const base = { dtstart: d('2026-07-06T08:30:00Z'), dtend: d('2026-07-06T15:00:00Z') };

  it('splits the base in two around a middle cut (leave + return)', () => {
    const out = subtractIntervals(base, [
      { dtstart: d('2026-07-06T10:00:00Z'), dtend: d('2026-07-06T11:00:00Z') },
    ]);
    expect(out.map((s) => [s.dtstart.toISOString(), s.dtend.toISOString()])).toEqual([
      ['2026-07-06T08:30:00.000Z', '2026-07-06T10:00:00.000Z'],
      ['2026-07-06T11:00:00.000Z', '2026-07-06T15:00:00.000Z'],
    ]);
  });

  it('trims to one segment when the cut hits an edge (attend part / late arrival)', () => {
    const out = subtractIntervals(base, [
      { dtstart: d('2026-07-06T08:00:00Z'), dtend: d('2026-07-06T10:00:00Z') },
    ]);
    expect(out.map((s) => [s.dtstart.toISOString(), s.dtend.toISOString()])).toEqual([
      ['2026-07-06T10:00:00.000Z', '2026-07-06T15:00:00.000Z'],
    ]);
  });

  it('yields nothing when a cut covers the whole base (fully displaced)', () => {
    const out = subtractIntervals(base, [
      { dtstart: d('2026-07-06T07:00:00Z'), dtend: d('2026-07-06T16:00:00Z') },
    ]);
    expect(out).toEqual([]);
  });

  it('merges overlapping/adjacent cuts into one gap', () => {
    const out = subtractIntervals(base, [
      { dtstart: d('2026-07-06T10:00:00Z'), dtend: d('2026-07-06T11:00:00Z') },
      { dtstart: d('2026-07-06T10:30:00Z'), dtend: d('2026-07-06T12:00:00Z') },
    ]);
    expect(out.map((s) => [s.dtstart.toISOString(), s.dtend.toISOString()])).toEqual([
      ['2026-07-06T08:30:00.000Z', '2026-07-06T10:00:00.000Z'],
      ['2026-07-06T12:00:00.000Z', '2026-07-06T15:00:00.000Z'],
    ]);
  });
});

// --- Stage D: travel estimation ---------------------------------------------

describe('estimateTravelMinutes', () => {
  // Well-known reference pair: ~3.9 km apart in San Francisco.
  const ferryBuilding = { lat: 37.7955, lon: -122.3937 };
  const missionDolores = { lat: 37.7596, lon: -122.4269 };

  it('measures the great-circle distance between two places', () => {
    expect(haversineKm(ferryBuilding, missionDolores)).toBeCloseTo(4.9, 0);
    expect(haversineKm(ferryBuilding, ferryBuilding)).toBe(0);
  });

  it('scales with distance, in 5-minute steps', () => {
    const acrossTown = estimateTravelMinutes(ferryBuilding, missionDolores);
    // ~6.4 road km at 40 km/h + overhead ⇒ a quarter hour, give or take a step.
    expect(acrossTown).toBeGreaterThanOrEqual(10);
    expect(acrossTown).toBeLessThanOrEqual(20);
    expect(acrossTown % 5).toBe(0);

    // Palo Alto — ~50 km south, mostly highway, so it must come out longer but
    // not proportionally so.
    const downThePeninsula = estimateTravelMinutes(ferryBuilding, { lat: 37.4419, lon: -122.143 });
    expect(downThePeninsula).toBeGreaterThan(acrossTown);
    expect(downThePeninsula).toBeLessThan(90);
  });

  it('floors a next-door trip and caps a transcontinental one', () => {
    // Same building: still 5 minutes — you don't teleport into the classroom.
    expect(estimateTravelMinutes(ferryBuilding, ferryBuilding)).toBe(5);
    // New York: nobody is driving this, but the block stays sane.
    expect(estimateTravelMinutes(ferryBuilding, { lat: 40.7128, lon: -74.006 })).toBe(120);
  });

  it('is symmetric', () => {
    expect(estimateTravelMinutes(ferryBuilding, missionDolores)).toBe(
      estimateTravelMinutes(missionDolores, ferryBuilding),
    );
  });
});
