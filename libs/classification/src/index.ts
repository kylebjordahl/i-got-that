import {
  parseEcmaRegex,
  type AttendanceRequirement,
  type GeoLocation,
  type OverrideMatchField,
  type OverrideMatchOp,
  type OverrideOutcome,
  type TaskResultType,
  type TaskRuleScope,
  type TaskType,
} from '@igt/domain';

/**
 * Pure synthesis + task-generation engine. Two decoupled stages, no I/O, and —
 * per the round-6 review — two independent rule pipelines:
 *
 *  Stage A — synthesis: feed occurrences + a link's OVERRIDE pipeline decide
 *  the SCHEDULE of events on the member's unified calendar (cancel / modify /
 *  ignore the covered baseline day). Unmatched exception events become pending
 *  decisions — the system never guesses.
 *
 *  Stage B — task generation: a member's TASK-RULE pipeline decides what
 *  claimable tasks each event spawns (a transition = drop-off + pickup, or an
 *  attendance block, with drop-off/pickup windows). Task typing is fully
 *  separate from the schedule.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

// --- Timezone / day helpers (host-independent; anchored via Intl) ----------

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Mon=bit0 … Sun=bit6. */
export function weekdayBit(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

/** Offset (ms) of `tz` from UTC at the given instant; 0 for UTC/unknown zones. */
export function tzOffsetMs(tz: string, utcMs: number): number {
  if (tz === 'UTC') return 0;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const m: Record<string, number> = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) {
      if (p.type !== 'literal') m[p.type] = Number(p.value);
    }
    const asUtc = Date.UTC(m.year!, m.month! - 1, m.day!, m.hour!, m.minute!, m.second!);
    return asUtc - utcMs;
  } catch {
    return 0; // unknown timezone → treat as UTC
  }
}

/** Interpret `hhmm` as a wall-clock time in `tz` on `day`'s calendar date → UTC. */
export function wallTimeToUtc(
  day: Date,
  hhmm: string | null | undefined,
  fallbackHour: number,
  tz: string,
): Date {
  const [h, m] = (hhmm ?? '').split(':');
  const hour = h !== undefined && m !== undefined ? Number(h) : fallbackHour;
  const min = h !== undefined && m !== undefined ? Number(m) : 0;
  const guess = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, min);
  return new Date(guess - tzOffsetMs(tz, guess));
}

/** `YYYY-MM-DD` for a UTC-day key (used in `bl:` synthKeys). */
export function utcDayString(dayMs: number): string {
  return new Date(dayMs).toISOString().slice(0, 10);
}

/**
 * Every UTC-day key (midnight ms) an occurrence covers, so a multi-day span
 * (e.g. a week-long closure) affects the baseline on *all* its days, not just
 * the first. All-day `dtend` is exclusive (the midnight after the last covered
 * day); a timed event covers through the day its end instant falls in. A
 * missing or non-positive-length end covers only the start day.
 */
export function coveredUtcDays(e: {
  dtstart: Date;
  dtend: Date | null;
  allDay: boolean;
}): number[] {
  const first = startOfUtcDay(e.dtstart).getTime();
  if (!e.dtend || e.dtend.getTime() <= e.dtstart.getTime()) return [first];
  const endExclusive = e.allDay
    ? startOfUtcDay(e.dtend).getTime()
    : startOfUtcDay(new Date(e.dtend.getTime() - 1)).getTime() + DAY_MS;
  const days: number[] = [];
  for (let d = first; d < endExclusive; d += DAY_MS) days.push(d);
  return days.length > 0 ? days : [first];
}

// --- Matchers (shared by both pipelines) -----------------------------------

/** The occurrence fields a matcher can inspect. */
export interface OccurrenceLike {
  summary: string | null;
  location: string | null;
  description?: string | null;
  allDay: boolean;
  dtstart: Date;
  dtend: Date | null;
}

/** The matcher fields common to override rules and task rules. */
export interface MatcherLike {
  matchField: OverrideMatchField;
  matchOp: OverrideMatchOp;
  matchValue: string | null;
}

function textValue(occ: OccurrenceLike, field: OverrideMatchField): string {
  switch (field) {
    case 'summary':
      return occ.summary ?? '';
    case 'location':
      return occ.location ?? '';
    case 'description':
      return occ.description ?? '';
    case 'any_text':
      return [occ.summary, occ.location, occ.description]
        .filter((v): v is string => !!v)
        .join('\n');
    default:
      return '';
  }
}

function durationMinutes(occ: OccurrenceLike): number {
  if (!occ.dtend) return 0;
  return Math.max(0, (occ.dtend.getTime() - occ.dtstart.getTime()) / 60_000);
}

export function ruleMatches(occ: OccurrenceLike, rule: MatcherLike): boolean {
  if (rule.matchField === 'all_day') {
    if (rule.matchOp === 'is_true') return occ.allDay;
    if (rule.matchOp === 'is_false') return !occ.allDay;
    return false;
  }
  if (rule.matchField === 'duration') {
    const minutes = Number(rule.matchValue);
    if (!Number.isFinite(minutes)) return false;
    if (rule.matchOp === 'gte') return durationMinutes(occ) >= minutes;
    if (rule.matchOp === 'lte') return durationMinutes(occ) <= minutes;
    return false;
  }
  const value = textValue(occ, rule.matchField);
  const pattern = rule.matchValue ?? '';
  switch (rule.matchOp) {
    case 'contains':
      return value.toLowerCase().includes(pattern.toLowerCase());
    case 'starts_with':
      return value.toLowerCase().startsWith(pattern.toLowerCase());
    case 'equals':
      return value === pattern;
    case 'regex':
      try {
        // Supports `/pattern/flags` (as the rule editor documents) or a bare pattern.
        return parseEcmaRegex(pattern).test(value);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** First matching rule in `position` order (first match wins), or null. */
export function firstMatch<R extends MatcherLike & { position: number }>(
  occ: OccurrenceLike,
  rules: R[],
): R | null {
  const sorted = [...rules].sort((a, b) => a.position - b.position);
  for (const rule of sorted) {
    if (ruleMatches(occ, rule)) return rule;
  }
  return null;
}

// --- Stage A: synthesis (schedule only) ------------------------------------

/** One override rule (schedule pipeline). */
export interface OverrideRuleLike extends MatcherLike {
  id: string;
  position: number;
  outcome: OverrideOutcome;
  params?: Record<string, unknown> | null;
}

/** A source-event occurrence as fed into synthesis (id = source_events.id). */
export interface SourceOccurrence extends OccurrenceLike {
  id: string;
  contentHash: string;
}

/** The link config synthesis needs (a `family_member_feeds` row shape). */
export interface LinkConfigLike {
  id: string;
  weekdayMask: number | null;
  dayStart: string | null;
  dayEnd: string | null;
  location: string | null;
  /** Geocoded coords for `location`; stamped onto generated baseline events. */
  locationGeo?: GeoLocation | null;
  /** Summary for generated baseline-day events (e.g. the feed's name). */
  baselineSummary?: string | null;
}

/** A desired event on the member's unified calendar. */
export interface EventIntent {
  synthKey: string;
  sourceEventId: string | null;
  matchedRuleId: string | null;
  dtstart: Date;
  dtend: Date | null;
  allDay: boolean;
  summary: string | null;
  location: string | null;
  /** Geocoded coords for `location` (baseline events only); null for feed events. */
  locationGeo: GeoLocation | null;
  description: string | null;
}

/** An occurrence the pipeline couldn't decide — a human must resolve it. */
export interface PendingIntent {
  sourceEventId: string;
  contentHash: string;
}

export interface SynthesisResult {
  events: EventIntent[];
  pending: PendingIntent[];
}

interface ModifyDayParamsLike {
  dayStart?: string;
  dayEnd?: string;
}

function occurrenceEvent(linkId: string, occ: SourceOccurrence): EventIntent {
  return {
    synthKey: `ev:${linkId}:${occ.id}`,
    sourceEventId: occ.id,
    matchedRuleId: null,
    dtstart: occ.dtstart,
    dtend: occ.dtend,
    allDay: occ.allDay,
    summary: occ.summary,
    location: occ.location,
    locationGeo: null,
    description: occ.description ?? null,
  };
}

export interface SynthesisWindow {
  start: Date;
  end: Date;
}

/**
 * Standard feed: every occurrence lands on the unified calendar as-is. A
 * standard feed's events mean what they say, so there are no schedule overrides
 * to apply and nothing ever pends. Task typing is decided later by task rules.
 */
export function synthesizeStandard(
  link: LinkConfigLike,
  occurrences: SourceOccurrence[],
): SynthesisResult {
  return { events: occurrences.map((o) => occurrenceEvent(link.id, o)), pending: [] };
}

/**
 * Busy feed (the calendar-firewall input): occurrences are opaque availability
 * intervals read via Google free/busy — they carry no titles or locations by
 * construction. Each lands on the unified calendar as a detail-free block
 * labeled with the link's summary ("Busy" when unnamed). No override rules
 * apply and nothing ever pends; the interval itself is the whole payload.
 */
export function synthesizeBusy(
  link: LinkConfigLike,
  occurrences: SourceOccurrence[],
): SynthesisResult {
  return {
    events: occurrences.map((occ) => ({
      synthKey: `fb:${link.id}:${occ.id}`,
      sourceEventId: occ.id,
      matchedRuleId: null,
      dtstart: occ.dtstart,
      dtend: occ.dtend,
      allDay: occ.allDay,
      summary: link.baselineSummary ?? 'Busy',
      location: null,
      locationGeo: null,
      description: null,
    })),
    pending: [],
  };
}

/**
 * Exception-only feed: normal days come from the link's baseline (weekday mask
 * + day start/end), feed events apply schedule overrides. Per covered day the
 * winning (lowest-position) rule decides: `cancel_day` drops the day's baseline
 * event, `modify_day` patches its hours, `ignore` keeps the baseline. An
 * occurrence matching NO rule becomes a pending decision — the baseline still
 * stands until a human resolves it.
 */
export function synthesizeException(
  link: LinkConfigLike,
  occurrences: SourceOccurrence[],
  rules: OverrideRuleLike[],
  window: SynthesisWindow,
  tz: string,
): SynthesisResult {
  const events: EventIntent[] = [];
  const pending: PendingIntent[] = [];

  interface DayRuling {
    rule: OverrideRuleLike;
    occ: SourceOccurrence;
  }
  const dayRulings = new Map<number, DayRuling[]>();
  for (const occ of occurrences) {
    const rule = firstMatch(occ, rules);
    if (!rule) {
      pending.push({ sourceEventId: occ.id, contentHash: occ.contentHash });
      continue;
    }
    for (const day of coveredUtcDays(occ)) {
      (dayRulings.get(day) ?? dayRulings.set(day, []).get(day)!).push({ rule, occ });
    }
  }

  if (link.weekdayMask != null) {
    const windowStart = startOfUtcDay(window.start);
    for (
      let day = windowStart;
      day < window.end;
      day = new Date(day.getTime() + DAY_MS)
    ) {
      if ((link.weekdayMask & (1 << weekdayBit(day))) === 0) continue;

      const rulings = dayRulings.get(day.getTime()) ?? [];
      rulings.sort((a, b) => a.rule.position - b.rule.position);
      const winner = rulings[0] ?? null;

      if (winner?.rule.outcome === 'cancel_day') continue;

      const modify =
        winner?.rule.outcome === 'modify_day'
          ? ((winner.rule.params ?? {}) as ModifyDayParamsLike)
          : null;
      const dtstart = wallTimeToUtc(day, modify?.dayStart ?? link.dayStart, 8, tz);
      const dtend = wallTimeToUtc(day, modify?.dayEnd ?? link.dayEnd, 15, tz);

      events.push({
        synthKey: `bl:${link.id}:${utcDayString(day.getTime())}`,
        sourceEventId: winner?.occ.id ?? null,
        matchedRuleId: winner?.rule.id ?? null,
        dtstart,
        dtend,
        allDay: false,
        summary: link.baselineSummary ?? null,
        location: link.location ?? null,
        locationGeo: link.locationGeo ?? null,
        description: null,
      });
    }
  }

  return { events, pending };
}

// --- Stage B: task generation (typing pipeline) ----------------------------

/** One task rule (typing pipeline). */
export interface TaskRuleLike extends MatcherLike {
  id: string;
  position: number;
  scope: TaskRuleScope;
  /** Which source calendar it lives on; null = the member's unified/direct calendar. */
  linkId: string | null;
  resultType: TaskResultType;
  dropoffWindowMin?: number | null;
  pickupWindowMin?: number | null;
}

/** A calendar's terminal default when no task rule matches. */
export interface TaskDefault {
  resultType: TaskResultType;
  dropoffWindowMin: number;
  pickupWindowMin: number;
}

/** The resolved task shape for an event (from a rule, or the calendar default). */
export interface TaskResolution {
  resultType: TaskResultType;
  dropoffWindowMin: number;
  pickupWindowMin: number;
}

/**
 * The subset of a member's task rules that governs one calendar, in evaluation
 * order: every `all_calendars` rule plus the `this_calendar` rules whose
 * `linkId` matches (null = the unified/direct calendar), sorted by shared
 * `position`. Used both to evaluate task typing and to render the 6k pipeline.
 */
export function taskRulesForCalendar(
  rules: TaskRuleLike[],
  calendarLinkId: string | null,
): TaskRuleLike[] {
  return rules
    .filter(
      (r) =>
        r.scope === 'all_calendars' ||
        (r.scope === 'this_calendar' && (r.linkId ?? null) === calendarLinkId),
    )
    .sort((a, b) => a.position - b.position);
}

/**
 * Resolve what an event on a given calendar should generate: the first matching
 * rule in that calendar's applicable subset, else the calendar's default.
 */
export function resolveTaskResult(
  occ: OccurrenceLike,
  rules: TaskRuleLike[],
  calendarLinkId: string | null,
  fallback: TaskDefault,
): TaskResolution {
  const applicable = taskRulesForCalendar(rules, calendarLinkId);
  const match = firstMatch(occ, applicable);
  if (match) {
    return {
      resultType: match.resultType,
      dropoffWindowMin: match.dropoffWindowMin ?? fallback.dropoffWindowMin,
      pickupWindowMin: match.pickupWindowMin ?? fallback.pickupWindowMin,
    };
  }
  return {
    resultType: fallback.resultType,
    dropoffWindowMin: fallback.dropoffWindowMin,
    pickupWindowMin: fallback.pickupWindowMin,
  };
}

export interface TaskIntent {
  type: TaskType;
  attendanceRequirement: AttendanceRequirement | null;
  dtstart: Date;
  dtend: Date | null;
  location: string | null;
}

/** Pad an anchor instant into a claimable window of `windowMin` minutes. */
function windowEnd(anchor: Date, windowMin: number): Date | null {
  return windowMin > 0 ? new Date(anchor.getTime() + windowMin * 60_000) : null;
}

/**
 * Resolve a transition task's `[dtstart, dtend]` around its anchor for a signed
 * window length (minutes). A positive length extends the window forward from the
 * anchor (`dtstart` at the anchor); a negative length reverses it, placing the
 * window before the anchor (`dtend` at the anchor) so the stored interval stays
 * ordered; 0 collapses to a point (`dtend: null`). Used for user-set duration
 * overrides — the anchor stays fixed to the event while the window flips sides.
 */
export function transitionWindow(
  anchor: Date,
  durationMin: number,
): { dtstart: Date; dtend: Date | null } {
  if (durationMin === 0) return { dtstart: anchor, dtend: null };
  if (durationMin > 0) {
    return { dtstart: anchor, dtend: new Date(anchor.getTime() + durationMin * 60_000) };
  }
  return { dtstart: new Date(anchor.getTime() + durationMin * 60_000), dtend: anchor };
}

/**
 * What claimable tasks an event spawns, given its resolved result type. A
 * `transition` yields a drop-off (padded from the event start) and a pickup
 * (padded from the event end); `attendance` yields one task spanning the event.
 */
export function generateTaskIntents(
  event: { dtstart: Date; dtend: Date | null; location?: string | null },
  resolution: TaskResolution,
): TaskIntent[] {
  const location = event.location ?? null;
  if (resolution.resultType === 'attendance') {
    return [
      {
        type: 'attendance',
        attendanceRequirement: 'any',
        dtstart: event.dtstart,
        dtend: event.dtend,
        location,
      },
    ];
  }
  const pickupAnchor = event.dtend ?? event.dtstart;
  return [
    {
      type: 'dropoff',
      attendanceRequirement: null,
      dtstart: event.dtstart,
      dtend: windowEnd(event.dtstart, resolution.dropoffWindowMin),
      location,
    },
    {
      type: 'pickup',
      attendanceRequirement: null,
      dtstart: pickupAnchor,
      dtend: windowEnd(pickupAnchor, resolution.pickupWindowMin),
      location,
    },
  ];
}

// --- Stage C: conflict detection & masking (a member's unified calendar) -----

/**
 * A member can't be in two places at once. When events on one unified calendar
 * overlap, the higher-priority one wins and the lower-priority *maskable* one is
 * trimmed or split around it. Priority is a plain number, lower wins — the
 * caller maps manual (human) events above every feed, and feeds by their
 * per-member link position (see the conflict service). This stage is pure: it
 * finds the overlaps and computes the split geometry; whether a split is applied
 * is an admin decision recorded outside the engine.
 */

/** An event on a member's calendar as the conflict engine sees it. */
export interface PriorityInterval {
  /** Stable identity — the calendar_event synthKey. */
  key: string;
  dtstart: Date;
  dtend: Date | null;
  /** Lower wins; manual/human events rank above every feed. */
  priority: number;
  /** Only maskable events (synthesized feed events) can be trimmed/split. */
  maskable: boolean;
}

/** A half-open interval [dtstart, dtend). */
export interface Interval {
  dtstart: Date;
  dtend: Date;
}

/**
 * Do two events occupy a common instant? Half-open [start, end): touching
 * edges (one ends exactly as the other starts) don't overlap, and a point event
 * (no end) can't double-book anything.
 */
export function intervalsOverlap(
  a: { dtstart: Date; dtend: Date | null },
  b: { dtstart: Date; dtend: Date | null },
): boolean {
  const ae = a.dtend?.getTime();
  const be = b.dtend?.getTime();
  if (ae == null || be == null) return false;
  return a.dtstart.getTime() < be && b.dtstart.getTime() < ae;
}

/** One detected conflict: a maskable loser overlapped by a higher-priority winner. */
export interface ConflictPair {
  loserKey: string;
  winnerKey: string;
}

/**
 * Every (loser, winner) pair where a maskable event is overlapped by a strictly
 * higher-priority one. Returned in a deterministic order (loser key, then winner
 * key) so the caller can diff against stored conflicts and reconcile.
 */
export function detectConflicts(events: PriorityInterval[]): ConflictPair[] {
  const pairs: ConflictPair[] = [];
  for (const loser of events) {
    if (!loser.maskable || loser.dtend == null) continue;
    for (const winner of events) {
      if (winner.key === loser.key) continue;
      if (winner.priority >= loser.priority) continue; // only a strictly higher event wins
      if (!intervalsOverlap(loser, winner)) continue;
      pairs.push({ loserKey: loser.key, winnerKey: winner.key });
    }
  }
  pairs.sort((a, b) =>
    a.loserKey === b.loserKey
      ? a.winnerKey.localeCompare(b.winnerKey)
      : a.loserKey.localeCompare(b.loserKey),
  );
  return pairs;
}

/**
 * Subtract a set of cut intervals from a base interval, yielding the surviving
 * segments in order. A cut covering the whole base yields none (fully
 * displaced); a cut in the middle splits the base in two (leave + return); a cut
 * at an edge trims it (attend part). Cuts are clamped to the base and merged, so
 * overlapping or adjacent winners collapse into one gap.
 */
export function subtractIntervals(base: Interval, cuts: Interval[]): Interval[] {
  const bs = base.dtstart.getTime();
  const be = base.dtend.getTime();
  if (be <= bs) return [];
  const clamped = cuts
    .map((c) => ({
      s: Math.max(bs, c.dtstart.getTime()),
      e: Math.min(be, c.dtend.getTime()),
    }))
    .filter((c) => c.e > c.s)
    .sort((a, b) => a.s - b.s);
  const out: Interval[] = [];
  let cursor = bs;
  for (const c of clamped) {
    if (c.s > cursor) out.push({ dtstart: new Date(cursor), dtend: new Date(c.s) });
    cursor = Math.max(cursor, c.e);
  }
  if (cursor < be) out.push({ dtstart: new Date(cursor), dtend: new Date(be) });
  return out;
}
