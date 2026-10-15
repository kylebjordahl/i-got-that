import { env } from 'cloudflare:test';
import {
  absenceNotices,
  calendarEvents,
  conflicts,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  notificationSchedules,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import {
  computeGap,
  mergeGaps,
  schedulePhrase,
} from '../src/services/absence-notices.js';
import { reconcileMemberConflicts } from '../src/services/conflicts.js';
import { buildUserDigest } from '../src/services/digest.js';
import { currentBadgeCount } from '../src/services/notifications.js';
import { authed, bearer, call, linkMember, login, put, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

/** A day a few days out (inside the default synthesis window) at hh:mm UTC. */
function futureAt(offsetDays: number, hour: number, min = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, min, 0, 0);
  return d;
}

const ISO_DAY = (d: Date) => d.toISOString().slice(0, 10);

/** Family + child + a school (exception) link, optionally with a feed timezone. */
async function fixture(email: string, timezone: string | null = null) {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        mode: 'exception',
        url: 'https://feed.example.com/school.ics',
        sourceCalendarName: 'Lincoln Elementary',
        timezone,
      })
      .returning()
  )[0]!;
  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({
        familyId: fam.familyId,
        feedId: feed.id,
        familyMemberId: fam.childId,
        weekdayMask: 127,
        dayStart: '08:30',
        dayEnd: '15:00',
      })
      .returning()
  )[0]!;
  return { ...fam, db, feed, linkId: link.id };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

const settingsUrl = (f: Fx) =>
  `/families/${f.familyId}/feeds/${f.feed.id}/member-links/${f.linkId}/absence-notice-settings`;

async function setRecipients(f: Fx, body: Record<string, unknown> = {}) {
  const res = await call(settingsUrl(f), put(f.admin.token, { to: ['office@school.test'], ...body }));
  expect(res.status).toBe(200);
}

/** Add the school day (day offset, 08:30–15:00 UTC). */
async function schoolDay(f: Fx, offset = 3) {
  const start = futureAt(offset, 8, 30);
  const key = `bl:${f.linkId}:${ISO_DAY(start)}`;
  await f.db.insert(calendarEvents).values({
    familyId: f.familyId,
    familyMemberId: f.childId,
    provenance: 'synthesized',
    synthKey: key,
    linkId: f.linkId,
    dtstart: start,
    dtend: futureAt(offset, 15, 0),
    summary: 'School day',
    contentHash: `bl-${key}`,
  });
  return key;
}

/** A human appointment; returns its event id and key. */
async function appointment(
  f: Fx,
  name: string,
  offset: number,
  [h1, m1]: [number, number],
  [h2, m2]: [number, number],
) {
  const synthKey = `ext:${name}:`;
  const row = (
    await f.db
      .insert(calendarEvents)
      .values({
        familyId: f.familyId,
        familyMemberId: f.childId,
        provenance: 'human',
        synthKey,
        externalUid: name,
        dtstart: futureAt(offset, h1, m1),
        dtend: futureAt(offset, h2, m2),
        summary: name,
        contentHash: `h-${name}`,
      })
      .returning()
  )[0]!;
  return { id: row.id, synthKey };
}

async function detect(f: Fx) {
  await reconcileMemberConflicts(f.db, f.childId);
  const rows = await f.db.select().from(conflicts).where(eq(conflicts.familyMemberId, f.childId));
  return rows;
}

async function resolveAll(f: Fx, body: Record<string, unknown> = {}) {
  for (const c of await detect(f)) {
    const res = await call(
      `/families/${f.familyId}/conflicts/${c.id}/resolve`,
      authed(f.admin.token, body),
    );
    expect(res.status).toBe(200);
  }
}

interface NoticeBody {
  available: boolean;
  reason?: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  state?: string;
  sentBy?: string | null;
  sentAt?: string | null;
  gapStamp?: string;
  date?: string;
}

async function notice(f: Fx, eventId: string, token = f.admin.token) {
  const res = await call(
    `/families/${f.familyId}/calendar-events/${eventId}/absence-notice`,
    bearer(token),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as NoticeBody;
}

async function eventIdOf(f: Fx, synthKey: string) {
  const rows = await f.db
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(eq(calendarEvents.synthKey, synthKey));
  return rows[0]!.id;
}

describe('gap computation (pure)', () => {
  const base = {
    dayStartMs: Date.UTC(2030, 0, 7, 8, 30),
    dayEndMs: Date.UTC(2030, 0, 7, 15, 0),
    winnerStartMs: Date.UTC(2030, 0, 7, 10, 0),
    winnerEndMs: Date.UTC(2030, 0, 7, 11, 0),
    travelBeforeMin: 0,
    travelAfterMin: 0,
    beforeNeeded: true,
    afterNeeded: true,
  };
  it('applies travel buffers and clamps to the school day', () => {
    expect(computeGap({ ...base, travelBeforeMin: 20, travelAfterMin: 30 })).toEqual({
      kind: 'gap',
      leaveMs: Date.UTC(2030, 0, 7, 9, 40),
      returnMs: Date.UTC(2030, 0, 7, 11, 30),
    });
    const clamped = computeGap({
      ...base,
      winnerStartMs: Date.UTC(2030, 0, 7, 8, 40),
      winnerEndMs: Date.UTC(2030, 0, 7, 14, 50),
      travelBeforeMin: 60,
      travelAfterMin: 60,
    });
    expect(clamped.leaveMs).toBe(base.dayStartMs);
    expect(clamped.returnMs).toBe(base.dayEndMs);
  });
  it('turns a skipped half into an arrival or an early departure', () => {
    expect(computeGap({ ...base, beforeNeeded: false }).kind).toBe('arrive');
    expect(computeGap({ ...base, afterNeeded: false }).kind).toBe('leave');
    expect(computeGap({ ...base, beforeNeeded: false, afterNeeded: false }).kind).toBe('all_day');
  });
  it('merges overlapping gaps and lets an all-day absence win', () => {
    const a = { kind: 'gap' as const, leaveMs: 10, returnMs: 20 };
    const b = { kind: 'gap' as const, leaveMs: 15, returnMs: 30 };
    const c = { kind: 'gap' as const, leaveMs: 40, returnMs: 50 };
    expect(mergeGaps([b, a, c])).toEqual([
      { kind: 'gap', leaveMs: 10, returnMs: 30 },
      c,
    ]);
    expect(
      mergeGaps([a, { kind: 'all_day', leaveMs: 0, returnMs: 100 }]),
    ).toHaveLength(1);
    expect(schedulePhrase([a], 'UTC')).toContain('leaving at');
  });
});

describe('absence notices: eligibility', () => {
  it('is off for a link with no recipients, even once resolved', async () => {
    const f = await fixture('absence-off@example.com');
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);

    expect((await notice(f, doc.id)).available).toBe(false);
    // Saved with an empty list is still off.
    await setRecipients(f, { to: [], cc: [] });
    expect((await notice(f, doc.id)).available).toBe(false);
    const list = await call(`/families/${f.familyId}/absence-notices`, bearer(f.admin.token));
    expect(((await list.json()) as { notices: unknown[] }).notices).toHaveLength(0);
    const digest = await buildUserDigest(
      f.db,
      f.admin.userId,
      { from: new Date(), to: futureAt(10, 0) },
      ['absence_notices'],
    );
    expect(digest.total).toBe(0);
  });

  it('only a resolved conflict qualifies: pending, dismissed and reverted are not', async () => {
    const f = await fixture('absence-status@example.com');
    await setRecipients(f);
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    const [c] = await detect(f);

    expect((await notice(f, doc.id)).available).toBe(false); // pending

    await call(`/families/${f.familyId}/conflicts/${c!.id}/dismiss`, authed(f.admin.token));
    expect((await notice(f, doc.id)).available).toBe(false); // dismissed

    await call(`/families/${f.familyId}/conflicts/${c!.id}/resolve`, authed(f.admin.token, {}));
    expect((await notice(f, doc.id)).available).toBe(true);

    await call(`/families/${f.familyId}/conflicts/${c!.id}/revert`, authed(f.admin.token));
    expect((await notice(f, doc.id)).available).toBe(false); // back to pending
  });

  it('ignores a resolved conflict whose loser is not a baseline day', async () => {
    const f = await fixture('absence-nonbaseline@example.com');
    await setRecipients(f);
    // An `ev:` feed event overlapped by the appointment.
    await f.db.insert(calendarEvents).values({
      familyId: f.familyId,
      familyMemberId: f.childId,
      provenance: 'synthesized',
      synthKey: `ev:${f.linkId}:assembly`,
      linkId: f.linkId,
      dtstart: futureAt(3, 9, 0),
      dtend: futureAt(3, 12, 0),
      summary: 'Assembly',
      contentHash: 'ev-1',
    });
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);
    expect((await notice(f, doc.id)).available).toBe(false);
  });
});

describe('absence notices: times and wording', () => {
  it('both halves kept, with travel buffers: leave and return around the appointment', async () => {
    const f = await fixture('absence-gap@example.com');
    await setRecipients(f, { cc: ['nurse@school.test'] });
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f, { travelBeforeMin: 30, travelAfterMin: 15 });

    const n = await notice(f, doc.id);
    expect(n).toMatchObject({
      available: true,
      to: ['office@school.test'],
      cc: ['nurse@school.test'],
      state: 'outstanding',
      sentBy: null,
    });
    expect(n.body).toContain('leaving at 9:30 AM and returning at 11:15 AM');
    expect(n.body).toContain('child');
    // Generic reason unless includeReason is on.
    expect(n.body).toContain('an appointment');
    expect(n.body).not.toContain('Doctor');
    expect(n.subject).toContain('child');
    // {parent} is the composer's relationName, never an account name.
    expect(n.body).toMatch(/Thank you,\n\S+/);
  });

  it('includes the appointment title only when includeReason is on', async () => {
    const f = await fixture('absence-reason@example.com');
    await setRecipients(f, { includeReason: true });
    await schoolDay(f);
    const doc = await appointment(f, 'Dentist', 3, [10, 0], [11, 0]);
    await resolveAll(f);
    expect((await notice(f, doc.id)).body).toContain('because of Dentist');
  });

  it('supports custom templates with every placeholder', async () => {
    const f = await fixture('absence-custom@example.com');
    await setRecipients(f, {
      subjectTemplate: '{child} out {date}',
      bodyTemplate: '{leaveTime}|{returnTime}|{reason}|{parent}|{unknown}',
    });
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);
    const n = await notice(f, doc.id);
    expect(n.subject).toMatch(/^child out \w+day, \w+ \d+$/);
    expect(n.body).toMatch(/^10:00 AM\|11:00 AM\|an appointment\|\S+\|\{unknown\}$/);
  });

  it('skipped morning reads as an arrival', async () => {
    const f = await fixture('absence-arrive@example.com');
    await setRecipients(f);
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f, { beforeNeeded: false, travelAfterMin: 30 });
    const n = await notice(f, doc.id);
    expect(n.body).toContain('arriving at 11:30 AM');
    expect(n.body).not.toContain('leaving');
  });

  it('skipped afternoon reads as leaving and not returning', async () => {
    const f = await fixture('absence-leave@example.com');
    await setRecipients(f);
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [13, 0], [14, 0]);
    await resolveAll(f, { afterNeeded: false, travelBeforeMin: 20 });
    expect((await notice(f, doc.id)).body).toContain('leaving at 12:40 PM, not returning today');
  });

  it('both halves skipped is absent all day', async () => {
    const f = await fixture('absence-allday@example.com');
    await setRecipients(f);
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f, { beforeNeeded: false, afterNeeded: false });
    expect((await notice(f, doc.id)).body).toContain('absent all day');
  });

  it('formats times in the school feed timezone', async () => {
    const f = await fixture('absence-tz@example.com', 'America/Los_Angeles');
    await setRecipients(f);
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [18, 0], [19, 0]);
    // 08:30-15:00 UTC is before dawn in LA, but the maths is what matters:
    // make the appointment sit inside the day.
    await f.db
      .update(calendarEvents)
      .set({ dtstart: futureAt(3, 10, 0), dtend: futureAt(3, 11, 0) })
      .where(eq(calendarEvents.id, doc.id));
    await resolveAll(f);
    const expected = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      minute: '2-digit',
    }).format(futureAt(3, 10, 0));
    expect((await notice(f, doc.id)).body).toContain(`leaving at ${expected}`);
  });

  it('two resolved conflicts on one school day produce one notice listing both gaps', async () => {
    const f = await fixture('absence-merge@example.com');
    await setRecipients(f);
    await schoolDay(f);
    const a = await appointment(f, 'Doctor', 3, [9, 30], [10, 0]);
    const b = await appointment(f, 'Therapy', 3, [13, 0], [14, 0]);
    await resolveAll(f);

    const na = await notice(f, a.id);
    const nb = await notice(f, b.id);
    expect(na.body).toContain('leaving at 9:30 AM and returning at 10:00 AM');
    expect(na.body).toContain('leaving at 1:00 PM and returning at 2:00 PM');
    expect(nb.gapStamp).toBe(na.gapStamp);
    const list = await call(`/families/${f.familyId}/absence-notices`, bearer(f.admin.token));
    expect(((await list.json()) as { notices: unknown[] }).notices).toHaveLength(1);
  });

  it('is reachable from the appointment, the school day and its trimmed segments', async () => {
    const f = await fixture('absence-entry@example.com');
    await setRecipients(f);
    const blKey = await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);

    const segKey = `cf:${blKey}:0`;
    const fromWinner = await notice(f, doc.id);
    const fromSegment = await notice(f, await eventIdOf(f, segKey));
    const fromLoser = await notice(f, await eventIdOf(f, blKey));
    expect(fromSegment.gapStamp).toBe(fromWinner.gapStamp);
    expect(fromLoser.gapStamp).toBe(fromWinner.gapStamp);
    // A trimmed second segment too.
    expect((await notice(f, await eventIdOf(f, `cf:${blKey}:1`))).available).toBe(true);
  });
});

describe('absence notices: send record', () => {
  it('records who sent it, goes stale when the times move, and says what it replaces', async () => {
    const f = await fixture('absence-sent@example.com');
    await setRecipients(f);
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);
    const before = await notice(f, doc.id);

    // A stale compose is refused.
    const stale = await call(
      `/families/${f.familyId}/calendar-events/${doc.id}/absence-notice/sent`,
      authed(f.admin.token, { gapStamp: 'nope' }),
    );
    expect(stale.status).toBe(409);
    expect(await f.db.select().from(absenceNotices)).toHaveLength(0);

    const sent = await call(
      `/families/${f.familyId}/calendar-events/${doc.id}/absence-notice/sent`,
      authed(f.admin.token, { gapStamp: before.gapStamp }),
    );
    expect(sent.status).toBe(200);
    const after = await notice(f, doc.id);
    expect(after.state).toBe('sent');
    expect(after.sentBy).toBeTruthy();
    expect(after.sentAt).toBeTruthy();

    // Sent notices leave the outstanding list but stay listed with ?all=true.
    const outstanding = await call(`/families/${f.familyId}/absence-notices`, bearer(f.admin.token));
    expect(((await outstanding.json()) as { notices: unknown[] }).notices).toHaveLength(0);
    const all = await call(`/families/${f.familyId}/absence-notices?all=true`, bearer(f.admin.token));
    expect(((await all.json()) as { notices: unknown[] }).notices).toHaveLength(1);

    // The appointment moves: the conflict reopens, so no notice until re-resolved.
    await f.db
      .update(calendarEvents)
      .set({ dtstart: futureAt(3, 11, 0), dtend: futureAt(3, 12, 0) })
      .where(eq(calendarEvents.id, doc.id));
    await reconcileMemberConflicts(f.db, f.childId);
    expect((await notice(f, doc.id)).available).toBe(false);

    await resolveAll(f);
    const updated = await notice(f, doc.id);
    expect(updated.state).toBe('needs_update');
    expect(updated.sentBy).toBeTruthy();
    expect(updated.subject).toMatch(/^Updated: /);
    expect(updated.body).toContain('replaces my earlier notice');
    expect(updated.body).toContain('10:00 AM and returning at 11:00 AM');
    expect(updated.body).toContain('leaving at 11:00 AM and returning at 12:00 PM');
    const again = await call(`/families/${f.familyId}/absence-notices`, bearer(f.admin.token));
    expect(((await again.json()) as { notices: unknown[] }).notices).toHaveLength(1);

    // Sending the update overwrites the one record for that child + link + date.
    await call(
      `/families/${f.familyId}/calendar-events/${doc.id}/absence-notice/sent`,
      authed(f.admin.token, { gapStamp: updated.gapStamp }),
    );
    expect((await notice(f, doc.id)).state).toBe('sent');
    expect(await f.db.select().from(absenceNotices)).toHaveLength(1);
  });

  it('drops a notice off the outstanding list once the school day is over', async () => {
    const f = await fixture('absence-past@example.com');
    await setRecipients(f);
    const blKey = await schoolDay(f, 3);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);
    // Time passes: the day (and appointment) are now behind us. Done by moving
    // the rows rather than reconciling, which would reopen the conflict.
    const past = (d: Date) => new Date(d.getTime() - 5 * 86_400_000);
    for (const key of [blKey, doc.synthKey]) {
      const row = (
        await f.db.select().from(calendarEvents).where(eq(calendarEvents.synthKey, key))
      )[0]!;
      await f.db
        .update(calendarEvents)
        .set({ dtstart: past(row.dtstart), dtend: past(row.dtend!) })
        .where(eq(calendarEvents.id, row.id));
    }
    expect((await notice(f, doc.id)).available).toBe(true);
    const list = await call(`/families/${f.familyId}/absence-notices`, bearer(f.admin.token));
    expect(((await list.json()) as { notices: unknown[] }).notices).toHaveLength(0);
  });
});

describe('absence notices: retraction when the absence goes away', () => {
  /** A sent notice for a resolved appointment; returns what the tests need. */
  async function sentNotice(email: string) {
    const f = await fixture(email);
    await setRecipients(f);
    const blKey = await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);
    const first = await notice(f, doc.id);
    const res = await call(
      `/families/${f.familyId}/calendar-events/${doc.id}/absence-notice/sent`,
      authed(f.admin.token, { gapStamp: first.gapStamp }),
    );
    expect(res.status).toBe(200);
    return { f, blKey, doc };
  }

  async function expectRetraction(f: Fx, blKey: string) {
    const blId = await eventIdOf(f, blKey);
    const n = await notice(f, blId);
    expect(n.available).toBe(true);
    expect(n.state).toBe('needs_update');
    expect(n.subject).toMatch(/^Updated: /);
    expect(n.body).toContain('will now attend the full school day');
    expect(n.body).toContain('leaving at 10:00 AM and returning at 11:00 AM');
    // On Home, in the digest and in the badge.
    const list = await call(`/families/${f.familyId}/absence-notices`, bearer(f.admin.token));
    expect(((await list.json()) as { notices: unknown[] }).notices).toHaveLength(1);
    const digest = await buildUserDigest(
      f.db,
      f.admin.userId,
      { from: new Date(), to: futureAt(7, 0) },
      ['absence_notices'],
    );
    expect(digest.actionable).toBe(1);
    // Marking it sent records it the same way and clears it.
    const sent = await call(
      `/families/${f.familyId}/calendar-events/${blId}/absence-notice/sent`,
      authed(f.admin.token, { gapStamp: n.gapStamp }),
    );
    expect(sent.status).toBe(200);
    expect((await notice(f, blId)).state).toBe('sent');
    const after = await call(`/families/${f.familyId}/absence-notices`, bearer(f.admin.token));
    expect(((await after.json()) as { notices: unknown[] }).notices).toHaveLength(0);
  }

  it('prompts to tell the school when the appointment is cancelled', async () => {
    const { f, blKey, doc } = await sentNotice('absence-cancel@example.com');
    await f.db.delete(calendarEvents).where(eq(calendarEvents.id, doc.id));
    await reconcileMemberConflicts(f.db, f.childId);
    await expectRetraction(f, blKey);
  });

  it('prompts when the appointment moves off the school day', async () => {
    const { f, blKey, doc } = await sentNotice('absence-moveoff@example.com');
    await f.db
      .update(calendarEvents)
      .set({ dtstart: futureAt(4, 10, 0), dtend: futureAt(4, 11, 0) })
      .where(eq(calendarEvents.id, doc.id));
    await reconcileMemberConflicts(f.db, f.childId);
    await expectRetraction(f, blKey);
  });

  it('prompts when the conflict is dismissed', async () => {
    const { f, blKey } = await sentNotice('absence-dismiss@example.com');
    const [c] = await f.db.select().from(conflicts).where(eq(conflicts.familyMemberId, f.childId));
    await call(`/families/${f.familyId}/conflicts/${c!.id}/dismiss`, authed(f.admin.token));
    await expectRetraction(f, blKey);
  });

  it('does not prompt while the conflict is pending again', async () => {
    const { f, blKey } = await sentNotice('absence-pending@example.com');
    const [c] = await f.db.select().from(conflicts).where(eq(conflicts.familyMemberId, f.childId));
    await call(`/families/${f.familyId}/conflicts/${c!.id}/revert`, authed(f.admin.token));
    const n = await notice(f, await eventIdOf(f, blKey));
    expect(n.available).toBe(false);
    const list = await call(`/families/${f.familyId}/absence-notices`, bearer(f.admin.token));
    expect(((await list.json()) as { notices: unknown[] }).notices).toHaveLength(0);
  });

  it('does not prompt when the school day itself is gone', async () => {
    const { f, blKey, doc } = await sentNotice('absence-daygone@example.com');
    await f.db.delete(calendarEvents).where(eq(calendarEvents.id, doc.id));
    await reconcileMemberConflicts(f.db, f.childId);
    await f.db.delete(calendarEvents).where(eq(calendarEvents.synthKey, blKey));
    const list = await call(`/families/${f.familyId}/absence-notices`, bearer(f.admin.token));
    expect(((await list.json()) as { notices: unknown[] }).notices).toHaveLength(0);
  });

  it('does not prompt for a notice that was never sent', async () => {
    const f = await fixture('absence-neversent@example.com');
    await setRecipients(f);
    const blKey = await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);
    await f.db.delete(calendarEvents).where(eq(calendarEvents.id, doc.id));
    await reconcileMemberConflicts(f.db, f.childId);
    expect((await notice(f, await eventIdOf(f, blKey))).available).toBe(false);
  });
});

describe('absence notices: permissions and settings', () => {
  it('lets any caretaker compose and mark sent, but only an admin edit settings', async () => {
    const f = await fixture('absence-perms@example.com');
    await setRecipients(f);
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);

    const partnerRes = await call(
      `/families/${f.familyId}/members`,
      authed(f.admin.token, { relationName: 'partner', isCaretaker: true }),
    );
    const partnerId = ((await partnerRes.json()) as { member: { id: string } }).member.id;
    const partner = await login('absence-partner@example.com');
    await linkMember(f.admin.token, f.familyId, partnerId, partner.token);

    const n = await notice(f, doc.id, partner.token);
    expect(n.available).toBe(true);
    expect(n.body).toContain('partner'); // {parent} = the composer's relationName
    const sent = await call(
      `/families/${f.familyId}/calendar-events/${doc.id}/absence-notice/sent`,
      authed(partner.token, {}),
    );
    expect(sent.status).toBe(200);
    expect((await notice(f, doc.id, f.admin.token)).sentBy).toBe('partner');

    // Settings are admin-only, both ways.
    expect((await call(settingsUrl(f), bearer(partner.token))).status).toBe(403);
    expect(
      (await call(settingsUrl(f), put(partner.token, { to: ['x@school.test'] }))).status,
    ).toBe(403);
  });

  it('refuses a dependent with a login', async () => {
    const f = await fixture('absence-dependent@example.com');
    await setRecipients(f);
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);
    const kid = await login('absence-kid@example.com');
    await linkMember(f.admin.token, f.familyId, f.childId, kid.token);

    const res = await call(
      `/families/${f.familyId}/calendar-events/${doc.id}/absence-notice`,
      bearer(kid.token),
    );
    expect(res.status).toBe(403);
    expect(
      (await call(`/families/${f.familyId}/absence-notices`, bearer(kid.token))).status,
    ).toBe(403);
  });

  it('round-trips settings with defaults, normalises addresses, and rejects bad ones', async () => {
    const f = await fixture('absence-settings@example.com');
    const fresh = await call(settingsUrl(f), bearer(f.admin.token));
    const { settings } = (await fresh.json()) as {
      settings: {
        to: string[];
        enabled: boolean;
        subjectTemplate: string;
        includeReason: boolean;
        defaults: { subjectTemplate: string; bodyTemplate: string };
      };
    };
    expect(settings).toMatchObject({ to: [], enabled: false, includeReason: false });
    expect(settings.subjectTemplate).toContain('{child}');
    expect(settings.defaults.bodyTemplate).toContain('{schedule}');

    const bad = await call(settingsUrl(f), put(f.admin.token, { to: ['not-an-email'] }));
    expect(bad.status).toBe(400);

    const ok = await call(
      settingsUrl(f),
      put(f.admin.token, { to: [' Office@School.test ', 'office@school.test'], includeReason: true }),
    );
    const saved = (await ok.json()) as { settings: { to: string[]; enabled: boolean } };
    expect(saved.settings).toMatchObject({ to: ['office@school.test'], enabled: true });

    // A second family's admin can't reach it.
    const other = await fixture('absence-settings-other@example.com');
    const cross = await call(
      `/families/${other.familyId}/feeds/${f.feed.id}/member-links/${f.linkId}/absence-notice-settings`,
      bearer(other.admin.token),
    );
    expect(cross.status).toBe(404);
  });
});

describe('absence notices: digest and badge', () => {
  it('counts toward actionable and the badge until it is sent', async () => {
    const f = await fixture('absence-digest@example.com');
    await setRecipients(f);
    await schoolDay(f);
    const doc = await appointment(f, 'Doctor', 3, [10, 0], [11, 0]);
    await resolveAll(f);
    await f.db.insert(notificationSchedules).values({
      userId: f.admin.userId,
      sendAt: '20:00',
      timezone: 'UTC',
      startOffsetDays: 0,
      horizonDays: 7,
      categories: ['absence_notices'],
    });

    const window = { from: new Date(), to: futureAt(7, 0) };
    const digest = await buildUserDigest(f.db, f.admin.userId, window, ['absence_notices']);
    expect(digest.buckets).toHaveLength(1);
    expect(digest.buckets[0]!.category).toBe('absence_notices');
    expect(digest.total).toBe(1);
    expect(digest.actionable).toBe(1);
    expect(await currentBadgeCount(f.db, f.admin.userId)).toBe(1);
    const badge = await call('/notifications/badge', bearer(f.admin.token));
    expect(((await badge.json()) as { count: number }).count).toBe(1);

    // Outside the window it is not counted.
    const early = await buildUserDigest(
      f.db,
      f.admin.userId,
      { from: new Date(), to: futureAt(1, 0) },
      ['absence_notices'],
    );
    expect(early.total).toBe(0);

    await call(
      `/families/${f.familyId}/calendar-events/${doc.id}/absence-notice/sent`,
      authed(f.admin.token, {}),
    );
    expect(await currentBadgeCount(f.db, f.admin.userId)).toBe(0);
  });
});

// Keep the helper types referenced for editors that tree-shake unused imports.
export type _Db = Db;
