import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import {
  and,
  assignmentRules,
  calendarEvents,
  conflicts,
  eq,
  externalAccounts,
  families,
  familyMemberFeeds,
  feeds,
  getDb,
  inArray,
  memberCalendars,
  pendingDecisions,
  sourceEvents,
  taskOwners,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { scheduled } from '../src/scheduled.js';
import { storeSecret } from '../src/lib/secrets.js';
import { syncClaimEvents } from '../src/services/claim.js';
import { reconcileMemberConflicts } from '../src/services/conflicts.js';
import { acquireFamilyLease, releaseFamilyLease } from '../src/services/family-lease.js';
import { runFamilyTick } from '../src/services/pipeline.js';
import { readBackMember } from '../src/services/readback.js';
import { hashCalendarEvent, synthesizeFeed } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { setupFamily, testKeys } from './helpers.js';

/**
 * #264 — the pipeline's stages run concurrently from several entry points (the
 * cron tick, ~20 route handlers' inline resynthesize → conflicts → task-gen, the
 * queue consumer) with no lock, and each stage is snapshot-read → diff → write.
 * Overlapping runs therefore make the same decision twice. These specs run a
 * stage twice with `Promise.all` — D1 calls interleave at every await, so both
 * runs take their snapshot before either has written — and assert the writes
 * converge: no throw, no duplicates.
 */

type Db = ReturnType<typeof getDb>;

/** A day a few days out (inside the default 30-day synthesis window) at hh:mm. */
function futureAt(offsetDays: number, hour: number, min = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  d.setUTCHours(hour, min, 0, 0);
  return d;
}

/** Family + child + one exception-mode feed link whose segments are transitions. */
async function feedFixture(email: string) {
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
        weekdayMask: 31, // Mon–Fri
        dayStart: '08:30',
        dayEnd: '14:45',
        defaultTaskType: 'transition',
      })
      .returning()
  )[0]!;
  return { ...fam, db, feed, linkId: link.id };
}

/** A synthesized "school day" for the child, on the given offset day. */
async function insertSchoolDay(
  db: Db,
  f: { familyId: string; childId: string; linkId: string },
  offsetDays: number,
) {
  const payload = {
    dtstart: futureAt(offsetDays, 8, 30),
    dtend: futureAt(offsetDays, 15, 0),
    allDay: false,
    summary: 'School day',
    location: 'Lincoln Elementary',
    locationGeo: null,
    description: null,
  };
  return (
    await db
      .insert(calendarEvents)
      .values({
        familyId: f.familyId,
        familyMemberId: f.childId,
        provenance: 'synthesized',
        synthKey: `bl:${f.linkId}:d${offsetDays}`,
        linkId: f.linkId,
        contentHash: hashCalendarEvent(payload),
        ...payload,
      })
      .returning()
  )[0]!;
}

describe('task-gen under overlapping runs', () => {
  it('two concurrent runs leave exactly one drop-off and one pickup per event', async () => {
    const f = await feedFixture('idem-taskgen@example.com');
    const events = [
      await insertSchoolDay(f.db, f, 2),
      await insertSchoolDay(f.db, f, 3),
      await insertSchoolDay(f.db, f, 4),
    ];

    const [a, b] = await Promise.all([
      buildMemberTasks(f.db, f.childId),
      buildMemberTasks(f.db, f.childId),
    ]);

    const rows = await f.db.select().from(tasks).where(eq(tasks.familyMemberId, f.childId));
    expect(rows).toHaveLength(events.length * 2);
    for (const e of events) {
      const forEvent = rows.filter((t) => t.calendarEventId === e.id);
      expect(forEvent.map((t) => t.type).sort()).toEqual(['dropoff', 'pickup']);
    }
    // Each task is *created* by exactly one of the two runs.
    expect(a.tasksCreated + b.tasksCreated).toBe(rows.length);

    // And the next run is a clean no-op: nothing swept as a stray duplicate.
    const again = await buildMemberTasks(f.db, f.childId);
    expect(again.tasksCreated).toBe(0);
    expect(again.tasksRemoved).toBe(0);
  });

  it('the run that loses the insert race still reconciles the owner on the winner’s row', async () => {
    const f = await feedFixture('idem-taskgen-owner@example.com');
    await f.db.insert(assignmentRules).values({
      familyId: f.familyId,
      ownerMemberId: f.adminMemberId,
      aboutMemberId: f.childId,
      position: 0,
    });
    const events = [await insertSchoolDay(f.db, f, 2), await insertSchoolDay(f.db, f, 3)];

    await Promise.all([
      buildMemberTasks(f.db, f.childId),
      buildMemberTasks(f.db, f.childId),
    ]);

    const rows = await f.db.select().from(tasks).where(eq(tasks.familyMemberId, f.childId));
    expect(rows).toHaveLength(events.length * 2);
    // The rule claims every task for the admin: owned, one owner row each, no throw
    // from two runs adding the same (task, member).
    expect(rows.every((t) => t.status === 'owned')).toBe(true);
    const owners = await f.db
      .select()
      .from(taskOwners)
      .where(
        inArray(
          taskOwners.taskId,
          rows.map((t) => t.id),
        ),
      );
    expect(owners).toHaveLength(rows.length);
    expect(owners.every((o) => o.familyMemberId === f.adminMemberId)).toBe(true);
  });

  it('rejects a second generated task for the same (event, type) but not manual ones', async () => {
    const f = await feedFixture('idem-index@example.com');
    const ev = await insertSchoolDay(f.db, f, 2);
    const base = {
      familyId: f.familyId,
      calendarEventId: ev.id,
      familyMemberId: f.childId,
      type: 'dropoff' as const,
      dtstart: ev.dtstart,
    };
    await f.db.insert(tasks).values({ ...base, createdVia: 'generated' });
    await expect(
      f.db.insert(tasks).values({ ...base, createdVia: 'generated' }),
    ).rejects.toThrow();
    // Converted tasks and event-less manual tasks sit outside the partial index.
    await f.db.insert(tasks).values({ ...base, createdVia: 'manual' });
    await f.db.insert(tasks).values({ ...base, createdVia: 'manual' });
    await f.db.insert(tasks).values({ ...base, calendarEventId: null, createdVia: 'generated' });
    await f.db.insert(tasks).values({ ...base, calendarEventId: null, createdVia: 'generated' });
  });
});

describe('synthesis under overlapping runs', () => {
  it('two concurrent synthesizeFeed runs neither throw nor duplicate events', async () => {
    const f = await feedFixture('idem-synth@example.com');
    const window = {
      windowStart: new Date('2026-07-06T00:00:00Z'),
      windowEnd: new Date('2026-07-13T00:00:00Z'),
    };

    await Promise.all([
      synthesizeFeed(f.db, f.feed, window),
      synthesizeFeed(f.db, f.feed, window),
    ]);

    const rows = await f.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.familyMemberId, f.childId));
    expect(rows).toHaveLength(5); // Mon–Fri baseline days
    expect(new Set(rows.map((r) => r.synthKey)).size).toBe(5);
  });
});

describe('pending decisions under overlapping runs', () => {
  it('two concurrent synthesizeFeed runs raise exactly one decision per link', async () => {
    const f = await feedFixture('idem-pending@example.com');
    // A second member on the same feed, so "per link" is more than one row.
    const adminLink = (
      await f.db
        .insert(familyMemberFeeds)
        .values({
          familyId: f.familyId,
          feedId: f.feed.id,
          familyMemberId: f.adminMemberId,
          weekdayMask: 31,
          dayStart: '08:30',
          dayEnd: '14:45',
        })
        .returning()
    )[0]!;
    // An exception-feed event no rule handles: each link must ask about it.
    const source = (
      await f.db
        .insert(sourceEvents)
        .values({
          feedId: f.feed.id,
          familyId: f.familyId,
          icalUid: 'book-fair',
          recurrenceId: '',
          summary: 'Book Fair',
          dtstart: new Date('2026-07-07T17:00:00Z'),
          dtend: new Date('2026-07-07T19:00:00Z'),
          allDay: false,
          contentHash: 'v1',
        })
        .returning()
    )[0]!;
    const window = {
      windowStart: new Date('2026-07-06T00:00:00Z'),
      windowEnd: new Date('2026-07-13T00:00:00Z'),
    };

    const [a, b] = await Promise.all([
      synthesizeFeed(f.db, f.feed, window),
      synthesizeFeed(f.db, f.feed, window),
    ]);

    // Both runs report the decision as open, and there is one row per link.
    expect(a.pendingOpen).toBe(2);
    expect(b.pendingOpen).toBe(2);
    const rows = await f.db
      .select()
      .from(pendingDecisions)
      .where(eq(pendingDecisions.sourceEventId, source.id));
    expect(rows.map((r) => r.linkId).sort()).toEqual([f.linkId, adminLink.id].sort());
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });
});

describe('conflict reconciliation under overlapping runs', () => {
  /** A school day overlapped by a doctor visit, the conflict resolved. */
  async function resolvedSplit(email: string) {
    const f = await feedFixture(email);
    const school = await insertSchoolDay(f.db, f, 3);
    await f.db.insert(calendarEvents).values({
      familyId: f.familyId,
      familyMemberId: f.childId,
      provenance: 'human',
      synthKey: 'ext:doctor:',
      externalUid: 'doctor',
      dtstart: futureAt(3, 10, 0),
      dtend: futureAt(3, 11, 0),
      summary: 'Doctor appointment',
      contentHash: 'doc-hash',
    });
    await reconcileMemberConflicts(f.db, f.childId);
    await f.db
      .update(conflicts)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(eq(conflicts.familyMemberId, f.childId));
    return { ...f, school };
  }

  it('two concurrent runs over a resolved split materialise each segment once', async () => {
    const f = await resolvedSplit('idem-conflict-split@example.com');

    await Promise.all([
      reconcileMemberConflicts(f.db, f.childId),
      reconcileMemberConflicts(f.db, f.childId),
    ]);

    const segments = (
      await f.db.select().from(calendarEvents).where(eq(calendarEvents.familyMemberId, f.childId))
    ).filter((e) => e.synthKey.startsWith('cf:'));
    expect(segments.map((s) => s.synthKey).sort()).toEqual([
      `cf:${f.school.synthKey}:0`,
      `cf:${f.school.synthKey}:1`,
    ]);
    // The baseline is masked and a third, sequential run changes nothing.
    const masked = (
      await f.db.select().from(calendarEvents).where(eq(calendarEvents.id, f.school.id))
    )[0]!;
    expect(masked.maskedAt).not.toBeNull();
    const third = await reconcileMemberConflicts(f.db, f.childId);
    expect(third.masksApplied).toBe(1);
    const after = (
      await f.db.select().from(calendarEvents).where(eq(calendarEvents.familyMemberId, f.childId))
    ).filter((e) => e.synthKey.startsWith('cf:'));
    expect(after.map((s) => s.id).sort()).toEqual(segments.map((s) => s.id).sort());
  });

  it('two concurrent first-time detections record the conflict once', async () => {
    const f = await feedFixture('idem-conflict-detect@example.com');
    await insertSchoolDay(f.db, f, 3);
    await f.db.insert(calendarEvents).values({
      familyId: f.familyId,
      familyMemberId: f.childId,
      provenance: 'human',
      synthKey: 'ext:doctor:',
      externalUid: 'doctor',
      dtstart: futureAt(3, 10, 0),
      dtend: futureAt(3, 11, 0),
      summary: 'Doctor appointment',
      contentHash: 'doc-hash',
    });

    await Promise.all([
      reconcileMemberConflicts(f.db, f.childId),
      reconcileMemberConflicts(f.db, f.childId),
    ]);

    const rows = await f.db
      .select()
      .from(conflicts)
      .where(eq(conflicts.familyMemberId, f.childId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
  });
});

describe('claim sync under overlapping runs', () => {
  it('two concurrent syncs leave one claimed event for the owner', async () => {
    const f = await feedFixture('idem-claim@example.com');
    const ev = await insertSchoolDay(f.db, f, 2);
    const task = (
      await f.db
        .insert(tasks)
        .values({
          familyId: f.familyId,
          calendarEventId: ev.id,
          familyMemberId: f.childId,
          type: 'pickup',
          dtstart: ev.dtend!,
          status: 'owned',
          createdVia: 'generated',
        })
        .returning()
    )[0]!;
    await f.db.insert(taskOwners).values({ taskId: task.id, familyMemberId: f.adminMemberId });

    await Promise.all([
      syncClaimEvents(f.db, task, [f.adminMemberId]),
      syncClaimEvents(f.db, task, [f.adminMemberId]),
    ]);

    const claimed = await f.db
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.taskId, task.id), eq(calendarEvents.provenance, 'claimed_task')));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.familyMemberId).toBe(f.adminMemberId);
  });
});

describe('read-back under overlapping runs', () => {
  it('two concurrent read-backs import each human event once', async () => {
    const f = await feedFixture('idem-readback@example.com');
    const credRef = await storeSecret(
      f.db,
      testKeys(),
      null,
      JSON.stringify({ kind: 'oauth', refreshToken: 'rt-1' }),
    );
    const account = (
      await f.db
        .insert(externalAccounts)
        .values({ userId: f.admin.userId, kind: 'google', name: 'G', credentialsRef: credRef })
        .returning()
    )[0]!;
    const cal = (
      await f.db
        .insert(memberCalendars)
        .values({
          familyId: f.familyId,
          familyMemberId: f.childId,
          targetExternalAccountId: account.id,
          targetMethod: 'google',
          targetCalendarId: 'kid-calendar-id',
        })
        .returning()
    )[0]!;
    const items = ['a', 'b', 'c'].map((n, i) => ({
      iCalUID: `${n}@google.com`,
      status: 'confirmed',
      summary: `Playdate ${n}`,
      start: { dateTime: `2026-07-${String(8 + i).padStart(2, '0')}T16:00:00Z` },
      end: { dateTime: `2026-07-${String(8 + i).padStart(2, '0')}T18:00:00Z` },
    }));
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items }),
    })) as unknown as typeof fetch;
    const opts = {
      windowStart: new Date('2026-07-06T00:00:00Z'),
      windowEnd: new Date('2026-08-05T00:00:00Z'),
      kek: testKeys(),
      googleRefresh: async () => 'access-token',
      fetchImpl,
    };

    await Promise.all([readBackMember(f.db, cal, opts), readBackMember(f.db, cal, opts)]);

    const humans = await f.db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.familyMemberId, f.childId),
          eq(calendarEvents.provenance, 'human'),
        ),
      );
    expect(humans.map((h) => h.summary).sort()).toEqual([
      'Playdate a',
      'Playdate b',
      'Playdate c',
    ]);
  });
});

describe('family cron lease', () => {
  const TTL = 14 * 60 * 1000;

  async function leaseUntil(familyId: string) {
    const db = getDb(env.DB);
    return (await db.select().from(families).where(eq(families.id, familyId)))[0]!
      .pipelineLeaseUntil;
  }

  it('a second acquire fails until the first is released', async () => {
    const { familyId } = await setupFamily('lease-release@example.com');
    const db = getDb(env.DB);

    expect(await leaseUntil(familyId)).toBeNull();
    const lease = await acquireFamilyLease(db, familyId, TTL);
    expect(lease).toBeInstanceOf(Date);
    expect(await leaseUntil(familyId)).toEqual(lease);
    expect(await acquireFamilyLease(db, familyId, TTL)).toBeNull();

    await releaseFamilyLease(db, familyId, lease!);
    expect(await leaseUntil(familyId)).toBeNull();
    expect(await acquireFamilyLease(db, familyId, TTL)).toBeInstanceOf(Date);
  });

  it('an expired lease can be taken over', async () => {
    const { familyId } = await setupFamily('lease-expiry@example.com');
    const db = getDb(env.DB);
    const t0 = new Date('2026-07-06T12:00:00Z');

    expect(await acquireFamilyLease(db, familyId, TTL, t0)).toEqual(
      new Date(t0.getTime() + TTL),
    );
    // Still held one millisecond before it lapses…
    expect(
      await acquireFamilyLease(db, familyId, TTL, new Date(t0.getTime() + TTL - 1)),
    ).toBeNull();
    // …and free the moment after.
    expect(
      await acquireFamilyLease(db, familyId, TTL, new Date(t0.getTime() + TTL + 1)),
    ).not.toBeNull();
  });

  it('a tick that outlived its TTL cannot release the newer tick’s lease', async () => {
    const { familyId } = await setupFamily('lease-stale-release@example.com');
    const db = getDb(env.DB);
    const t0 = new Date('2026-07-06T12:00:00Z');

    // A takes the lease and runs long…
    const a = await acquireFamilyLease(db, familyId, TTL, t0);
    expect(a).not.toBeNull();
    // …it expires and B takes over…
    const b = await acquireFamilyLease(db, familyId, TTL, new Date(t0.getTime() + TTL + 1));
    expect(b).not.toBeNull();
    expect(b).not.toEqual(a);
    // …then A finally finishes and releases. B's lease must survive that.
    await releaseFamilyLease(db, familyId, a!);
    expect(await leaseUntil(familyId)).toEqual(b);
    expect(
      await acquireFamilyLease(db, familyId, TTL, new Date(t0.getTime() + TTL + 2)),
    ).toBeNull();

    // B releasing its own lease does clear it.
    await releaseFamilyLease(db, familyId, b!);
    expect(await leaseUntil(familyId)).toBeNull();
  });

  it('exactly one of several concurrent acquirers wins', async () => {
    const { familyId } = await setupFamily('lease-race@example.com');
    const db = getDb(env.DB);
    const won = await Promise.all(
      Array.from({ length: 5 }, () => acquireFamilyLease(db, familyId, TTL)),
    );
    expect(won.filter(Boolean)).toHaveLength(1);
  });

  it('leases are per family', async () => {
    const a = await setupFamily('lease-a@example.com');
    const b = await setupFamily('lease-b@example.com');
    const db = getDb(env.DB);
    expect(await acquireFamilyLease(db, a.familyId, TTL)).not.toBeNull();
    expect(await acquireFamilyLease(db, b.familyId, TTL)).not.toBeNull();
  });
});

describe('cron tick lease', () => {
  const TTL = 14 * 60 * 1000;

  /** A paused feed (no network work) plus one dirty event: only task-gen has a job. */
  async function dirtyFamily(email: string) {
    const f = await feedFixture(email);
    await f.db.update(feeds).set({ status: 'paused' }).where(eq(feeds.id, f.feed.id));
    await insertSchoolDay(f.db, f, 2); // task-gen has not seen it
    const taskCount = async () =>
      (await f.db.select().from(tasks).where(eq(tasks.familyMemberId, f.childId))).length;
    const leaseUntil = async () =>
      (await f.db.select().from(families).where(eq(families.id, f.familyId)))[0]!
        .pipelineLeaseUntil;
    return { ...f, taskCount, leaseUntil };
  }

  it('runFamilyTick skips a family whose lease is held, runs it once free, and hands the lease back', async () => {
    const f = await dirtyFamily('lease-tick@example.com');

    // A previous tick is still running → this one leaves the family alone.
    const held = await acquireFamilyLease(f.db, f.familyId, TTL);
    expect(held).not.toBeNull();
    expect(await runFamilyTick(env, f.familyId)).toEqual({ failedStages: [], skipped: true });
    expect(await f.taskCount()).toBe(0);
    // Skipping must leave the other holder's lease alone.
    expect(await f.leaseUntil()).toEqual(held);

    await releaseFamilyLease(f.db, f.familyId, held!);
    expect(await runFamilyTick(env, f.familyId)).toEqual({ failedStages: [] });
    expect(await f.taskCount()).toBe(2); // drop-off + pickup

    // The tick released its own lease on the way out.
    expect(await f.leaseUntil()).toBeNull();
  });

  it('two overlapping ticks over one family: one runs, the other skips', async () => {
    const f = await dirtyFamily('lease-overlap@example.com');

    const [a, b] = await Promise.all([
      runFamilyTick(env, f.familyId),
      runFamilyTick(env, f.familyId),
    ]);

    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
    expect(await f.taskCount()).toBe(2);
    expect(await f.leaseUntil()).toBeNull();
  });

  it('an expired lease from a tick that died does not block the family', async () => {
    const f = await dirtyFamily('lease-expired@example.com');
    const longAgo = new Date(Date.now() - 2 * TTL);
    expect(await acquireFamilyLease(f.db, f.familyId, TTL, longAgo)).not.toBeNull();

    expect(await runFamilyTick(env, f.familyId)).toEqual({ failedStages: [] });
    expect(await f.taskCount()).toBe(2);
  });

  it('the cron path (no queue bound, so inline) goes through the same lease', async () => {
    const f = await dirtyFamily('lease-cron@example.com');
    const runCron = async () => {
      const ctx = createExecutionContext();
      await scheduled({} as ScheduledController, env, ctx);
      await waitOnExecutionContext(ctx);
    };

    const held = await acquireFamilyLease(f.db, f.familyId, TTL);
    expect(held).not.toBeNull();
    await runCron();
    expect(await f.taskCount()).toBe(0);

    await releaseFamilyLease(f.db, f.familyId, held!);
    await runCron();
    expect(await f.taskCount()).toBe(2);
    expect(await f.leaseUntil()).toBeNull();
  });
});

describe('migration 0027 dedupe', () => {
  // Wrangler hands the whole file over as one multi-statement query (comments
  // stripped), so split it back into its statements to run them one at a time.
  const statements = () =>
    env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0027'))!
      .queries.join('\n')
      .split(/;\s*\n/)
      .map((q) => q.trim())
      .filter(Boolean);
  // The dedupe is the statements before the ALTER, in file order: detach the
  // owned losers, then delete the rest.
  const dedupeSql = () =>
    statements().filter((q) => q.startsWith('UPDATE ') || q.startsWith('DELETE FROM'));
  const runDedupe = async () => {
    for (const q of dedupeSql()) await env.DB.prepare(q).run();
  };
  const indexSql = () => statements().find((q) => q.startsWith('CREATE UNIQUE INDEX'))!;

  it('keeps one winner per group, detaches owned losers, deletes the rest, then builds the index', async () => {
    const f = await feedFixture('migration-dedupe@example.com');
    const db = f.db;
    expect(dedupeSql().map((q) => q.split(' ')[0])).toEqual(['UPDATE', 'DELETE']);
    expect(indexSql()).toBeTruthy();

    // Put the database back in its pre-0027 shape: duplicates are allowed.
    await env.DB.prepare('DROP INDEX tasks_generated_event_type_uq').run();

    const t = (n: number) => new Date(Date.UTC(2026, 6, 6, 12, n));
    const base = {
      familyId: f.familyId,
      familyMemberId: f.childId,
      dtstart: t(0),
    };
    const dup = (
      id: string,
      calendarEventId: string | null,
      type: 'dropoff' | 'pickup',
      over: Partial<typeof tasks.$inferInsert> = {},
    ) => ({
      ...base,
      id,
      calendarEventId,
      type,
      status: 'unowned' as const,
      createdVia: 'generated' as const,
      createdAt: t(1),
      ...over,
    });

    // E1 dropoff: an owned row that is NOT the oldest wins over unowned and
    //   dismissed ones, which are deleted.
    // E2 pickup: dismissed beats an older unowned one.
    // E3 dropoff: all else equal, the oldest wins, and on a created_at tie the lowest id.
    // E4: a manual twin and an event-less generated twin sit outside the index.
    // E5 pickup: two claimed duplicates. The earliest stays attached, the other
    //   is detached with its claim intact.
    // E6 dropoff: three claimed duplicates and an unowned row older than all of
    //   them. The oldest *owned* wins, the other owned two are detached, the
    //   unowned one is deleted.
    // One row per insert: a multi-row VALUES would trip D1's 100-parameter cap.
    const seed = [
      dup('e1-old-unowned', 'E1', 'dropoff', { createdAt: t(1) }),
      dup('e1-owned', 'E1', 'dropoff', { createdAt: t(5), status: 'owned' }),
      dup('e1-new-unowned', 'E1', 'dropoff', { createdAt: t(9) }),
      dup('e1-dismissed', 'E1', 'dropoff', { createdAt: t(0), status: 'dismissed' }),
      dup('e1-other-type', 'E1', 'pickup'),
      dup('e2-old-unowned', 'E2', 'pickup', { createdAt: t(1) }),
      dup('e2-dismissed', 'E2', 'pickup', { createdAt: t(5), status: 'dismissed' }),
      dup('e3-b', 'E3', 'dropoff', { createdAt: t(3) }),
      dup('e3-a', 'E3', 'dropoff', { createdAt: t(3) }),
      dup('e3-newer', 'E3', 'dropoff', { createdAt: t(4) }),
      dup('e4-generated', 'E4', 'dropoff'),
      dup('e4-manual-1', 'E4', 'dropoff', { createdVia: 'manual' }),
      dup('e4-manual-2', 'E4', 'dropoff', { createdVia: 'manual' }),
      dup('free-1', null, 'dropoff'),
      dup('free-2', null, 'dropoff'),
      dup('e5-first', 'E5', 'pickup', { createdAt: t(2), status: 'owned' }),
      dup('e5-second', 'E5', 'pickup', { createdAt: t(6), status: 'owned' }),
      dup('e6-unowned-oldest', 'E6', 'dropoff', { createdAt: t(0) }),
      dup('e6-owned-1', 'E6', 'dropoff', { createdAt: t(1), status: 'owned' }),
      dup('e6-owned-2', 'E6', 'dropoff', { createdAt: t(3), status: 'owned' }),
      dup('e6-owned-3', 'E6', 'dropoff', { createdAt: t(7), status: 'owned' }),
    ];
    for (const row of seed) await db.insert(tasks).values(row);

    // Every owned task carries a claim: an owner row and a claimed calendar event.
    const owned = ['e1-owned', 'e5-first', 'e5-second', 'e6-owned-1', 'e6-owned-2', 'e6-owned-3'];
    for (const id of owned) {
      await db.insert(taskOwners).values({ taskId: id, familyMemberId: f.adminMemberId });
      await db.insert(calendarEvents).values({
        familyId: f.familyId,
        familyMemberId: f.adminMemberId,
        provenance: 'claimed_task',
        synthKey: `task:${id}`,
        taskId: id,
        dtstart: t(0),
        contentHash: `claim-${id}`,
      });
    }

    // The index cannot be built over the duplicates…
    await expect(env.DB.prepare(indexSql()).run()).rejects.toThrow();

    // …until the migration's dedupe has run.
    await runDedupe();

    const after = async () =>
      Object.fromEntries(
        (await db.select({ id: tasks.id, ev: tasks.calendarEventId }).from(tasks)).map((r) => [
          r.id,
          r.ev,
        ]),
      );
    const expected = {
      'e1-owned': 'E1',
      'e1-other-type': 'E1',
      'e2-dismissed': 'E2',
      'e3-a': 'E3',
      'e4-generated': 'E4',
      'e4-manual-1': 'E4',
      'e4-manual-2': 'E4',
      'free-1': null,
      'free-2': null,
      'e5-first': 'E5',
      'e5-second': null, // owned loser: detached, not deleted
      'e6-owned-1': 'E6',
      'e6-owned-2': null,
      'e6-owned-3': null,
    };
    expect(await after()).toEqual(expected);

    // No claim was lost: every owned task still has its owner row and its
    // claimed calendar event, attached or detached alike.
    for (const id of owned) {
      expect(await db.select().from(taskOwners).where(eq(taskOwners.taskId, id))).toHaveLength(1);
      expect(
        await db.select().from(calendarEvents).where(eq(calendarEvents.taskId, id)),
      ).toHaveLength(1);
    }
    // Deleted losers took nothing with them but themselves: no stray owner rows.
    expect(await db.select().from(taskOwners)).toHaveLength(owned.length);

    // Now the index builds, and the dedupe is idempotent.
    await env.DB.prepare(indexSql()).run();
    await runDedupe();
    expect(await after()).toEqual(expected);
  });
});
