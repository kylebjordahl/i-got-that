import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  ApnsEnvironment,
  AttendanceRequirement,
  ConflictStatus,
  EventProvenance,
  ExternalAccountKind,
  FeedKind,
  FeedMode,
  FeedStatus,
  GeoLocation,
  IdentityProvider,
  InviteStatus,
  InviteType,
  MirrorMethod,
  MirrorStatus,
  NotificationCategory,
  OverrideMatchField,
  OverrideMatchOp,
  OverrideOutcome,
  PendingDecisionKind,
  PendingDecisionStatus,
  PushPlatform,
  TaskCreatedVia,
  TaskResultType,
  TaskRuleScope,
  TaskStatus,
  TaskType,
} from '@igt/domain';

/**
 * D1 (SQLite) schema. Every family-owned row carries `familyId`; all
 * tenant-scoped queries must go through the helpers in ./tenancy so a caller
 * can only ever touch rows for a family they belong to.
 */

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date());

// --- Identity ------------------------------------------------------------

export const users = sqliteTable('users', {
  id: id(),
  // Login account only. No email on the user — email lives on identities and,
  // separately, on email delivery targets.
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: createdAt(),
});

export const identities = sqliteTable(
  'identities',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: IdentityProvider.options }).notNull(),
    // Apple subject, or the email used for magic-link login. Intentionally
    // distinct from any calendar-invite delivery address.
    providerRef: text('provider_ref').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    providerRefUq: uniqueIndex('identities_provider_ref_uq').on(
      t.provider,
      t.providerRef,
    ),
    userIdx: index('identities_user_idx').on(t.userId),
  }),
);

// --- Tenancy -------------------------------------------------------------

export const families = sqliteTable('families', {
  id: id(),
  name: text('name').notNull(),
  // Max gap (minutes) between adjacent tasks for the client to render them as
  // one threaded "trip". Presentation-only; nothing server-side keys off it.
  threadingThresholdMinutes: integer('threading_threshold_minutes')
    .notNull()
    .default(30),
  createdAt: createdAt(),
});

/**
 * Unified person record. `userId` null ⇒ cannot log in (a child, or a
 * caretaker tracked but not using the app). Capabilities are independent
 * booleans; `requiresCaretaker` flags a dependent (replaces a separate child
 * table).
 */
export const familyMembers = sqliteTable(
  'family_members',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    relationName: text('relation_name').notNull(),
    isCaretaker: integer('is_caretaker', { mode: 'boolean' })
      .notNull()
      .default(false),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    requiresCaretaker: integer('requires_caretaker', { mode: 'boolean' })
      .notNull()
      .default(false),
    // When false, this member's unified-calendar events don't spawn claimable
    // family tasks (their calendar defaults + task rules are kept for later).
    generatesFamilyTasks: integer('generates_family_tasks', { mode: 'boolean' })
      .notNull()
      .default(true),
    /** Persistent per-person accent color (hex `#RRGGBB`). Null ⇒ derived client-side. */
    color: text('color'),
    // Where this person's day starts and ends. Display text plus (when the
    // client could geocode it) coordinates: the mirror measures travel time
    // from here whenever a trip has no earlier event to leave from — the first
    // thing in the morning, or anything after a long unscheduled gap.
    homeLocation: text('home_location'),
    homeLocationGeo: text('home_location_geo', { mode: 'json' }).$type<GeoLocation>(),
    // The task-rule terminal default for this member's own unified/direct
    // calendar (events added by hand, not synthesized from a feed).
    unifiedDefaultTaskType: text('unified_default_task_type', {
      enum: TaskResultType.options,
    })
      .notNull()
      .default('attendance'),
    unifiedDropoffWindowMin: integer('unified_dropoff_window_min')
      .notNull()
      .default(15),
    unifiedPickupWindowMin: integer('unified_pickup_window_min')
      .notNull()
      .default(15),
    createdAt: createdAt(),
  },
  (t) => ({
    familyIdx: index('family_members_family_idx').on(t.familyId),
    userIdx: index('family_members_user_idx').on(t.userId),
  }),
);

// --- External accounts (user-owned calendar connections) -----------------

/**
 * A calendar account (Google, iCloud, generic CalDAV) connected by a single
 * user. Private to that user but reusable across every family they belong to;
 * only the owner may draw its calendars into input/output feeds. The credential
 * lives in `secrets` with `familyId = null` (user-owned, not family-scoped).
 */
export const externalAccounts = sqliteTable(
  'external_accounts',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ExternalAccountKind.options }).notNull(),
    name: text('name').notNull(),
    // CalDAV server/base URL (iCloud uses a well-known default); null for google.
    serverUrl: text('server_url'),
    // Basic-auth username for caldav/icloud (display + auth); null for google.
    username: text('username'),
    credentialsRef: text('credentials_ref').references(() => secrets.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index('external_accounts_user_idx').on(t.userId),
  }),
);

// --- Feeds & baselines ---------------------------------------------------

export const feeds = sqliteTable(
  'feeds',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: FeedKind.options }).notNull().default('ics'),
    // ICS feeds: the public URL. Account feeds: null (source lives on the account).
    url: text('url'),
    // Account-backed feeds: the connected account + its immutable target calendar
    // (CalDAV collection URL or Google calendar id). Null for ICS feeds.
    externalAccountId: text('external_account_id').references(
      () => externalAccounts.id,
      { onDelete: 'set null' },
    ),
    sourceCalendarId: text('source_calendar_id'),
    sourceCalendarName: text('source_calendar_name'),
    mode: text('mode', { enum: FeedMode.options }).notNull(),
    // Shared family calendar: one calendar carrying several members' events, so
    // each link's rules become a per-member FILTER (`keep`) rather than a
    // pass-through. Deliberately a property of the FEED, not of a link — the
    // whole point is that turning it on from any one member's copy of the
    // calendar puts every linked member on the routed pipeline, and that an
    // event no link keeps is a single family-level routing decision rather than
    // one per member. `standard` mode only.
    routed: integer('routed', { mode: 'boolean' }).notNull().default(false),
    // IANA timezone the calendar's wall-clock times are in — auto-detected from
    // the feed's own X-WR-TIMEZONE/VTIMEZONE on sync, or set manually for feeds
    // that never advertise one (e.g. some booking-software ICS exports). Used
    // to interpret exception baseline times and the feed's own floating
    // (zone-less) VEVENT times. Null ⇒ exception baselines treated as UTC and
    // floating VEVENT times fall back to the host runtime's timezone.
    timezone: text('timezone'),
    refreshMinutes: integer('refresh_minutes').notNull().default(360),
    etag: text('etag'),
    lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
    lastRefreshRequestedAt: integer('last_refresh_requested_at', {
      mode: 'timestamp_ms',
    }),
    // When ingest last *attempted* this feed, success or failure. `lastSyncedAt`
    // only moves on success, so it can't pace retries: without this a feed that
    // errors has no timestamp the cron can back off from.
    lastAttemptedAt: integer('last_attempted_at', { mode: 'timestamp_ms' }),
    // Failed ingests since the last successful one (0 whenever the last attempt
    // succeeded). Drives the cron's retry backoff for a feed in 'error'.
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    // Why the last attempt failed, so a stuck feed is visible instead of just
    // silently serving whatever it had ingested before. Null when healthy.
    lastErrorMessage: text('last_error_message'),
    status: text('status', { enum: FeedStatus.options })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
  },
  (t) => ({
    familyIdx: index('feeds_family_idx').on(t.familyId),
  }),
);

/**
 * The always-present link between a feed and the member(s) whose unified
 * calendar it feeds (one feed → many members). For `exception` feeds it also
 * carries that member's baseline schedule (weekday mask + day start/end +
 * default location). Task typing is NOT here — it lives in the per-calendar
 * task-rule pipeline (`taskRules` + the `default*` columns below are this
 * calendar's terminal default).
 */
export const familyMemberFeeds = sqliteTable(
  'family_member_feeds',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    feedId: text('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    familyMemberId: text('family_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    weekdayMask: integer('weekday_mask'),
    dayStart: text('day_start'),
    dayEnd: text('day_end'),
    // Priority rank of this feed *within this member's* unified calendar,
    // ascending (0 = highest). Conflict resolution compares only the feeds on a
    // single member's calendar, so priority is a property of the feed↔member
    // link, not the feed: when two feed-derived events overlap, the lower-
    // position link wins and the other is masked. Manual (human) events always
    // outrank every feed. Lower = wins.
    position: integer('position').notNull().default(0),
    // Location stamped on generated baseline events (e.g. the school). Null ⇒ none.
    location: text('location'),
    // Geocoded coordinates for `location` (validated at input via MapKit/etc.).
    // When present, baseline events carry GEO + X-APPLE-STRUCTURED-LOCATION so
    // Apple Calendar computes travel time. Null ⇒ free-text location only.
    locationGeo: text('location_geo', { mode: 'json' }).$type<GeoLocation>(),
    // This calendar's task-rule terminal default (what an unmatched event
    // generates): 'transition' | 'attendance', with drop-off/pickup windows.
    defaultTaskType: text('default_task_type', {
      enum: TaskResultType.options,
    })
      .notNull()
      .default('transition'),
    defaultDropoffWindowMin: integer('default_dropoff_window_min')
      .notNull()
      .default(15),
    defaultPickupWindowMin: integer('default_pickup_window_min')
      .notNull()
      .default(15),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    feedMemberUq: uniqueIndex('fmf_feed_member_uq').on(
      t.feedId,
      t.familyMemberId,
    ),
    familyIdx: index('fmf_family_idx').on(t.familyId),
    memberPositionIdx: index('fmf_member_position_idx').on(
      t.familyMemberId,
      t.position,
    ),
  }),
);

// --- Source events -------------------------------------------------------

export const sourceEvents = sqliteTable(
  'source_events',
  {
    id: id(),
    feedId: text('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    icalUid: text('ical_uid').notNull(),
    recurrenceId: text('recurrence_id'),
    dtstart: integer('dtstart', { mode: 'timestamp_ms' }).notNull(),
    dtend: integer('dtend', { mode: 'timestamp_ms' }),
    // All-day (VALUE=DATE) event: dtstart/dtend are anchored to UTC midnight of
    // the calendar date; render as a bare date, never tz-converted.
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    summary: text('summary'),
    location: text('location'),
    // Coordinates the source event carried for `location` (its GEO and/or
    // X-APPLE-STRUCTURED-LOCATION). Synthesis stamps them onto the events it
    // makes, so a feed whose events are geocoded upstream keeps travel time
    // all the way out to a claimed drop-off/pickup. Null ⇒ free text only.
    locationGeo: text('location_geo', { mode: 'json' }).$type<GeoLocation>(),
    raw: text('raw'),
    contentHash: text('content_hash').notNull(),
    // The content_hash synthesis last consumed. Needs (re)processing iff
    // synthesizedHash != contentHash.
    synthesizedHash: text('synthesized_hash'),
    // Manually marked unneeded (e.g. a bad feed event): excluded from
    // synthesis and the exception resolver. Null ⇒ active.
    dismissedAt: integer('dismissed_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    occurrenceUq: uniqueIndex('source_events_occurrence_uq').on(
      t.feedId,
      t.icalUid,
      t.recurrenceId,
    ),
    feedIdx: index('source_events_feed_idx').on(t.feedId),
  }),
);

// --- Override pipeline (per feed↔member link; schedule only) --------------

/**
 * One rule in a feed link's pipeline. Rules run in `position` order over each
 * incoming feed event; the first match wins and its `outcome` shapes the
 * SCHEDULE only. On an exception feed that's the covered baseline day
 * (`cancel_day` / `modify_day` / `ignore`), or `add_event`, which puts the feed
 * event on the calendar alongside an untouched baseline day; on a routed feed
 * (a shared family calendar) it's `keep` — the event is routed onto this link's
 * member calendar. Task typing lives in `taskRules`. `params` (modify_day's new
 * hours) is validated by the domain schemas.
 */
export const linkRules = sqliteTable(
  'link_rules',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    linkId: text('link_id')
      .notNull()
      .references(() => familyMemberFeeds.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    matchField: text('match_field', {
      enum: OverrideMatchField.options,
    }).notNull(),
    matchOp: text('match_op', { enum: OverrideMatchOp.options }).notNull(),
    // Text/regex pattern, or minutes for duration ops; null for is_true/is_false.
    matchValue: text('match_value'),
    outcome: text('outcome', { enum: OverrideOutcome.options }).notNull(),
    params: text('params', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => ({
    linkPositionIdx: index('link_rules_link_position_idx').on(
      t.linkId,
      t.position,
    ),
    familyIdx: index('link_rules_family_idx').on(t.familyId),
  }),
);

// --- Task rules (per member; typing pipeline across their calendars) ------

/**
 * One rule in a member's task-generation pipeline. Decides whether a matched
 * event generates a `transition` (drop-off + pickup) or an `attendance` task.
 * `scope` = `this_calendar` (only the calendar named by `linkId`; null linkId =
 * the member's own unified/direct calendar) or `all_calendars` (every calendar
 * of the member). Rules share one `position` order per member; when a calendar
 * is evaluated, its applicable subset (all_calendars ∪ this-calendar-for-it) is
 * run in that order, first match wins, then the calendar's default.
 */
export const taskRules = sqliteTable(
  'task_rules',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    familyMemberId: text('family_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    // The source calendar this rule lives on; null = the unified/direct calendar.
    // Ignored when scope = all_calendars.
    linkId: text('link_id').references(() => familyMemberFeeds.id, {
      onDelete: 'cascade',
    }),
    scope: text('scope', { enum: TaskRuleScope.options })
      .notNull()
      .default('this_calendar'),
    position: integer('position').notNull(),
    matchField: text('match_field', {
      enum: OverrideMatchField.options,
    }).notNull(),
    matchOp: text('match_op', { enum: OverrideMatchOp.options }).notNull(),
    matchValue: text('match_value'),
    resultType: text('result_type', { enum: TaskResultType.options }).notNull(),
    // Only meaningful when resultType = transition.
    dropoffWindowMin: integer('dropoff_window_min'),
    pickupWindowMin: integer('pickup_window_min'),
    createdAt: createdAt(),
  },
  (t) => ({
    memberPositionIdx: index('task_rules_member_position_idx').on(
      t.familyMemberId,
      t.position,
    ),
    familyIdx: index('task_rules_family_idx').on(t.familyId),
  }),
);

// --- Assignment rules ------------------------------------------------------

/**
 * A family's auto-assignment pipeline: when a generated task matches a rule, the
 * task is claimed for `ownerMemberId` (a caretaker) automatically instead of
 * sitting unowned. One flat ordered list per family; first match in `position`
 * order wins.
 *
 * The targeting filters (`aboutMemberId`, `linkId`, `taskType`) are ANDed and
 * each is nullable = "any", covering both layers the issue asks for: a per-feed
 * rule sets `linkId`; an overarching "all of Child B" rule sets `aboutMemberId`.
 * The recurrence pattern (`weekdayMask` + `cadenceWeeks`/`anchorDate`) is inline
 * — a pattern is never a resource the user manages separately.
 */
export const assignmentRules = sqliteTable(
  'assignment_rules',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    // The caretaker the matching task is claimed for (the rule's result).
    ownerMemberId: text('owner_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    // Targeting filters; null = any.
    aboutMemberId: text('about_member_id').references(() => familyMembers.id, {
      onDelete: 'cascade',
    }),
    linkId: text('link_id').references(() => familyMemberFeeds.id, {
      onDelete: 'cascade',
    }),
    taskType: text('task_type', { enum: TaskType.options }),
    position: integer('position').notNull(),
    // Recurrence pattern (inline). weekdayMask: Mon=bit0…Sun=bit6, 0 = any day.
    weekdayMask: integer('weekday_mask').notNull().default(0),
    // 1 = every week, 2 = every other week, …; anchored to anchorDate's week.
    cadenceWeeks: integer('cadence_weeks').notNull().default(1),
    anchorDate: integer('anchor_date', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    familyPositionIdx: index('assignment_rules_family_position_idx').on(
      t.familyId,
      t.position,
    ),
  }),
);

// --- Pending decisions -----------------------------------------------------

/**
 * A feed event the pipeline wouldn't decide for itself — the system never
 * guesses, a human resolves or dismisses it. Rows persist after resolution so
 * synthesis won't re-raise them; `sourceContentHash` reopens the decision when
 * the feed event's content changes.
 *
 * Two kinds, both scoped to one feed↔member link:
 *   `exception` — an exception-feed event that matched no override rule: what
 *     does it do to this member's baseline day?
 *   `routing` — an event on a routed shared family calendar that NO link's
 *     `keep` rules claimed: is it this member's? One row per link of the feed,
 *     raised and cleared together (they share a `sourceEventId`), so the client
 *     asks once — "whose is this?" — and one answer resolves the rows for the
 *     members picked and dismisses the rest.
 */
export const pendingDecisions = sqliteTable(
  'pending_decisions',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    feedId: text('feed_id')
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: PendingDecisionKind.options })
      .notNull()
      .default('exception'),
    linkId: text('link_id')
      .notNull()
      .references(() => familyMemberFeeds.id, { onDelete: 'cascade' }),
    familyMemberId: text('family_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    sourceEventId: text('source_event_id')
      .notNull()
      .references(() => sourceEvents.id, { onDelete: 'cascade' }),
    status: text('status', { enum: PendingDecisionStatus.options })
      .notNull()
      .default('pending'),
    sourceContentHash: text('source_content_hash').notNull(),
    // JSON array of TaskType chosen at resolution.
    resolvedTypes: text('resolved_types', { mode: 'json' }).$type<string[]>(),
    resolvedByMemberId: text('resolved_by_member_id').references(
      () => familyMembers.id,
      { onDelete: 'set null' },
    ),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    dismissedAt: integer('dismissed_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    linkSourceUq: uniqueIndex('pending_decisions_link_source_uq').on(
      t.linkId,
      t.sourceEventId,
    ),
    familyStatusIdx: index('pending_decisions_family_status_idx').on(
      t.familyId,
      t.status,
    ),
  }),
);

// --- Conflicts (agenda overlaps on a member's unified calendar) ------------

/**
 * Two events overlap on one member's unified calendar — they can't be in two
 * places at once. The higher-priority `winner` displaces the lower-priority,
 * maskable `loser` (a synthesized feed event); resolving splits/trims the loser
 * around the winner (task-gen then spawns the drop-off/pickup at each split).
 * Identity is the pair of event `synthKey`s (stable across resynthesis), not row
 * ids — there is deliberately no FK to calendar_events: the conflict service
 * reconciles rows itself and a masked loser's row disappears while the split
 * segments stand in for it. Detected live each pass, so a conflict auto-clears
 * when the overlap no longer exists.
 */
export const conflicts = sqliteTable(
  'conflicts',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    familyMemberId: text('family_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    // synthKeys of the two overlapping events on this member's calendar.
    loserKey: text('loser_key').notNull(),
    winnerKey: text('winner_key').notNull(),
    status: text('status', { enum: ConflictStatus.options })
      .notNull()
      .default('pending'),
    resolvedByMemberId: text('resolved_by_member_id').references(
      () => familyMembers.id,
      { onDelete: 'set null' },
    ),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    dismissedAt: integer('dismissed_at', { mode: 'timestamp_ms' }),
    // Resolution parameters (design §8b), applied when a resolved conflict's
    // split is materialised. Defaults reproduce the plain split: flush cut,
    // both halves kept. `travel_*_min` widen the cut around the winner (the gap
    // the spawned pick-up / drop-off sits in); `*_needed=false` drops the
    // leading / trailing half of the loser (a cancel_day for that side).
    travelBeforeMin: integer('travel_before_min').notNull().default(0),
    travelAfterMin: integer('travel_after_min').notNull().default(0),
    beforeNeeded: integer('before_needed', { mode: 'boolean' })
      .notNull()
      .default(true),
    afterNeeded: integer('after_needed', { mode: 'boolean' })
      .notNull()
      .default(true),
    // Snapshot of the loser/winner events' SCHEDULE (start / end / all-day) at
    // the moment a decision (resolve or dismiss) was made — the only thing the
    // decision is a function of, since both outcomes are statements about two
    // commitments colliding in time ("split the loser around it" / "leave both
    // as they are"). When either event later MOVES the decision is stale, so
    // the reconciler reopens the conflict back to 'pending' and clears these.
    //
    // Deliberately NOT the events' `content_hash`: that also folds in summary /
    // location / geocode, which for a `bl:` baseline day are the link's and
    // feed's *config*, not any feed event's content — so watching it reopened
    // every decided conflict on a member's calendar whenever the school link
    // was re-pinned or a sync auto-detected the feed's timezone.
    //
    // Written as a versioned `s1:` stamp (see `scheduleStamp`) so a value left
    // by an older format re-baselines instead of reading as drift.
    loserScheduleStamp: text('loser_schedule_stamp'),
    winnerScheduleStamp: text('winner_schedule_stamp'),
    createdAt: createdAt(),
  },
  (t) => ({
    memberPairUq: uniqueIndex('conflicts_member_pair_uq').on(
      t.familyMemberId,
      t.loserKey,
      t.winnerKey,
    ),
    familyStatusIdx: index('conflicts_family_status_idx').on(
      t.familyId,
      t.status,
    ),
    memberIdx: index('conflicts_member_idx').on(t.familyMemberId),
  }),
);

// --- Tasks ---------------------------------------------------------------

export const tasks = sqliteTable(
  'tasks',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    // The unified-calendar event this task was generated from. Deliberately NOT
    // a foreign key: an owned task must survive its event vanishing (surfaced
    // as stale, not silently deleted) — task-gen sweeps unowned orphans itself.
    calendarEventId: text('calendar_event_id'),
    // The member the task is about (the event's calendar owner), NOT the
    // claiming caretaker — that's ownerMemberId.
    familyMemberId: text('family_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    type: text('type', { enum: TaskType.options }).notNull(),
    attendanceRequirement: text('attendance_requirement', {
      enum: AttendanceRequirement.options,
    }),
    dtstart: integer('dtstart', { mode: 'timestamp_ms' }).notNull(),
    dtend: integer('dtend', { mode: 'timestamp_ms' }),
    // A user-set window length (minutes, signed) for a transition task, measured
    // from its anchor — the event's start for a drop-off, its end for a pickup.
    // Positive extends forward from the anchor, negative reverses it (window sits
    // before the anchor). Null ⇒ derived from the task-rule pipeline's window;
    // when set, task-gen re-anchors around it instead of recomputing the window.
    durationOverrideMin: integer('duration_override_min'),
    location: text('location'),
    // Geocoded coordinates for `location`, carried from the event the task was
    // generated from. Travels on to the claimed event so the caretaker's own
    // calendar keeps GEO + X-APPLE-STRUCTURED-LOCATION (Apple travel time) —
    // without it a claimed pickup/drop-off mirrors as free text only.
    locationGeo: text('location_geo', { mode: 'json' }).$type<GeoLocation>(),
    status: text('status', { enum: TaskStatus.options })
      .notNull()
      .default('unowned'),
    ownerMemberId: text('owner_member_id').references(() => familyMembers.id, {
      onDelete: 'set null',
    }),
    // Set to the assignment rule that auto-claimed this task; null for a human
    // claim (or an unowned task). Lets task-gen recognise a rule-owned task so a
    // rule edit can move or release it. Deliberately NOT a FK — deleting a rule
    // must not cascade the task away; task-gen releases it on the next run.
    autoAssignedRuleId: text('auto_assigned_rule_id'),
    // True once a human performs any ownership action (assign / unassign /
    // reassign / dismiss / restore). Auto-assignment permanently skips such
    // tasks — a manual action always wins over the rule engine.
    manualOwnerOverride: integer('manual_owner_override', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdVia: text('created_via', { enum: TaskCreatedVia.options }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    familyStatusIdx: index('tasks_family_status_idx').on(t.familyId, t.status),
    calendarEventIdx: index('tasks_calendar_event_idx').on(t.calendarEventId),
    // The notification digest asks for a *date-windowed* slice of a family's
    // tasks ("what's outstanding tomorrow"), which the status index above can't
    // serve — it has nothing on `dtstart`.
    familyStartIdx: index('tasks_family_start_idx').on(t.familyId, t.dtstart),
  }),
);

// --- Secrets ---------------------------------------------------------------

export const secrets = sqliteTable('secrets', {
  id: id(),
  familyId: text('family_id').references(() => families.id, {
    onDelete: 'cascade',
  }),
  // Envelope encryption: ciphertext + iv + DEK wrapped by the KEK.
  ciphertext: text('ciphertext').notNull(),
  iv: text('iv').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  createdAt: createdAt(),
});

// --- Unified calendars -----------------------------------------------------

/**
 * The canonical unified calendar: one row per event on a member's agenda. The
 * DB is the source of truth; an optional external target (member_calendars) is
 * a write-through mirror. `synthKey` is the idempotency backbone — synthesis
 * computes the desired key set per link+window and upserts/deletes by
 * (familyMemberId, synthKey), so config changes resynthesize without dupes:
 *   `bl:<linkId>:<YYYY-MM-DD>`  baseline day
 *   `ev:<linkId>:<sourceEventId>`  feed-event-derived
 *   `fb:<linkId>:<sourceEventId>`  opaque busy block (free/busy firewall feed)
 *   `pd:<pendingDecisionId>`  resolved pending decision
 *   `task:<taskId>`  claimed task on the claimer's calendar (the recursion)
 *   `ext:<uid>:<recurrenceId|''>`  human event read back from the target
 */
export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    // Whose unified calendar this event is on.
    familyMemberId: text('family_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    provenance: text('provenance', { enum: EventProvenance.options }).notNull(),
    synthKey: text('synth_key').notNull(),
    // Provenance linkage. Cascades are safe here because mirror bookkeeping
    // (event_mirrors) deliberately has no FK and outlives these rows — the next
    // mirror reconcile cancels the remote copy of any vanished event.
    linkId: text('link_id').references(() => familyMemberFeeds.id, {
      onDelete: 'cascade',
    }),
    sourceEventId: text('source_event_id').references(() => sourceEvents.id, {
      onDelete: 'cascade',
    }),
    matchedRuleId: text('matched_rule_id').references(() => linkRules.id, {
      onDelete: 'set null',
    }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    pendingDecisionId: text('pending_decision_id').references(
      () => pendingDecisions.id,
      { onDelete: 'cascade' },
    ),
    // Identity of a human event on the external target (foreign UID); null for
    // synthesized/claimed events — the mirror owns their `igt-` UIDs.
    externalUid: text('external_uid'),
    externalRecurrenceId: text('external_recurrence_id'),
    // Payload.
    dtstart: integer('dtstart', { mode: 'timestamp_ms' }).notNull(),
    dtend: integer('dtend', { mode: 'timestamp_ms' }),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    summary: text('summary'),
    location: text('location'),
    // Geocoded coordinates for `location`, carried from the synthesizing link so
    // the mirror can emit GEO + X-APPLE-STRUCTURED-LOCATION. Null ⇒ text only.
    locationGeo: text('location_geo', { mode: 'json' }).$type<GeoLocation>(),
    // A human's own answer for how long getting here takes (minutes), set on
    // the event itself. Overrides everything the mirror would estimate; 0 means
    // "no travel time on this one". Null ⇒ estimate it (see mirror.ts). Not
    // part of `contentHash`: it's a property of the trip, not of the event's
    // schedule, so healing the event never disturbs it.
    travelTimeOverrideMin: integer('travel_time_override_min'),
    description: text('description'),
    // Task typing is NOT stamped here — task-gen resolves it at build time from
    // the member's task-rule pipeline, keyed by this event's `linkId` (the
    // source calendar; null ⇒ the member's own unified/direct calendar).
    // Skip no-op rewrites on resynthesis (same pattern as source_events).
    contentHash: text('content_hash').notNull(),
    // The content_hash task-gen last consumed; reprocess iff != contentHash.
    tasksBuiltHash: text('tasks_built_hash'),
    // Set when a resolved agenda conflict has split/trimmed this event: the row
    // stays (so conflict detection stays stable and synthesis keeps owning it),
    // but task-gen, the mirror, and the calendar views skip it in favour of the
    // `cf:<synthKey>:<i>` split segments the conflict service materialises.
    maskedAt: integer('masked_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    memberSynthKeyUq: uniqueIndex('calendar_events_member_synth_key_uq').on(
      t.familyMemberId,
      t.synthKey,
    ),
    memberStartIdx: index('calendar_events_member_start_idx').on(
      t.familyMemberId,
      t.dtstart,
    ),
    taskIdx: index('calendar_events_task_idx').on(t.taskId),
    familyIdx: index('calendar_events_family_idx').on(t.familyId),
  }),
);

/**
 * A member's designated external target calendar — the write-through mirror of
 * their unified calendar (and the source of human events read back into it).
 * At most one per member; a member without a row still has a fully working
 * DB-only unified calendar.
 */
export const memberCalendars = sqliteTable(
  'member_calendars',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    familyMemberId: text('family_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    // The owning user's connected account the target is drawn from. If the
    // account is deleted this goes null and mirror/read-back skip the row.
    targetExternalAccountId: text('target_external_account_id').references(
      () => externalAccounts.id,
      { onDelete: 'set null' },
    ),
    targetMethod: text('target_method', { enum: MirrorMethod.options }).notNull(),
    // CalDAV collection URL or Google calendar id.
    targetCalendarId: text('target_calendar_id').notNull(),
    targetCalendarName: text('target_calendar_name'),
    // JSON array of minutes-before-start for default alerts (max 2), e.g. [30,10].
    alertMinutes: text('alert_minutes', { mode: 'json' }).$type<number[]>(),
    // IANA timezone the target calendar's wall-clock times are in — auto-detected
    // from a read-back event's own TZID/VTIMEZONE, or set manually for events
    // that carry neither (e.g. an externally-sourced ICS invite imported as a
    // floating/zone-less VEVENT). Used to interpret the target's own floating
    // read-back times (see readBackMember). Null ⇒ they fall back to the host
    // runtime's timezone.
    timezone: text('timezone'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    lastMirroredAt: integer('last_mirrored_at', { mode: 'timestamp_ms' }),
    lastReadBackAt: integer('last_read_back_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    memberUq: uniqueIndex('member_calendars_member_uq').on(t.familyMemberId),
    familyIdx: index('member_calendars_family_idx').on(t.familyId),
  }),
);

/**
 * Mirror bookkeeping: one row per event we have written to a member's target
 * calendar. Deliberately NO foreign key to calendar_events — event deletion
 * happens deep inside synthesis, and the mirror row must survive it so the
 * next reconcile can cancel the remote copy before dropping the row.
 */
export const eventMirrors = sqliteTable(
  'event_mirrors',
  {
    id: id(),
    familyMemberId: text('family_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    calendarEventId: text('calendar_event_id').notNull(),
    // `igt-<calendarEventId>` — also the read-back filter that keeps our own
    // mirrored events from being re-imported as human events.
    icalUid: text('ical_uid').notNull(),
    sequence: integer('sequence').notNull().default(0),
    // Hash of the mirrored payload; lets reconcile skip unchanged events.
    payloadHash: text('payload_hash'),
    externalRef: text('external_ref'),
    status: text('status', { enum: MirrorStatus.options })
      .notNull()
      .default('sent'),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    memberUidUq: uniqueIndex('event_mirrors_member_uid_uq').on(
      t.familyMemberId,
      t.icalUid,
    ),
    calendarEventIdx: index('event_mirrors_calendar_event_idx').on(
      t.calendarEventId,
    ),
  }),
);

// --- Invites (no public signup) -----------------------------------------

export const invites = sqliteTable(
  'invites',
  {
    id: id(),
    type: text('type', { enum: InviteType.options }).notNull(),
    familyId: text('family_id').references(() => families.id, {
      onDelete: 'cascade',
    }),
    issuedByMemberId: text('issued_by_member_id').references(
      () => familyMembers.id,
      { onDelete: 'set null' },
    ),
    // For `claim_member` invites: the pre-created member the accepting user is
    // linked to (sets family_members.user_id). Null for family-level invites.
    memberId: text('member_id').references(() => familyMembers.id, {
      onDelete: 'cascade',
    }),
    email: text('email'),
    // Only the hash of the one-time token is stored (see auth_tokens/sessions
    // below) — the raw value is returned once at creation and never persisted.
    tokenHash: text('token_hash').notNull().unique(),
    grantIsCaretaker: integer('grant_is_caretaker', { mode: 'boolean' })
      .notNull()
      .default(true),
    grantIsAdmin: integer('grant_is_admin', { mode: 'boolean' })
      .notNull()
      .default(false),
    status: text('status', { enum: InviteStatus.options })
      .notNull()
      .default('pending'),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    statusIdx: index('invites_status_idx').on(t.status),
  }),
);

// --- Auth: magic-link tokens + sessions ----------------------------------

export const authTokens = sqliteTable(
  'auth_tokens',
  {
    id: id(),
    purpose: text('purpose', { enum: ['magic_link'] })
      .notNull()
      .default('magic_link'),
    // The login email this token authorizes (becomes an identity.provider_ref).
    email: text('email').notNull(),
    // Only the hash of the one-time token is stored.
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    emailIdx: index('auth_tokens_email_idx').on(t.email),
  }),
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Only the hash of the session token is stored; the raw token is returned
    // to the client once and never persisted.
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
  }),
);

// --- Apple S2S notification replay dedupe --------------------------------

/**
 * One row per Apple server-to-server notification JWS we've successfully
 * verified and applied, keyed by a digest of the raw token. `verifyApple-
 * NotificationToken`'s `iat`/`event_time` freshness checks close most of the
 * replay window, but Apple retries notifications on anything but a 200 — so
 * a legitimately-fresh redelivery must still no-op rather than re-apply a
 * destructive action (`consent-revoked` / `account-delete`) a second time.
 * `expiresAt` lets a periodic sweep (or lazy delete-on-insert) reclaim rows
 * once they're older than the freshness window could ever accept anyway.
 */
export const appleNotificationReceipts = sqliteTable('apple_notification_receipts', {
  id: id(),
  digest: text('digest').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: createdAt(),
});

// --- Push notifications --------------------------------------------------

/**
 * One row per app install that has an APNs token. Owned by the **user**, not a
 * family member: a device belongs to the person who signed in, and a digest
 * spans every family they belong to.
 *
 * `deviceToken` is unique on purpose — APNs re-issues the same token to the
 * same install, and signing a second account into one phone must *move* the
 * device rather than leave the previous user's digests arriving on it. The
 * register route therefore upserts by token and re-points `userId`.
 *
 * `environment` picks the APNs host, and it is not cosmetic: a token minted by
 * a build entitled `aps-environment: development` is only routable via the
 * sandbox host (and vice versa) — cross them and every send is a
 * `BadDeviceToken`.
 */
export const pushDevices = sqliteTable(
  'push_devices',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Lowercase hex, as reported by didRegisterForRemoteNotifications.
    deviceToken: text('device_token').notNull(),
    // The app's bundle id — sent as the `apns-topic` header for this device,
    // so staging and production installs can coexist under one user.
    bundleId: text('bundle_id').notNull(),
    environment: text('environment', { enum: ApnsEnvironment.options }).notNull(),
    platform: text('platform', { enum: PushPlatform.options })
      .notNull()
      .default('ios'),
    // The device's IANA zone at last registration. Seeds a new schedule's
    // timezone — nothing else in the schema knows where a user is.
    timezone: text('timezone'),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    // Stamped when APNs rejects the token for good (410 Unregistered, or 400
    // BadDeviceToken / DeviceTokenNotForTopic). Kept rather than deleted so a
    // re-register can revive the same row and we can see churn.
    disabledAt: integer('disabled_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenUq: uniqueIndex('push_devices_token_uq').on(t.deviceToken),
    userIdx: index('push_devices_user_idx').on(t.userId),
  }),
);

/**
 * A recurring digest of outstanding items: "what still needs a human before
 * tomorrow". One push per firing, aggregated across all of the user's families.
 *
 * The send time and the day window are both read in `timezone` — there is no
 * user- or family-level zone anywhere else in this schema (only `feeds.timezone`
 * and `member_calendars.timezone`, which describe *sources*), so the schedule
 * carries its own, seeded from the registering device.
 *
 * `lastSentSlot` is the idempotency key: the local `YYYY-MM-DDTHH:MM` this
 * schedule was last dispatched for. The dispatcher claims a slot with a
 * conditional UPDATE, which is what makes overlapping cron ticks safe, and what
 * makes the fall-back DST repeat of an hour a no-op.
 */
export const notificationSchedules = sqliteTable(
  'notification_schedules',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull().default('Daily brief'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    // 'HH:MM' wall clock in `timezone`.
    sendAt: text('send_at').notNull(),
    timezone: text('timezone').notNull(),
    // Mon=bit0 … Sun=bit6 — the same convention as `assignment_rules`
    // (weekdayBit() in @igt/classification), so the client's day chips are shared.
    weekdayMask: integer('weekday_mask').notNull().default(127),
    // Window = [startOfLocalDay(now) + startOffsetDays, + horizonDays days),
    // with the start clamped to `now` when startOffsetDays is 0.
    startOffsetDays: integer('start_offset_days').notNull().default(1),
    horizonDays: integer('horizon_days').notNull().default(1),
    // JSON array of NotificationCategory.
    categories: text('categories', { mode: 'json' })
      .notNull()
      .$type<NotificationCategory[]>(),
    // Stay silent when the window turns up nothing, rather than pushing a zero.
    skipWhenEmpty: integer('skip_when_empty', { mode: 'boolean' })
      .notNull()
      .default(true),
    lastSentSlot: text('last_sent_slot'),
    lastSentAt: integer('last_sent_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    userIdx: index('notification_schedules_user_idx').on(t.userId),
    // The dispatcher's sweep: only enabled rows are ever candidates.
    enabledIdx: index('notification_schedules_enabled_idx').on(t.enabled),
  }),
);

export const schema = {
  users,
  identities,
  families,
  familyMembers,
  externalAccounts,
  feeds,
  familyMemberFeeds,
  sourceEvents,
  linkRules,
  taskRules,
  pendingDecisions,
  conflicts,
  tasks,
  calendarEvents,
  memberCalendars,
  eventMirrors,
  secrets,
  invites,
  authTokens,
  sessions,
  appleNotificationReceipts,
  pushDevices,
  notificationSchedules,
};

// Keep `sql` referenced for future raw defaults without tripping lint.
export const __schemaSqlMarker = sql;
