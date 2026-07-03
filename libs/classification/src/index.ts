import type {
  AttendanceRequirement,
  RuleEffect,
  RuleMatchField,
  RuleMatchOp,
  TaskType,
} from '@igt/domain';

/**
 * Pure classification engine. Given feed occurrences + rules it decides what
 * tasks to create (explicit feeds) or how exceptions modify a baseline
 * (inverted feeds). No I/O — fully unit-testable.
 */

export interface OccurrenceLike {
  summary: string | null;
  location: string | null;
  description?: string | null;
}

export interface RuleLike {
  /** null = family-global rule; set = scoped to a single feed. */
  feedId?: string | null;
  priority: number;
  matchField: RuleMatchField;
  matchOp: RuleMatchOp;
  matchValue: string;
  effect: RuleEffect;
  producesTypes?: TaskType[] | null;
  defaultAttendance?: AttendanceRequirement | null;
  shiftToTime?: string | null;
  defaultOwnerMemberId?: string | null;
}

function fieldValue(occ: OccurrenceLike, field: RuleMatchField): string {
  switch (field) {
    case 'summary':
      return occ.summary ?? '';
    case 'location':
      return occ.location ?? '';
    case 'description':
      return occ.description ?? '';
  }
}

export function ruleMatches(occ: OccurrenceLike, rule: RuleLike): boolean {
  const value = fieldValue(occ, rule.matchField);
  switch (rule.matchOp) {
    case 'contains':
      return value.toLowerCase().includes(rule.matchValue.toLowerCase());
    case 'equals':
      return value === rule.matchValue;
    case 'regex':
      try {
        return new RegExp(rule.matchValue).test(value);
      } catch {
        return false;
      }
  }
}

/**
 * Highest-precedence matching rule, or null. Precedence: feed-scoped rules win
 * over global on ties, then lower `priority` first.
 */
export function pickRule(occ: OccurrenceLike, rules: RuleLike[]): RuleLike | null {
  const matched = rules.filter((r) => ruleMatches(occ, r));
  if (matched.length === 0) return null;
  matched.sort((a, b) => {
    const aScoped = a.feedId != null ? 0 : 1;
    const bScoped = b.feedId != null ? 0 : 1;
    if (aScoped !== bScoped) return aScoped - bScoped;
    return a.priority - b.priority;
  });
  return matched[0] ?? null;
}

export interface TaskIntent {
  type: TaskType;
  attendanceRequirement: AttendanceRequirement | null;
  defaultOwnerMemberId: string | null;
}

/**
 * Explicit feed: an occurrence becomes task intents. A matching `create` rule
 * decides the types (an empty `producesTypes` yields none — an admin can
 * intentionally suppress a match). When no `create` rule matches, the occurrence
 * falls back to a single "attendance" task requiring any one caretaker; the user
 * can later convert it to pickup and/or drop-off.
 */
export function classifyExplicit(
  occ: OccurrenceLike,
  rules: RuleLike[],
): TaskIntent[] {
  const rule = pickRule(occ, rules);
  if (rule && rule.effect === 'create') {
    return (rule.producesTypes ?? []).map((type) => ({
      type,
      attendanceRequirement: rule.defaultAttendance ?? null,
      defaultOwnerMemberId: rule.defaultOwnerMemberId ?? null,
    }));
  }
  return [{ type: 'attendance', attendanceRequirement: 'any', defaultOwnerMemberId: null }];
}

export interface BaselineDay {
  /** The baseline task types for this school day, e.g. ['pickup','dropoff']. */
  types: TaskType[];
  /** Default pickup time "HH:MM" (may be shifted by an exception). */
  pickupTime?: string;
}

export interface ResolvedDay {
  cancelled: boolean;
  types: TaskType[];
  pickupTime?: string;
  /** The matched exception effect, for observability/tests. */
  appliedEffect: RuleEffect | 'none';
}

/**
 * Exception/inverted feed: apply the day's matched exception events to the
 * baseline. `cancel` removes the day; `shift` moves the pickup; `ignore` and
 * unmatched events leave the baseline intact (so "picture day" stays a normal
 * school day). The highest-precedence matching rule across the day's events
 * wins.
 */
export function resolveExceptionDay(
  baseline: BaselineDay,
  dayOccurrences: OccurrenceLike[],
  rules: RuleLike[],
): ResolvedDay {
  let chosen: RuleLike | null = null;
  for (const occ of dayOccurrences) {
    const rule = pickRule(occ, rules);
    if (!rule) continue;
    if (!chosen) {
      chosen = rule;
      continue;
    }
    const moreScoped =
      (rule.feedId != null ? 0 : 1) - (chosen.feedId != null ? 0 : 1);
    if (moreScoped < 0 || (moreScoped === 0 && rule.priority < chosen.priority)) {
      chosen = rule;
    }
  }

  if (!chosen || chosen.effect === 'ignore') {
    return {
      cancelled: false,
      types: baseline.types,
      pickupTime: baseline.pickupTime,
      appliedEffect: chosen ? 'ignore' : 'none',
    };
  }
  if (chosen.effect === 'cancel') {
    return { cancelled: true, types: [], appliedEffect: 'cancel' };
  }
  if (chosen.effect === 'shift') {
    return {
      cancelled: false,
      types: baseline.types,
      pickupTime: chosen.shiftToTime ?? baseline.pickupTime,
      appliedEffect: 'shift',
    };
  }
  // `create` is meaningless on exception feeds — treat as no-op.
  return {
    cancelled: false,
    types: baseline.types,
    pickupTime: baseline.pickupTime,
    appliedEffect: 'none',
  };
}
