import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  AttendanceRequirement,
  DeliveryMethod,
  DeliveryStatus,
  FeedKind,
  FeedMode,
  FeedStatus,
  IdentityProvider,
  InviteStatus,
  InviteType,
  ProviderHint,
  RsvpStatus,
  RuleEffect,
  RuleMatchField,
  RuleMatchOp,
  TaskCreatedVia,
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
    createdAt: createdAt(),
  },
  (t) => ({
    familyIdx: index('family_members_family_idx').on(t.familyId),
    userIdx: index('family_members_user_idx').on(t.userId),
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
    url: text('url').notNull(),
    mode: text('mode', { enum: FeedMode.options }).notNull(),
    // IANA timezone the calendar's wall-clock times are in (from X-WR-TIMEZONE);
    // used to interpret exception baseline times. Null ⇒ treated as UTC.
    timezone: text('timezone'),
    refreshMinutes: integer('refresh_minutes').notNull().default(360),
    etag: text('etag'),
    lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
    lastRefreshRequestedAt: integer('last_refresh_requested_at', {
      mode: 'timestamp_ms',
    }),
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
 * The always-present link between a feed and the dependent(s) it covers
 * (one feed → many members). For `exception` feeds it also carries that
 * member's baseline schedule; for `explicit` feeds the baseline columns are
 * unused. Folds in the old standalone baseline_schedule table.
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
    // Block length (minutes) for generated baseline events. Null ⇒ a point in
    // time (the delivery layer falls back to a 1h block).
    durationMinutes: integer('duration_minutes'),
    // Location stamped on generated baseline events (e.g. the school). Null ⇒ none.
    location: text('location'),
    // JSON array of TaskType, e.g. ["pickup","dropoff"].
    generatesTypes: text('generates_types', { mode: 'json' }).$type<
      string[]
    >(),
    defaultAttendance: text('default_attendance', {
      enum: AttendanceRequirement.options,
    }),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    feedMemberUq: uniqueIndex('fmf_feed_member_uq').on(
      t.feedId,
      t.familyMemberId,
    ),
    familyIdx: index('fmf_family_idx').on(t.familyId),
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
    summary: text('summary'),
    location: text('location'),
    raw: text('raw'),
    contentHash: text('content_hash').notNull(),
    // The content_hash tasks were last generated from. Needs (re)processing
    // iff tasksBuiltHash != contentHash.
    tasksBuiltHash: text('tasks_built_hash'),
    // Manually marked unneeded (e.g. a bad feed event): excluded from task
    // generation and the exception resolver. Null ⇒ active.
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

// --- Classification ------------------------------------------------------

export const classificationRules = sqliteTable(
  'classification_rules',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    // null = family-global (all feeds); set = scoped to one feed.
    feedId: text('feed_id').references(() => feeds.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull().default(100),
    matchField: text('match_field', { enum: RuleMatchField.options }).notNull(),
    matchOp: text('match_op', { enum: RuleMatchOp.options }).notNull(),
    matchValue: text('match_value').notNull(),
    effect: text('effect', { enum: RuleEffect.options }).notNull(),
    producesTypes: text('produces_types', { mode: 'json' }).$type<string[]>(),
    defaultAttendance: text('default_attendance', {
      enum: AttendanceRequirement.options,
    }),
    shiftToTime: text('shift_to_time'),
    defaultOwnerMemberId: text('default_owner_member_id').references(
      () => familyMembers.id,
      { onDelete: 'set null' },
    ),
    createdAt: createdAt(),
  },
  (t) => ({
    familyIdx: index('classification_rules_family_idx').on(t.familyId),
    feedIdx: index('classification_rules_feed_idx').on(t.feedId),
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
    // The feed that generated this task (null for manually-created tasks) — lets
    // us clean up a child's tasks when their feed link changes/removes.
    feedId: text('feed_id').references(() => feeds.id, { onDelete: 'cascade' }),
    sourceEventId: text('source_event_id').references(() => sourceEvents.id, {
      onDelete: 'cascade',
    }),
    familyMemberId: text('family_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    type: text('type', { enum: TaskType.options }).notNull(),
    attendanceRequirement: text('attendance_requirement', {
      enum: AttendanceRequirement.options,
    }),
    dtstart: integer('dtstart', { mode: 'timestamp_ms' }).notNull(),
    dtend: integer('dtend', { mode: 'timestamp_ms' }),
    location: text('location'),
    status: text('status', { enum: TaskStatus.options })
      .notNull()
      .default('unowned'),
    ownerMemberId: text('owner_member_id').references(() => familyMembers.id, {
      onDelete: 'set null',
    }),
    createdVia: text('created_via', { enum: TaskCreatedVia.options }).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    familyStatusIdx: index('tasks_family_status_idx').on(t.familyId, t.status),
    sourceEventIdx: index('tasks_source_event_idx').on(t.sourceEventId),
  }),
);

// --- Delivery & secrets --------------------------------------------------

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

export const calendarTargets = sqliteTable(
  'calendar_targets',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    method: text('method', { enum: DeliveryMethod.options }).notNull(),
    providerHint: text('provider_hint', { enum: ProviderHint.options }),
    // email: the delivery address. caldav: the collection URL. google: unused.
    addressOrUrl: text('address_or_url').notNull(),
    credentialsRef: text('credentials_ref').references(() => secrets.id, {
      onDelete: 'set null',
    }),
    externalCalendarId: text('external_calendar_id'),
    // JSON array of minutes-before-start for default alerts (max 2), e.g. [30,10].
    alertMinutes: text('alert_minutes', { mode: 'json' }).$type<number[]>(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    memberIdx: index('calendar_targets_member_idx').on(t.memberId),
  }),
);

export const deliveries = sqliteTable(
  'deliveries',
  {
    id: id(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    calendarTargetId: text('calendar_target_id')
      .notNull()
      .references(() => calendarTargets.id, { onDelete: 'cascade' }),
    method: text('method', { enum: DeliveryMethod.options }).notNull(),
    status: text('status', { enum: DeliveryStatus.options })
      .notNull()
      .default('pending'),
    externalRef: text('external_ref'),
    icalUid: text('ical_uid'),
    sequence: integer('sequence').notNull().default(0),
    // Hash of the delivered event payload; lets reconcile skip unchanged events.
    payloadHash: text('payload_hash'),
    rsvpStatus: text('rsvp_status', { enum: RsvpStatus.options })
      .notNull()
      .default('none'),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    createdAt: createdAt(),
  },
  (t) => ({
    taskIdx: index('deliveries_task_idx').on(t.taskId),
    icalUidIdx: index('deliveries_ical_uid_idx').on(t.icalUid),
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
    email: text('email'),
    token: text('token').notNull().unique(),
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

// --- Ownership rules (modeled now; auto-assign engine lands in v1.1) ------

export const ownershipRules = sqliteTable(
  'ownership_rules',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    // JSON filter, e.g. { taskType: "pickup", familyMemberId: "..." }.
    filter: text('filter', { mode: 'json' }).$type<Record<string, unknown>>(),
    weekdayMask: integer('weekday_mask'),
    ownerMemberId: text('owner_member_id')
      .notNull()
      .references(() => familyMembers.id, { onDelete: 'cascade' }),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => ({
    familyIdx: index('ownership_rules_family_idx').on(t.familyId),
  }),
);

export const schema = {
  users,
  identities,
  families,
  familyMembers,
  feeds,
  familyMemberFeeds,
  sourceEvents,
  classificationRules,
  tasks,
  secrets,
  calendarTargets,
  deliveries,
  invites,
  authTokens,
  sessions,
  ownershipRules,
};

// Keep `sql` referenced for future raw defaults without tripping lint.
export const __schemaSqlMarker = sql;
