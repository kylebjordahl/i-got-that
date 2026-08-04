import { env } from 'cloudflare:test';
import {
  calendarEvents,
  eq,
  eventMirrors,
  familyMemberFeeds,
  familyMembers,
  feeds,
  getDb,
  memberCalendars,
  tasks,
} from '@igt/db';
import {
  type DeliveryEvent,
  type DeliveryProvider,
  DeliveryProviderRegistry,
  type DeliveryTarget,
} from '@igt/delivery';
import { estimateTravelMinutes } from '@igt/classification';
import type { DeliveryMethod } from '@igt/domain';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/lib/secrets.js';
import {
  type DeliveryJob,
  deliveryQueueConsumer,
  enqueueReconcile,
  purgeMemberMirror,
  syncMemberMirror,
} from '../src/services/mirror.js';
import { hashCalendarEvent } from '../src/services/synthesis.js';
import { authed, bearer, call, setupFamily } from './helpers.js';

class FakeProvider implements DeliveryProvider {
  upserts: { event: DeliveryEvent; target: DeliveryTarget }[] = [];
  cancels: { event: DeliveryEvent; target: DeliveryTarget }[] = [];
  constructor(readonly method: DeliveryMethod) {}
  async upsert(event: DeliveryEvent, target: DeliveryTarget) {
    this.upserts.push({ event, target });
    return { externalRef: `fake-${event.uid}`, sequence: event.sequence };
  }
  async cancel(event: DeliveryEvent, target: DeliveryTarget) {
    this.cancels.push({ event, target });
  }
}

type Db = ReturnType<typeof getDb>;

/** Connect an iCloud account via the API, then designate the member's target. */
async function connectTarget(
  db: Db,
  fam: { admin: { token: string }; familyId: string },
  memberId: string,
) {
  const acctRes = await call(
    '/accounts',
    authed(fam.admin.token, {
      kind: 'icloud',
      name: 'My iCloud',
      username: 'me@icloud.com',
      password: 'abcd-efgh',
    }),
  );
  expect(acctRes.status).toBe(201);
  const account = ((await acctRes.json()) as { account: { id: string } }).account;
  const cal = (
    await db
      .insert(memberCalendars)
      .values({
        familyId: fam.familyId,
        familyMemberId: memberId,
        targetExternalAccountId: account.id,
        targetMethod: 'caldav',
        targetCalendarId: 'https://caldav.icloud.com/123/calendars/kid/',
        alertMinutes: [30, 10],
      })
      .returning()
  )[0]!;
  return { account, cal };
}

async function insertEvent(
  db: Db,
  familyId: string,
  familyMemberId: string,
  values: Partial<typeof calendarEvents.$inferInsert> & { synthKey: string },
) {
  const payload = {
    dtstart: values.dtstart ?? new Date('2026-07-06T15:30:00Z'),
    dtend: values.dtend === undefined ? new Date('2026-07-06T21:45:00Z') : values.dtend,
    allDay: values.allDay ?? false,
    summary: values.summary ?? 'School day',
    location: values.location ?? null,
    locationGeo: values.locationGeo ?? null,
    description: null,
  };
  return (
    await db
      .insert(calendarEvents)
      .values({
        familyId,
        familyMemberId,
        provenance: values.provenance ?? 'synthesized',
        linkId: values.linkId ?? null,
        taskId: values.taskId ?? null,
        contentHash: hashCalendarEvent(payload as never),
        ...payload,
        synthKey: values.synthKey,
      })
      .returning()
  )[0]!;
}

describe('envelope encryption', () => {
  it('round-trips a secret through encrypt/decrypt', async () => {
    const enc = await encryptSecret(env.KEK, 'app-specific-password');
    expect(enc.ciphertext).toBeTruthy();
    expect(enc.wrappedDek).toBeTruthy();
    const back = await decryptSecret(env.KEK, enc);
    expect(back).toBe('app-specific-password');
  });
});

describe('mirror reconcile (syncMemberMirror)', () => {
  it('creates, skips unchanged, updates on change, and cancels vanished events', async () => {
    const fam = await setupFamily('mirror-basic@example.com');
    const db = getDb(env.DB);
    await connectTarget(db, fam, fam.childId);

    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'bl:l1:2026-07-06',
      summary: 'School day',
    });
    // Human events already live on the target — never mirrored back out.
    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ext:abc:',
      provenance: 'human',
      summary: 'Playdate',
    });

    const fake = new FakeProvider('caldav');
    const registry = new DeliveryProviderRegistry().register(fake);

    // 1) First sync mirrors only the synthesized event.
    const r1 = await syncMemberMirror(db, registry, env.KEK, fam.childId);
    expect(r1.created).toBe(1);
    expect(fake.upserts).toHaveLength(1);
    expect(fake.upserts[0]!.event.uid).toBe(`igt-${event.id}`);
    expect(fake.upserts[0]!.event.summary).toBe('School day');
    expect(fake.upserts[0]!.event.alertMinutes).toEqual([30, 10]);
    expect(fake.upserts[0]!.target.addressOrUrl).toBe(
      'https://caldav.icloud.com/123/calendars/kid/',
    );
    const m1 = (
      await db.select().from(eventMirrors).where(eq(eventMirrors.calendarEventId, event.id))
    )[0]!;
    expect(m1.status).toBe('sent');
    expect(m1.sequence).toBe(0);

    // 2) Re-sync with no change is a no-op (payloadHash match).
    const r2 = await syncMemberMirror(db, registry, env.KEK, fam.childId);
    expect(r2.created + r2.updated).toBe(0);
    expect(fake.upserts).toHaveLength(1);

    // 3) Changing the event updates the mirror + bumps sequence.
    await db
      .update(calendarEvents)
      .set({ location: 'New Gym' })
      .where(eq(calendarEvents.id, event.id));
    const r3 = await syncMemberMirror(db, registry, env.KEK, fam.childId);
    expect(r3.updated).toBe(1);
    const m3 = (
      await db.select().from(eventMirrors).where(eq(eventMirrors.calendarEventId, event.id))
    )[0]!;
    expect(m3.status).toBe('updated');
    expect(m3.sequence).toBe(1);

    // 4) Deleting the event (synthesis would do this) → remote cancel, row gone.
    await db.delete(calendarEvents).where(eq(calendarEvents.id, event.id));
    const r4 = await syncMemberMirror(db, registry, env.KEK, fam.childId);
    expect(r4.removed).toBe(1);
    expect(fake.cancels).toHaveLength(1);
    expect(fake.cancels[0]!.event.uid).toBe(`igt-${event.id}`);
    expect(
      await db.select().from(eventMirrors).where(eq(eventMirrors.calendarEventId, event.id)),
    ).toHaveLength(0);
  });

  it("carries a synthesized event's geocode into the delivery payload", async () => {
    const fam = await setupFamily('mirror-geo@example.com');
    const db = getDb(env.DB);
    await connectTarget(db, fam, fam.childId);

    const geo = {
      lat: 37.331686,
      lon: -122.030656,
      title: 'Lincoln Elementary',
      address: '123 Main St, Springfield',
    };
    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'bl:l1:2026-07-06',
      summary: 'School day',
      location: 'Lincoln Elementary',
      locationGeo: geo,
    });

    const fake = new FakeProvider('caldav');
    const registry = new DeliveryProviderRegistry().register(fake);
    const r = await syncMemberMirror(db, registry, env.KEK, fam.childId);
    expect(r.created).toBe(1);
    expect(fake.upserts[0]!.event.location).toBe('Lincoln Elementary');
    expect(fake.upserts[0]!.event.locationGeo).toEqual(geo);
  });

  it('mirrors claimed_task events too, and purge cancels everything', async () => {
    const fam = await setupFamily('mirror-claimed@example.com');
    const db = getDb(env.DB);
    const { cal } = await connectTarget(db, fam, fam.adminMemberId);

    await insertEvent(db, fam.familyId, fam.adminMemberId, {
      synthKey: 'task:t1',
      provenance: 'claimed_task',
      summary: 'Pickup — child',
    });

    const fake = new FakeProvider('caldav');
    const registry = new DeliveryProviderRegistry().register(fake);
    const r = await syncMemberMirror(db, registry, env.KEK, fam.adminMemberId);
    expect(r.created).toBe(1);

    await purgeMemberMirror(db, registry, env.KEK, cal);
    expect(fake.cancels).toHaveLength(1);
    expect(
      await db
        .select()
        .from(eventMirrors)
        .where(eq(eventMirrors.familyMemberId, fam.adminMemberId)),
    ).toHaveLength(0);
  });

  it('mirrors a claimed drop-off/pickup task in the source calendar\'s timezone, not bare UTC', async () => {
    const fam = await setupFamily('mirror-claimed-tz@example.com');
    const db = getDb(env.DB);
    // The claimer (admin) is the mirror target; the task is about the child,
    // sourced from a feed whose calendar is in America/Denver.
    await connectTarget(db, fam, fam.adminMemberId);

    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          kind: 'ics',
          url: 'https://example.com/cal.ics',
          mode: 'exception',
          timezone: 'America/Denver',
        })
        .returning()
    )[0]!;
    const link = (
      await db
        .insert(familyMemberFeeds)
        .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId: fam.childId })
        .returning()
    )[0]!;
    const source = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: `bl:${link.id}:2026-07-06`,
      linkId: link.id,
      summary: 'School day',
    });
    const task = (
      await db
        .insert(tasks)
        .values({
          familyId: fam.familyId,
          calendarEventId: source.id,
          familyMemberId: fam.childId,
          type: 'dropoff',
          dtstart: new Date('2026-07-06T15:30:00Z'),
          dtend: new Date('2026-07-06T15:45:00Z'),
          status: 'owned',
          ownerMemberId: fam.adminMemberId,
          createdVia: 'generated',
        })
        .returning()
    )[0]!;
    await insertEvent(db, fam.familyId, fam.adminMemberId, {
      synthKey: `task:${task.id}`,
      provenance: 'claimed_task',
      summary: 'Drop-off — child',
      taskId: task.id,
    });

    const fake = new FakeProvider('caldav');
    const registry = new DeliveryProviderRegistry().register(fake);
    const r = await syncMemberMirror(db, registry, env.KEK, fam.adminMemberId);
    expect(r.created).toBe(1);
    expect(fake.upserts[0]!.event.timezone).toBe('America/Denver');
  });

  it('measures a claim\'s travel block from wherever the caretaker is coming from', async () => {
    const fam = await setupFamily('mirror-travel-origin@example.com');
    const db = getDb(env.DB);
    await connectTarget(db, fam, fam.adminMemberId);

    // Home is ~50 km out; the school is in the city, a short hop from the
    // caretaker's own morning meeting. The two origins therefore produce
    // obviously different blocks, which is what these assertions turn on.
    const home = { lat: 37.4419, lon: -122.143, title: 'Home' };
    const school = { lat: 37.7955, lon: -122.3937, title: 'Lincoln Elementary' };
    const meeting = { lat: 37.7896, lon: -122.4, title: 'Office' };
    await db
      .update(familyMembers)
      .set({ homeLocation: 'Home', homeLocationGeo: home })
      .where(eq(familyMembers.id, fam.adminMemberId));

    const dropoff = async (dtstart: Date) => {
      const task = (
        await db
          .insert(tasks)
          .values({
            familyId: fam.familyId,
            familyMemberId: fam.childId,
            type: 'dropoff',
            dtstart,
            dtend: new Date(dtstart.getTime() + 15 * 60_000),
            status: 'owned',
            ownerMemberId: fam.adminMemberId,
            createdVia: 'generated',
          })
          .returning()
      )[0]!;
      return insertEvent(db, fam.familyId, fam.adminMemberId, {
        synthKey: `task:${task.id}`,
        provenance: 'claimed_task',
        summary: 'Drop-off — child',
        taskId: task.id,
        dtstart,
        dtend: new Date(dtstart.getTime() + 15 * 60_000),
        location: 'Lincoln Elementary',
        locationGeo: school,
      });
    };

    // Monday: nothing precedes the 08:30 run, so it starts from home.
    const fromHome = await dropoff(new Date('2026-07-06T15:30:00Z'));

    // Tuesday: a meeting of the caretaker's own ends 20 minutes before the run
    // — they're leaving from there, not from home. It's a human read-back
    // event, the kind that only exists because we can see the target calendar.
    await insertEvent(db, fam.familyId, fam.adminMemberId, {
      synthKey: 'ext:standup:',
      provenance: 'human',
      summary: 'Standup',
      dtstart: new Date('2026-07-07T14:30:00Z'),
      dtend: new Date('2026-07-07T15:10:00Z'),
      location: 'Office',
      locationGeo: meeting,
    });
    const fromMeeting = await dropoff(new Date('2026-07-07T15:30:00Z'));

    // Wednesday: the preceding thing is 3 hours earlier — long enough that
    // they've plainly been elsewhere since, so home is the better guess.
    await insertEvent(db, fam.familyId, fam.adminMemberId, {
      synthKey: 'ext:early-call:',
      provenance: 'human',
      summary: 'Early call',
      dtstart: new Date('2026-07-08T11:30:00Z'),
      dtend: new Date('2026-07-08T12:30:00Z'),
      location: 'Office',
      locationGeo: meeting,
    });
    const afterLongGap = await dropoff(new Date('2026-07-08T15:30:00Z'));

    const fake = new FakeProvider('caldav');
    const registry = new DeliveryProviderRegistry().register(fake);
    await syncMemberMirror(db, registry, env.KEK, fam.adminMemberId);
    const travelFor = (eventId: string) =>
      fake.upserts.find((u) => u.event.uid === `igt-${eventId}`)?.event.travelTimeMinutes;

    expect(travelFor(fromHome.id)).toBe(estimateTravelMinutes(home, school));
    expect(travelFor(fromMeeting.id)).toBe(estimateTravelMinutes(meeting, school));
    expect(travelFor(afterLongGap.id)).toBe(estimateTravelMinutes(home, school));
    // Sanity: the long haul from home really is the bigger block, so the three
    // assertions above aren't all quietly agreeing on the same number.
    expect(travelFor(fromHome.id)!).toBeGreaterThan(travelFor(fromMeeting.id)!);
  });

  it("falls back to the claim's own window when there's nowhere to measure from", async () => {
    const fam = await setupFamily('mirror-travel@example.com');
    const db = getDb(env.DB);
    await connectTarget(db, fam, fam.adminMemberId);
    const geo = { lat: 37.331686, lon: -122.030656, title: 'Lincoln Elementary' };

    const claim = async (
      type: 'dropoff' | 'attendance',
      values: {
        dtstart: Date;
        dtend: Date | null;
        locationGeo?: typeof geo | null;
      },
    ) => {
      const task = (
        await db
          .insert(tasks)
          .values({
            familyId: fam.familyId,
            familyMemberId: fam.childId,
            type,
            dtstart: values.dtstart,
            dtend: values.dtend,
            status: 'owned',
            ownerMemberId: fam.adminMemberId,
            createdVia: 'generated',
          })
          .returning()
      )[0]!;
      return insertEvent(db, fam.familyId, fam.adminMemberId, {
        synthKey: `task:${task.id}`,
        provenance: 'claimed_task',
        summary: `${type} — child`,
        taskId: task.id,
        location: 'Lincoln Elementary',
        locationGeo: values.locationGeo === undefined ? geo : values.locationGeo,
        ...values,
      });
    };

    // A 20-minute drop-off window ⇒ a 20-minute travel block.
    const windowed = await claim('dropoff', {
      dtstart: new Date('2026-07-06T15:30:00Z'),
      dtend: new Date('2026-07-06T15:50:00Z'),
    });
    // A point-in-time transition has no window to borrow → the 15-min default.
    const instant = await claim('dropoff', {
      dtstart: new Date('2026-07-07T15:30:00Z'),
      dtend: null,
    });
    // Free text gives Apple nothing to route to.
    const textOnly = await claim('dropoff', {
      dtstart: new Date('2026-07-08T15:30:00Z'),
      dtend: new Date('2026-07-08T15:50:00Z'),
      locationGeo: null,
    });
    // An attendance claim spans its event; it isn't a trip to a fixed moment.
    const attendance = await claim('attendance', {
      dtstart: new Date('2026-07-09T15:30:00Z'),
      dtend: new Date('2026-07-09T21:45:00Z'),
    });

    const fake = new FakeProvider('caldav');
    const registry = new DeliveryProviderRegistry().register(fake);
    await syncMemberMirror(db, registry, env.KEK, fam.adminMemberId);

    const travelFor = (eventId: string) =>
      fake.upserts.find((u) => u.event.uid === `igt-${eventId}`)?.event.travelTimeMinutes;
    expect(travelFor(windowed.id)).toBe(20);
    expect(travelFor(instant.id)).toBe(15);
    expect(travelFor(textOnly.id)).toBeUndefined();
    expect(travelFor(attendance.id)).toBeUndefined();
  });

  it('a member without a target is a clean no-op', async () => {
    const fam = await setupFamily('mirror-notarget@example.com');
    const db = getDb(env.DB);
    await insertEvent(db, fam.familyId, fam.childId, { synthKey: 'bl:l1:2026-07-06' });
    const registry = new DeliveryProviderRegistry().register(new FakeProvider('caldav'));
    const r = await syncMemberMirror(db, registry, env.KEK, fam.childId);
    expect(r).toMatchObject({ targets: 0, created: 0, errors: [] });
  });
});

describe('delivery queue', () => {
  it('enqueues a reconcile job when a queue is bound', async () => {
    const sent: DeliveryJob[] = [];
    const ctx = {
      env: { ...env, DELIVERY_QUEUE: { send: async (j: DeliveryJob) => void sent.push(j) } },
      executionCtx: { waitUntil: (_: Promise<unknown>) => {} },
    };
    enqueueReconcile(ctx as never, { kind: 'member', memberId: 'm-1' });
    expect(sent).toEqual([{ kind: 'member', memberId: 'm-1' }]);
  });

  it('falls back to an inline reconcile when no queue is bound', async () => {
    const awaited: Promise<unknown>[] = [];
    const ctx = {
      env, // no DELIVERY_QUEUE
      executionCtx: { waitUntil: (p: Promise<unknown>) => void awaited.push(p) },
    };
    enqueueReconcile(ctx as never, { kind: 'family', familyId: 'does-not-exist' });
    expect(awaited).toHaveLength(1);
    await expect(awaited[0]).resolves.toMatchObject({ targets: 0, errors: [] });
  });

  it('consumer processes a job and acks it (no errors)', async () => {
    const fam = await setupFamily('mirror-queue@example.com');
    let acked = 0;
    let retried = 0;
    const message = {
      body: { kind: 'family', familyId: fam.familyId } as DeliveryJob,
      ack: () => void acked++,
      retry: () => void retried++,
    };
    await deliveryQueueConsumer({ messages: [message] } as never, env);
    // No configured targets ⇒ reconcile is a clean no-op ⇒ ack, no retry.
    expect(acked).toBe(1);
    expect(retried).toBe(0);
  });
});

describe('member calendar-target routes', () => {
  it('sets, reads, replaces, and removes a member’s target', async () => {
    const fam = await setupFamily('target-routes@example.com');
    const acctRes = await call(
      '/accounts',
      authed(fam.admin.token, {
        kind: 'icloud',
        name: 'iCloud',
        username: 'me@icloud.com',
        password: 'pw',
      }),
    );
    const account = ((await acctRes.json()) as { account: { id: string } }).account;
    const base = `/families/${fam.familyId}/members/${fam.childId}/calendar-target`;

    // Initially none.
    const empty = await call(base, bearer(fam.admin.token));
    expect(((await empty.json()) as { target: unknown }).target).toBeNull();

    // Set.
    const put = await call(base, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        externalAccountId: account.id,
        targetCalendarId: 'https://caldav.icloud.com/1/calendars/kid/',
        targetCalendarName: 'Kid',
        alertMinutes: [15],
      }),
    });
    expect(put.status).toBe(201);
    const target = ((await put.json()) as {
      target: { targetMethod: string; targetCalendarName: string };
    }).target;
    expect(target.targetMethod).toBe('caldav');
    expect(target.targetCalendarName).toBe('Kid');

    // Replace (same member, new calendar) → 200, single row.
    const put2 = await call(base, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        externalAccountId: account.id,
        targetCalendarId: 'https://caldav.icloud.com/1/calendars/kid2/',
      }),
    });
    expect(put2.status).toBe(200);
    const db = getDb(env.DB);
    expect(
      await db
        .select()
        .from(memberCalendars)
        .where(eq(memberCalendars.familyMemberId, fam.childId)),
    ).toHaveLength(1);

    // Remove.
    const del = await call(base, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${fam.admin.token}` },
    });
    expect(del.status).toBe(200);
    expect(
      await db
        .select()
        .from(memberCalendars)
        .where(eq(memberCalendars.familyMemberId, fam.childId)),
    ).toHaveLength(0);
  });

  it('rejects another user’s account and protects a linked member from admins', async () => {
    const fam = await setupFamily('target-authz@example.com');
    const base = `/families/${fam.familyId}/members/${fam.childId}/calendar-target`;

    // Someone else's account → 404 (not the caller's).
    const stranger = await setupFamily('target-stranger@example.com');
    const acctRes = await call(
      '/accounts',
      authed(stranger.admin.token, { kind: 'icloud', name: 'X', username: 'x', password: 'y' }),
    );
    const strangerAccount = ((await acctRes.json()) as { account: { id: string } }).account;
    const put = await call(base, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        externalAccountId: strangerAccount.id,
        targetCalendarId: 'https://caldav.example.com/cal/',
      }),
    });
    expect(put.status).toBe(404);

    // A member linked to a different user: even an admin may not manage their
    // target (user-level privacy).
    const partnerLogin = await call('/auth/magic-link/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'target-partner@example.com' }),
    });
    const { devToken } = (await partnerLogin.json()) as { devToken: string };
    const verify = await call('/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: devToken }),
    });
    const partnerUserId = ((await verify.json()) as { user: { id: string } }).user.id;
    const partnerRes = await call(
      `/families/${fam.familyId}/members`,
      authed(fam.admin.token, {
        relationName: 'partner',
        isCaretaker: true,
        userId: partnerUserId,
      }),
    );
    const partnerId = ((await partnerRes.json()) as { member: { id: string } }).member.id;

    const acct2 = await call(
      '/accounts',
      authed(fam.admin.token, { kind: 'icloud', name: 'Mine', username: 'a', password: 'b' }),
    );
    const myAccount = ((await acct2.json()) as { account: { id: string } }).account;
    const forbidden = await call(
      `/families/${fam.familyId}/members/${partnerId}/calendar-target`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${fam.admin.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          externalAccountId: myAccount.id,
          targetCalendarId: 'https://caldav.example.com/cal/',
        }),
      },
    );
    expect(forbidden.status).toBe(403);
  });
});
