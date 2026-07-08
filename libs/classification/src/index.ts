import {
  parseEcmaRegex,
  type AttendanceRequirement,
  type EventProvenance,
  type OverrideMatchField,
  type OverrideMatchOp,
  type OverrideOutcome,
  type TaskType,
} from '@igt/domain';

/**
 * Pure synthesis + task-generation engine. Two decoupled stages, no I/O:
 *
 *  Stage A — synthesis: feed occurrences + a link's override pipeline decide
 *  what EVENTS land on the member's unified calendar (and which occurrences
 *  become pending decisions instead — the system never guesses).
 *
 *  Stage B — task generation: a unified-calendar event decides what claimable
 *  TASKS it spawns, from the task-gen metadata synthesis stamped on it.
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

// --- Matchers ---------------------------------------------------------------

/** The occurrence fields a matcher can inspect. */
export interface OccurrenceLike {
  summary: string | null;
  location: string | null;
  description?: string | null;
  allDay: boolean;
  dtstart: Date;
  dtend: Date | null;
}

/** One rule of a link's override pipeline (first match wins by `position`). */
export interface OverrideRuleLike {
  id: string;
  position: number;
  matchField: OverrideMatchField;
  matchOp: OverrideMatchOp;
  matchValue: string | null;
  outcome: OverrideOutcome;
  params?: Record<string, unknown> | null;
  generatesTypes?: TaskType[] | null;
  defaultAttendance?: AttendanceRequirement | null;
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

export function ruleMatches(occ: OccurrenceLike, rule: OverrideRuleLike): boolean {
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
export function firstMatch(
  occ: OccurrenceLike,
  rules: OverrideRuleLike[],
): OverrideRuleLike | null {
  const sorted = [...rules].sort((a, b) => a.position - b.position);
  for (const rule of sorted) {
    if (ruleMatches(occ, rule)) return rule;
  }
  return null;
}

// --- Stage A: synthesis ------------------------------------------------------

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
  durationMinutes: number | null;
  location: string | null;
  generatesTypes?: TaskType[] | null;
  defaultAttendance?: AttendanceRequirement | null;
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
  description: string | null;
  annotation: string | null;
  generatesTypes: TaskType[] | null;
  defaultAttendance: AttendanceRequirement | null;
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

interface SetEventParamsLike {
  summary?: string;
  startTime?: string;
  durationMinutes?: number;
  location?: string;
  suppress?: boolean;
}

interface ModifyDayParamsLike {
  dayStart?: string;
  dayEnd?: string;
  durationMinutes?: number;
  location?: string;
}

/** Apply a `set_event` patch to an occurrence-derived event. */
function applySetEvent(
  base: EventIntent,
  params: SetEventParamsLike,
  tz: string,
): EventIntent | null {
  if (params.suppress) return null;
  let dtstart = base.dtstart;
  let dtend = base.dtend;
  let allDay = base.allDay;
  if (params.startTime) {
    dtstart = wallTimeToUtc(startOfUtcDay(base.dtstart), params.startTime, 8, tz);
    allDay = false;
    dtend = base.dtend && base.dtend.getTime() > dtstart.getTime() ? base.dtend : null;
  }
  if (params.durationMinutes != null) {
    dtend =
      params.durationMinutes > 0
        ? new Date(dtstart.getTime() + params.durationMinutes * 60_000)
        : null;
    if (params.durationMinutes > 0) allDay = false;
  }
  return {
    ...base,
    dtstart,
    dtend,
    allDay,
    summary: params.summary ?? base.summary,
    location: params.location ?? base.location,
  };
}

function occurrenceEvent(
  linkId: string,
  occ: SourceOccurrence,
  rule: OverrideRuleLike | null,
  link: LinkConfigLike,
): EventIntent {
  return {
    synthKey: `ev:${linkId}:${occ.id}`,
    sourceEventId: occ.id,
    matchedRuleId: rule?.id ?? null,
    dtstart: occ.dtstart,
    dtend: occ.dtend,
    allDay: occ.allDay,
    summary: occ.summary,
    location: occ.location,
    description: occ.description ?? null,
    annotation: null,
    // Rule config wins; otherwise null ⇒ the downstream default (a single
    // convertible attendance task) — "never guess" at the task-typing layer.
    generatesTypes: rule?.generatesTypes ?? null,
    defaultAttendance: rule?.defaultAttendance ?? link.defaultAttendance ?? null,
  };
}

/**
 * Standard feed: every occurrence lands on the unified calendar as-is unless a
 * rule reshapes or suppresses it. Unmatched occurrences pass through (a
 * standard feed is a real calendar); pending decisions are exception-only.
 * `cancel_day`/`modify_day` rules are baseline concepts and are ignored here
 * (route validation rejects creating them on standard links).
 */
export function synthesizeStandard(
  link: LinkConfigLike,
  occurrences: SourceOccurrence[],
  rules: OverrideRuleLike[],
  tz: string,
): SynthesisResult {
  const applicable = rules.filter(
    (r) => r.outcome !== 'cancel_day' && r.outcome !== 'modify_day',
  );
  const events: EventIntent[] = [];
  for (const occ of occurrences) {
    const rule = firstMatch(occ, applicable);
    const base = occurrenceEvent(link.id, occ, rule, link);
    if (!rule) {
      events.push(base);
      continue;
    }
    if (rule.outcome === 'annotate') {
      const text = (rule.params as { text?: string } | null)?.text ?? null;
      events.push({ ...base, annotation: text });
      continue;
    }
    // set_event
    const patched = applySetEvent(base, (rule.params ?? {}) as SetEventParamsLike, tz);
    if (patched) events.push(patched);
  }
  return { events, pending: [] };
}

export interface SynthesisWindow {
  start: Date;
  end: Date;
}

/**
 * Exception-only feed: normal days come from the link's baseline (weekday mask
 * + day start/end), feed events apply overrides. Per covered day the winning
 * (lowest-position) day-level rule decides: `cancel_day` drops the day's
 * baseline event, `modify_day` patches it, `annotate` keeps it and stamps a
 * note. `set_event` matches synthesize their own extra event and leave the
 * baseline alone. An occurrence matching NO rule becomes a pending decision —
 * the system never guesses — while the baseline stands.
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

  // Evaluate every occurrence once; bucket day-level outcomes by covered day.
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
    if (rule.outcome === 'set_event') {
      const patched = applySetEvent(
        occurrenceEvent(link.id, occ, rule, link),
        (rule.params ?? {}) as SetEventParamsLike,
        tz,
      );
      if (patched) events.push(patched);
      continue;
    }
    for (const day of coveredUtcDays(occ)) {
      (dayRulings.get(day) ?? dayRulings.set(day, []).get(day)!).push({ rule, occ });
    }
  }

  // Expand the baseline over the window, applying each day's winning ruling.
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
      const dayStart = modify?.dayStart ?? link.dayStart;
      const dayEnd = modify?.dayEnd ?? link.dayEnd;
      const duration = modify?.durationMinutes ?? link.durationMinutes;

      const dtstart = wallTimeToUtc(day, dayStart, 8, tz);
      const dtend = dayEnd
        ? wallTimeToUtc(day, dayEnd, 15, tz)
        : duration != null && duration > 0
          ? new Date(dtstart.getTime() + duration * 60_000)
          : null;

      const annotation =
        winner?.rule.outcome === 'annotate'
          ? (((winner.rule.params ?? {}) as { text?: string }).text ??
            winner.occ.summary)
          : null;

      events.push({
        synthKey: `bl:${link.id}:${utcDayString(day.getTime())}`,
        sourceEventId: winner?.occ.id ?? null,
        matchedRuleId: winner?.rule.id ?? null,
        dtstart,
        dtend,
        allDay: false,
        summary: link.baselineSummary ?? null,
        location: modify?.location ?? link.location ?? null,
        description: null,
        annotation: annotation ?? null,
        generatesTypes:
          winner?.rule.generatesTypes ?? link.generatesTypes ?? null,
        defaultAttendance:
          winner?.rule.defaultAttendance ?? link.defaultAttendance ?? null,
      });
    }
  }

  return { events, pending };
}

// --- Stage B: task generation -------------------------------------------------

/** The slice of a unified-calendar event task-gen reads. */
export interface TaskGenEventLike {
  provenance: EventProvenance;
  generatesTypes?: TaskType[] | null;
  defaultAttendance?: AttendanceRequirement | null;
  dtstart: Date;
  dtend: Date | null;
  location?: string | null;
}

export interface TaskIntent {
  type: TaskType;
  attendanceRequirement: AttendanceRequirement | null;
  dtstart: Date;
  dtend: Date | null;
  location: string | null;
}

/**
 * What claimable tasks an event spawns. `claimed_task` events spawn none —
 * that's the recursion guard that keeps a claimed task from re-generating
 * itself up the chain. Events without explicit `generatesTypes` (human events,
 * unconfigured synthesized ones) default to a single convertible attendance
 * task requiring any one caretaker; an empty array is an explicit "generate
 * nothing".
 */
export function generateTaskIntents(event: TaskGenEventLike): TaskIntent[] {
  if (event.provenance === 'claimed_task') return [];

  const location = event.location ?? null;
  const types = event.generatesTypes;
  if (types == null) {
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

  const intents: TaskIntent[] = [];
  for (const type of types) {
    if (type === 'dropoff') {
      intents.push({
        type,
        attendanceRequirement: event.defaultAttendance ?? null,
        dtstart: event.dtstart,
        dtend: null,
        location,
      });
    } else if (type === 'pickup') {
      intents.push({
        type,
        attendanceRequirement: event.defaultAttendance ?? null,
        dtstart: event.dtend ?? event.dtstart,
        dtend: null,
        location,
      });
    } else {
      intents.push({
        type,
        attendanceRequirement: event.defaultAttendance ?? 'any',
        dtstart: event.dtstart,
        dtend: event.dtend,
        location,
      });
    }
  }
  return intents;
}
