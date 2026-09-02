import { env, fetchMock } from 'cloudflare:test';
import {
  conflicts,
  eq,
  getDb,
  notificationSchedules,
  pendingDecisions,
  pushDevices,
  sourceEvents,
  calendarEvents,
  familyMemberFeeds,
  feeds,
  taskOwners,
  tasks,
} from '@igt/db';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApnsPusher, DevPusher, pemToPkcs8, signApnsToken } from '../src/lib/apns.js';
import {
  buildUserDigest,
  digestNotificationText,
  digestWindow,
  localDateKey,
  startOfLocalDay,
} from '../src/services/digest.js';
import {
  claimSlot,
  currentBadgeCount,
  dueSlot,
  sendDigest,
} from '../src/services/notifications.js';
import {
  authed,
  bearer,
  call,
  login,
  patched,
  setupFamily,
} from './helpers.js';

type Db = ReturnType<typeof getDb>;

const LA = 'America/Los_Angeles';
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

function device(token: string, extra: Record<string, unknown> = {}) {
  return {
    deviceToken: token,
    bundleId: 'com.kylebjordahl.igt.staging',
    environment: 'development',
    timezone: LA,
    ...extra,
  };
}

function schedulePayload(extra: Record<string, unknown> = {}) {
  return {
    label: 'Evening brief',
    sendAt: '20:00',
    timezone: LA,
    categories: ['unclaimed_tasks'],
    ...extra,
  };
}

/** A schedule row shaped for the pure helpers, without going through the API. */
function scheduleRow(
  extra: Partial<typeof notificationSchedules.$inferSelect> = {},
): typeof notificationSchedules.$inferSelect {
  return {
    id: 's1',
    userId: 'u1',
    label: 'Evening brief',
    enabled: true,
    sendAt: '20:00',
    timezone: LA,
    weekdayMask: 127,
    startOffsetDays: 1,
    horizonDays: 1,
    categories: ['unclaimed_tasks'],
    skipWhenEmpty: true,
    lastSentSlot: null,
    lastSentAt: null,
    createdAt: new Date(),
    ...extra,
  };
}

async function insertTask(
  db: Db,
  familyId: string,
  familyMemberId: string,
  values: Partial<typeof tasks.$inferInsert> & { dtstart: Date; ownerMemberId?: string },
) {
  const { ownerMemberId, ...taskValues } = values;
  const task = (
    await db
      .insert(tasks)
      .values({
        familyId,
        familyMemberId,
        type: values.type ?? 'pickup',
        status: values.status ?? 'unowned',
        createdVia: 'generated',
        ...taskValues,
      })
      .returning()
  )[0]!;
  if (ownerMemberId) {
    await db.insert(taskOwners).values({ taskId: task.id, familyMemberId: ownerMemberId });
  }
  return task;
}

// --- Device registration ---------------------------------------------------

describe('push device registration', () => {
  it('registers a device and lists it back', async () => {
    const { token } = await login('push-register@example.com');
    const res = await call('/notifications/devices', authed(token, device(TOKEN_A)));
    expect(res.status).toBe(200);

    const list = await call('/notifications/devices', bearer(token));
    const { devices } = (await list.json()) as { devices: { deviceToken: string }[] };
    expect(devices.map((d) => d.deviceToken)).toEqual([TOKEN_A]);
  });

  it('re-registering the same token under another user moves it rather than duplicating', async () => {
    const first = await login('push-move-a@example.com');
    const second = await login('push-move-b@example.com');
    const shared = 'c'.repeat(64);

    await call('/notifications/devices', authed(first.token, device(shared)));
    await call('/notifications/devices', authed(second.token, device(shared)));

    const db = getDb(env.DB);
    const rows = await db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.deviceToken, shared));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(second.userId);

    // The first user must no longer see it — otherwise their digests keep
    // arriving on a phone that now belongs to someone else.
    const firstList = await call('/notifications/devices', bearer(first.token));
    const { devices } = (await firstList.json()) as { devices: unknown[] };
    expect(devices).toHaveLength(0);
  });

  it('re-registering revives a device APNs had rejected', async () => {
    const { token } = await login('push-revive@example.com');
    const revived = 'd'.repeat(64);
    await call('/notifications/devices', authed(token, device(revived)));

    const db = getDb(env.DB);
    await db
      .update(pushDevices)
      .set({ disabledAt: new Date() })
      .where(eq(pushDevices.deviceToken, revived));

    await call('/notifications/devices', authed(token, device(revived)));
    const rows = await db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.deviceToken, revived));
    expect(rows[0]!.disabledAt).toBeNull();
  });

  it('rejects a malformed device token', async () => {
    const { token } = await login('push-bad-token@example.com');
    const res = await call(
      '/notifications/devices',
      authed(token, device('NOT-HEX!')),
    );
    expect(res.status).toBe(400);
  });

  it('unregisters a device', async () => {
    const { token } = await login('push-unregister@example.com');
    const gone = 'e'.repeat(64);
    await call('/notifications/devices', authed(token, device(gone)));
    const res = await call('/notifications/devices', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ deviceToken: gone }),
    });
    expect(res.status).toBe(200);

    const list = await call('/notifications/devices', bearer(token));
    const { devices } = (await list.json()) as { devices: unknown[] };
    expect(devices).toHaveLength(0);
  });

  it('requires a session', async () => {
    const res = await call('/notifications/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(device(TOKEN_B)),
    });
    expect(res.status).toBe(401);
  });
});

// --- Schedule CRUD ---------------------------------------------------------

describe('notification schedules', () => {
  it('creates, lists, updates and deletes a schedule', async () => {
    const { token } = await login('sched-crud@example.com');
    const created = await call('/notifications/schedules', authed(token, schedulePayload()));
    expect(created.status).toBe(201);
    const { schedule } = (await created.json()) as {
      schedule: { id: string; weekdayMask: number; horizonDays: number };
    };
    // Defaults come from the Zod contract, not the caller.
    expect(schedule.weekdayMask).toBe(127);
    expect(schedule.horizonDays).toBe(1);

    const patch = await call(
      `/notifications/schedules/${schedule.id}`,
      patched(token, { label: 'Morning', weekdayMask: 31, horizonDays: 2 }),
    );
    expect(patch.status).toBe(200);
    const { schedule: updated } = (await patch.json()) as {
      schedule: { label: string; weekdayMask: number; horizonDays: number };
    };
    expect(updated).toMatchObject({ label: 'Morning', weekdayMask: 31, horizonDays: 2 });

    const del = await call(`/notifications/schedules/${schedule.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(200);

    const list = await call('/notifications/schedules', bearer(token));
    const { schedules } = (await list.json()) as { schedules: unknown[] };
    expect(schedules).toHaveLength(0);
  });

  it("another user's schedule is not found, not merely forbidden", async () => {
    const owner = await login('sched-owner@example.com');
    const stranger = await login('sched-stranger@example.com');
    const created = await call(
      '/notifications/schedules',
      authed(owner.token, schedulePayload()),
    );
    const { schedule } = (await created.json()) as { schedule: { id: string } };

    for (const res of [
      await call(
        `/notifications/schedules/${schedule.id}`,
        patched(stranger.token, { label: 'mine now' }),
      ),
      await call(`/notifications/schedules/${schedule.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${stranger.token}` },
      }),
      await call(
        `/notifications/schedules/${schedule.id}/test`,
        authed(stranger.token),
      ),
    ]) {
      expect(res.status).toBe(404);
    }
  });

  it('rejects an empty category list and an invalid timezone', async () => {
    const { token } = await login('sched-invalid@example.com');
    const noCategories = await call(
      '/notifications/schedules',
      authed(token, schedulePayload({ categories: [] })),
    );
    expect(noCategories.status).toBe(400);

    const badTz = await call(
      '/notifications/schedules',
      authed(token, schedulePayload({ timezone: 'Mars/Olympus' })),
    );
    expect(badTz.status).toBe(400);

    const badTime = await call(
      '/notifications/schedules',
      authed(token, schedulePayload({ sendAt: '25:00' })),
    );
    expect(badTime.status).toBe(400);
  });

  it('clears the claimed slot when the send time moves, so an edit can fire the same day', async () => {
    const { token } = await login('sched-retime@example.com');
    const created = await call('/notifications/schedules', authed(token, schedulePayload()));
    const { schedule } = (await created.json()) as { schedule: { id: string } };

    const db = getDb(env.DB);
    await db
      .update(notificationSchedules)
      .set({ lastSentSlot: '2026-08-05T20:00' })
      .where(eq(notificationSchedules.id, schedule.id));

    // A cosmetic edit leaves the stamp alone…
    await call(`/notifications/schedules/${schedule.id}`, patched(token, { label: 'x' }));
    let row = (
      await db
        .select()
        .from(notificationSchedules)
        .where(eq(notificationSchedules.id, schedule.id))
    )[0]!;
    expect(row.lastSentSlot).toBe('2026-08-05T20:00');

    // …but retiming it clears the stamp.
    await call(
      `/notifications/schedules/${schedule.id}`,
      patched(token, { sendAt: '21:00' }),
    );
    row = (
      await db
        .select()
        .from(notificationSchedules)
        .where(eq(notificationSchedules.id, schedule.id))
    )[0]!;
    expect(row.lastSentSlot).toBeNull();
  });
});

// --- Window maths ----------------------------------------------------------

describe('digest window', () => {
  it('(1, 1) is exactly tomorrow, local', () => {
    // 2026-08-05T21:00Z is 14:00 in Los Angeles.
    const now = new Date('2026-08-05T21:00:00Z');
    const { from, to } = digestWindow(now, LA, 1, 1);
    expect(localDateKey(from, LA)).toBe('2026-08-06');
    expect(from.toISOString()).toBe('2026-08-06T07:00:00.000Z');
    expect(to.toISOString()).toBe('2026-08-07T07:00:00.000Z');
  });

  it('(0, 1) clamps the start to now, so a morning brief skips what already happened', () => {
    const now = new Date('2026-08-05T21:00:00Z');
    const { from, to } = digestWindow(now, LA, 0, 1);
    expect(from).toEqual(now);
    expect(to.toISOString()).toBe('2026-08-06T07:00:00.000Z');
  });

  it('(0, 2) spans two local days', () => {
    const now = new Date('2026-08-05T21:00:00Z');
    const { to } = digestWindow(now, LA, 0, 2);
    expect(to.toISOString()).toBe('2026-08-07T07:00:00.000Z');
  });

  it('stays on calendar days across spring-forward', () => {
    // US DST begins 2026-03-08. The day is 23 hours long, so adding a flat 24h
    // would land at 01:00 rather than midnight.
    const now = new Date('2026-03-07T20:00:00Z'); // 12:00 PST on the 7th
    const { from, to } = digestWindow(now, LA, 1, 1);
    expect(localDateKey(from, LA)).toBe('2026-03-08');
    expect(from.toISOString()).toBe('2026-03-08T08:00:00.000Z'); // PST midnight
    expect(to.toISOString()).toBe('2026-03-09T07:00:00.000Z'); // PDT midnight
    expect(to.getTime() - from.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('stays on calendar days across fall-back', () => {
    // US DST ends 2026-11-01 — a 25-hour day.
    const now = new Date('2026-10-31T19:00:00Z'); // 12:00 PDT
    const { from, to } = digestWindow(now, LA, 1, 1);
    expect(localDateKey(from, LA)).toBe('2026-11-01');
    expect(to.getTime() - from.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it('startOfLocalDay respects the zone, not the host', () => {
    // 03:00Z on the 6th is still the evening of the 5th in Los Angeles.
    const at = new Date('2026-08-06T03:00:00Z');
    expect(startOfLocalDay(at, LA).toISOString()).toBe('2026-08-05T07:00:00.000Z');
    expect(startOfLocalDay(at, 'UTC').toISOString()).toBe('2026-08-06T00:00:00.000Z');
  });
});

// --- Slot selection + claiming --------------------------------------------

describe('due slots', () => {
  it('fires within the grace window and not before the send time', () => {
    const schedule = scheduleRow();
    // 20:00 PDT on 2026-08-05 is 03:00Z on the 6th.
    expect(dueSlot(schedule, new Date('2026-08-06T02:59:00Z'))).toBeNull();
    expect(dueSlot(schedule, new Date('2026-08-06T03:00:00Z'))).toBe('2026-08-05T20:00');
    // A missed tick still delivers, up to the half-hour grace.
    expect(dueSlot(schedule, new Date('2026-08-06T03:20:00Z'))).toBe('2026-08-05T20:00');
    expect(dueSlot(schedule, new Date('2026-08-06T03:31:00Z'))).toBeNull();
  });

  it('honours the weekday mask', () => {
    // 2026-08-05 is a Wednesday (Mon=bit0 ⇒ bit2).
    const wednesdays = scheduleRow({ weekdayMask: 1 << 2 });
    const mondays = scheduleRow({ weekdayMask: 1 << 0 });
    const at = new Date('2026-08-06T03:05:00Z');
    expect(dueSlot(wednesdays, at)).toBe('2026-08-05T20:00');
    expect(dueSlot(mondays, at)).toBeNull();
  });

  it("picks up yesterday's late slot just after local midnight", () => {
    const schedule = scheduleRow({ sendAt: '23:50' });
    // 23:50 PDT on the 5th is 06:50Z on the 6th; check 10 minutes later, which
    // is already 00:00 local on the 6th.
    expect(dueSlot(schedule, new Date('2026-08-06T07:00:00Z'))).toBe('2026-08-05T23:50');
  });

  it('claims a slot exactly once', async () => {
    const { token } = await login('slot-claim@example.com');
    const created = await call('/notifications/schedules', authed(token, schedulePayload()));
    const { schedule } = (await created.json()) as { schedule: { id: string } };

    const db = getDb(env.DB);
    const now = new Date();
    expect(await claimSlot(db, schedule.id, '2026-08-05T20:00', now)).toBe(true);
    // A second tick inside the same slot loses the race and must not send.
    expect(await claimSlot(db, schedule.id, '2026-08-05T20:00', now)).toBe(false);
    // The next day's slot is a different key and claims cleanly.
    expect(await claimSlot(db, schedule.id, '2026-08-06T20:00', now)).toBe(true);
  });
});

// --- Digest contents -------------------------------------------------------

describe('digest contents', () => {
  it('counts unclaimed tasks in the window and ignores ones outside it', async () => {
    const { admin, familyId, childId } = await setupFamily('digest-unclaimed@example.com');
    const db = getDb(env.DB);
    const window = {
      from: new Date('2026-08-06T07:00:00Z'),
      to: new Date('2026-08-07T07:00:00Z'),
    };
    await insertTask(db, familyId, childId, { dtstart: new Date('2026-08-06T16:00:00Z') });
    await insertTask(db, familyId, childId, { dtstart: new Date('2026-08-06T23:00:00Z') });
    // Outside the window, and inside it but already owned.
    await insertTask(db, familyId, childId, { dtstart: new Date('2026-08-09T16:00:00Z') });
    await insertTask(db, familyId, childId, {
      dtstart: new Date('2026-08-06T18:00:00Z'),
      status: 'owned',
    });

    const digest = await buildUserDigest(db, admin.userId, window, ['unclaimed_tasks']);
    expect(digest.total).toBe(2);
    expect(digest.buckets[0]!.category).toBe('unclaimed_tasks');
    expect(digest.buckets[0]!.items[0]!.label).toBe('child pickup');
  });

  it('counts the tasks the caller owns under my_tasks', async () => {
    const { admin, familyId, adminMemberId, childId } = await setupFamily(
      'digest-mine@example.com',
    );
    const db = getDb(env.DB);
    const window = {
      from: new Date('2026-08-06T07:00:00Z'),
      to: new Date('2026-08-07T07:00:00Z'),
    };
    await insertTask(db, familyId, childId, {
      dtstart: new Date('2026-08-06T16:00:00Z'),
      status: 'owned',
      ownerMemberId: adminMemberId,
    });
    // Owned by nobody the caller is — must not show up as "yours".
    await insertTask(db, familyId, childId, {
      dtstart: new Date('2026-08-06T17:00:00Z'),
      status: 'owned',
      ownerMemberId: childId,
    });

    const digest = await buildUserDigest(db, admin.userId, window, ['my_tasks']);
    expect(digest.total).toBe(1);
  });

  it('does not nudge a non-caretaker to claim work', async () => {
    // The child member has a login but isn't a caretaker, so the claim queue
    // isn't theirs to act on.
    const { admin, familyId, childId } = await setupFamily('digest-dependent@example.com');
    const kid = await login('digest-kid@example.com');
    const invited = await call(
      `/families/${familyId}/members/${childId}/invite`,
      authed(admin.token),
    );
    const { token: inviteToken } = (await invited.json()) as { token: string };
    await call(`/invites/${inviteToken}/accept`, authed(kid.token));

    const db = getDb(env.DB);
    const window = {
      from: new Date('2026-08-06T07:00:00Z'),
      to: new Date('2026-08-07T07:00:00Z'),
    };
    await insertTask(db, familyId, childId, { dtstart: new Date('2026-08-06T16:00:00Z') });

    expect(
      (await buildUserDigest(db, kid.userId, window, ['unclaimed_tasks'])).total,
    ).toBe(0);
    expect(
      (await buildUserDigest(db, admin.userId, window, ['unclaimed_tasks'])).total,
    ).toBe(1);
  });

  it('counts a routing decision once per event, not once per member asked', async () => {
    const { admin, familyId, childId } = await setupFamily('digest-routing@example.com');
    const siblingRes = await call(
      `/families/${familyId}/members`,
      authed(admin.token, { relationName: 'sibling', requiresCaretaker: true }),
    );
    const { member: sibling } = (await siblingRes.json()) as { member: { id: string } };
    const db = getDb(env.DB);
    const window = {
      from: new Date('2026-08-06T07:00:00Z'),
      to: new Date('2026-08-07T07:00:00Z'),
    };
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId,
          mode: 'standard',
          routed: true,
          url: 'https://f.example.com/shared.ics',
        })
        .returning()
    )[0]!;
    const source = (
      await db
        .insert(sourceEvents)
        .values({
          familyId,
          feedId: feed.id,
          icalUid: 'shared-1',
          summary: 'Swim meet',
          dtstart: new Date('2026-08-06T18:00:00Z'),
          dtend: new Date('2026-08-06T20:00:00Z'),
          allDay: false,
          contentHash: 'h1',
        })
        .returning()
    )[0]!;

    // The same question asked of two members: two rows, one card, one count.
    for (const memberId of [childId, sibling.id]) {
      const link = (
        await db
          .insert(familyMemberFeeds)
          .values({ familyId, feedId: feed.id, familyMemberId: memberId })
          .returning()
      )[0]!;
      await db.insert(pendingDecisions).values({
        familyId,
        feedId: feed.id,
        kind: 'routing',
        linkId: link.id,
        familyMemberId: memberId,
        sourceEventId: source.id,
        sourceContentHash: 'h1',
      });
    }

    const digest = await buildUserDigest(db, admin.userId, window, ['pending_decisions']);
    expect(digest.total).toBe(1);
    expect(digest.buckets[0]!.items[0]!.label).toBe('Swim meet');
  });

  it('counts a conflict only when its loser falls in the window', async () => {
    const { admin, familyId, childId } = await setupFamily('digest-conflict@example.com');
    const db = getDb(env.DB);

    const mkEvent = async (synthKey: string, dtstart: Date, summary: string) =>
      db.insert(calendarEvents).values({
        familyId,
        familyMemberId: childId,
        synthKey,
        provenance: 'synthesized',
        summary,
        dtstart,
        dtend: new Date(dtstart.getTime() + 60 * 60 * 1000),
        allDay: false,
        contentHash: `${synthKey}-h`,
      });
    await mkEvent('bl:x:1', new Date('2026-08-06T18:00:00Z'), 'Soccer');
    await mkEvent('bl:x:2', new Date('2026-08-06T18:30:00Z'), 'Piano');
    await db.insert(conflicts).values({
      familyId,
      familyMemberId: childId,
      loserKey: 'bl:x:1',
      winnerKey: 'bl:x:2',
      status: 'pending',
    });

    const inWindow = await buildUserDigest(
      db,
      admin.userId,
      { from: new Date('2026-08-06T07:00:00Z'), to: new Date('2026-08-07T07:00:00Z') },
      ['conflicts'],
    );
    expect(inWindow.total).toBe(1);
    expect(inWindow.buckets[0]!.items[0]!.label).toBe('Soccer vs Piano');

    const outOfWindow = await buildUserDigest(
      db,
      admin.userId,
      { from: new Date('2026-08-08T07:00:00Z'), to: new Date('2026-08-09T07:00:00Z') },
      ['conflicts'],
    );
    expect(outOfWindow.total).toBe(0);
  });

  it('aggregates across every family the user belongs to, naming each', async () => {
    const first = await setupFamily('digest-multi@example.com', 'Household A');
    const secondRes = await call(
      '/families',
      authed(first.admin.token, { name: 'Household B' }),
    );
    const { family: familyB } = (await secondRes.json()) as { family: { id: string } };
    const childRes = await call(
      `/families/${familyB.id}/members`,
      authed(first.admin.token, { relationName: 'kid b', requiresCaretaker: true }),
    );
    const { member: childB } = (await childRes.json()) as { member: { id: string } };

    const db = getDb(env.DB);
    const window = {
      from: new Date('2026-08-06T07:00:00Z'),
      to: new Date('2026-08-07T07:00:00Z'),
    };
    await insertTask(db, first.familyId, first.childId, {
      dtstart: new Date('2026-08-06T16:00:00Z'),
    });
    await insertTask(db, familyB.id, childB.id, {
      dtstart: new Date('2026-08-06T17:00:00Z'),
    });

    const digest = await buildUserDigest(db, first.admin.userId, window, [
      'unclaimed_tasks',
    ]);
    expect(digest.total).toBe(2);
    expect(digest.familyIds).toHaveLength(2);
    // With more than one family, every line says which one it's about.
    expect(digest.buckets[0]!.items.map((i) => i.label)).toEqual([
      'Household A: child pickup',
      'Household B: kid b pickup',
    ]);
  });

  it('keeps Home ranking regardless of how the schedule listed its categories', async () => {
    const { admin, familyId, adminMemberId, childId } = await setupFamily(
      'digest-order@example.com',
    );
    const db = getDb(env.DB);
    const window = {
      from: new Date('2026-08-06T07:00:00Z'),
      to: new Date('2026-08-07T07:00:00Z'),
    };
    await insertTask(db, familyId, childId, { dtstart: new Date('2026-08-06T16:00:00Z') });
    await insertTask(db, familyId, childId, {
      dtstart: new Date('2026-08-06T17:00:00Z'),
      status: 'owned',
      ownerMemberId: adminMemberId,
    });

    const digest = await buildUserDigest(db, admin.userId, window, [
      'my_tasks',
      'unclaimed_tasks',
    ]);
    expect(digest.buckets.map((b) => b.category)).toEqual([
      'unclaimed_tasks',
      'my_tasks',
    ]);
  });
});

describe('digest copy', () => {
  it('names the day and leads with the most imminent item', () => {
    const now = new Date('2026-08-05T21:00:00Z'); // 14:00 PDT
    const window = digestWindow(now, LA, 1, 1);
    const { title, body } = digestNotificationText(
      {
        window,
        total: 3,
        actionable: 3,
        familyIds: ['f1'],
        buckets: [
          {
            category: 'unclaimed_tasks',
            count: 3,
            items: [{ label: 'child pickup', at: window.from }],
          },
        ],
      },
      now,
      LA,
    );
    expect(title).toBe('Tomorrow: 3 things need you');
    expect(body).toBe('3 unclaimed tasks — starting with child pickup');
  });

  it('says Today for a same-day window and singularises a lone item', () => {
    const now = new Date('2026-08-05T14:00:00Z'); // 07:00 PDT
    const window = digestWindow(now, LA, 0, 1);
    const { title } = digestNotificationText(
      { window, total: 1, actionable: 1, familyIds: ['f1'], buckets: [] },
      now,
      LA,
    );
    expect(title).toBe('Today: 1 thing needs you');
  });
});

// --- Sending ---------------------------------------------------------------

describe('sending a digest', () => {
  async function scheduleFor(
    userId: string,
    extra: Partial<typeof notificationSchedules.$inferInsert> = {},
  ) {
    return (
      await getDb(env.DB)
        .insert(notificationSchedules)
        .values({
          userId,
          sendAt: '20:00',
          timezone: LA,
          categories: ['unclaimed_tasks'],
          ...extra,
        })
        .returning()
    )[0]!;
  }

  it('clears the badge instead of alerting when nothing is outstanding', async () => {
    const { admin } = await setupFamily('send-empty@example.com');
    const db = getDb(env.DB);
    await db.insert(pushDevices).values({
      userId: admin.userId,
      deviceToken: 'f'.repeat(64),
      bundleId: 'com.example.app',
      environment: 'development',
    });
    const schedule = await scheduleFor(admin.userId);
    const pusher = new DevPusher();

    const outcome = await sendDigest(db, pusher, schedule, new Date('2026-08-06T03:00:00Z'));
    expect(outcome.skipped).toBe('empty');
    expect(outcome.delivered).toBe(0);
    // Silent, but not nothing: a badge left over from an earlier evening has
    // to come down, and a badge-only payload carries no alert copy.
    expect(pusher.sent).toHaveLength(1);
    expect(pusher.lastPush).toMatchObject({ badge: 0 });
    expect(pusher.lastPush?.title).toBeUndefined();
    expect(pusher.lastPush?.body).toBeUndefined();
  });

  it("badges only what still needs doing, not the tasks you're already covering", async () => {
    const { admin, familyId, childId, adminMemberId } = await setupFamily(
      'send-covering@example.com',
    );
    const db = getDb(env.DB);
    await db.insert(pushDevices).values({
      userId: admin.userId,
      deviceToken: '6'.repeat(64),
      bundleId: 'com.example.app',
      environment: 'development',
    });
    await insertTask(db, familyId, childId, {
      dtstart: new Date('2026-08-06T16:00:00Z'),
      status: 'owned',
      ownerMemberId: adminMemberId,
    });

    const schedule = await scheduleFor(admin.userId, {
      categories: ['unclaimed_tasks', 'my_tasks'],
    });
    const pusher = new DevPusher();
    const outcome = await sendDigest(db, pusher, schedule, new Date('2026-08-06T03:00:00Z'));

    // The brief still reads "1 task you're covering" — it just doesn't leave a
    // badge behind for work that needs nothing from anyone.
    expect(outcome.digest.total).toBe(1);
    expect(outcome.skipped).toBeUndefined();
    expect(pusher.lastPush?.badge).toBe(0);
    expect(pusher.lastPush?.body).toContain("you're covering");
  });

  it('pushes to every live device, with the badge and deep-link payload', async () => {
    const { admin, familyId, childId } = await setupFamily('send-full@example.com');
    const db = getDb(env.DB);
    for (const token of ['1'.repeat(64), '2'.repeat(64)]) {
      await db.insert(pushDevices).values({
        userId: admin.userId,
        deviceToken: token,
        bundleId: 'com.example.app',
        environment: 'development',
      });
    }
    // A device APNs already rejected must be skipped.
    await db.insert(pushDevices).values({
      userId: admin.userId,
      deviceToken: '3'.repeat(64),
      bundleId: 'com.example.app',
      environment: 'development',
      disabledAt: new Date(),
    });
    await insertTask(db, familyId, childId, { dtstart: new Date('2026-08-06T16:00:00Z') });

    const schedule = await scheduleFor(admin.userId);
    const pusher = new DevPusher();
    const outcome = await sendDigest(db, pusher, schedule, new Date('2026-08-06T03:00:00Z'));

    expect(outcome.delivered).toBe(2);
    expect(pusher.sent).toHaveLength(2);
    const [first] = pusher.sent;
    expect(first!.badge).toBe(1);
    expect(first!.threadId).toBe(schedule.id);
    expect(first!.data).toMatchObject({ type: 'digest', scheduleId: schedule.id });
  });

  it('disables a device APNs says is gone, and retries a transient failure', async () => {
    const { admin, familyId, childId } = await setupFamily('send-errors@example.com');
    const db = getDb(env.DB);
    const deadToken = '4'.repeat(64);
    const flakyToken = '5'.repeat(64);
    for (const deviceToken of [deadToken, flakyToken]) {
      await db.insert(pushDevices).values({
        userId: admin.userId,
        deviceToken,
        bundleId: 'com.example.app',
        environment: 'development',
      });
    }
    await insertTask(db, familyId, childId, { dtstart: new Date('2026-08-06T16:00:00Z') });

    const schedule = await scheduleFor(admin.userId);
    const outcome = await sendDigest(
      db,
      {
        async send(message) {
          if (message.deviceToken === deadToken) {
            return { ok: false, kind: 'device_gone', reason: 'Unregistered' };
          }
          return { ok: false, kind: 'retryable', reason: 'HTTP 503' };
        },
      },
      schedule,
      new Date('2026-08-06T03:00:00Z'),
    );

    expect(outcome.delivered).toBe(0);
    expect(outcome.retry).toBe(true);
    // The reason APNs gave for each device, so the test endpoint can tell
    // "delivered" apart from "reached APNs and was rejected".
    expect(outcome.failures.sort()).toEqual(['HTTP 503', 'Unregistered']);
    const rows = await db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.userId, admin.userId));
    expect(rows.find((r) => r.deviceToken === deadToken)!.disabledAt).not.toBeNull();
    // A transient failure must NOT burn the device.
    expect(rows.find((r) => r.deviceToken === flakyToken)!.disabledAt).toBeNull();
  });

  it('the test endpoint returns the digest even with nothing outstanding', async () => {
    const { admin } = await setupFamily('send-test-route@example.com');
    const created = await call(
      '/notifications/schedules',
      authed(admin.token, schedulePayload()),
    );
    const { schedule } = (await created.json()) as { schedule: { id: string } };

    const res = await call(`/notifications/schedules/${schedule.id}/test`, authed(admin.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      digest: { total: number };
      skipped: string | null;
      failures: string[];
    };
    // `force` bypasses skipWhenEmpty, so an empty digest still reports back —
    // it just has no devices to go to in this test.
    expect(body.digest.total).toBe(0);
    expect(body.skipped).toBe('no_devices');
    expect(body.failures).toEqual([]);
  });
});

// --- Badge -----------------------------------------------------------------

describe('the live badge count', () => {
  it('counts what needs a human across every enabled schedule, and drops to zero once it is claimed', async () => {
    const { admin, familyId, childId, adminMemberId } = await setupFamily(
      'badge-count@example.com',
    );
    const db = getDb(env.DB);
    const now = new Date('2026-08-05T21:00:00Z'); // 14:00 PDT
    await db.insert(notificationSchedules).values({
      userId: admin.userId,
      sendAt: '20:00',
      timezone: LA,
      categories: ['unclaimed_tasks', 'my_tasks'],
    });
    const task = await insertTask(db, familyId, childId, {
      dtstart: new Date('2026-08-06T16:00:00Z'), // inside tomorrow's window
    });

    expect(await currentBadgeCount(db, admin.userId, now)).toBe(1);

    // Claiming it moves the task from "needs an owner" into "you're covering",
    // which is the moment the badge is supposed to go away.
    await db
      .update(tasks)
      .set({ status: 'owned' })
      .where(eq(tasks.id, task.id));
    await db.insert(taskOwners).values({ taskId: task.id, familyMemberId: adminMemberId });

    expect(await currentBadgeCount(db, admin.userId, now)).toBe(0);
  });

  it('is zero with no enabled schedule — nothing is left to raise it again', async () => {
    const { admin, familyId, childId } = await setupFamily('badge-noschedule@example.com');
    const db = getDb(env.DB);
    await insertTask(db, familyId, childId, {
      dtstart: new Date('2026-08-06T16:00:00Z'),
    });
    await db.insert(notificationSchedules).values({
      userId: admin.userId,
      enabled: false,
      sendAt: '20:00',
      timezone: LA,
      categories: ['unclaimed_tasks'],
    });

    expect(
      await currentBadgeCount(db, admin.userId, new Date('2026-08-05T21:00:00Z')),
    ).toBe(0);
  });

  it('serves the count over the API for the signed-in user', async () => {
    const { admin, familyId, childId } = await setupFamily('badge-route@example.com');
    const db = getDb(env.DB);
    await db.insert(notificationSchedules).values({
      userId: admin.userId,
      sendAt: '20:00',
      timezone: LA,
      startOffsetDays: 0,
      horizonDays: 2,
      categories: ['unclaimed_tasks'],
    });
    // The route reads the real clock, so the task is placed relative to it —
    // an hour out is always inside a "today plus tomorrow" window.
    await insertTask(db, familyId, childId, {
      dtstart: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await call('/notifications/badge', bearer(admin.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 1 });
  });

  it('needs a session', async () => {
    const res = await call('/notifications/badge', {});
    expect(res.status).toBe(401);
  });
});

/** A fresh ECDSA P-256 key, PEM-armoured, good enough to sign a real APNs JWT with. */
async function testP8(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  let binary = '';
  for (const byte of new Uint8Array(pkcs8)) binary += String.fromCharCode(byte);
  const b64 = btoa(binary);
  return `-----BEGIN PRIVATE KEY-----\n${b64.replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
}

// --- APNs provider token ---------------------------------------------------

describe('APNs provider token', () => {
  it('signs a verifiable ES256 JWT with the raw r||s signature JWS wants', async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const pkcs8 = (await crypto.subtle.exportKey(
      'pkcs8',
      pair.privateKey,
    )) as ArrayBuffer;
    let binary = '';
    for (const byte of new Uint8Array(pkcs8)) binary += String.fromCharCode(byte);
    const b64 = btoa(binary);
    const pem = `-----BEGIN PRIVATE KEY-----\n${b64.replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;

    const jwt = await signApnsToken(
      { keyP8: pem, keyId: 'ABCDE12345', teamId: 'WG5R9LUU9X' },
      1_770_000_000,
    );
    const [header, payload, signature] = jwt.split('.');
    const decode = (part: string) =>
      JSON.parse(
        atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')),
      );
    expect(decode(header!)).toEqual({ alg: 'ES256', kid: 'ABCDE12345' });
    expect(decode(payload!)).toEqual({ iss: 'WG5R9LUU9X', iat: 1_770_000_000 });

    const sigBytes = Uint8Array.from(
      atob(signature!.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(signature!.length / 4) * 4, '=')),
      (ch) => ch.charCodeAt(0),
    );
    // 64 bytes = r||s. A DER-wrapped signature would be longer and fail here.
    expect(sigBytes.length).toBe(64);
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.publicKey,
        sigBytes,
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  });

  it('accepts a .p8 with or without its PEM armour', () => {
    const body = 'MEECAQAwEwYHKoZIzj0CAQYIKoZIzj0DAQcEJzAlAgEBBCA=';
    const armoured = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    expect(pemToPkcs8(armoured)).toEqual(pemToPkcs8(body));
  });
});

// --- APNs send ---------------------------------------------------------------

describe('ApnsPusher.send', () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  // Smoke test for a real staging outage: `ApnsPusher` used to stash the
  // platform `fetch` on `this.fetchImpl` and call it as `this.fetchImpl(...)`,
  // which invokes it with `this` bound to the ApnsPusher instance rather than
  // the global scope — real workerd throws "Illegal invocation" for that,
  // before the request ever leaves the Worker (see
  // https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors).
  // Every other test in this file supplies its own `fetchImpl`/`Pusher` mock,
  // so this is the only one that constructs `ApnsPusher` with no override —
  // the exact configuration every real deployment runs with.
  //
  // Caveat: `vitest-pool-workers`' `fetch` does NOT reproduce the receiver
  // check real deployed Workers enforce (confirmed by hand: detaching `fetch`
  // onto a plain object and calling it here does not throw), so this test
  // alone would not have caught the original bug and can't regress-guard it.
  // It's still worth having as a smoke test of the default `fetchImpl` path,
  // which nothing previously exercised.
  it('sends through the default fetchImpl end to end', async () => {
    const deviceToken = 'c'.repeat(64);
    fetchMock
      .get('https://api.sandbox.push.apple.com')
      .intercept({ path: `/3/device/${deviceToken}`, method: 'POST' })
      .reply(200, '');

    const pusher = new ApnsPusher({
      keyP8: await testP8(),
      keyId: 'ABCDE12345',
      teamId: 'WG5R9LUU9X',
    });
    const result = await pusher.send({
      deviceToken,
      bundleId: 'com.example.app',
      environment: 'development',
      title: 'Test',
      body: 'Body',
    });

    expect(result).toEqual({ ok: true });
  });
});
