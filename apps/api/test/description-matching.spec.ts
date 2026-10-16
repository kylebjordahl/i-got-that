import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  externalAccounts,
  familyMemberFeeds,
  feeds,
  getDb,
  linkRules,
  memberCalendars,
  pendingDecisions,
  sourceEvents,
  taskRules,
  tasks,
} from '@igt/db';
import { MAX_DESCRIPTION_CHARS } from '@igt/ical';
import { describe, expect, it } from 'vitest';
import { storeSecret } from '../src/lib/secrets.js';
import { syncClaimEvents } from '../src/services/claim.js';
import { ingestFeed } from '../src/services/ingest.js';
import { readBackMember } from '../src/services/readback.js';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { authed, call, pinClockTo, setupFamily, testKeys } from './helpers.js';

/**
 * #271: a rule on `description` / `any_text` has to see the source event's
 * DESCRIPTION. The text is stored on `source_events` for matching and goes no
 * further — `calendar_events.description` stays null for a feed event, so it
 * never reaches the mirror or an email invite.
 */

// The fixtures are the week of 2026-07-06.
pinClockTo('2026-07-06T12:00:00Z');

const WINDOW = {
  windowStart: new Date('2026-07-06T00:00:00Z'),
  windowEnd: new Date('2026-07-13T00:00:00Z'),
};

const serving = (body: () => string) =>
  (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body(),
  })) as unknown as typeof fetch;

interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  /** `YYYYMMDD`: an all-day event on that date. */
  date?: string;
  /** Timed event start, `YYYYMMDDTHHMMSSZ`; ends an hour later. */
  start?: string;
  end?: string;
}

function ics(...events: IcsEvent[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//test//EN'];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `SUMMARY:${e.summary}`);
    if (e.date) {
      const next = new Date(Date.UTC(+e.date.slice(0, 4), +e.date.slice(4, 6) - 1, +e.date.slice(6, 8) + 1));
      const nextStr = next.toISOString().slice(0, 10).replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${e.date}`, `DTEND;VALUE=DATE:${nextStr}`);
    } else {
      lines.push(`DTSTART:${e.start}`, `DTEND:${e.end}`);
    }
    if (e.description !== undefined) lines.push(`DESCRIPTION:${e.description}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

async function feedFixture(email: string, mode: 'exception' | 'standard') {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        kind: 'ics',
        url: 'https://feed.example.com/cal.ics',
        mode,
        timezone: 'UTC',
        sourceCalendarName: 'Lincoln Elementary',
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
        weekdayMask: 31,
        dayStart: '08:30',
        dayEnd: '14:45',
      })
      .returning()
  )[0]!;

  let body = ics();
  const ingest = async (doc: string) => {
    body = doc;
    await ingestFeed(db, feed, { fetchImpl: serving(() => body), ...WINDOW });
    return synthesizeFeed(db, feed, WINDOW);
  };
  const sources = () => db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id));
  const childEvents = () =>
    db.select().from(calendarEvents).where(eq(calendarEvents.familyMemberId, fam.childId));
  const decisions = () =>
    db.select().from(pendingDecisions).where(eq(pendingDecisions.familyId, fam.familyId));
  return { ...fam, db, feed, link, ingest, sources, childEvents, decisions };
}

const EARLY = 'Early release at noon - pickup 12:15';

describe('exception feed: link rules on description', () => {
  async function withRule(email: string) {
    const f = await feedFixture(email, 'exception');
    const rule = (
      await f.db
        .insert(linkRules)
        .values({
          familyId: f.familyId,
          linkId: f.link.id,
          position: 0,
          matchField: 'description',
          matchOp: 'contains',
          matchValue: 'early release',
          outcome: 'modify_day',
          params: { dayEnd: '12:00' },
        })
        .returning()
    )[0]!;
    return { ...f, rule };
  }

  it('a description rule modifies the day instead of leaving the event pending', async () => {
    const f = await withRule('desc-exc-match@example.com');
    await f.ingest(
      ics({ uid: 'staff@x', summary: 'Staff development', date: '20260708', description: EARLY }),
    );

    // The body is stored on the source event...
    expect((await f.sources())[0]!.description).toBe(EARLY);
    // ...and the rule saw it: Wednesday ends at noon, nothing awaits a decision.
    expect(await f.decisions()).toHaveLength(0);
    const wed = (await f.childEvents()).find((e) => e.synthKey === `bl:${f.link.id}:2026-07-08`)!;
    expect(wed.dtend!.toISOString()).toBe('2026-07-08T12:00:00.000Z');
    expect(wed.matchedRuleId).toBe(f.rule.id);
  });

  it('an event with no matching description is still pending (the rule is not a catch-all)', async () => {
    const f = await withRule('desc-exc-nomatch@example.com');
    await f.ingest(
      ics(
        { uid: 'a@x', summary: 'Staff development', date: '20260708', description: 'Regular dismissal' },
        { uid: 'b@x', summary: 'Picture day', date: '20260709' },
      ),
    );
    expect(await f.decisions()).toHaveLength(2);
    const thu = (await f.childEvents()).find((e) => e.synthKey === `bl:${f.link.id}:2026-07-09`)!;
    expect(thu.dtend!.toISOString()).toBe('2026-07-09T14:45:00.000Z');
  });

  it('any_text now spans the description too', async () => {
    const f = await withRule('desc-exc-anytext@example.com');
    await f.db
      .update(linkRules)
      .set({ matchField: 'any_text', matchValue: 'pickup 12:15' })
      .where(eq(linkRules.id, f.rule.id));
    await f.ingest(
      ics({ uid: 'staff@x', summary: 'Staff development', date: '20260708', description: EARLY }),
    );
    expect(await f.decisions()).toHaveLength(0);
  });

  it('a DESCRIPTION-only edit re-synthesizes: the pending event is ruled once the text matches', async () => {
    const f = await withRule('desc-exc-edit@example.com');
    const doc = (description: string) =>
      ics({ uid: 'staff@x', summary: 'Staff development', date: '20260708', description });

    await f.ingest(doc('Regular dismissal'));
    expect(await f.decisions()).toHaveLength(1);
    const before = (await f.sources())[0]!;

    // Nothing but the DESCRIPTION changes upstream.
    await f.ingest(doc(EARLY));
    const after = (await f.sources())[0]!;
    expect(after.id).toBe(before.id);
    expect(after.summary).toBe(before.summary);
    expect(after.dtstart).toEqual(before.dtstart);
    expect(after.description).toBe(EARLY);
    expect(after.contentHash).not.toBe(before.contentHash);

    expect(await f.decisions()).toHaveLength(0);
    const wed = (await f.childEvents()).find((e) => e.synthKey === `bl:${f.link.id}:2026-07-08`)!;
    expect(wed.dtend!.toISOString()).toBe('2026-07-08T12:00:00.000Z');

    // And back again: the text no longer matches, the day is a question again.
    await f.ingest(doc('Regular dismissal'));
    expect(await f.decisions()).toHaveLength(1);
    const reverted = (await f.childEvents()).find((e) => e.synthKey === `bl:${f.link.id}:2026-07-08`)!;
    expect(reverted.dtend!.toISOString()).toBe('2026-07-08T14:45:00.000Z');
  });

  it('nothing the feed wrote into a description lands on a calendar event', async () => {
    const f = await withRule('desc-exc-private@example.com');
    await f.db.insert(linkRules).values({
      familyId: f.familyId,
      linkId: f.link.id,
      position: 1,
      matchField: 'summary',
      matchOp: 'contains',
      matchValue: 'dinner',
      outcome: 'add_event',
    });
    await f.ingest(
      ics(
        { uid: 'staff@x', summary: 'Staff development', date: '20260708', description: EARLY },
        {
          uid: 'dinner@x',
          summary: 'Community dinner',
          start: '20260707T230000Z',
          end: '20260708T000000Z',
          description: 'Potluck - bring a dish; RSVP to the front office',
        },
      ),
    );
    const events = await f.childEvents();
    expect(events.some((e) => e.synthKey.startsWith('ev:'))).toBe(true);
    expect(events.filter((e) => e.description !== null)).toEqual([]);
  });
});

describe('task rules on description', () => {
  async function withTaskRule(email: string) {
    const f = await feedFixture(email, 'standard');
    await f.db.insert(taskRules).values({
      familyId: f.familyId,
      familyMemberId: f.childId,
      linkId: f.link.id,
      scope: 'this_calendar',
      position: 0,
      matchField: 'description',
      matchOp: 'contains',
      matchValue: 'parents welcome',
      resultType: 'attendance',
    });
    const typesOf = async (uid: string) => {
      const source = (await f.sources()).find((s) => s.icalUid === uid)!;
      const event = (await f.childEvents()).find((e) => e.sourceEventId === source.id)!;
      const rows = await f.db.select().from(tasks).where(eq(tasks.calendarEventId, event.id));
      return rows.map((t) => t.type).sort();
    };
    return { ...f, typesOf };
  }

  const concert = (description: string) => ({
    uid: 'concert@x',
    summary: 'Spring concert',
    start: '20260708T180000Z',
    end: '20260708T190000Z',
    description,
  });
  const practice = {
    uid: 'practice@x',
    summary: 'Practice',
    start: '20260709T150000Z',
    end: '20260709T160000Z',
    description: 'Bring water',
  };

  it('types a feed event from its source description, which stays off the calendar event', async () => {
    const f = await withTaskRule('desc-task-match@example.com');
    await f.ingest(ics(concert('Parents welcome - doors at 5:30'), practice));
    await buildMemberTasks(f.db, f.childId);

    expect(await f.typesOf('concert@x')).toEqual(['attendance']);
    // No rule matches the practice, so the link default (transition) applies.
    expect(await f.typesOf('practice@x')).toEqual(['dropoff', 'pickup']);
    // The text drove the typing; it was not copied onto what gets mirrored.
    expect((await f.childEvents()).filter((e) => e.description !== null)).toEqual([]);
  });

  it('re-types the event when only its DESCRIPTION changes', async () => {
    const f = await withTaskRule('desc-task-edit@example.com');
    await f.ingest(ics(concert('Parents welcome - doors at 5:30')));
    await buildMemberTasks(f.db, f.childId);
    expect(await f.typesOf('concert@x')).toEqual(['attendance']);
    const stampedBefore = (await f.childEvents()).find((e) => e.synthKey.startsWith('ev:'))!;

    // Same event upstream except the invitation was withdrawn.
    const resynth = await f.ingest(ics(concert('Students only')));
    expect(resynth.eventsUpserted).toBe(1);
    const dirty = (await f.childEvents()).find((e) => e.synthKey.startsWith('ev:'))!;
    expect(dirty.id).toBe(stampedBefore.id);
    expect(dirty.contentHash).not.toBe(stampedBefore.contentHash);
    expect(dirty.description).toBeNull();
    // The mirror hashes what it would send, which did not change.
    expect(dirty.summary).toBe(stampedBefore.summary);

    await buildMemberTasks(f.db, f.childId);
    expect(await f.typesOf('concert@x')).toEqual(['dropoff', 'pickup']);

    // And an unchanged feed is a no-op for synthesis (the hash is stable).
    expect((await f.ingest(ics(concert('Students only')))).eventsUpserted).toBe(0);
  });

  it('an event with no description at all is unaffected by the new hash input', async () => {
    const f = await withTaskRule('desc-task-none@example.com');
    await f.ingest(ics({ ...practice, description: undefined }));
    expect((await f.sources())[0]!.description).toBeNull();
    expect((await f.ingest(ics({ ...practice, description: undefined }))).eventsUpserted).toBe(0);
  });
});

describe('read-back (human events)', () => {
  async function googleTarget(email: string) {
    const fam = await setupFamily(email);
    const db = getDb(env.DB);
    const credRef = await storeSecret(
      db,
      testKeys(),
      null,
      JSON.stringify({ kind: 'oauth', refreshToken: 'rt-1' }),
    );
    const account = (
      await db
        .insert(externalAccounts)
        .values({ userId: fam.admin.userId, kind: 'google', name: 'G', credentialsRef: credRef })
        .returning()
    )[0]!;
    const cal = (
      await db
        .insert(memberCalendars)
        .values({
          familyId: fam.familyId,
          familyMemberId: fam.childId,
          targetExternalAccountId: account.id,
          targetMethod: 'google',
          targetCalendarId: 'kid-calendar-id',
        })
        .returning()
    )[0]!;
    const read = (items: Record<string, unknown>[]) =>
      readBackMember(db, cal, {
        windowStart: new Date('2026-07-06T00:00:00Z'),
        windowEnd: new Date('2026-08-05T00:00:00Z'),
        kek: testKeys(),
        googleRefresh: async () => 'access-token',
        fetchImpl: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ items }),
        })) as unknown as typeof fetch,
      });
    const human = () =>
      db
        .select()
        .from(calendarEvents)
        .where(and(eq(calendarEvents.familyMemberId, fam.childId), eq(calendarEvents.provenance, 'human')));
    return { ...fam, db, read, human };
  }

  const item = (uid: string, extra: Record<string, unknown>) => ({
    iCalUID: uid,
    status: 'confirmed',
    summary: 'Recital',
    start: { dateTime: '2026-07-08T16:00:00Z' },
    end: { dateTime: '2026-07-08T17:00:00Z' },
    ...extra,
  });

  it('keeps a human event’s description (truncated) so task rules can match it', async () => {
    const f = await googleTarget('desc-readback@example.com');
    await f.read([
      item('r1@g', { description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 500) }),
      item('r2@g', { summary: 'Dentist' }),
    ]);
    const rows = await f.human();
    expect(rows.find((e) => e.externalUid === 'r1@g')!.description).toHaveLength(MAX_DESCRIPTION_CHARS);
    expect(rows.find((e) => e.externalUid === 'r2@g')!.description).toBeNull();
  });

  it('a task rule on description types a human event', async () => {
    const f = await googleTarget('desc-readback-task@example.com');
    await f.db.insert(taskRules).values({
      familyId: f.familyId,
      familyMemberId: f.childId,
      linkId: null,
      scope: 'this_calendar',
      position: 0,
      matchField: 'description',
      matchOp: 'contains',
      matchValue: 'drop off',
      resultType: 'transition',
    });
    await f.read([
      item('r1@g', { description: 'Please drop off at the side door' }),
      item('r2@g', { summary: 'Dentist', start: { dateTime: '2026-07-09T16:00:00Z' }, end: { dateTime: '2026-07-09T17:00:00Z' } }),
    ]);
    await buildMemberTasks(f.db, f.childId);

    const typesFor = async (uid: string) => {
      const event = (await f.human()).find((e) => e.externalUid === uid)!;
      const rows = await f.db.select().from(tasks).where(eq(tasks.calendarEventId, event.id));
      return rows.map((t) => t.type).sort();
    };
    expect(await typesFor('r1@g')).toEqual(['dropoff', 'pickup']);
    // No description, so the unified default (attendance) applies.
    expect(await typesFor('r2@g')).toEqual(['attendance']);

    // Editing only the description re-types it once (hashCalendarEvent covers it).
    await f.read([
      item('r1@g', { description: 'Parents stay for the show' }),
      item('r2@g', { summary: 'Dentist', start: { dateTime: '2026-07-09T16:00:00Z' }, end: { dateTime: '2026-07-09T17:00:00Z' } }),
    ]);
    await buildMemberTasks(f.db, f.childId);
    expect(await typesFor('r1@g')).toEqual(['attendance']);
  });

  it('a caretaker claiming a human attendance event does not carry its description onto their own calendar', async () => {
    const f = await googleTarget('desc-readback-claim@example.com');
    await f.read([item('r1@g', { description: 'Private note: bring the insurance card' })]);
    await buildMemberTasks(f.db, f.childId);
    const event = (await f.human())[0]!;
    expect(event.description).toBe('Private note: bring the insurance card');
    const task = (await f.db.select().from(tasks).where(eq(tasks.calendarEventId, event.id)))[0]!;
    expect(task.type).toBe('attendance');

    await syncClaimEvents(f.db, { ...task, status: 'owned' }, [f.adminMemberId]);
    const claims = await f.db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.taskId, task.id), eq(calendarEvents.provenance, 'claimed_task')));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ summary: 'Recital', description: null });
  });
});

describe('routed feed: keep rule created from an event', () => {
  it('can be made on description, because the check reads the same text synthesis will', async () => {
    const fam = await setupFamily('desc-routed@example.com');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          kind: 'ics',
          url: 'https://feed.example.com/family.ics',
          mode: 'standard',
          routed: true,
          timezone: 'UTC',
        })
        .returning()
    )[0]!;
    const link = (
      await db
        .insert(familyMemberFeeds)
        .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId: fam.childId })
        .returning()
    )[0]!;
    await ingestFeed(db, feed, {
      fetchImpl: serving(() =>
        ics({
          uid: 'x@x',
          summary: 'Appointment',
          start: '20260708T150000Z',
          end: '20260708T160000Z',
          description: 'Dr. Lee - orthodontist for the kids',
        }),
      ),
      ...WINDOW,
    });
    await synthesizeFeed(db, feed, WINDOW);
    const decision = (
      await db.select().from(pendingDecisions).where(eq(pendingDecisions.familyId, fam.familyId))
    )[0]!;
    expect(decision.kind).toBe('routing');

    const miss = await call(
      `/families/${fam.familyId}/pending-decisions/${decision.id}/resolve`,
      authed(fam.admin.token, {
        routeToLinkIds: [link.id],
        rule: { matchField: 'description', matchOp: 'contains', matchValue: 'dentist' },
      }),
    );
    expect(miss.status).toBe(400);

    const res = await call(
      `/families/${fam.familyId}/pending-decisions/${decision.id}/resolve`,
      authed(fam.admin.token, {
        routeToLinkIds: [link.id],
        rule: { matchField: 'description', matchOp: 'contains', matchValue: 'orthodontist' },
      }),
    );
    expect(res.status).toBe(200);
    const rules = await db.select().from(linkRules).where(eq(linkRules.linkId, link.id));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ matchField: 'description', outcome: 'keep' });
    // The rule — not a one-off copy — now keeps it, and still no description on the event.
    const events = await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.familyMemberId, fam.childId));
    expect(events).toHaveLength(1);
    expect(events[0]!.synthKey.startsWith('ev:')).toBe(true);
    expect(events[0]!.description).toBeNull();
  });
});
