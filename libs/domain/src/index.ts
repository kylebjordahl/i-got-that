import { z } from 'zod';

/**
 * Shared domain types + Zod schemas — the single source of truth for the API
 * contract. The OpenAPI spec (and the generated Dart client) are derived from
 * these schemas. Keep this package free of runtime/platform dependencies.
 */

// --- Enums ---------------------------------------------------------------

export const FeedKind = z.enum(['ics']);
export type FeedKind = z.infer<typeof FeedKind>;

/** `explicit` = feed events create tasks; `exception` = deviations from a baseline. */
export const FeedMode = z.enum(['explicit', 'exception']);
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

export const TaskCreatedVia = z.enum(['rule', 'baseline', 'manual']);
export type TaskCreatedVia = z.infer<typeof TaskCreatedVia>;

export const RuleMatchField = z.enum(['summary', 'location', 'description']);
export type RuleMatchField = z.infer<typeof RuleMatchField>;

export const RuleMatchOp = z.enum(['contains', 'equals', 'regex']);
export type RuleMatchOp = z.infer<typeof RuleMatchOp>;

/**
 * `create` for explicit feeds. For exception feeds: `cancel` (no-school),
 * `shift` (early dismissal), `ignore` (informational, e.g. picture day).
 */
export const RuleEffect = z.enum(['create', 'cancel', 'shift', 'ignore']);
export type RuleEffect = z.infer<typeof RuleEffect>;

export const DeliveryMethod = z.enum(['email', 'caldav', 'google']);
export type DeliveryMethod = z.infer<typeof DeliveryMethod>;

export const ProviderHint = z.enum(['icloud', 'google', 'generic_caldav']);
export type ProviderHint = z.infer<typeof ProviderHint>;

export const DeliveryStatus = z.enum([
  'pending',
  'sent',
  'updated',
  'cancelled',
  'failed',
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

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

export const CreateFeedInput = z.object({
  url: z.string().url(),
  kind: FeedKind.default('ics'),
  mode: FeedMode,
  refreshMinutes: z.number().int().min(15).max(10080).default(360),
});
export type CreateFeedInput = z.infer<typeof CreateFeedInput>;

export const CreateFamilyMemberInput = z.object({
  relationName: z.string().min(1).max(64),
  isCaretaker: z.boolean().default(false),
  isAdmin: z.boolean().default(false),
  requiresCaretaker: z.boolean().default(false),
  userId: Id.optional(),
});
export type CreateFamilyMemberInput = z.infer<typeof CreateFamilyMemberInput>;

/** Partial update for a family member. Flag changes are admin-only (enforced server-side). */
export const UpdateFamilyMemberInput = z.object({
  relationName: z.string().min(1).max(64).optional(),
  isCaretaker: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  requiresCaretaker: z.boolean().optional(),
});
export type UpdateFamilyMemberInput = z.infer<typeof UpdateFamilyMemberInput>;

export const FamilyMemberFeedBaselineInput = z.object({
  feedId: Id,
  familyMemberId: Id,
  weekdayMask: WeekdayMask.optional(),
  dayStart: TimeOfDay.optional(),
  dayEnd: TimeOfDay.optional(),
  generatesTypes: z.array(TaskType).optional(),
  defaultAttendance: AttendanceRequirement.optional(),
});
export type FamilyMemberFeedBaselineInput = z.infer<
  typeof FamilyMemberFeedBaselineInput
>;

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

export const CreateClassificationRuleInput = z.object({
  feedId: Id.optional(),
  priority: z.number().int().default(100),
  matchField: RuleMatchField,
  matchOp: RuleMatchOp,
  matchValue: z.string().min(1),
  effect: RuleEffect,
  producesTypes: z.array(TaskType).optional(),
  defaultAttendance: AttendanceRequirement.optional(),
  shiftToTime: TimeOfDay.optional(),
  defaultOwnerMemberId: Id.optional(),
});
export type CreateClassificationRuleInput = z.infer<
  typeof CreateClassificationRuleInput
>;

/** Partial update for a classification rule. Fields are optional; nullable-optional on the four
 *  nullable columns so an effect change can explicitly clear stale data by sending `null`. */
export const UpdateClassificationRuleInput = z.object({
  feedId: Id.nullable().optional(),
  priority: z.number().int().optional(),
  matchField: RuleMatchField.optional(),
  matchOp: RuleMatchOp.optional(),
  matchValue: z.string().min(1).optional(),
  effect: RuleEffect.optional(),
  producesTypes: z.array(TaskType).nullable().optional(),
  defaultAttendance: AttendanceRequirement.nullable().optional(),
  shiftToTime: TimeOfDay.nullable().optional(),
  defaultOwnerMemberId: Id.nullable().optional(),
});
export type UpdateClassificationRuleInput = z.infer<typeof UpdateClassificationRuleInput>;

/** Discover the CalDAV calendars available for a set of credentials. */
export const CalDavDiscoverInput = z.object({
  serverUrl: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
});
export type CalDavDiscoverInput = z.infer<typeof CalDavDiscoverInput>;

const TargetCredential = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
  accessToken: z.string().optional(),
  // Google OAuth: the consent authorization code + the redirect URI it was
  // issued for; the server exchanges these for a stored refresh token.
  authCode: z.string().optional(),
  redirectUri: z.string().optional(),
});

/** Build a Google OAuth consent URL for the given redirect URI. */
export const GoogleAuthorizeUrlInput = z.object({
  redirectUri: z.string().url(),
});
export type GoogleAuthorizeUrlInput = z.infer<typeof GoogleAuthorizeUrlInput>;

/**
 * Default alerts for a calendar target: minutes before the event start, at most
 * two. An empty array clears alerts. Capped at 4 weeks (40320 min).
 */
export const AlertMinutes = z.array(z.number().int().min(0).max(40320)).max(2);
export type AlertMinutes = z.infer<typeof AlertMinutes>;

/** Partial update for an existing calendar target. */
export const UpdateCalendarTargetInput = z.object({
  name: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  addressOrUrl: z.string().min(1).optional(),
  externalCalendarId: z.string().optional(),
  providerHint: ProviderHint.optional(),
  alertMinutes: AlertMinutes.optional(),
  credential: TargetCredential.optional(),
});
export type UpdateCalendarTargetInput = z.infer<typeof UpdateCalendarTargetInput>;

export const CreateCalendarTargetInput = z.object({
  memberId: Id,
  name: z.string().min(1).max(120),
  method: DeliveryMethod,
  providerHint: ProviderHint.optional(),
  addressOrUrl: z.string().min(1),
  externalCalendarId: z.string().optional(),
  /** Default alerts (minutes before start), at most two. */
  alertMinutes: AlertMinutes.optional(),
  /**
   * Credential material (encrypted server-side into a `secret`). For caldav:
   * username + password (e.g. iCloud app-specific password). For google: an
   * OAuth `authCode` + `redirectUri` (exchanged for a refresh token), or a
   * pasted `accessToken`. Omit for email targets.
   */
  credential: TargetCredential.optional(),
});
export type CreateCalendarTargetInput = z.infer<
  typeof CreateCalendarTargetInput
>;
