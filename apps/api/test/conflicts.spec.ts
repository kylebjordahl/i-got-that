import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  conflicts,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  tasks,
} from '@igt/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { reconcileMemberConflicts } from '../src/services/conflicts.js';
import { authed, bearer, call, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

/** A day a few days out (inside the default 30-day synthesis window) at hh:mm. */
function futureAt(offsetDays: number, hour: number, min = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, min, 0, 0);
  return d;
}

/** Family + child + one exception feed link (position 0) — the school calendar. */
async function fixture(email: string) {
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
        // Split segments should generate drop-off + pickup (a transition).
        defaultTaskType: 'transition',
      })
      .returning()
  )[0]!;
  return { ...fam, db, feed, linkId: link.id };
}

/** Insert a synthesized baseline "school day" and a higher-priority manual event
 *  that overlaps it in the middle. Returns their synthKeys. */
async function schoolAndDoctor(
  db: Db,
  f: { familyId: string; childId: string; linkId: string },
) {
  const blKey = 'bl:' + f.linkId + ':day';
  await db.insert(calendarEvents).values({
    familyId: f.familyId,
    familyMemberId: f.childId,
    provenance: 'synthesized',
    synthKey: blKey,
    linkId: f.linkId,
    dtstart: futureAt(3, 8, 30),
    dtend: futureAt(3, 15, 0),
    summary: 'School day',
    location: 'Lincoln Elementary',
    contentHash: 'bl-hash',
  });
  const docKey = 'ext:doctor:';
  await db.insert(calendarEvents).values({
    familyId: f.familyId,
    familyMemberId: f.childId,
    provenance: 'human',
    synthKey: docKey,
    externalUid: 'doctor',
    dtstart: futureAt(3, 10, 0),
    dtend: futureAt(3, 11, 0),
    summary: 'Doctor appointment',
    contentHash: 'doc-hash',
  });
  return { blKey, docKey };
}

async function eventKeys(db: Db, childId: string): Promise<string[]> {
  const rows = await db
    .select({ synthKey: calendarEvents.synthKey, maskedAt: calendarEvents.maskedAt })
    .from(calendarEvents)
    .where(eq(calendarEvents.familyMemberId, childId));
  return rows.filter((r) => r.maskedAt == null).map((r) => r.synthKey).sort();
}

describe('conflict detection & masking', () => {
  beforeEach(() => {});

  it('detects a baseline overlapped by a manual event, and exposes it via /conflicts', async () => {
    const f = await fixture('conflict-detect@example.com');
    const { blKey, docKey } = await schoolAndDoctor(f.db, f);

    const res = await reconcileMemberConflicts(f.db, f.childId);
    expect(res.conflictsOpen).toBe(1);
    expect(res.masksApplied).toBe(0);

    const rows = await f.db
      .select()
      .from(conflicts)
      .where(eq(conflicts.familyMemberId, f.childId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ loserKey: blKey, winnerKey: docKey, status: 'pending' });

    const api = await call(`/families/${f.familyId}/conflicts`, bearer(f.admin.token));
    const { conflicts: list } = (await api.json()) as {
      conflicts: { id: string; loser: { summary: string }; winner: { summary: string } }[];
    };
    expect(list).toHaveLength(1);
    expect(list[0]!.loser.summary).toBe('School day');
    expect(list[0]!.winner.summary).toBe('Doctor appointment');
  });

  it('resolving splits the baseline around the appointment and generates the drop-off/pickup', async () => {
    const f = await fixture('conflict-resolve@example.com');
    const { blKey } = await schoolAndDoctor(f.db, f);
    await reconcileMemberConflicts(f.db, f.childId);

    const conflict = (
      await f.db.select().from(conflicts).where(eq(conflicts.familyMemberId, f.childId))
    )[0]!;

    const res = await call(
      `/families/${f.familyId}/conflicts/${conflict.id}/resolve`,
      authed(f.admin.token),
    );
    expect(res.status).toBe(200);

    // The baseline row survives but is masked; two split segments stand in.
    const bl = (
      await f.db.select().from(calendarEvents).where(eq(calendarEvents.synthKey, blKey))
    )[0]!;
    expect(bl.maskedAt).not.toBeNull();

    const keys = await eventKeys(f.db, f.childId);
    expect(keys).toEqual([`cf:${blKey}:0`, `cf:${blKey}:1`, 'ext:doctor:']);

    const seg0 = (
      await f.db.select().from(calendarEvents).where(eq(calendarEvents.synthKey, `cf:${blKey}:0`))
    )[0]!;
    const seg1 = (
      await f.db.select().from(calendarEvents).where(eq(calendarEvents.synthKey, `cf:${blKey}:1`))
    )[0]!;
    expect(seg0.dtstart.toISOString()).toBe(futureAt(3, 8, 30).toISOString());
    expect(seg0.dtend!.toISOString()).toBe(futureAt(3, 10, 0).toISOString());
    expect(seg1.dtstart.toISOString()).toBe(futureAt(3, 11, 0).toISOString());
    expect(seg1.dtend!.toISOString()).toBe(futureAt(3, 15, 0).toISOString());

    // Task-gen ran (via the endpoint): each segment is a transition, so the
    // split boundary carries a pickup (leave at 10:00) and a drop-off (return at
    // 11:00) — the heart of the feature.
    const segTasks = await f.db
      .select()
      .from(tasks)
      .where(eq(tasks.familyMemberId, f.childId));
    const pickup = segTasks.find(
      (t) => t.type === 'pickup' && t.dtstart.toISOString() === futureAt(3, 10, 0).toISOString(),
    );
    const dropoff = segTasks.find(
      (t) => t.type === 'dropoff' && t.dtstart.toISOString() === futureAt(3, 11, 0).toISOString(),
    );
    expect(pickup, 'pickup at the split start').toBeTruthy();
    expect(dropoff, 'drop-off at the split end').toBeTruthy();

    // The masked baseline itself spawns no tasks (only the segments do).
    const onBaseline = segTasks.filter((t) => t.calendarEventId === bl.id);
    expect(onBaseline).toHaveLength(0);

    // The calendar view hides the masked baseline and shows the segments.
    const view = await call(
      `/families/${f.familyId}/calendar-events?memberId=${f.childId}`,
      bearer(f.admin.token),
    );
    const { events } = (await view.json()) as { events: { id: string }[] };
    expect(events.map((e) => e.id)).not.toContain(bl.id);
    expect(events.map((e) => e.id)).toContain(seg0.id);
  });

  it('reverting undoes the split and re-surfaces the conflict as pending', async () => {
    const f = await fixture('conflict-revert@example.com');
    const { blKey, docKey } = await schoolAndDoctor(f.db, f);
    await reconcileMemberConflicts(f.db, f.childId);
    const conflict = (
      await f.db.select().from(conflicts).where(eq(conflicts.familyMemberId, f.childId))
    )[0]!;

    const resolveRes = await call(
      `/families/${f.familyId}/conflicts/${conflict.id}/resolve`,
      authed(f.admin.token),
    );
    expect(resolveRes.status).toBe(200);
    // A resolved conflict shows up as an override in effect for the member.
    const overridesRes = await call(
      `/families/${f.familyId}/conflicts?status=resolved&memberId=${f.childId}`,
      bearer(f.admin.token),
    );
    const { conflicts: overrides } = (await overridesRes.json()) as {
      conflicts: { id: string }[];
    };
    expect(overrides.map((o) => o.id)).toEqual([conflict.id]);

    const revertRes = await call(
      `/families/${f.familyId}/conflicts/${conflict.id}/revert`,
      authed(f.admin.token),
    );
    expect(revertRes.status).toBe(200);

    // The baseline is unmasked and the split segments are gone.
    const bl = (
      await f.db.select().from(calendarEvents).where(eq(calendarEvents.synthKey, blKey))
    )[0]!;
    expect(bl.maskedAt).toBeNull();
    const keys = await eventKeys(f.db, f.childId);
    expect(keys).toEqual([blKey, docKey]);

    // Back in the pending decision queue, and no longer listed as an override.
    const row = (
      await f.db.select().from(conflicts).where(eq(conflicts.id, conflict.id))
    )[0]!;
    expect(row.status).toBe('pending');
    expect(row.resolvedAt).toBeNull();
    const api = await call(`/families/${f.familyId}/conflicts`, bearer(f.admin.token));
    const { conflicts: pending } = (await api.json()) as { conflicts: { id: string }[] };
    expect(pending.map((c) => c.id)).toEqual([conflict.id]);
    const overridesAfter = await call(
      `/families/${f.familyId}/conflicts?status=resolved&memberId=${f.childId}`,
      bearer(f.admin.token),
    );
    expect(
      ((await overridesAfter.json()) as { conflicts: unknown[] }).conflicts,
    ).toHaveLength(0);
  });

  it('dismissing leaves the double-book intact and applies no split', async () => {
    const f = await fixture('conflict-dismiss@example.com');
    const { blKey } = await schoolAndDoctor(f.db, f);
    await reconcileMemberConflicts(f.db, f.childId);
    const conflict = (
      await f.db.select().from(conflicts).where(eq(conflicts.familyMemberId, f.childId))
    )[0]!;

    const res = await call(
      `/families/${f.familyId}/conflicts/${conflict.id}/dismiss`,
      authed(f.admin.token),
    );
    expect(res.status).toBe(200);

    const bl = (
      await f.db.select().from(calendarEvents).where(eq(calendarEvents.synthKey, blKey))
    )[0]!;
    expect(bl.maskedAt).toBeNull();
    // No split segments were created.
    const keys = await eventKeys(f.db, f.childId);
    expect(keys).toEqual([blKey, 'ext:doctor:']);
    // A dismissed conflict is not re-surfaced as pending.
    const api = await call(`/families/${f.familyId}/conflicts`, bearer(f.admin.token));
    expect(((await api.json()) as { conflicts: unknown[] }).conflicts).toHaveLength(0);
  });

  it('stays stable across a re-run, and auto-clears when the overlap goes away', async () => {
    const f = await fixture('conflict-stable@example.com');
    const { blKey, docKey } = await schoolAndDoctor(f.db, f);
    await reconcileMemberConflicts(f.db, f.childId);
    const conflict = (
      await f.db.select().from(conflicts).where(eq(conflicts.familyMemberId, f.childId))
    )[0]!;
    await f.db
      .update(conflicts)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(eq(conflicts.id, conflict.id));

    // First pass masks. A second pass (no synthesis in between) must NOT
    // un-mask — the masked baseline row keeps detection stable.
    await reconcileMemberConflicts(f.db, f.childId);
    await reconcileMemberConflicts(f.db, f.childId);
    let keys = await eventKeys(f.db, f.childId);
    expect(keys).toEqual([`cf:${blKey}:0`, `cf:${blKey}:1`, docKey]);
    expect(
      (await f.db.select().from(conflicts).where(eq(conflicts.familyMemberId, f.childId))).length,
    ).toBe(1);

    // Move the appointment out of the school day → overlap gone → conflict
    // clears and the baseline is un-masked (segments removed).
    await f.db
      .update(calendarEvents)
      .set({ dtstart: futureAt(3, 16, 0), dtend: futureAt(3, 17, 0) })
      .where(eq(calendarEvents.synthKey, docKey));
    const res = await reconcileMemberConflicts(f.db, f.childId);
    expect(res.conflictsOpen).toBe(0);
    expect(
      (await f.db.select().from(conflicts).where(eq(conflicts.familyMemberId, f.childId))).length,
    ).toBe(0);
    keys = await eventKeys(f.db, f.childId);
    expect(keys).toEqual([blKey, docKey]);
  });
});
