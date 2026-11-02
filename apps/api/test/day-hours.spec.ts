import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  conflicts,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  linkDayOverrides,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { reconcileMemberConflicts } from '../src/services/conflicts.js';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { setTaskOwners } from '../src/services/task-owners.js';
import {
  authed,
  bearer,
  call,
  linkMember,
  login,
  pinClockTo,
  put,
  setupFamily,
} from './helpers.js';

/**
 * One baseline day's hours set by hand — "Tuesday I'm picking her up at 1:00"
 * — from the day's own event, with no calendar event (and no conflict) needed.
 */

// A Monday; the synthesis window is [2026-07-06, 2026-08-05).
pinClockTo('2026-07-06T12:00:00Z');

type Db = ReturnType<typeof getDb>;

/** A school feed (Chicago, CDT = UTC-5, unless told otherwise): Mon–Fri 08:30–15:00. */
async function fixture(
  email: string,
  mode: 'exception' | 'standard' = 'exception',
  timezone = 'America/Chicago',
) {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        mode,
        url: 'https://feed.example.com/cal.ics',
        sourceCalendarName: 'Lincoln Elementary',
        timezone,
        // Already synced, so the routes' resynthesis doesn't try an ingest.
        lastSyncedAt: new Date(),
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
        dayEnd: '15:00',
      })
      .returning()
  )[0]!;
  await synthesizeFeed(db, feed);
  await buildMemberTasks(db, fam.childId);
  return { ...fam, db, feed, link };
}

const dayRow = async (db: Db, linkId: string, date: string) =>
  (
    await db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.synthKey, `bl:${linkId}:${date}`))
  )[0];

const hoursUrl = (f: { familyId: string }, eventId: string) =>
  `/families/${f.familyId}/calendar-events/${eventId}/day-hours`;

const del = (token: string): RequestInit => ({ ...bearer(token), method: 'DELETE' });

type BaselineDay = { date: string; dayStart: string; dayEnd: string; adjusted: boolean };
async function listedDays(f: { familyId: string; admin: { token: string } }) {
  const res = await call(`/families/${f.familyId}/calendar-events`, bearer(f.admin.token));
  const { events } = (await res.json()) as {
    events: { id: string; baselineDay: BaselineDay | null }[];
  };
  return new Map(events.map((e) => [e.id, e.baselineDay]));
}

describe('day hours: one baseline day, set by hand', () => {
  it('moves that day only, keeps its row, and carries a claimed pickup along; reset restores it', async () => {
    const f = await fixture('day-hours@example.com');
    const tue = (await dayRow(f.db, f.link.id, '2026-07-07'))!;
    // 15:00 CDT.
    expect(tue.dtend!.toISOString()).toBe('2026-07-07T20:00:00.000Z');
    const pickup = (
      await f.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.calendarEventId, tue.id), eq(tasks.type, 'pickup')))
    )[0]!;
    await setTaskOwners(f.db, pickup, [f.adminMemberId], { manual: true });

    // Before: the day is listed with its usual hours, in the school's own zone.
    expect((await listedDays(f)).get(tue.id)).toEqual({
      date: '2026-07-07',
      dayStart: '08:30',
      dayEnd: '15:00',
      adjusted: false,
    });

    const res = await call(hoursUrl(f, tue.id), put(f.admin.token, { dayStart: '08:30', dayEnd: '13:00' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { override: { date: string } }).override.date).toBe('2026-07-07');

    // Same row (its id, and so its tasks, survive), new end at 13:00 CDT.
    const moved = (await dayRow(f.db, f.link.id, '2026-07-07'))!;
    expect(moved.id).toBe(tue.id);
    expect(moved.dtstart.toISOString()).toBe('2026-07-07T13:30:00.000Z');
    expect(moved.dtend!.toISOString()).toBe('2026-07-07T18:00:00.000Z');
    // Nothing else moved.
    expect((await dayRow(f.db, f.link.id, '2026-07-08'))!.dtend!.toISOString()).toBe(
      '2026-07-08T20:00:00.000Z',
    );

    // The claimed pickup followed the day: same task, still owned, new time —
    // and the claim on the caretaker's calendar with it.
    const healed = (await f.db.select().from(tasks).where(eq(tasks.id, pickup.id)))[0]!;
    expect(healed.status).toBe('owned');
    expect(healed.dtstart.toISOString()).toBe('2026-07-07T18:00:00.000Z');
    const claims = await f.db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.familyMemberId, f.adminMemberId),
          eq(calendarEvents.taskId, pickup.id),
        ),
      );
    expect(claims).toHaveLength(1);
    expect(claims[0]!.dtstart.toISOString()).toBe('2026-07-07T18:00:00.000Z');
    expect(
      (await f.db.select().from(tasks).where(eq(tasks.calendarEventId, tue.id))).filter(
        (t) => t.type === 'pickup',
      ),
    ).toHaveLength(1);

    expect((await listedDays(f)).get(tue.id)).toEqual({
      date: '2026-07-07',
      dayStart: '08:30',
      dayEnd: '13:00',
      adjusted: true,
    });

    // Setting it again replaces it.
    expect(
      (await call(hoursUrl(f, tue.id), put(f.admin.token, { dayStart: '09:00', dayEnd: '13:30' })))
        .status,
    ).toBe(200);
    expect(await f.db.select().from(linkDayOverrides).where(eq(linkDayOverrides.linkId, f.link.id))).toHaveLength(1);
    expect((await dayRow(f.db, f.link.id, '2026-07-07'))!.dtend!.toISOString()).toBe(
      '2026-07-07T18:30:00.000Z',
    );

    // Reset: back on the usual hours, the pickup with it.
    const reset = await call(hoursUrl(f, tue.id), del(f.admin.token));
    expect(await reset.json()).toEqual({ ok: true, removed: true });
    expect((await dayRow(f.db, f.link.id, '2026-07-07'))!.dtend!.toISOString()).toBe(
      '2026-07-07T20:00:00.000Z',
    );
    expect(
      (await f.db.select().from(tasks).where(eq(tasks.id, pickup.id)))[0]!.dtstart.toISOString(),
    ).toBe('2026-07-07T20:00:00.000Z');
    expect((await listedDays(f)).get(tue.id)?.adjusted).toBe(false);

    const again = await call(hoursUrl(f, tue.id), del(f.admin.token));
    expect(await again.json()).toEqual({ ok: true, removed: false });
  });

  it('refuses a day a resolved conflict has split, leaving the decision and its claim alone', async () => {
    const f = await fixture('day-hours-split@example.com');
    const tue = (await dayRow(f.db, f.link.id, '2026-07-07'))!;
    // A dentist appointment mid-morning (10:00–11:00 CDT), resolved with the
    // plain split: the day is masked and cut into two segments around it.
    await f.db.insert(calendarEvents).values({
      familyId: f.familyId,
      familyMemberId: f.childId,
      provenance: 'human',
      synthKey: 'ext:dentist:',
      externalUid: 'dentist',
      dtstart: new Date('2026-07-07T15:00:00Z'),
      dtend: new Date('2026-07-07T16:00:00Z'),
      summary: 'Dentist',
      contentHash: 'dentist',
    });
    await reconcileMemberConflicts(f.db, f.childId);
    const [conflict] = await f.db
      .select()
      .from(conflicts)
      .where(eq(conflicts.familyMemberId, f.childId));
    expect(
      (await call(`/families/${f.familyId}/conflicts/${conflict!.id}/resolve`, authed(f.admin.token, {})))
        .status,
    ).toBe(200);

    const segments = await f.db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.familyMemberId, f.childId), eq(calendarEvents.linkId, f.link.id)));
    const afternoon = segments.find((e) => e.synthKey === `cf:${tue.synthKey}:1`)!;
    expect(afternoon.dtend!.toISOString()).toBe('2026-07-07T20:00:00.000Z');
    const pickup = (
      await f.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.calendarEventId, afternoon.id), eq(tasks.type, 'pickup')))
    )[0]!;
    await setTaskOwners(f.db, pickup, [f.adminMemberId], { manual: true });

    // Neither the segments nor the masked day offer the hours…
    const listed = await listedDays(f);
    expect(listed.get(afternoon.id)).toBeNull();
    expect(listed.has(tue.id)).toBe(false); // masked rows aren't listed at all
    // …and neither takes them.
    for (const id of [afternoon.id, tue.id]) {
      const res = await call(hoursUrl(f, id), put(f.admin.token, { dayStart: '08:30', dayEnd: '13:00' }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'day_split_by_conflict' });
      expect((await call(hoursUrl(f, id), del(f.admin.token))).status).toBe(409);
    }

    expect(await f.db.select().from(linkDayOverrides).where(eq(linkDayOverrides.linkId, f.link.id))).toEqual([]);
    expect((await f.db.select().from(conflicts).where(eq(conflicts.id, conflict!.id)))[0]!.status).toBe(
      'resolved',
    );
    const kept = (await f.db.select().from(tasks).where(eq(tasks.id, pickup.id)))[0]!;
    expect(kept.status).toBe('owned');
    expect(kept.calendarEventId).toBe(afternoon.id);
  });

  it("goes by the school's own date: east of UTC, yesterday is past even inside the window", async () => {
    // 2026-07-06T12:00Z is already Tue 00:00 in Auckland (NZST, UTC+12), while
    // the synthesis window still starts on Mon Jul 6.
    const f = await fixture('day-hours-auckland@example.com', 'exception', 'Pacific/Auckland');
    const mon = (await dayRow(f.db, f.link.id, '2026-07-06'))!;
    const tue = (await dayRow(f.db, f.link.id, '2026-07-07'))!;

    const listed = await listedDays(f);
    expect(listed.get(mon.id)).toBeNull();
    expect(listed.get(tue.id)).toMatchObject({ date: '2026-07-07', dayStart: '08:30', dayEnd: '15:00' });

    const past = await call(hoursUrl(f, mon.id), put(f.admin.token, { dayStart: '08:30', dayEnd: '13:00' }));
    expect(past.status).toBe(409);
    expect(await past.json()).toEqual({ error: 'day_in_past' });
    expect(
      (await call(hoursUrl(f, tue.id), put(f.admin.token, { dayStart: '08:30', dayEnd: '13:00' }))).status,
    ).toBe(200);
  });

  it('validates hours, and refuses non-baseline events, past days, dependents and other families', async () => {
    const f = await fixture('day-hours-invalid@example.com');
    const tue = (await dayRow(f.db, f.link.id, '2026-07-07'))!;
    const set = (eventId: string, body: unknown, token = f.admin.token) =>
      call(hoursUrl(f, eventId), put(token, body));

    expect((await set(tue.id, { dayStart: '8:30', dayEnd: '13:00' })).status).toBe(400);
    expect((await set(tue.id, { dayEnd: '13:00' })).status).toBe(400);
    const backwards = await set(tue.id, { dayStart: '13:00', dayEnd: '08:30' });
    expect(backwards.status).toBe(400);
    expect(await backwards.json()).toEqual({ error: 'day_end_before_start' });

    // A day synthesis no longer shapes can't be changed.
    const past = (
      await f.db
        .insert(calendarEvents)
        .values({
          familyId: f.familyId,
          familyMemberId: f.childId,
          provenance: 'synthesized',
          synthKey: `bl:${f.link.id}:2026-07-03`,
          linkId: f.link.id,
          dtstart: new Date('2026-07-03T13:30:00Z'),
          dtend: new Date('2026-07-03T20:00:00Z'),
          contentHash: 'past',
        })
        .returning()
    )[0]!;
    const pastRes = await set(past.id, { dayStart: '08:30', dayEnd: '13:00' });
    expect(pastRes.status).toBe(409);
    expect(await pastRes.json()).toEqual({ error: 'day_in_past' });
    expect((await listedDays(f)).get(past.id)).toBeNull();

    // Not a baseline day: a standard feed's event.
    const s = await fixture('day-hours-standard@example.com', 'standard');
    const event = (
      await s.db
        .insert(calendarEvents)
        .values({
          familyId: s.familyId,
          familyMemberId: s.childId,
          provenance: 'synthesized',
          synthKey: `ev:${s.link.id}:abc`,
          linkId: s.link.id,
          dtstart: new Date('2026-07-07T22:00:00Z'),
          dtend: new Date('2026-07-07T23:00:00Z'),
          contentHash: 'ev',
        })
        .returning()
    )[0]!;
    const notDay = await call(hoursUrl(s, event.id), put(s.admin.token, { dayStart: '08:30', dayEnd: '13:00' }));
    expect(notDay.status).toBe(409);
    expect(await notDay.json()).toEqual({ error: 'not_a_baseline_day' });

    // Another family's admin can't see the event at all.
    expect((await call(hoursUrl(s, tue.id), put(s.admin.token, { dayStart: '08:30', dayEnd: '13:00' }))).status).toBe(404);
    expect((await call(hoursUrl(f, tue.id), put(s.admin.token, { dayStart: '08:30', dayEnd: '13:00' }))).status).toBe(403);

    // A dependent with a login doesn't get to rewrite their own school day.
    const kid = await login('day-hours-kid@example.com');
    await linkMember(f.admin.token, f.familyId, f.childId, kid.token);
    const kidRes = await set(tue.id, { dayStart: '08:30', dayEnd: '13:00' }, kid.token);
    expect(kidRes.status).toBe(403);
    expect((await call(hoursUrl(f, tue.id), del(kid.token))).status).toBe(403);

    expect(await f.db.select().from(linkDayOverrides).where(eq(linkDayOverrides.linkId, f.link.id))).toEqual([]);
  });

  it('synthesis sweeps one-offs whose day has passed and keeps the rest', async () => {
    const f = await fixture('day-hours-sweep@example.com');
    await f.db.insert(linkDayOverrides).values([
      { familyId: f.familyId, linkId: f.link.id, date: '2026-07-02', dayStart: '08:30', dayEnd: '12:00' },
      { familyId: f.familyId, linkId: f.link.id, date: '2026-07-06', dayStart: '08:30', dayEnd: '12:00' },
      { familyId: f.familyId, linkId: f.link.id, date: '2026-07-09', dayStart: '08:30', dayEnd: '12:00' },
    ]);
    await synthesizeFeed(f.db, f.feed);

    const left = await f.db.select().from(linkDayOverrides).where(eq(linkDayOverrides.linkId, f.link.id));
    expect(left.map((o) => o.date).sort()).toEqual(['2026-07-06', '2026-07-09']);
    // Today's still applies (12:00 CDT).
    expect((await dayRow(f.db, f.link.id, '2026-07-06'))!.dtend!.toISOString()).toBe(
      '2026-07-06T17:00:00.000Z',
    );
  });
});
