import {
  and,
  calendarEvents,
  type Db,
  emailOutputMirrors,
  emailOutputs,
  emailVerifications,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
} from '@igt/db';
import {
  buildTextEmailMime,
  type DeliveryEvent,
  type DeliveryTarget,
  EmailImipProvider,
} from '@igt/delivery';
import { geoKey, type EmailOutputEventKind, type EmailOutputFilters } from '@igt/domain';
import type { Outbox } from '../lib/email.js';
import { randomToken, sha256hex } from '../lib/crypto.js';
import {
  claimedTaskMeta,
  type ClaimedTaskMeta,
  linkTimezones,
  mirroredSummary,
  type SyncResult,
} from './mirror.js';

type CalendarEventRow = typeof calendarEvents.$inferSelect;
type EmailOutputRow = typeof emailOutputs.$inferSelect;

/**
 * Email invite outputs: iMIP invites for a filtered slice of a member's
 * unified calendar, mailed to an address that proved it wants them.
 *
 * Same reconcile shape as the calendar mirror (`mirror.ts`), with the
 * differences an inbox forces:
 * - every write is a mail someone reads, so the set is bounded in time — only
 *   events that haven't ended and start within `EMAIL_INVITE_HORIZON_DAYS` —
 *   and each run sends at most `EMAIL_INVITE_SENDS_PER_RUN` per output, the
 *   nearest events first, leaving the rest to the next tick;
 * - an event that has simply finished is forgotten, not cancelled;
 * - an unverified output sends nothing at all.
 */

export const EMAIL_INVITE_HORIZON_DAYS = 60;
export const EMAIL_INVITE_SENDS_PER_RUN = 25;
/** How many email outputs one member may have. */
export const EMAIL_OUTPUTS_PER_MEMBER = 10;
/**
 * Verification mails one user may cause per rolling 24 hours, across every
 * family and member. This is the anti-spam limit: it's the only way the app
 * mails an address nobody has vouched for, so it caps how many strangers one
 * account can reach in a day.
 */
export const EMAIL_VERIFICATION_DAILY_CAP = 5;
const VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Which filter bucket an event on the unified calendar falls in, if any. */
export function emailOutputEventKind(event: CalendarEventRow): EmailOutputEventKind | null {
  if (event.provenance === 'claimed_task') return 'claimed_task';
  if (event.provenance !== 'synthesized') return null;
  return event.synthKey.startsWith('fb:') ? 'busy' : 'schedule';
}

export function matchesEmailOutputFilters(
  filters: EmailOutputFilters,
  event: CalendarEventRow,
  task: ClaimedTaskMeta | undefined,
): boolean {
  const kind = emailOutputEventKind(event);
  if (!kind || !filters.include.includes(kind)) return false;
  if (kind === 'claimed_task' && filters.taskTypes) {
    if (!task || !filters.taskTypes.includes(task.type as never)) return false;
  }
  if (filters.sourceLinkIds) {
    const source = kind === 'claimed_task' ? task?.sourceLinkId : event.linkId;
    if (!source || !filters.sourceLinkIds.includes(source)) return false;
  }
  return true;
}

function eventEnd(event: { dtstart: Date; dtend: Date | null }): Date {
  return event.dtend ?? event.dtstart;
}

function inviteUid(outputId: string, calendarEventId: string): string {
  // `igt-` prefix: if the invite is accepted onto a calendar we read back, the
  // read-back recursion guard skips it (see readback.ts).
  return `igt-em-${outputId}-${calendarEventId}`;
}

function hashInvite(
  summary: string,
  event: CalendarEventRow,
  alertMinutes: number[],
  timezone: string | undefined,
): string {
  const parts = [
    summary,
    event.dtstart.toISOString(),
    event.dtend ? event.dtend.toISOString() : '',
    event.allDay ? '1' : '0',
    event.location ?? '',
    geoKey(event.locationGeo),
    event.description ?? '',
    alertMinutes.join(','),
    timezone ?? '',
  ].join('|');
  let h = 5381;
  for (let i = 0; i < parts.length; i++) h = ((h << 5) + h) ^ parts.charCodeAt(i);
  return (h >>> 0).toString(16);
}

function emptyResult(): SyncResult {
  return { targets: 0, created: 0, updated: 0, removed: 0, errors: [] };
}

function target(output: EmailOutputRow): DeliveryTarget {
  return { method: 'email', addressOrUrl: output.email };
}

/**
 * Reconcile every email output on one member. Call only when `emailEnabled`:
 * with a capture-only outbox this would record invites as sent that never
 * left, and nothing would re-send them once mail is switched on.
 */
export async function syncMemberEmailOutputs(
  db: Db,
  outbox: Outbox,
  memberId: string,
  now: Date = new Date(),
): Promise<SyncResult> {
  const result = emptyResult();
  const outputs = await db
    .select()
    .from(emailOutputs)
    .where(eq(emailOutputs.familyMemberId, memberId));
  const verified = outputs.filter((o) => o.verifiedAt != null);
  if (verified.length === 0) return result;

  const horizon = new Date(now.getTime() + EMAIL_INVITE_HORIZON_DAYS * DAY_MS);
  const candidates = (
    await db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.familyMemberId, memberId),
          inArray(calendarEvents.provenance, ['synthesized', 'claimed_task']),
          isNull(calendarEvents.maskedAt),
          lte(calendarEvents.dtstart, horizon),
        ),
      )
  )
    .filter((e) => eventEnd(e).getTime() >= now.getTime())
    .sort((a, b) => a.dtstart.getTime() - b.dtstart.getTime());
  const familyId = verified[0]!.familyId;
  const timezones = await linkTimezones(db, familyId);
  const claimedTasks = await claimedTaskMeta(db, familyId);
  const provider = new EmailImipProvider(outbox.send, outbox.from);

  for (const output of verified) {
    result.targets++;
    const desired = output.active
      ? candidates.filter((e) =>
          matchesEmailOutputFilters(
            output.filters,
            e,
            e.taskId ? claimedTasks.get(e.taskId) : undefined,
          ),
        )
      : [];
    const desiredIds = new Set(desired.map((e) => e.id));
    const existing = await db
      .select()
      .from(emailOutputMirrors)
      .where(eq(emailOutputMirrors.emailOutputId, output.id));
    const existingByEvent = new Map(existing.map((m) => [m.calendarEventId, m]));
    let budget = EMAIL_INVITE_SENDS_PER_RUN;

    for (const m of existing) {
      if (desiredIds.has(m.calendarEventId)) continue;
      if (m.eventEndsAt.getTime() < now.getTime()) {
        // It happened; there's nothing to take back.
        await db.delete(emailOutputMirrors).where(eq(emailOutputMirrors.id, m.id));
        continue;
      }
      if (budget <= 0) break;
      budget--;
      try {
        await provider.cancel(
          {
            uid: m.icalUid,
            sequence: m.sequence + 1,
            start: m.eventStartsAt,
            end: m.eventEndsAt,
            summary: m.summary,
          },
          target(output),
        );
        await db.delete(emailOutputMirrors).where(eq(emailOutputMirrors.id, m.id));
        result.removed++;
      } catch (err) {
        // Keep the row: the next run retries the cancellation.
        result.errors.push({ memberId, calendarEventId: m.calendarEventId, error: String(err) });
      }
    }

    const alertMinutes = output.alertMinutes ?? [];
    for (const event of desired) {
      const summary = mirroredSummary(event);
      const task = event.taskId ? claimedTasks.get(event.taskId) : undefined;
      const timezone = event.linkId ? timezones.get(event.linkId) : task?.timezone;
      const hash = hashInvite(summary, event, alertMinutes, timezone);
      const prior = existingByEvent.get(event.id);
      if (prior && prior.payloadHash === hash) continue;
      if (budget <= 0) break;
      budget--;

      const uid = prior?.icalUid ?? inviteUid(output.id, event.id);
      const sequence = prior ? prior.sequence + 1 : 0;
      const invite: DeliveryEvent = {
        uid,
        sequence,
        start: event.dtstart,
        end: event.dtend,
        summary,
        description: event.description ?? undefined,
        location: event.location ?? undefined,
        locationGeo: event.locationGeo ?? undefined,
        alertMinutes: alertMinutes.length > 0 ? alertMinutes : undefined,
        timezone,
      };
      try {
        await provider.upsert(invite, target(output));
      } catch (err) {
        result.errors.push({ memberId, calendarEventId: event.id, error: String(err) });
        continue;
      }
      const row = {
        sequence,
        payloadHash: hash,
        summary,
        eventStartsAt: event.dtstart,
        eventEndsAt: eventEnd(event),
        sentAt: now,
      };
      if (prior) {
        await db.update(emailOutputMirrors).set(row).where(eq(emailOutputMirrors.id, prior.id));
        result.updated++;
      } else {
        await db
          .insert(emailOutputMirrors)
          .values({ emailOutputId: output.id, calendarEventId: event.id, icalUid: uid, ...row });
        result.created++;
      }
    }

    await db
      .update(emailOutputs)
      .set({ lastMirroredAt: now })
      .where(eq(emailOutputs.id, output.id));
  }
  return result;
}

/** Periodic true-up across every member in a family that has an email output. */
export async function syncFamilyEmailOutputs(
  db: Db,
  outbox: Outbox,
  familyId: string,
  now: Date = new Date(),
): Promise<SyncResult> {
  const result = emptyResult();
  const rows = await db
    .selectDistinct({ memberId: emailOutputs.familyMemberId })
    .from(emailOutputs)
    .where(eq(emailOutputs.familyId, familyId));
  for (const { memberId } of rows) {
    const r = await syncMemberEmailOutputs(db, outbox, memberId, now);
    result.targets += r.targets;
    result.created += r.created;
    result.updated += r.updated;
    result.removed += r.removed;
    result.errors.push(...r.errors);
  }
  return result;
}

type EmailOutputMirrorRow = typeof emailOutputMirrors.$inferSelect;

/** An output's invites for events that haven't ended yet. */
export async function upcomingInvites(
  db: Db,
  outputId: string,
  now: Date = new Date(),
): Promise<EmailOutputMirrorRow[]> {
  return db
    .select()
    .from(emailOutputMirrors)
    .where(
      and(eq(emailOutputMirrors.emailOutputId, outputId), gt(emailOutputMirrors.eventEndsAt, now)),
    );
}

/**
 * Mail a cancellation for each of `rows` (an output being deleted). Takes the
 * rows rather than the output id because the delete cascades them away.
 * Best-effort per invite.
 */
export async function cancelInvites(
  outbox: Outbox,
  email: string,
  rows: EmailOutputMirrorRow[],
): Promise<void> {
  const provider = new EmailImipProvider(outbox.send, outbox.from);
  for (const m of rows) {
    try {
      await provider.cancel(
        {
          uid: m.icalUid,
          sequence: m.sequence + 1,
          start: m.eventStartsAt,
          end: m.eventEndsAt,
          summary: m.summary,
        },
        { method: 'email', addressOrUrl: email },
      );
    } catch {
      // best-effort
    }
  }
}

// --- Verification ------------------------------------------------------------

export class VerificationCapExceededError extends Error {
  constructor() {
    super('too many verification emails in the last 24 hours');
    this.name = 'VerificationCapExceededError';
  }
}

/**
 * Has `userId` already proven they can read `email` — i.e. do they own a
 * verified output to that address? Then a new output to it (another member,
 * a different filter) needs no fresh mail.
 */
export async function userHasVerified(db: Db, userId: string, email: string): Promise<boolean> {
  const row = await db
    .select({ id: emailOutputs.id })
    .from(emailOutputs)
    .innerJoin(emailVerifications, eq(emailVerifications.emailOutputId, emailOutputs.id))
    .where(
      and(
        eq(emailOutputs.email, email),
        eq(emailVerifications.userId, userId),
        eq(emailVerifications.email, email),
        // consumed ⇒ the link was opened for this very address
        isNotNull(emailVerifications.consumedAt),
      ),
    )
    .limit(1);
  return row.length > 0;
}

/** Verification mails `userId` has caused in the last 24 hours. */
export async function verificationsSentToday(db: Db, userId: string, now = new Date()) {
  const rows = await db
    .select({ id: emailVerifications.id })
    .from(emailVerifications)
    .where(
      and(
        eq(emailVerifications.userId, userId),
        gt(emailVerifications.createdAt, new Date(now.getTime() - DAY_MS)),
      ),
    )
    .limit(EMAIL_VERIFICATION_DAILY_CAP);
  return rows.length;
}

/**
 * Mail `output.email` a one-time link that verifies it. Throws
 * `VerificationCapExceededError` when the user is out of budget. Returns the
 * raw token (the route hands it back only where dev tokens are allowed).
 */
export async function sendVerification(
  db: Db,
  outbox: Outbox,
  opts: {
    userId: string;
    output: EmailOutputRow;
    memberName: string;
    requesterName: string;
    /** Absolute base for the link, e.g. `https://host/api`; empty ⇒ relative. */
    linkBase: string;
  },
  now = new Date(),
): Promise<string> {
  if ((await verificationsSentToday(db, opts.userId, now)) >= EMAIL_VERIFICATION_DAILY_CAP) {
    throw new VerificationCapExceededError();
  }
  const raw = randomToken();
  await db.insert(emailVerifications).values({
    userId: opts.userId,
    emailOutputId: opts.output.id,
    email: opts.output.email,
    tokenHash: await sha256hex(raw),
    expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
    createdAt: now,
  });
  const link = `${opts.linkBase}/email-outputs/verify/${raw}`;
  await outbox.send(
    buildTextEmailMime({
      from: outbox.from,
      to: opts.output.email,
      subject: `Confirm calendar invites for ${opts.memberName}`,
      text: [
        `${opts.requesterName} wants to send calendar invites for ${opts.memberName}'s`,
        'schedule to this address.',
        '',
        'Nothing will be sent unless you confirm here:',
        link,
        '',
        "If you weren't expecting this, ignore it — the link expires in 48 hours.",
      ].join('\n'),
    }),
    opts.output.email,
  );
  return raw;
}

/** Why a verification link can't be used. */
export type VerifyOutcome =
  | { ok: true; output: EmailOutputRow }
  | { ok: false; reason: 'invalid' | 'expired' | 'gone' };

/** Look a link's token up without consuming it (the GET confirmation page). */
export async function peekVerification(db: Db, raw: string, now = new Date()): Promise<VerifyOutcome> {
  const row = (
    await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.tokenHash, await sha256hex(raw)))
      .limit(1)
  )[0];
  if (!row || row.consumedAt) return { ok: false, reason: 'invalid' };
  if (row.expiresAt.getTime() < now.getTime()) return { ok: false, reason: 'expired' };
  const output = (
    await db.select().from(emailOutputs).where(eq(emailOutputs.id, row.emailOutputId)).limit(1)
  )[0];
  // The output was deleted, or re-pointed at another address since the mail went out.
  if (!output || output.email !== row.email) return { ok: false, reason: 'gone' };
  return { ok: true, output };
}

/** Consume a link's token and mark its output verified. */
export async function consumeVerification(
  db: Db,
  raw: string,
  now = new Date(),
): Promise<VerifyOutcome> {
  const peeked = await peekVerification(db, raw, now);
  if (!peeked.ok) return peeked;
  const consumed = await db
    .update(emailVerifications)
    .set({ consumedAt: now })
    .where(
      and(
        eq(emailVerifications.tokenHash, await sha256hex(raw)),
        isNull(emailVerifications.consumedAt),
      ),
    )
    .returning({ id: emailVerifications.id });
  if (consumed.length === 0) return { ok: false, reason: 'invalid' };
  const output = (
    await db
      .update(emailOutputs)
      .set({ verifiedAt: peeked.output.verifiedAt ?? now })
      .where(eq(emailOutputs.id, peeked.output.id))
      .returning()
  )[0]!;
  return { ok: true, output };
}
