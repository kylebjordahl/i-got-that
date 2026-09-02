import {
  and,
  asc,
  calendarEvents,
  conflicts,
  type Db,
  eq,
  families,
  familyMembers,
  gte,
  inArray,
  lt,
  pendingDecisions,
  sourceEvents,
  taskOwners,
  tasks,
} from '@igt/db';
import { DAY_MS, tzOffsetMs } from '@igt/classification';
import type { NotificationCategory } from '@igt/domain';
import { hydrateConflicts } from './conflicts.js';

/**
 * "What still needs a human before tomorrow", computed for one user across
 * every family they belong to.
 *
 * This is the server-side twin of Home (`home_screen.dart`), and it keeps
 * Home's ranking on purpose — conflicts first (a member can't be in two places
 * at once), then pending decisions (they block the pipeline until someone
 * answers), then the unclaimed queue, and only then what you're already
 * covering. A digest that ordered these differently would teach a different
 * priority than the screen the user opens next.
 */

/** A local-day window, resolved to the UTC instants the tables are stored in. */
export interface DigestWindow {
  from: Date;
  to: Date;
}

export interface DigestItem {
  /** One line of copy, already family-qualified when the user has more than one. */
  label: string;
  at: Date;
}

export interface DigestBucket {
  category: NotificationCategory;
  count: number;
  /** A few representative items, most imminent first, for the notification body. */
  items: DigestItem[];
}

export interface UserDigest {
  window: DigestWindow;
  buckets: DigestBucket[];
  total: number;
  /**
   * The part of `total` that still needs a human: everything except
   * `my_tasks`, which is a reminder of work you've *already* taken on rather
   * than a gap.
   *
   * This — not `total` — is what the app-icon badge counts, and it's the whole
   * reason the badge can reach zero: claim the last unowned task and the work
   * moves from `unclaimed_tasks` into `my_tasks`, so `total` stays put while
   * `actionable` drops to 0.
   */
  actionable: number;
  /** The families the digest drew from, for the tap-through payload. */
  familyIds: string[];
}

/** How many sample lines each bucket carries. The body only has room for a few. */
const SAMPLE_LIMIT = 3;

/**
 * Home's order, which the digest inherits. `my_tasks` is a reminder of what
 * you've taken on rather than a gap, so it always sorts last regardless of how
 * the schedule listed its categories.
 */
const CATEGORY_ORDER: NotificationCategory[] = [
  'conflicts',
  'pending_decisions',
  'unclaimed_tasks',
  'my_tasks',
];

/**
 * Start of the local calendar day containing `at`, as a UTC instant. Same
 * shape as `wallTimeToUtc` in `@igt/classification` — shift the instant into
 * local wall-clock parts, rebuild midnight from those parts, then subtract the
 * zone's offset to get back to a real instant.
 */
export function startOfLocalDay(at: Date, tz: string): Date {
  const local = new Date(at.getTime() + tzOffsetMs(tz, at.getTime()));
  const guess = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  return new Date(guess - tzOffsetMs(tz, guess));
}

/** The local calendar date of an instant in `tz`, as `YYYY-MM-DD`. */
export function localDateKey(at: Date, tz: string): string {
  return new Date(at.getTime() + tzOffsetMs(tz, at.getTime()))
    .toISOString()
    .slice(0, 10);
}

/**
 * The instant at which `hhmm` wall clock occurs on the local calendar date
 * `dateKey` in `tz`. Same guess-then-correct shape as `wallTimeToUtc`, but
 * keyed by a date string rather than a Date whose UTC parts happen to carry
 * the local date.
 */
export function localWallInstant(dateKey: string, hhmm: string, tz: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh ?? 0, mm ?? 0);
  return new Date(guess - tzOffsetMs(tz, guess));
}

/**
 * `n` local calendar days after the local midnight `day`.
 *
 * Adding `n * DAY_MS` alone is wrong across a DST boundary — 24 hours after a
 * spring-forward midnight is 1am the next day, not midnight — so the sum lands
 * mid-afternoon and is re-anchored to that day's true midnight.
 */
function addLocalDays(day: Date, n: number, tz: string): Date {
  return startOfLocalDay(new Date(day.getTime() + n * DAY_MS + DAY_MS / 2), tz);
}

/**
 * The window a schedule is asking about:
 *
 *   from = startOfLocalDay(now) + startOffsetDays days   (clamped to `now` at 0)
 *   to   = that anchor          + horizonDays days
 *
 * An evening "what's outstanding tomorrow" brief is `(1, 1)`; a morning "rest
 * of today" is `(0, 1)`. The clamp is what stops a 7am "today" digest from
 * reporting the 6am drop-off it's already too late to claim.
 */
export function digestWindow(
  now: Date,
  tz: string,
  startOffsetDays: number,
  horizonDays: number,
): DigestWindow {
  const anchor = addLocalDays(startOfLocalDay(now, tz), startOffsetDays, tz);
  const to = addLocalDays(anchor, horizonDays, tz);
  const from = anchor.getTime() < now.getTime() ? now : anchor;
  return { from, to };
}

/** The user's membership in every family, which every bucket below is scoped by. */
export interface UserScope {
  familyIds: string[];
  /** The caller's own member row per family — `my_tasks` is keyed by these. */
  memberIds: string[];
  /** Families where the caller can actually claim work (`isCaretaker`). */
  caretakerFamilyIds: string[];
  familyNames: Map<string, string>;
}

export async function loadUserScope(db: Db, userId: string): Promise<UserScope> {
  const rows = await db
    .select({ member: familyMembers, familyName: families.name })
    .from(familyMembers)
    .innerJoin(families, eq(families.id, familyMembers.familyId))
    .where(eq(familyMembers.userId, userId));

  return {
    familyIds: [...new Set(rows.map((r) => r.member.familyId))],
    memberIds: rows.map((r) => r.member.id),
    caretakerFamilyIds: rows
      .filter((r) => r.member.isCaretaker)
      .map((r) => r.member.familyId),
    familyNames: new Map(rows.map((r) => [r.member.familyId, r.familyName])),
  };
}

/**
 * Prefix a line with its family when the user belongs to more than one — the
 * whole point of aggregating into a single push is that "Ada's pickup" is
 * ambiguous across two households.
 */
function qualify(scope: UserScope, familyId: string, text: string): string {
  if (scope.familyIds.length < 2) return text;
  const name = scope.familyNames.get(familyId);
  return name ? `${name}: ${text}` : text;
}

function bucket(
  category: NotificationCategory,
  count: number,
  items: DigestItem[],
): DigestBucket {
  return { category, count, items: items.slice(0, SAMPLE_LIMIT) };
}

/** Tasks nobody has claimed yet, in the window — Home's "Needs an owner". */
async function unclaimedTasks(
  db: Db,
  scope: UserScope,
  window: DigestWindow,
): Promise<DigestBucket> {
  // Only families where the caller is a caretaker: a dependent with a login
  // shouldn't be told to go claim a pickup they can't claim.
  if (scope.caretakerFamilyIds.length === 0) return bucket('unclaimed_tasks', 0, []);
  const rows = await db
    .select({
      familyId: tasks.familyId,
      type: tasks.type,
      dtstart: tasks.dtstart,
      relationName: familyMembers.relationName,
    })
    .from(tasks)
    .innerJoin(familyMembers, eq(familyMembers.id, tasks.familyMemberId))
    .where(
      and(
        inArray(tasks.familyId, scope.caretakerFamilyIds),
        eq(tasks.status, 'unowned'),
        gte(tasks.dtstart, window.from),
        lt(tasks.dtstart, window.to),
      ),
    )
    .orderBy(asc(tasks.dtstart));

  return bucket(
    'unclaimed_tasks',
    rows.length,
    rows.map((r) => ({
      label: qualify(scope, r.familyId, `${r.relationName} ${r.type}`),
      at: r.dtstart,
    })),
  );
}

/** What the caller has already taken on, in the window — Home's "You're covering". */
async function myTasks(
  db: Db,
  scope: UserScope,
  window: DigestWindow,
): Promise<DigestBucket> {
  if (scope.memberIds.length === 0) return bucket('my_tasks', 0, []);
  const rows = await db
    .select({
      familyId: tasks.familyId,
      type: tasks.type,
      dtstart: tasks.dtstart,
      relationName: familyMembers.relationName,
    })
    .from(tasks)
    .innerJoin(familyMembers, eq(familyMembers.id, tasks.familyMemberId))
    // A task can be covered by several caretakers (both parents at the same
    // recital); the join is on the caller's own claim, so it still yields one
    // row per task of theirs.
    .innerJoin(taskOwners, eq(taskOwners.taskId, tasks.id))
    .where(
      and(
        inArray(tasks.familyId, scope.familyIds),
        eq(tasks.status, 'owned'),
        inArray(taskOwners.familyMemberId, scope.memberIds),
        gte(tasks.dtstart, window.from),
        lt(tasks.dtstart, window.to),
      ),
    )
    .orderBy(asc(tasks.dtstart));

  return bucket(
    'my_tasks',
    rows.length,
    rows.map((r) => ({
      label: qualify(scope, r.familyId, `${r.relationName} ${r.type}`),
      at: r.dtstart,
    })),
  );
}

/**
 * Events the pipeline couldn't place — an unmatched exception-feed event, or an
 * event on a routed shared calendar that no member's rules claimed.
 *
 * A routing decision is raised **once per link**, all sharing a `sourceEventId`,
 * because it's the same question asked of every member ("whose is this?"). The
 * client groups them into one card and one resolve answers the whole group, so
 * the digest counts distinct source events — otherwise a family with four kids
 * reads as four questions when it's one.
 */
async function pendingDecisionCount(
  db: Db,
  scope: UserScope,
  window: DigestWindow,
): Promise<DigestBucket> {
  const rows = await db
    .select({
      familyId: pendingDecisions.familyId,
      sourceEventId: pendingDecisions.sourceEventId,
      summary: sourceEvents.summary,
      dtstart: sourceEvents.dtstart,
    })
    .from(pendingDecisions)
    .innerJoin(sourceEvents, eq(sourceEvents.id, pendingDecisions.sourceEventId))
    .where(
      and(
        inArray(pendingDecisions.familyId, scope.familyIds),
        eq(pendingDecisions.status, 'pending'),
        gte(sourceEvents.dtstart, window.from),
        lt(sourceEvents.dtstart, window.to),
      ),
    )
    .orderBy(asc(sourceEvents.dtstart));

  const seen = new Set<string>();
  const items: DigestItem[] = [];
  for (const r of rows) {
    if (seen.has(r.sourceEventId)) continue;
    seen.add(r.sourceEventId);
    items.push({
      label: qualify(scope, r.familyId, r.summary ?? 'Untitled event'),
      at: r.dtstart,
    });
  }
  return bucket('pending_decisions', seen.size, items);
}

/**
 * Open agenda overlaps whose *loser* falls in the window. A conflict carries no
 * time of its own — its identity is the pair of event `synthKey`s — so this has
 * to hydrate before it can filter by date.
 */
async function conflictCount(
  db: Db,
  scope: UserScope,
  window: DigestWindow,
): Promise<DigestBucket> {
  const rows = await db
    .select()
    .from(conflicts)
    .where(
      and(
        inArray(conflicts.familyId, scope.familyIds),
        eq(conflicts.status, 'pending'),
      ),
    )
    .orderBy(asc(conflicts.createdAt));

  const hydrated = await hydrateConflicts(db, scope.familyIds, rows);
  const inWindow = hydrated
    .filter(
      ({ loser }) =>
        loser.dtstart.getTime() >= window.from.getTime() &&
        loser.dtstart.getTime() < window.to.getTime(),
    )
    .sort((a, b) => a.loser.dtstart.getTime() - b.loser.dtstart.getTime());

  return bucket(
    'conflicts',
    inWindow.length,
    inWindow.map(({ conflict, loser, winner }) => ({
      label: qualify(
        scope,
        conflict.familyId,
        `${loser.summary ?? 'Untitled'} vs ${winner.summary ?? 'Untitled'}`,
      ),
      at: loser.dtstart,
    })),
  );
}

/**
 * Build the digest for one user over one window. Each category is a single
 * query batched across every family the user belongs to — never a loop per
 * family, since this runs on the cron tick for every due schedule.
 *
 * Buckets with a zero count are dropped: the copy only ever mentions what's
 * actually outstanding.
 */
export async function buildUserDigest(
  db: Db,
  userId: string,
  window: DigestWindow,
  categories: NotificationCategory[],
): Promise<UserDigest> {
  const scope = await loadUserScope(db, userId);
  if (scope.familyIds.length === 0) {
    return { window, buckets: [], total: 0, actionable: 0, familyIds: [] };
  }

  const wanted = new Set(categories);
  const built = await Promise.all(
    CATEGORY_ORDER.filter((c) => wanted.has(c)).map((category) => {
      switch (category) {
        case 'conflicts':
          return conflictCount(db, scope, window);
        case 'pending_decisions':
          return pendingDecisionCount(db, scope, window);
        case 'unclaimed_tasks':
          return unclaimedTasks(db, scope, window);
        case 'my_tasks':
          return myTasks(db, scope, window);
      }
    }),
  );

  const buckets = built.filter((b) => b.count > 0);
  return {
    window,
    buckets,
    total: buckets.reduce((sum, b) => sum + b.count, 0),
    actionable: buckets
      .filter((b) => b.category !== 'my_tasks')
      .reduce((sum, b) => sum + b.count, 0),
    familyIds: scope.familyIds,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The phrase a bucket contributes to the notification body. */
function bucketPhrase(b: DigestBucket): string {
  switch (b.category) {
    case 'conflicts':
      return plural(b.count, 'double-booking', 'double-bookings');
    case 'pending_decisions':
      return plural(b.count, 'event to sort out', 'events to sort out');
    case 'unclaimed_tasks':
      return plural(b.count, 'unclaimed task', 'unclaimed tasks');
    case 'my_tasks':
      return `${plural(b.count, 'task', 'tasks')} you're covering`;
  }
}

/**
 * Notification copy for a digest: a title naming the window in plain language,
 * and a body that leads with the counts and then names the most imminent item
 * so the push says something concrete even from the lock screen.
 */
export function digestNotificationText(
  digest: UserDigest,
  now: Date,
  tz: string,
): { title: string; body: string } {
  const today = startOfLocalDay(now, tz).getTime();
  const start = startOfLocalDay(digest.window.from, tz).getTime();
  const dayOffset = Math.round((start - today) / DAY_MS);
  const spansOneDay =
    startOfLocalDay(new Date(digest.window.to.getTime() - 1), tz).getTime() === start;

  let when: string;
  if (!spansOneDay) when = 'Coming up';
  else if (dayOffset <= 0) when = 'Today';
  else if (dayOffset === 1) when = 'Tomorrow';
  else
    when = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz }).format(
      digest.window.from,
    );

  const title = `${when}: ${plural(digest.total, 'thing needs you', 'things need you')}`;
  const counts = digest.buckets.map(bucketPhrase).join(' · ');
  const first = digest.buckets[0]?.items[0]?.label;
  const body = first ? `${counts} — starting with ${first}` : counts;
  return { title, body };
}
