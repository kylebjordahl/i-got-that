import { z } from 'zod';

/**
 * Shared domain types + Zod schemas — the single source of truth for the API
 * contract. The OpenAPI spec (and the generated Dart client) are derived from
 * these schemas. Keep this package free of runtime/platform dependencies.
 */

// --- Enums ---------------------------------------------------------------

/** Where an input feed's events come from: a public ICS URL, or a calendar in a connected account. */
export const FeedKind = z.enum(['ics', 'caldav', 'google']);
export type FeedKind = z.infer<typeof FeedKind>;

/** A user-owned external calendar connection. iCloud is CalDAV with a well-known URL. */
export const ExternalAccountKind = z.enum(['google', 'icloud', 'caldav']);
export type ExternalAccountKind = z.infer<typeof ExternalAccountKind>;

/**
 * `standard` = feed events mean what they say; `exception` = the feed is empty
 * on normal days and only carries deviations from a per-link baseline.
 */
export const FeedMode = z.enum(['standard', 'exception']);
export type FeedMode = z.infer<typeof FeedMode>;

export const FeedStatus = z.enum(['active', 'paused', 'error']);
export type FeedStatus = z.infer<typeof FeedStatus>;

export const TaskType = z.enum(['pickup', 'dropoff', 'attendance']);
export type TaskType = z.infer<typeof TaskType>;

/** Who must attend: a specific caretaker, any one, or all. */
export const AttendanceRequirement = z.enum(['specific', 'any', 'both']);
export type AttendanceRequirement = z.infer<typeof AttendanceRequirement>;

/** `dismissed` = manually marked unneeded (e.g. a bad feed event); not delivered. */
export const TaskStatus = z.enum(['unowned', 'owned', 'dismissed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** `generated` = produced by synthesis/task-gen; `manual` = user-converted (task-gen heals times only, never reclassifies). */
export const TaskCreatedVia = z.enum(['generated', 'manual']);
export type TaskCreatedVia = z.infer<typeof TaskCreatedVia>;

/**
 * Where a unified-calendar event came from: `synthesized` (feed/baseline via the
 * override pipeline), `human` (read back from the member's target calendar), or
 * `claimed_task` (the recursion — a claimed task on the claimer's calendar).
 */
export const EventProvenance = z.enum(['synthesized', 'human', 'claimed_task']);
export type EventProvenance = z.infer<typeof EventProvenance>;

/** Field an override-rule matcher inspects. `any_text` = summary/location/description. */
export const OverrideMatchField = z.enum([
  'summary',
  'location',
  'description',
  'any_text',
  'all_day',
  'duration',
]);
export type OverrideMatchField = z.infer<typeof OverrideMatchField>;

/**
 * Matcher condition. Text ops apply to text fields; `is_true`/`is_false` to
 * `all_day`; `gte`/`lte` (minutes) to `duration`.
 */
export const OverrideMatchOp = z.enum([
  'contains',
  'starts_with',
  'equals',
  'regex',
  'is_true',
  'is_false',
  'gte',
  'lte',
]);
export type OverrideMatchOp = z.infer<typeof OverrideMatchOp>;

/**
 * What a matched override rule does. `cancel_day`/`modify_day` apply to the
 * baseline day an exception event covers (exception feeds only); `annotate`
 * keeps the event/day and stamps a note; `set_event` patches (or suppresses)
 * the resulting synthesized event.
 */
export const OverrideOutcome = z.enum([
  'cancel_day',
  'modify_day',
  'annotate',
  'set_event',
]);
export type OverrideOutcome = z.infer<typeof OverrideOutcome>;

/** An unmatched exception-feed event awaiting a human decision — never guessed. */
export const PendingDecisionStatus = z.enum(['pending', 'resolved', 'dismissed']);
export type PendingDecisionStatus = z.infer<typeof PendingDecisionStatus>;

export const DeliveryMethod = z.enum(['email', 'caldav', 'google']);
export type DeliveryMethod = z.infer<typeof DeliveryMethod>;

/** Writable protocols for a member's unified-calendar mirror target (email is parked). */
export const MirrorMethod = z.enum(['caldav', 'google']);
export type MirrorMethod = z.infer<typeof MirrorMethod>;

export const MirrorStatus = z.enum(['sent', 'updated', 'failed']);
export type MirrorStatus = z.infer<typeof MirrorStatus>;

export const RsvpStatus = z.enum(['none', 'accepted', 'declined']);
export type RsvpStatus = z.infer<typeof RsvpStatus>;

export const IdentityProvider = z.enum(['apple', 'magic_link']);
export type IdentityProvider = z.infer<typeof IdentityProvider>;

/** `claim_member` links an accepting user to a pre-created family member. */
export const InviteType = z.enum(['new_family', 'join_family', 'claim_member']);
export type InviteType = z.infer<typeof InviteType>;

export const InviteStatus = z.enum([
  'pending',
  'accepted',
  'revoked',
  'expired',
]);
export type InviteStatus = z.infer<typeof InviteStatus>;

// --- Reusable fragments --------------------------------------------------

/** Bitmask of weekdays, Mon=1 (bit 0) … Sun=64 (bit 6). */
export const WeekdayMask = z.number().int().min(0).max(127);
export type WeekdayMask = z.infer<typeof WeekdayMask>;

/** "HH:MM" 24h local time. */
export const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
export type TimeOfDay = z.infer<typeof TimeOfDay>;

export const Id = z.string().min(1);

// --- API input schemas (v1 subset) --------------------------------------

export const MagicLinkRequestInput = z.object({
  email: z.string().email(),
});
export type MagicLinkRequestInput = z.infer<typeof MagicLinkRequestInput>;

export const MagicLinkVerifyInput = z.object({
  token: z.string().min(1),
});
export type MagicLinkVerifyInput = z.infer<typeof MagicLinkVerifyInput>;

/** Sign in with Apple: the identity token the native/web flow returns. */
export const AppleSignInInput = z.object({
  identityToken: z.string().min(1),
});
export type AppleSignInInput = z.infer<typeof AppleSignInInput>;

export const CreateFamilyInput = z.object({
  name: z.string().min(1).max(120),
  /** The creator's relation label within the new family (e.g. "mom"). */
  relationName: z.string().min(1).max(64).default('parent'),
});
export type CreateFamilyInput = z.infer<typeof CreateFamilyInput>;

const RefreshMinutes = z.number().int().min(15).max(10080).default(360);

/**
 * Create an input feed. Either a public ICS URL (`kind: 'ics'`, the default) or a
 * calendar drawn from a connected external account (`kind: 'caldav' | 'google'`,
 * with `externalAccountId` + the immutable `sourceCalendarId`). `sourceCalendarId`
 * is the CalDAV collection URL or the Google calendar id.
 */
export const CreateFeedInput = z
  .object({
    kind: FeedKind.default('ics'),
    mode: FeedMode,
    refreshMinutes: RefreshMinutes,
    // ics
    url: z.string().url().optional(),
    // account-backed
    externalAccountId: Id.optional(),
    sourceCalendarId: z.string().min(1).optional(),
    sourceCalendarName: z.string().max(256).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'ics') {
      if (!v.url) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is required for ics feeds' });
      }
    } else {
      if (!v.externalAccountId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['externalAccountId'], message: 'externalAccountId is required for account feeds' });
      }
      if (!v.sourceCalendarId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceCalendarId'], message: 'sourceCalendarId is required for account feeds' });
      }
    }
  });
export type CreateFeedInput = z.infer<typeof CreateFeedInput>;

/**
 * Partial update for an input feed (admin). The feed's source — its `url` or the
 * external account's target calendar — is immutable; change it by recreating.
 */
export const UpdateFeedInput = z.object({
  mode: FeedMode.optional(),
  refreshMinutes: z.number().int().min(15).max(10080).optional(),
  status: FeedStatus.optional(),
});
export type UpdateFeedInput = z.infer<typeof UpdateFeedInput>;

/**
 * Connect an external calendar account (owned by the calling user, reusable
 * across their families). Google runs the OAuth consent flow client-side and
 * sends the `authCode` + `redirectUri` (exchanged for a stored refresh token);
 * iCloud/CalDAV use basic auth (`username` + app-specific `password`). iCloud
 * defaults to the well-known CalDAV URL when `serverUrl` is omitted.
 */
export const CreateExternalAccountInput = z
  .object({
    kind: ExternalAccountKind,
    name: z.string().min(1).max(120),
    // google
    authCode: z.string().min(1).optional(),
    redirectUri: z.string().url().optional(),
    // caldav / icloud
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    serverUrl: z.string().url().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'google') {
      if (!v.authCode || !v.redirectUri) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['authCode'], message: 'authCode + redirectUri are required for google accounts' });
      }
    } else {
      if (!v.username || !v.password) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'username + password are required for caldav/icloud accounts' });
      }
      if (v.kind === 'caldav' && !v.serverUrl) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['serverUrl'], message: 'serverUrl is required for generic caldav accounts' });
      }
    }
  });
export type CreateExternalAccountInput = z.infer<typeof CreateExternalAccountInput>;

/** A persistent per-person accent color as a hex string (`#RRGGBB`). */
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB hex color');
export type HexColor = z.infer<typeof HexColor>;

export const CreateFamilyMemberInput = z.object({
  relationName: z.string().min(1).max(64),
  isCaretaker: z.boolean().default(false),
  isAdmin: z.boolean().default(false),
  requiresCaretaker: z.boolean().default(false),
  color: HexColor.optional(),
  userId: Id.optional(),
});
export type CreateFamilyMemberInput = z.infer<typeof CreateFamilyMemberInput>;

/**
 * Partial update for a family member. Flag changes are admin-only (enforced
 * server-side); `relationName`/`color` may be edited by the member themselves.
 */
export const UpdateFamilyMemberInput = z.object({
  relationName: z.string().min(1).max(64).optional(),
  isCaretaker: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  requiresCaretaker: z.boolean().optional(),
  color: HexColor.optional(),
});
export type UpdateFamilyMemberInput = z.infer<typeof UpdateFamilyMemberInput>;

/** Block length (minutes) of a generated baseline event; 0 ⇒ point-in-time. */
export const BlockDurationMinutes = z.number().int().min(0).max(1440);

/** Link a dependent to a feed (+ optional baseline for exception feeds). feedId comes from the path. */
export const MemberFeedLinkInput = z.object({
  familyMemberId: Id,
  weekdayMask: WeekdayMask.optional(),
  dayStart: TimeOfDay.optional(),
  dayEnd: TimeOfDay.optional(),
  durationMinutes: BlockDurationMinutes.optional(),
  location: z.string().max(256).optional(),
  generatesTypes: z.array(TaskType).optional(),
  defaultAttendance: AttendanceRequirement.optional(),
});
export type MemberFeedLinkInput = z.infer<typeof MemberFeedLinkInput>;

/** Partial update for a feed↔member link (baseline). */
export const UpdateMemberFeedLinkInput = z.object({
  weekdayMask: WeekdayMask.optional(),
  dayStart: TimeOfDay.optional(),
  dayEnd: TimeOfDay.optional(),
  durationMinutes: BlockDurationMinutes.optional(),
  location: z.string().max(256).optional(),
  generatesTypes: z.array(TaskType).optional(),
  defaultAttendance: AttendanceRequirement.optional(),
  active: z.boolean().optional(),
});
export type UpdateMemberFeedLinkInput = z.infer<typeof UpdateMemberFeedLinkInput>;

/** Assign a task to a caretaker; defaults to the calling member when omitted. */
export const AssignTaskInput = z.object({
  memberId: Id.optional(),
});
export type AssignTaskInput = z.infer<typeof AssignTaskInput>;

/**
 * Convert a feed-generated task into a chosen set of types (attendance, pickup,
 * and/or drop-off). The event's tasks for that dependent become exactly these
 * types; at least one is required.
 */
export const ConvertTaskInput = z.object({
  types: z.array(TaskType).min(1),
});
export type ConvertTaskInput = z.infer<typeof ConvertTaskInput>;

// --- Override rules (the per-link event pipeline) -------------------------

/** `cancel_day`: the covered baseline day is suppressed entirely. */
export const CancelDayParams = z.object({}).strict();
export type CancelDayParams = z.infer<typeof CancelDayParams>;

/** `modify_day`: patch the covered baseline day (e.g. early release). */
export const ModifyDayParams = z
  .object({
    dayStart: TimeOfDay.optional(),
    dayEnd: TimeOfDay.optional(),
    durationMinutes: z.number().int().min(0).max(1440).optional(),
    location: z.string().max(256).optional(),
  })
  .strict();
export type ModifyDayParams = z.infer<typeof ModifyDayParams>;

/** `annotate`: keep the event/day, stamp a note (e.g. "Photo Day"). */
export const AnnotateParams = z.object({ text: z.string().min(1).max(256) }).strict();
export type AnnotateParams = z.infer<typeof AnnotateParams>;

/** `set_event`: patch the resulting synthesized event, or suppress it. */
export const SetEventParams = z
  .object({
    summary: z.string().min(1).max(256).optional(),
    startTime: TimeOfDay.optional(),
    durationMinutes: z.number().int().min(0).max(1440).optional(),
    location: z.string().max(256).optional(),
    /** Drop the event from the unified calendar entirely. */
    suppress: z.boolean().optional(),
  })
  .strict();
export type SetEventParams = z.infer<typeof SetEventParams>;

export const OverrideRuleParams = z.union([
  CancelDayParams,
  ModifyDayParams,
  AnnotateParams,
  SetEventParams,
]);
export type OverrideRuleParams = z.infer<typeof OverrideRuleParams>;

const paramsSchemaFor: Record<OverrideOutcome, z.ZodTypeAny> = {
  cancel_day: CancelDayParams,
  modify_day: ModifyDayParams,
  annotate: AnnotateParams,
  set_event: SetEventParams,
};

/**
 * Parse an ECMAScript regex matcher value: either `/pattern/flags` (the form
 * the rule editor documents — flags after the closing slash) or a bare,
 * flagless pattern. Throws on invalid patterns/flags.
 */
export function parseEcmaRegex(value: string): RegExp {
  const slashForm = /^\/(.*)\/([a-z]*)$/s.exec(value);
  if (slashForm) return new RegExp(slashForm[1]!, slashForm[2]);
  return new RegExp(value);
}

const TEXT_FIELDS = new Set<OverrideMatchField>([
  'summary',
  'location',
  'description',
  'any_text',
]);
const TEXT_OPS = new Set<OverrideMatchOp>(['contains', 'starts_with', 'equals', 'regex']);
const BOOL_OPS = new Set<OverrideMatchOp>(['is_true', 'is_false']);
const NUM_OPS = new Set<OverrideMatchOp>(['gte', 'lte']);

/** Cross-field checks shared by create/update once a full rule shape is known. */
function refineOverrideRule(
  v: {
    matchField: OverrideMatchField;
    matchOp: OverrideMatchOp;
    matchValue?: string | null;
    outcome: OverrideOutcome;
    params?: unknown;
  },
  ctx: z.RefinementCtx,
) {
  if (TEXT_FIELDS.has(v.matchField)) {
    if (!TEXT_OPS.has(v.matchOp)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matchOp'], message: `text fields require one of: contains, starts_with, equals, regex` });
    }
    if (!v.matchValue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matchValue'], message: 'matchValue is required for text matchers' });
    }
  } else if (v.matchField === 'all_day') {
    if (!BOOL_OPS.has(v.matchOp)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matchOp'], message: 'all_day requires is_true or is_false' });
    }
  } else if (v.matchField === 'duration') {
    if (!NUM_OPS.has(v.matchOp)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matchOp'], message: 'duration requires gte or lte' });
    }
    if (!v.matchValue || !/^\d+$/.test(v.matchValue)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matchValue'], message: 'matchValue must be a whole number of minutes' });
    }
  }
  if (v.matchOp === 'regex' && v.matchValue) {
    try {
      // ECMAScript flavor, same as the client help copy.
      parseEcmaRegex(v.matchValue);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['matchValue'], message: 'invalid ECMAScript regular expression' });
    }
  }
  const parsed = paramsSchemaFor[v.outcome].safeParse(v.params ?? {});
  if (!parsed.success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['params'], message: `invalid params for outcome '${v.outcome}': ${parsed.error.issues[0]?.message ?? 'invalid'}` });
  }
}

/**
 * Create an override rule on a feed↔member link. Rules run in `position` order,
 * first match wins. `cancel_day`/`modify_day` are only valid on exception-feed
 * links (enforced server-side where the feed mode is known). `generatesTypes` /
 * `defaultAttendance` stamp task-generation config onto the synthesized event.
 */
export const CreateLinkRuleInput = z
  .object({
    /** Insert position (0-based); appended when omitted. */
    position: z.number().int().min(0).optional(),
    matchField: OverrideMatchField,
    matchOp: OverrideMatchOp,
    matchValue: z.string().min(1).optional(),
    outcome: OverrideOutcome,
    params: OverrideRuleParams.optional(),
    generatesTypes: z.array(TaskType).optional(),
    defaultAttendance: AttendanceRequirement.optional(),
  })
  .superRefine(refineOverrideRule);
export type CreateLinkRuleInput = z.infer<typeof CreateLinkRuleInput>;

/** Partial update for an override rule; nullable fields clear with `null`. */
export const UpdateLinkRuleInput = z
  .object({
    matchField: OverrideMatchField.optional(),
    matchOp: OverrideMatchOp.optional(),
    matchValue: z.string().min(1).nullable().optional(),
    outcome: OverrideOutcome.optional(),
    params: OverrideRuleParams.nullable().optional(),
    generatesTypes: z.array(TaskType).nullable().optional(),
    defaultAttendance: AttendanceRequirement.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'no fields to update' });
export type UpdateLinkRuleInput = z.infer<typeof UpdateLinkRuleInput>;

/** Full ordering of a link's rules — every rule id exactly once, new order. */
export const ReorderLinkRulesInput = z.object({
  ruleIds: z.array(Id).min(1),
});
export type ReorderLinkRulesInput = z.infer<typeof ReorderLinkRulesInput>;

/** The rule-shape validator, exported so routes can re-check merged updates. */
export const validateOverrideRuleShape = refineOverrideRule;

// --- Pending decisions -----------------------------------------------------

/**
 * Resolve a pending decision: what the unmatched exception event should become.
 * Creates a synthesized event with these task types; optional time adjustments
 * override the source event's own times.
 */
export const ResolvePendingDecisionInput = z.object({
  types: z.array(TaskType).min(1),
  defaultAttendance: AttendanceRequirement.optional(),
  startTime: TimeOfDay.optional(),
  durationMinutes: z.number().int().min(0).max(1440).optional(),
});
export type ResolvePendingDecisionInput = z.infer<typeof ResolvePendingDecisionInput>;

// --- Family settings -------------------------------------------------------

/** Partial family update; threading threshold governs client-side task stitching. */
export const UpdateFamilyInput = z.object({
  name: z.string().min(1).max(120).optional(),
  threadingThresholdMinutes: z.number().int().min(0).max(240).optional(),
});
export type UpdateFamilyInput = z.infer<typeof UpdateFamilyInput>;

/** Build a Google OAuth consent URL for the given redirect URI. */
export const GoogleAuthorizeUrlInput = z.object({
  redirectUri: z.string().url(),
});
export type GoogleAuthorizeUrlInput = z.infer<typeof GoogleAuthorizeUrlInput>;

/**
 * Default alerts for a mirror target: minutes before the event start, at most
 * two. An empty array clears alerts. Capped at 4 weeks (40320 min).
 */
export const AlertMinutes = z.array(z.number().int().min(0).max(40320)).max(2);
export type AlertMinutes = z.infer<typeof AlertMinutes>;

/**
 * Designate a member's unified-calendar target: one writable calendar drawn
 * from a connected external account. Synthesized + claimed events are mirrored
 * there and human events on it are read back. Only the account owner may attach
 * it, and only to a member linked to their own user (enforced server-side).
 * `targetCalendarId` is the CalDAV collection URL or the Google calendar id.
 */
export const SetMemberCalendarTargetInput = z.object({
  externalAccountId: Id,
  targetCalendarId: z.string().min(1),
  targetCalendarName: z.string().max(256).optional(),
  alertMinutes: AlertMinutes.optional(),
});
export type SetMemberCalendarTargetInput = z.infer<typeof SetMemberCalendarTargetInput>;
