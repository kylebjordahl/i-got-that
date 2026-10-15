import {
  absenceNoticeSettings,
  absenceNotices,
  and,
  calendarEvents,
  conflicts,
  type Db,
  eq,
  familyMemberFeeds,
  familyMembers,
  feeds,
  gte,
  inArray,
} from '@igt/db';
import { tzOffsetMs } from '@igt/classification';
import type { AbsenceNotice, AbsenceNoticeState } from '@igt/domain';
import { selectChunked } from '../lib/d1.js';
import { hydrateConflicts, type HydratedConflict } from './conflicts.js';

/**
 * "Email school" absence notices.
 *
 * A resolved conflict whose loser is a `bl:` baseline school day means the
 * child leaves the school day for the winning event (an appointment) and comes
 * back afterwards. This module turns those into one notice per child + school
 * link + school date: who it goes to, the gap(s) it announces, the composed
 * subject and body, and whether somebody has already sent it for those times.
 *
 * Nothing here sends anything — the phone's Mail app does. The server only
 * computes (times, wording, state) and records that a person said they sent it.
 */

const MIN = 60_000;

/** One stretch of the school day the child is away for. Epoch ms, UTC. */
export interface AbsenceGap {
  /**
   * `gap`: leaves and comes back. `arrive`: skipped morning, arrives at `returnMs`.
   * `leave`: skipped afternoon, leaves at `leaveMs` and doesn't return.
   * `all_day`: absent for the whole day.
   */
  kind: 'gap' | 'arrive' | 'leave' | 'all_day';
  /** Epoch ms the child leaves school (for `arrive`/`all_day`, the day's start). */
  leaveMs: number;
  /** Epoch ms the child is back (for `leave`/`all_day`, the day's end). */
  returnMs: number;
}

/** The pieces of one resolved conflict that decide its gap. */
export interface GapInput {
  dayStartMs: number;
  dayEndMs: number;
  winnerStartMs: number;
  winnerEndMs: number;
  travelBeforeMin: number;
  travelAfterMin: number;
  beforeNeeded: boolean;
  afterNeeded: boolean;
}

/**
 * The school-day gap one resolved conflict leaves: leave = winner start minus
 * the travel-before buffer, return = winner end plus the travel-after buffer,
 * both clamped to the baseline day's bounds. A skipped half turns it into an
 * arrival or an early departure; both skipped is the whole day.
 */
export function computeGap(i: GapInput): AbsenceGap {
  const leaveMs = Math.max(i.dayStartMs, i.winnerStartMs - i.travelBeforeMin * MIN);
  const returnMs = Math.min(i.dayEndMs, i.winnerEndMs + i.travelAfterMin * MIN);
  if (!i.beforeNeeded && !i.afterNeeded) {
    return { kind: 'all_day', leaveMs: i.dayStartMs, returnMs: i.dayEndMs };
  }
  if (!i.beforeNeeded) return { kind: 'arrive', leaveMs: i.dayStartMs, returnMs };
  if (!i.afterNeeded) return { kind: 'leave', leaveMs, returnMs: i.dayEndMs };
  return { kind: 'gap', leaveMs, returnMs };
}

/**
 * Collapse several conflicts' gaps on one school day into the minimal list:
 * any whole-day absence swallows the rest; otherwise overlapping gaps merge
 * (an arrival and a departure that meet or cross are a whole day).
 */
export function mergeGaps(gaps: AbsenceGap[]): AbsenceGap[] {
  if (gaps.length === 0) return [];
  const sorted = [...gaps].sort((a, b) => a.leaveMs - b.leaveMs || a.returnMs - b.returnMs);
  const dayStart = Math.min(...sorted.map((g) => g.leaveMs));
  const dayEnd = Math.max(...sorted.map((g) => g.returnMs));
  if (sorted.some((g) => g.kind === 'all_day')) {
    return [{ kind: 'all_day', leaveMs: dayStart, returnMs: dayEnd }];
  }
  const out: AbsenceGap[] = [];
  for (const g of sorted) {
    const last = out[out.length - 1];
    if (last && g.leaveMs <= last.returnMs) {
      // Overlapping or touching: one stretch. Its kind follows the open ends.
      const arrive = last.kind === 'arrive' || g.kind === 'arrive';
      const leave = last.kind === 'leave' || g.kind === 'leave';
      last.returnMs = Math.max(last.returnMs, g.returnMs);
      last.kind = arrive && leave ? 'all_day' : arrive ? 'arrive' : leave ? 'leave' : 'gap';
    } else {
      out.push({ ...g });
    }
  }
  // A morning skip plus an afternoon skip that never overlap still leave a
  // child in school for the middle — keep them as two lines.
  return out;
}

/** Canonical, comparable snapshot of a day's gaps — what `absence_notices.gapStamp` stores. */
export function gapStampOf(gaps: AbsenceGap[]): string {
  return JSON.stringify(gaps.map((g) => [g.kind, g.leaveMs, g.returnMs]));
}

function parseGapStamp(stamp: string): AbsenceGap[] {
  try {
    const raw = JSON.parse(stamp) as [AbsenceGap['kind'], number, number][];
    return raw.map(([kind, leaveMs, returnMs]) => ({ kind, leaveMs, returnMs }));
  } catch {
    return [];
  }
}

/** The local calendar date of an instant in `tz`, as `YYYY-MM-DD`. */
function localDate(ms: number, tz: string): string {
  return new Date(ms + tzOffsetMs(tz, ms)).toISOString().slice(0, 10);
}

function safeTz(tz: string | null): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function formatTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

function formatDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The natural-language phrase for a day's gaps ("leaving at 10:00 AM and returning at 11:30 AM"). */
export function schedulePhrase(gaps: AbsenceGap[], tz: string): string {
  if (gaps.some((g) => g.kind === 'all_day')) return 'absent all day';
  const phrases = gaps.map((g) => {
    switch (g.kind) {
      case 'arrive':
        return `arriving at ${formatTime(g.returnMs, tz)}`;
      case 'leave':
        return `leaving at ${formatTime(g.leaveMs, tz)}, not returning today`;
      default:
        return `leaving at ${formatTime(g.leaveMs, tz)} and returning at ${formatTime(g.returnMs, tz)}`;
    }
  });
  return joinAnd(phrases);
}

/** Replace `{name}` placeholders; unknown placeholders are left as typed. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : whole,
  );
}

export interface ComposeInput {
  subjectTemplate: string;
  bodyTemplate: string;
  includeReason: boolean;
  child: string;
  parent: string;
  dateKey: string;
  tz: string;
  gaps: AbsenceGap[];
  /** Event titles of the appointments, used only when `includeReason`. */
  reasons: string[];
  /** The gaps of the earlier notice that this one replaces, if any. */
  previous?: AbsenceGap[] | null;
  /** The absence is off: the child will now attend the whole day. */
  attendsFullDay?: boolean;
}

/** Fill the templates; when replacing an earlier notice, say so and quote its times. */
export function composeNotice(i: ComposeInput): { subject: string; body: string } {
  const first = i.gaps[0];
  const last = i.gaps[i.gaps.length - 1];
  const reasons = [...new Set(i.reasons.map((r) => r.trim()).filter(Boolean))];
  const reason = i.includeReason && reasons.length > 0 ? joinAnd(reasons) : 'an appointment';
  const values: Record<string, string> = {
    child: i.child,
    parent: i.parent,
    date: formatDate(i.dateKey),
    leaveTime: first ? formatTime(first.leaveMs, i.tz) : '',
    returnTime: last ? formatTime(last.returnMs, i.tz) : '',
    reason,
    schedule: schedulePhrase(i.gaps, i.tz),
  };
  let subject = fillTemplate(i.subjectTemplate, values);
  let body = fillTemplate(i.bodyTemplate, values);
  if (i.attendsFullDay) {
    const was = i.previous && i.previous.length > 0 ? `, which said ${i.child} would be ${schedulePhrase(i.previous, i.tz)}` : '';
    subject = `Updated: ${subject}`;
    body = `Update: ${i.child} will now attend the full school day on ${values.date}. This replaces my earlier notice${was}.\n\n${i.parent}`;
  } else if (i.previous) {
    subject = `Updated: ${subject}`;
    body =
      `This replaces my earlier notice, which said ${i.child} would be ` +
      `${i.previous.length > 0 ? schedulePhrase(i.previous, i.tz) : 'attending the full day'}.\n\n${body}`;
  }
  return { subject, body };
}

/** An eligible notice with everything the callers need to route and filter it. */
export interface EligibleNotice extends AbsenceNotice {
  familyId: string;
  /** Child's relationName. */
  child: string;
  /** The school day this notice is about, UTC epoch ms. */
  dayStartMs: number;
  dayEndMs: number;
  /** Plain-language times for Home's card ("leaving at 10:00 AM and returning at 11:30 AM"). */
  schedule: string;
  /** First gap's leave time, for ordering and digest lines. */
  leaveMs: number;
  /** An event the client can open the notice from (the appointment). */
  eventId: string;
  /** synthKeys that lead to this notice: loser, its cf: segments are derived from it. */
  loserKeys: string[];
  winnerKeys: string[];
}

export interface LoadOptions {
  /** Restrict to one child. */
  memberId?: string;
  /** The composing member (for `{parent}`). */
  composerName?: string;
}

/** `bl:<linkId>:<date>` → linkId. Link ids are UUIDs, so they contain no colon. */
function linkIdOfBaselineKey(key: string): string | null {
  const parts = key.split(':');
  return parts.length >= 3 && parts[0] === 'bl' ? parts[1]! : null;
}

/**
 * Every eligible notice across the given families, with its composed text and
 * send state. Eligible = a `resolved` conflict whose loser is a `bl:` baseline
 * day on a link with at least one recipient. A pending, dismissed or reopened
 * conflict never appears (the reconcile flips a moved conflict back to pending).
 *
 * Every query here is bounded by the families' size, or chunked through
 * `hydrateConflicts` / `selectChunked` — nothing binds a list that grows with
 * the amount of calendar data.
 */
export async function loadAbsenceNotices(
  db: Db,
  familyIds: string[],
  opts: LoadOptions = {},
): Promise<EligibleNotice[]> {
  if (familyIds.length === 0) return [];

  // Links that have recipients, with the school feed's timezone.
  const settingsRows = await db
    .select({
      linkId: absenceNoticeSettings.linkId,
      to: absenceNoticeSettings.toAddresses,
      cc: absenceNoticeSettings.ccAddresses,
      subjectTemplate: absenceNoticeSettings.subjectTemplate,
      bodyTemplate: absenceNoticeSettings.bodyTemplate,
      includeReason: absenceNoticeSettings.includeReason,
      timezone: feeds.timezone,
    })
    .from(absenceNoticeSettings)
    .innerJoin(familyMemberFeeds, eq(familyMemberFeeds.id, absenceNoticeSettings.linkId))
    .innerJoin(feeds, eq(feeds.id, familyMemberFeeds.feedId))
    .where(inArray(absenceNoticeSettings.familyId, familyIds));
  const settingsByLink = new Map(
    settingsRows
      .filter((s) => s.to.length + s.cc.length > 0)
      .map((s) => [s.linkId, s]),
  );
  if (settingsByLink.size === 0) return [];

  const allConflicts = await db
    .select()
    .from(conflicts)
    .where(inArray(conflicts.familyId, familyIds));
  const baselineRows = allConflicts.filter(
    (r) =>
      r.status === 'resolved' &&
      r.loserKey.startsWith('bl:') &&
      (!opts.memberId || r.familyMemberId === opts.memberId),
  );

  const hydrated = (await hydrateConflicts(db, familyIds, baselineRows)).filter((h) => {
    const linkId = linkIdOfBaselineKey(h.loser.synthKey);
    return linkId != null && settingsByLink.has(linkId) && h.loser.dtend != null;
  });
  // Group by child + link + school date.
  interface Group {
    familyId: string;
    memberId: string;
    linkId: string;
    date: string;
    tz: string;
    items: HydratedConflict[];
  }
  const groups = new Map<string, Group>();
  for (const h of hydrated) {
    const linkId = linkIdOfBaselineKey(h.loser.synthKey)!;
    const tz = safeTz(settingsByLink.get(linkId)!.timezone);
    const date = localDate(h.loser.dtstart.getTime(), tz);
    const key = `${h.conflict.familyMemberId}|${linkId}|${date}`;
    const g = groups.get(key) ?? {
      familyId: h.conflict.familyId,
      memberId: h.conflict.familyMemberId,
      linkId,
      date,
      tz,
      items: [],
    };
    g.items.push(h);
    groups.set(key, g);
  }

  // Sent records for the dates in play, and the names to show.
  // Records reach back two days so a notice for a school day that was just
  // called off can still be retracted.
  const floor = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const dates = [...groups.values()].map((g) => g.date).sort();
  const sent = await db
    .select()
    .from(absenceNotices)
    .where(
      and(
        inArray(absenceNotices.familyId, familyIds),
        gte(absenceNotices.date, dates[0] && dates[0] < floor ? dates[0] : floor),
      ),
    );
  const sentByKey = new Map(sent.map((s) => [`${s.familyMemberId}|${s.linkId}|${s.date}`, s]));
  const members = await db
    .select({ id: familyMembers.id, relationName: familyMembers.relationName })
    .from(familyMembers)
    .where(inArray(familyMembers.familyId, familyIds));
  const nameOf = new Map(members.map((m) => [m.id, m.relationName]));

  // The appointment's event id, so a client can open the notice from it.
  const winnerKeys = [...new Set(hydrated.map((h) => h.conflict.winnerKey))];
  const winnerMemberIds = [
    ...new Set([
      ...hydrated.map((h) => h.conflict.familyMemberId),
      ...sent.map((r) => r.familyMemberId),
    ]),
  ];
  const winnerEvents = await selectChunked(
    winnerKeys,
    (chunk) =>
      db
        .select({
          id: calendarEvents.id,
          familyMemberId: calendarEvents.familyMemberId,
          synthKey: calendarEvents.synthKey,
        })
        .from(calendarEvents)
        .where(
          and(
            inArray(calendarEvents.familyMemberId, winnerMemberIds),
            inArray(calendarEvents.synthKey, chunk),
          ),
        ),
    winnerMemberIds.length,
  );
  const eventIdByKey = new Map(winnerEvents.map((e) => [`${e.familyMemberId}|${e.synthKey}`, e.id]));

  const out: EligibleNotice[] = [];
  for (const g of groups.values()) {
    const settings = settingsByLink.get(g.linkId)!;
    const gaps = mergeGaps(
      g.items.map((h) =>
        computeGap({
          dayStartMs: h.loser.dtstart.getTime(),
          dayEndMs: h.loser.dtend!.getTime(),
          winnerStartMs: h.winner.dtstart.getTime(),
          winnerEndMs: (h.winner.dtend ?? h.winner.dtstart).getTime(),
          travelBeforeMin: h.conflict.travelBeforeMin,
          travelAfterMin: h.conflict.travelAfterMin,
          beforeNeeded: h.conflict.beforeNeeded,
          afterNeeded: h.conflict.afterNeeded,
        }),
      ),
    );
    const stamp = gapStampOf(gaps);
    const record = sentByKey.get(`${g.memberId}|${g.linkId}|${g.date}`);
    const state: AbsenceNoticeState = !record
      ? 'outstanding'
      : record.gapStamp === stamp
        ? 'sent'
        : 'needs_update';
    const winnersSorted = [...g.items].sort(
      (a, b) => a.winner.dtstart.getTime() - b.winner.dtstart.getTime(),
    );
    const child = nameOf.get(g.memberId) ?? '';
    const { subject, body } = composeNotice({
      subjectTemplate: settings.subjectTemplate,
      bodyTemplate: settings.bodyTemplate,
      includeReason: settings.includeReason,
      child,
      parent: opts.composerName ?? '',
      dateKey: g.date,
      tz: g.tz,
      gaps,
      reasons: winnersSorted.map((h) => h.winner.summary ?? ''),
      previous: state === 'needs_update' ? parseGapStamp(record!.gapStamp) : null,
    });
    out.push({
      familyId: g.familyId,
      familyMemberId: g.memberId,
      linkId: g.linkId,
      date: g.date,
      to: settings.to,
      cc: settings.cc,
      subject,
      body,
      state,
      sentBy: record?.sentByMemberId ? (nameOf.get(record.sentByMemberId) ?? null) : null,
      sentAt: record?.sentAt ?? null,
      gapStamp: stamp,
      child,
      schedule: schedulePhrase(gaps, g.tz),
      dayStartMs: Math.min(...g.items.map((h) => h.loser.dtstart.getTime())),
      dayEndMs: Math.max(...g.items.map((h) => h.loser.dtend!.getTime())),
      leaveMs: gaps[0]?.leaveMs ?? 0,
      eventId:
        eventIdByKey.get(`${g.memberId}|${winnersSorted[0]!.conflict.winnerKey}`) ?? '',
      loserKeys: g.items.map((h) => h.conflict.loserKey),
      winnerKeys: g.items.map((h) => h.conflict.winnerKey),
    });
  }

  // --- Retractions: sent, but the absence has gone away. ---------------------
  // The appointment was cancelled or moved off the school day (the conflict row
  // is deleted) or the conflict was dismissed. If the school day still exists,
  // hasn't been resolved/reopened as a conflict, and the school was told the
  // child would be away, they need telling the child will attend after all.
  const conflictedLoserKeys = new Set(
    allConflicts
      .filter((c) => c.status !== 'dismissed')
      .map((c) => `${c.familyMemberId}|${c.loserKey}`),
  );
  const candidates = sent.filter(
    (r) =>
      !groups.has(`${r.familyMemberId}|${r.linkId}|${r.date}`) &&
      settingsByLink.has(r.linkId) &&
      (!opts.memberId || r.familyMemberId === opts.memberId) &&
      !conflictedLoserKeys.has(`${r.familyMemberId}|bl:${r.linkId}:${r.date}`),
  );
  if (candidates.length > 0) {
    const blKeys = [...new Set(candidates.map((r) => `bl:${r.linkId}:${r.date}`))];
    const blEvents = await selectChunked(
      blKeys,
      (chunk) =>
        db
          .select({
            id: calendarEvents.id,
            familyMemberId: calendarEvents.familyMemberId,
            synthKey: calendarEvents.synthKey,
            dtstart: calendarEvents.dtstart,
            dtend: calendarEvents.dtend,
          })
          .from(calendarEvents)
          .where(
            and(
              inArray(calendarEvents.familyMemberId, winnerMemberIds),
              inArray(calendarEvents.synthKey, chunk),
            ),
          ),
      winnerMemberIds.length,
    );
    const blByKey = new Map(blEvents.map((e) => [`${e.familyMemberId}|${e.synthKey}`, e]));
    for (const r of candidates) {
      const bl = blByKey.get(`${r.familyMemberId}|bl:${r.linkId}:${r.date}`);
      if (!bl || !bl.dtend) continue; // the school day itself is gone: nothing to say
      const settings = settingsByLink.get(r.linkId)!;
      const tz = safeTz(settings.timezone);
      const stamp = gapStampOf([]);
      const state: AbsenceNoticeState = r.gapStamp === stamp ? 'sent' : 'needs_update';
      const child = nameOf.get(r.familyMemberId) ?? '';
      const previous = parseGapStamp(r.gapStamp);
      const composed = composeNotice({
        subjectTemplate: settings.subjectTemplate,
        bodyTemplate: settings.bodyTemplate,
        includeReason: settings.includeReason,
        child,
        parent: opts.composerName ?? '',
        dateKey: r.date,
        tz,
        gaps: [],
        reasons: [],
        previous,
        attendsFullDay: true,
      });
      out.push({
        familyId: r.familyId,
        familyMemberId: r.familyMemberId,
        linkId: r.linkId,
        date: r.date,
        to: settings.to,
        cc: settings.cc,
        subject: composed.subject,
        body: composed.body,
        state,
        sentBy: r.sentByMemberId ? (nameOf.get(r.sentByMemberId) ?? null) : null,
        sentAt: r.sentAt,
        gapStamp: stamp,
        child,
        schedule: 'attending the full day after all',
        dayStartMs: bl.dtstart.getTime(),
        dayEndMs: bl.dtend.getTime(),
        leaveMs: previous[0]?.leaveMs ?? bl.dtstart.getTime(),
        eventId: bl.id,
        loserKeys: [bl.synthKey],
        winnerKeys: [],
      });
    }
  }
  return out.sort((a, b) => a.dayStartMs - b.dayStartMs || a.child.localeCompare(b.child));
}

/** Outstanding = eligible, not sent for the current gap, and the school day hasn't ended. */
export function isOutstanding(n: EligibleNotice, now: Date): boolean {
  return n.state !== 'sent' && n.dayEndMs > now.getTime();
}

/**
 * The notice an event leads to: the appointment (winner) of a resolved
 * conflict, the school day (loser) itself, or one of its `cf:` split
 * segments. A winner that reaches several school days gets the earliest.
 */
export function noticeForEvent(
  notices: EligibleNotice[],
  event: { familyMemberId: string; synthKey: string },
): EligibleNotice | null {
  let key = event.synthKey;
  if (key.startsWith('cf:')) key = key.slice(3, key.lastIndexOf(':'));
  return (
    notices.find(
      (n) =>
        n.familyMemberId === event.familyMemberId &&
        (n.loserKeys.includes(key) || n.winnerKeys.includes(key)),
    ) ?? null
  );
}

/** Strip server-only fields before a notice goes over the wire. */
export function publicNotice(n: EligibleNotice) {
  const {
    familyId: _f,
    dayStartMs: _s,
    dayEndMs: _e,
    leaveMs: _l,
    loserKeys: _lk,
    winnerKeys: _wk,
    ...rest
  } = n;
  return rest;
}
