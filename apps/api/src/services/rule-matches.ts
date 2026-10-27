import {
  and,
  asc,
  calendarEvents,
  type Db,
  eq,
  familyMemberFeeds,
  familyMembers,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sourceEvents,
  tasks,
} from '@igt/db';
import {
  DAY_MS,
  resolveTaskResult,
  ruleMatches,
  startOfUtcDay,
  type TaskDefault,
  type TaskRuleLike,
  taskRulesForCalendar,
} from '@igt/classification';
import { RULE_MATCH_WINDOW_MAX_DAYS, type TaskRuleResultType } from '@igt/domain';
import { selectChunked } from '../lib/d1.js';
import { taskRuleOmissions } from './task-gen.js';
import { type TaskWithOwners, withOwners } from './task-owners.js';

/** A rule's match list covers the past and next 30 days unless asked otherwise. */
export function defaultMatchWindow(now = new Date()): { from: Date; to: Date } {
  const today = startOfUtcDay(now);
  return {
    from: new Date(today.getTime() - 30 * DAY_MS),
    to: new Date(today.getTime() + 31 * DAY_MS),
  };
}

/**
 * The window a request asks for, with either bound defaulted, checked after the
 * defaults apply: ordered, and at most `RULE_MATCH_WINDOW_MAX_DAYS` long.
 * Null when it isn't — the route answers 400.
 */
export function resolveMatchWindow(
  from?: string,
  to?: string,
  now = new Date(),
): { from: Date; to: Date } | null {
  const fallback = defaultMatchWindow(now);
  const window = {
    from: from ? new Date(from) : fallback.from,
    to: to ? new Date(to) : fallback.to,
  };
  const span = window.to.getTime() - window.from.getTime();
  return span > 0 && span <= RULE_MATCH_WINDOW_MAX_DAYS * DAY_MS ? window : null;
}

/**
 * How a rule stands on one event it matches:
 *  - `applies`: it's the first match, so it decides what the event generates;
 *  - `shadowed`: an earlier rule matches first and decides instead;
 *  - `omitted`: the event was excepted from this rule, so it falls through.
 */
export type TaskRuleMatchStatus = 'applies' | 'shadowed' | 'omitted';

export interface TaskRuleMatch {
  event: {
    id: string;
    summary: string | null;
    dtstart: Date;
    dtend: Date | null;
    allDay: boolean;
    linkId: string | null;
    provenance: string;
  };
  status: TaskRuleMatchStatus;
  /** The rule that actually decides the event (null: its calendar's default). */
  decidedByRuleId: string | null;
  /** What the pipeline says the event generates. */
  resultType: TaskRuleResultType;
  /**
   * The event's tasks were converted by hand, which freezes them: no rule
   * changes what it has.
   */
  converted: boolean;
  /** The event's current tasks (omitted from a preview). */
  tasks?: TaskWithOwners[];
}

/**
 * Every event in `window` on the member's calendars that `target`'s matcher
 * catches within its calendar scope, with how the member's `pipeline` (which
 * must contain `target`, saved or a draft) resolves each one.
 *
 * Shadowed matches are listed on purpose: they're what you need to see to
 * tighten a broad rule, and they start counting the moment the rule above them
 * changes. Events that can never carry tasks — claims, free/busy blocks, a
 * conflict-masked original — aren't.
 */
export async function matchTaskRule(
  db: Db,
  memberId: string,
  target: TaskRuleLike,
  pipeline: TaskRuleLike[],
  window: { from: Date; to: Date },
  opts: { withTasks: boolean },
): Promise<TaskRuleMatch[]> {
  const member = (
    await db.select().from(familyMembers).where(eq(familyMembers.id, memberId)).limit(1)
  )[0];
  if (!member) return [];

  const events = (
    await db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.familyMemberId, memberId),
          ne(calendarEvents.provenance, 'claimed_task'),
          isNull(calendarEvents.maskedAt),
          gte(calendarEvents.dtstart, window.from),
          lt(calendarEvents.dtstart, window.to),
        ),
      )
      .orderBy(asc(calendarEvents.dtstart))
  ).filter(
    (e) =>
      !e.synthKey.startsWith('fb:') &&
      taskRulesForCalendar([target], e.linkId ?? null).length > 0,
  );

  // A feed event's DESCRIPTION is on its source row, never the calendar event;
  // read it only when some rule in the pipeline matches on one.
  const needsDescription = pipeline.some(
    (r) => r.matchField === 'description' || r.matchField === 'any_text',
  );
  const sourceIds = needsDescription
    ? [
        ...new Set(
          events.flatMap((e) =>
            e.description == null && e.sourceEventId ? [e.sourceEventId] : [],
          ),
        ),
      ]
    : [];
  const sourceDescriptions = new Map(
    (
      await selectChunked(sourceIds, (chunk) =>
        db
          .select({ id: sourceEvents.id, description: sourceEvents.description })
          .from(sourceEvents)
          .where(and(inArray(sourceEvents.id, chunk), isNotNull(sourceEvents.description))),
      )
    ).map((r): [string, string | null] => [r.id, r.description]),
  );
  const occurrence = (e: (typeof events)[number]) => ({
    summary: e.summary,
    location: e.location,
    description:
      e.description ??
      (e.sourceEventId ? sourceDescriptions.get(e.sourceEventId) : null) ??
      null,
    allDay: e.allDay,
    dtstart: e.dtstart,
    dtend: e.dtend,
  });

  const matched = events.filter((e) => ruleMatches(occurrence(e), target));
  if (matched.length === 0) return [];

  const links = await db
    .select()
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.familyMemberId, memberId));
  const linkDefault = new Map<string, TaskDefault>(
    links.map((l) => [
      l.id,
      {
        resultType: l.defaultTaskType,
        dropoffWindowMin: l.defaultDropoffWindowMin,
        pickupWindowMin: l.defaultPickupWindowMin,
      },
    ]),
  );
  const unifiedDefault: TaskDefault = {
    resultType: member.unifiedDefaultTaskType,
    dropoffWindowMin: member.unifiedDropoffWindowMin,
    pickupWindowMin: member.unifiedPickupWindowMin,
  };

  const ids = matched.map((e) => e.id);
  const omissions = await taskRuleOmissions(db, ids);
  const taskRows = await selectChunked(ids, (chunk) =>
    db.select().from(tasks).where(inArray(tasks.calendarEventId, chunk)),
  );
  const tasksByEvent = new Map<string, (typeof taskRows)[number][]>();
  for (const t of taskRows) {
    const list = tasksByEvent.get(t.calendarEventId!) ?? [];
    list.push(t);
    tasksByEvent.set(t.calendarEventId!, list);
  }
  const decorated = opts.withTasks ? await withOwners(db, taskRows) : [];
  const decoratedByEvent = new Map<string, TaskWithOwners[]>();
  for (const t of decorated) {
    const list = decoratedByEvent.get(t.calendarEventId!) ?? [];
    list.push(t);
    decoratedByEvent.set(t.calendarEventId!, list);
  }

  return matched.map((e) => {
    const omitted = omissions.get(e.id);
    const resolution = resolveTaskResult(
      occurrence(e),
      pipeline,
      e.linkId ?? null,
      (e.linkId && linkDefault.get(e.linkId)) || unifiedDefault,
      omitted,
    );
    const status: TaskRuleMatchStatus = omitted?.has(target.id)
      ? 'omitted'
      : resolution.ruleId === target.id
        ? 'applies'
        : 'shadowed';
    return {
      event: {
        id: e.id,
        summary: e.summary,
        dtstart: e.dtstart,
        dtend: e.dtend,
        allDay: e.allDay,
        linkId: e.linkId ?? null,
        provenance: e.provenance,
      },
      status,
      decidedByRuleId: resolution.ruleId,
      resultType: resolution.resultType,
      converted: (tasksByEvent.get(e.id) ?? []).some((t) => t.createdVia === 'manual'),
      ...(opts.withTasks ? { tasks: decoratedByEvent.get(e.id) ?? [] } : {}),
    };
  });
}
