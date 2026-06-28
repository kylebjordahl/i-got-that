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

export const TaskStatus = z.enum(['unowned', 'owned']);
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

export const InviteType = z.enum(['new_family', 'join_family']);
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

export const CreateCalendarTargetInput = z.object({
  memberId: Id,
  name: z.string().min(1).max(120),
  method: DeliveryMethod,
  providerHint: ProviderHint.optional(),
  addressOrUrl: z.string().min(1),
  externalCalendarId: z.string().optional(),
});
export type CreateCalendarTargetInput = z.infer<
  typeof CreateCalendarTargetInput
>;
