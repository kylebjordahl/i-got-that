import {
  and,
  asc,
  calendarEvents,
  type Db,
  eq,
  families,
  familyMembers,
  gte,
  inArray,
  lt,
  ne,
  tasks,
} from '@igt/db';
import type { AssistantCoverageQuery, TaskType } from '@igt/domain';
import { localDateKey, localWallInstant } from './digest.js';
import { withOwners } from './task-owners.js';

/**
 * Answers for a voice assistant — "Who's picking up Felix tomorrow?", "Who's
 * taking Poppy to the doctor on Friday?".
 *
 * The spoken sentence is composed here rather than on the device so every
 * assistant front end (Siri today, an Android one if Google ever opens
 * AppFunctions to third parties) says the same thing, and so the copy can be
 * fixed without shipping an app update. English only, like the rest of the
 * server-side copy (digests, invite mails).
 */

/** What an assistant can resolve "Felix" against: every member of every family the user is in. */
export interface AssistantMember {
  id: string;
  name: string;
  familyId: string;
  familyName: string;
}

export async function assistantMembers(db: Db, userId: string): Promise<AssistantMember[]> {
  const mine = await db
    .select({ familyId: familyMembers.familyId })
    .from(familyMembers)
    .where(eq(familyMembers.userId, userId));
  const familyIds = [...new Set(mine.map((r) => r.familyId))];
  if (familyIds.length === 0) return [];

  const rows = await db
    .select({
      id: familyMembers.id,
      name: familyMembers.relationName,
      familyId: familyMembers.familyId,
      familyName: families.name,
    })
    .from(familyMembers)
    .innerJoin(families, eq(families.id, familyMembers.familyId))
    // Bounded by how many families one person is in, so unchunked is fine.
    .where(inArray(familyMembers.familyId, familyIds))
    .orderBy(asc(familyMembers.relationName));
  return rows;
}

/** One task as the assistant reports it. */
export interface CoverageItem {
  taskId: string;
  type: TaskType;
  /** When it happens: the event's start (drop-off, attendance) or end (pickup). */
  at: Date;
  allDay: boolean;
  summary: string | null;
  ownerNames: string[];
  /** The asker is one of the owners — spoken as "you". */
  includesYou: boolean;
}

export interface CoverageAnswer {
  member: { id: string; name: string };
  date: string;
  items: CoverageItem[];
  /** True when `q` was given but nothing matched it, so `items` is the whole day. */
  queryUnmatched: boolean;
  speech: string;
}

/** Most sentences an answer reads out before summarising the rest — it's a voice reply, not a list. */
const SPOKEN_LIMIT = 4;

/**
 * Load one member's tasks for a local day and phrase them. `null` ⇒ the member
 * isn't in any family the user belongs to (the caller turns that into a 404,
 * never a 403, so ids don't leak).
 */
export async function coverageAnswer(
  db: Db,
  userId: string,
  query: AssistantCoverageQuery,
  now: Date,
): Promise<CoverageAnswer | null> {
  const subject = (
    await db.select().from(familyMembers).where(eq(familyMembers.id, query.memberId)).limit(1)
  )[0];
  if (!subject) return null;

  const people = await db
    .select()
    .from(familyMembers)
    .where(eq(familyMembers.familyId, subject.familyId));
  const me = people.find((p) => p.userId === userId);
  if (!me) return null;
  const names = new Map(people.map((p) => [p.id, p.relationName]));

  const from = localWallInstant(query.date, '00:00', query.tz);
  const to = localWallInstant(nextDateKey(query.date), '00:00', query.tz);

  const rows = await db
    .select({ task: tasks, event: calendarEvents })
    .from(tasks)
    // Not a FK (an owned task outlives its event), so a left join: a task
    // whose event vanished is still somebody's trip and still gets an answer.
    .leftJoin(calendarEvents, eq(calendarEvents.id, tasks.calendarEventId))
    .where(
      and(
        eq(tasks.familyId, subject.familyId),
        eq(tasks.familyMemberId, subject.id),
        ne(tasks.status, 'dismissed'),
        gte(tasks.dtstart, from),
        lt(tasks.dtstart, to),
      ),
    )
    .orderBy(asc(tasks.dtstart));

  const owned = await withOwners(
    db,
    rows.map((r) => r.task),
  );
  let items: CoverageItem[] = owned
    .map((t, i) => {
      const event = rows[i]!.event;
      const anchor = t.type === 'pickup' ? (event?.dtend ?? event?.dtstart) : event?.dtstart;
      return {
        taskId: t.id,
        type: t.type,
        at: anchor ?? t.dtstart,
        allDay: event?.allDay ?? false,
        summary: event?.summary?.trim() || null,
        ownerNames: t.ownerMemberIds
          .filter((id) => id !== me.id)
          .map((id) => names.get(id))
          .filter((n): n is string => !!n),
        includesYou: t.ownerMemberIds.includes(me.id),
      };
    })
    .filter((item) => query.type === 'any' || item.type === query.type);

  let queryUnmatched = false;
  if (query.q) {
    const matched = items.filter((item) => matchesQuery(item.summary, query.q!));
    if (matched.length > 0) items = matched;
    else queryUnmatched = items.length > 0;
  }

  const day = spokenDay(query.date, localDateKey(now, query.tz));
  return {
    member: { id: subject.id, name: subject.relationName },
    date: query.date,
    items,
    queryUnmatched,
    speech: composeSpeech({
      child: subject.relationName,
      day,
      type: query.type,
      q: query.q,
      queryUnmatched,
      items,
      tz: query.tz,
    }),
  };
}

function nextDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

/** Words of a title, lowercased, with possessives and punctuation dropped. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Filler a spoken question carries that says nothing about which event. */
const QUERY_STOPWORDS = new Set(['the', 'a', 'an', 'to', 'at', 'for', 'her', 'his', 'their', 'my']);

/**
 * Loose on purpose: a spoken "the doctor's appointment" has to find "Doctor —
 * Dr. Patel". Any meaningful word of the query starting a word of the title
 * is a match.
 */
export function matchesQuery(summary: string | null, q: string): boolean {
  if (!summary) return false;
  const title = words(summary);
  return words(q)
    .filter((w) => w.length >= 2 && !QUERY_STOPWORDS.has(w))
    .some((w) => title.some((t) => t.startsWith(w) || (t.length >= 3 && w.startsWith(t))));
}

/**
 * How the day is said: "today", "tomorrow", "on Friday" within the coming
 * week, and a full date beyond it — Siri reads a bare weekday as this week's.
 */
export function spokenDay(dateKey: string, todayKey: string): string {
  const days = Math.round((Date.parse(dateKey) - Date.parse(todayKey)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  const noon = new Date(`${dateKey}T12:00:00Z`);
  const weekday = noon.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  if (days > 1 && days < 7) return `on ${weekday}`;
  const date = noon.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return `on ${weekday}, ${date}`;
}

/** "3 PM", "3:15 PM" — the minutes only when they say something. */
function spokenTime(at: Date, tz: string): string {
  return at
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
    .replace(':00', '');
}

/** "Kyle", "Kyle and Sam", "you, Kyle and Sam". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const TYPE_NOUN: Record<TaskType, string> = {
  pickup: 'pickup',
  dropoff: 'drop-off',
  attendance: 'event',
};

/** One task as a clause, without a leading capital or trailing stop. */
function clause(item: CoverageItem, child: string, tz: string): string {
  const when = item.allDay ? '' : ` at ${spokenTime(item.at, tz)}`;
  const title = item.summary;
  const who = item.includesYou ? ['you', ...item.ownerNames] : item.ownerNames;
  const subject = joinNames(who);
  const verb = who.length === 1 && who[0] === 'you' ? "you're" : `${subject} ${who.length > 1 ? 'are' : 'is'}`;

  if (who.length === 0) {
    switch (item.type) {
      case 'pickup':
        return `nobody has ${child}'s pickup${title ? ` from ${title}` : ''}${when} yet`;
      case 'dropoff':
        return `nobody has ${child}'s drop-off${title ? ` at ${title}` : ''}${when} yet`;
      case 'attendance':
        return `nobody is going to ${child}'s ${title ?? 'event'}${when} yet`;
    }
  }
  switch (item.type) {
    case 'pickup':
      return `${verb} picking ${child} up${title ? ` from ${title}` : ''}${when}`;
    case 'dropoff':
      return `${verb} dropping ${child} off${title ? ` at ${title}` : ''}${when}`;
    case 'attendance':
      return `${verb} going to ${child}'s ${title ?? 'event'}${when}`;
  }
}

export function composeSpeech(args: {
  child: string;
  day: string;
  type: AssistantCoverageQuery['type'];
  q?: string;
  queryUnmatched: boolean;
  items: CoverageItem[];
  tz: string;
}): string {
  const { child, day, items, tz } = args;
  if (items.length === 0) {
    if (args.q) return `I couldn't find anything matching "${args.q}" for ${child} ${day}.`;
    if (args.type === 'any') return `I don't see anything for ${child} ${day}.`;
    return `${child} has no ${TYPE_NOUN[args.type]} ${day}.`;
  }

  const sentences = items
    .slice(0, SPOKEN_LIMIT)
    .map((item, i) =>
      i === 0 ? `${capitalize(day)}, ${clause(item, child, tz)}.` : `${capitalize(clause(item, child, tz))}.`,
    );
  const rest = items.length - SPOKEN_LIMIT;
  if (rest > 0) sentences.push(`And ${rest} more — open IGT to see them.`);
  if (args.queryUnmatched) {
    sentences.unshift(`I couldn't find anything matching "${args.q}", but here's ${child}'s day.`);
  }
  return sentences.join(' ');
}
