import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  linkDayOverrides,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { setTaskOwners } from '../src/services/task-owners.js';
import { bearer, call, linkMember, login, pinClockTo, put, setupFamily } from './helpers.js';

/**
 * One baseline day's hours set by hand — "Tuesday I'm picking her up at 1:00"
 * — from the day's own event, with no calendar event (and no conflict) needed.
 */

// A Monday; the synthesis window is [2026-07-06, 2026-08-05).
pinClockTo('2026-07-06T12:00:00Z');

type Db = ReturnType<typeof getDb>;

/** A school feed in Chicago (CDT, UTC-5): Mon–Fri 08:30–15:00. */
async function fixture(email: string, mode: 'exception' | 'standard' = 'exception') {
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
        timezone: 'America/Chicago',
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

  it("takes a split day's segment, and lists the whole day's hours on it", async () => {
    const f = await fixture('day-hours-split@example.com');
    const tue = (await dayRow(f.db, f.link.id, '2026-07-07'))!;
    // Stand in for a resolved conflict: the full day masked, a segment cut from it.
    await f.db.update(calendarEvents).set({ maskedAt: new Date() }).where(eq(calendarEvents.id, tue.id));
    const segment = (
      await f.db
        .insert(calendarEvents)
        .values({
          familyId: f.familyId,
          familyMemberId: f.childId,
          provenance: 'synthesized',
          synthKey: `cf:${tue.synthKey}:1`,
          linkId: f.link.id,
          dtstart: new Date('2026-07-07T17:00:00Z'),
          dtend: tue.dtend,
          summary: tue.summary,
          contentHash: 'segment',
        })
        .returning()
    )[0]!;

    const listed = await listedDays(f);
    expect(listed.has(tue.id)).toBe(false); // masked rows aren't listed
    expect(listed.get(segment.id)).toEqual({
      date: '2026-07-07',
      dayStart: '08:30',
      dayEnd: '15:00',
      adjusted: false,
    });

    const res = await call(hoursUrl(f, segment.id), put(f.admin.token, { dayStart: '08:30', dayEnd: '13:00' }));
    expect(res.status).toBe(200);
    const [override] = await f.db.select().from(linkDayOverrides).where(eq(linkDayOverrides.linkId, f.link.id));
    expect(override).toMatchObject({ date: '2026-07-07', dayEnd: '13:00' });
    expect((await dayRow(f.db, f.link.id, '2026-07-07'))!.dtend!.toISOString()).toBe(
      '2026-07-07T18:00:00.000Z',
    );
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
