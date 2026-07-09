import {
  and,
  calendarEvents,
  type Db,
  eq,
  gte,
  lt,
  memberCalendars,
} from '@igt/db';
import {
  fetchCalDavOccurrences,
  fetchGoogleOccurrences,
  type Occurrence,
} from '@igt/ical';
import { resolveAccountCredential } from '../lib/account-credentials.js';
import { hashCalendarEvent, synthesisWindow } from './synthesis.js';

type MemberCalendarRow = typeof memberCalendars.$inferSelect;

export interface ReadBackOptions {
  fetchImpl?: typeof fetch;
  windowStart?: Date;
  windowEnd?: Date;
  /** Envelope key — required to decrypt the target account's credential. */
  kek?: string;
  /** Exchange a Google refresh token for an access token (host holds the client secret). */
  googleRefresh?: (refreshToken: string) => Promise<string>;
}

export interface ReadBackResult {
  familyMemberId: string;
  fetched: boolean;
  upserted: number;
  removed: number;
}

/** Our own mirrored events carry this UID prefix and must never be re-imported. */
const MIRROR_UID_PREFIX = 'igt-';

function humanSynthKey(occ: Occurrence): string {
  return `ext:${occ.uid}:${occ.recurrenceId ?? ''}`;
}

/**
 * Read a member's external target calendar back into their unified calendar as
 * `human` events — the other half of "manual + synthesized events coexist as
 * first-class items on the target". The recursion guard: anything with an
 * `igt-` UID is one of our own mirrored events and is skipped, so the
 * mirror→read-back loop can never echo.
 */
export async function readBackMember(
  db: Db,
  cal: MemberCalendarRow,
  opts: ReadBackOptions = {},
): Promise<ReadBackResult> {
  const result: ReadBackResult = {
    familyMemberId: cal.familyMemberId,
    fetched: false,
    upserted: 0,
    removed: 0,
  };
  if (!cal.active) return result;

  const credential = await resolveAccountCredential(
    db,
    opts.kek,
    cal.targetExternalAccountId,
  );
  if (!credential) return result;

  const window = synthesisWindow(opts);
  const expand = { windowStart: window.start, windowEnd: window.end };

  let occurrences: Occurrence[];
  if (cal.targetMethod === 'caldav') {
    if (credential.kind !== 'basic') return result;
    occurrences = await fetchCalDavOccurrences(
      {
        collectionUrl: cal.targetCalendarId,
        username: credential.username,
        password: credential.password,
      },
      expand,
      opts.fetchImpl,
    );
  } else {
    if (credential.kind !== 'oauth') return result;
    const accessToken =
      credential.accessToken ??
      (credential.refreshToken && opts.googleRefresh
        ? await opts.googleRefresh(credential.refreshToken)
        : undefined);
    if (!accessToken) return result;
    occurrences = await fetchGoogleOccurrences(
      accessToken,
      cal.targetCalendarId,
      expand,
      opts.fetchImpl,
    );
  }
  result.fetched = true;

  const human = occurrences.filter((o) => !o.uid.startsWith(MIRROR_UID_PREFIX));

  const existing = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.familyMemberId, cal.familyMemberId),
        eq(calendarEvents.provenance, 'human'),
        gte(calendarEvents.dtstart, window.start),
        lt(calendarEvents.dtstart, window.end),
      ),
    );
  const existingByKey = new Map(existing.map((e) => [e.synthKey, e]));
  const desiredKeys = new Set<string>();

  for (const occ of human) {
    const synthKey = humanSynthKey(occ);
    desiredKeys.add(synthKey);
    const payload = {
      dtstart: occ.start,
      dtend: occ.end,
      allDay: occ.allDay,
      summary: occ.summary,
      location: occ.location,
      description: null,
    };
    const contentHash = hashCalendarEvent(payload);
    const prior = existingByKey.get(synthKey);
    if (prior) {
      if (prior.contentHash !== contentHash) {
        await db
          .update(calendarEvents)
          .set({ ...payload, contentHash })
          .where(eq(calendarEvents.id, prior.id));
        result.upserted++;
      }
      continue;
    }
    await db.insert(calendarEvents).values({
      familyId: cal.familyId,
      familyMemberId: cal.familyMemberId,
      provenance: 'human',
      synthKey,
      externalUid: occ.uid,
      externalRecurrenceId: occ.recurrenceId ?? '',
      contentHash,
      ...payload,
    });
    result.upserted++;
  }

  // Human events that vanished remotely disappear here too (their unowned
  // tasks are swept by the next task-gen pass).
  for (const prior of existing) {
    if (!desiredKeys.has(prior.synthKey)) {
      await db.delete(calendarEvents).where(eq(calendarEvents.id, prior.id));
      result.removed++;
    }
  }

  await db
    .update(memberCalendars)
    .set({ lastReadBackAt: new Date() })
    .where(eq(memberCalendars.id, cal.id));
  return result;
}

/** Read back every configured member calendar in a family. */
export async function readBackFamily(
  db: Db,
  familyId: string,
  opts: ReadBackOptions = {},
): Promise<ReadBackResult[]> {
  const cals = await db
    .select()
    .from(memberCalendars)
    .where(eq(memberCalendars.familyId, familyId));
  const results: ReadBackResult[] = [];
  for (const cal of cals) {
    try {
      results.push(await readBackMember(db, cal, opts));
    } catch (err) {
      // One unreachable target shouldn't block the family's other members.
      console.error(`read-back failed for member ${cal.familyMemberId}`, err);
    }
  }
  return results;
}
