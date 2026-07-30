import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  conflicts,
  eq,
  familyMemberFeeds,
  familyMembers,
  feeds,
  getDb,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { reconcileMemberConflicts } from '../src/services/conflicts.js';
import { hashCalendarEvent } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { authed, bearer, call, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

const START = new Date('2026-08-06T15:30:00Z');
const END = new Date('2026-08-06T17:00:00Z');

/** A feed + active link for the child, typed attendance-by-default. */
async function linkedFeed(
  db: Db,
  familyId: string,
  childId: string,
  mode: 'standard' | 'busy' = 'standard',
) {
  const feed = (
    await db
      .insert(feeds)
      .values({ familyId, mode, url: `https://f.example.com/${mode}.ics` })
      .returning()
  )[0]!;
  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({
        familyId,
        feedId: feed.id,
        familyMemberId: childId,
        defaultTaskType: 'attendance',
      })
      .returning()
  )[0]!;
  return { feed, link };
}

async function insertEvent(
  db: Db,
  familyId: string,
  familyMemberId: string,
  values: Partial<typeof calendarEvents.$inferInsert> & { synthKey: string },
) {
  const payload = {
    dtstart: values.dtstart ?? START,
    dtend: values.dtend === undefined ? END : values.dtend,
    allDay: false,
    summary: values.summary ?? 'Orthodontist',
    location: null,
    locationGeo: null,
    description: null,
  };
  return (
    await db
      .insert(calendarEvents)
      .values({
        familyId,
        familyMemberId,
        provenance: values.provenance ?? 'synthesized',
        contentHash: hashCalendarEvent(payload),
        ...payload,
        synthKey: values.synthKey,
        linkId: values.linkId ?? null,
        maskedAt: values.maskedAt ?? null,
      })
      .returning()
  )[0]!;
}

function eventTasks(db: Db, eventId: string) {
  return db.select().from(tasks).where(eq(tasks.calendarEventId, eventId));
}

describe("rebuilding an event's tasks", () => {
  it('restores a dismissed task that task-gen would never resurrect on its own', async () => {
    const fam = await setupFamily('event-tasks-restore@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: `ev:${link.id}:ortho`,
      linkId: link.id,
    });

    await buildMemberTasks(db, fam.childId);
    const built = await eventTasks(db, event.id);
    expect(built.map((t) => t.type)).toEqual(['attendance']);

    // Somebody marks it not needed. Dismissal is sticky: task-gen heals the row
    // but never brings it back, so the event is stuck showing nothing to claim.
    const dismiss = await call(
      `/families/${fam.familyId}/tasks/${built[0]!.id}/dismiss`,
      authed(fam.admin.token),
    );
    expect(dismiss.status).toBe(200);
    await buildMemberTasks(db, fam.childId);
    expect((await eventTasks(db, event.id)).map((t) => t.status)).toEqual([
      'dismissed',
    ]);

    const res = await call(
      `/families/${fam.familyId}/calendar-events/${event.id}/tasks`,
      authed(fam.admin.token),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ restored: 1 });

    // The same row is claimable again — restored, not duplicated.
    const after = await eventTasks(db, event.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: built[0]!.id, status: 'unowned' });
  });

  it('un-freezes an event a convert left holding only a dismissed manual task', async () => {
    const fam = await setupFamily('event-tasks-convert@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: `ev:${link.id}:ortho`,
      linkId: link.id,
    });
    await buildMemberTasks(db, fam.childId);
    const attendance = (await eventTasks(db, event.id))[0]!;

    // Convert to attendance-only marks the row `manual`, which freezes the type
    // set: after a dismissal, task-gen's manual branch only ever heals anchors.
    await call(
      `/families/${fam.familyId}/tasks/${attendance.id}/convert`,
      authed(fam.admin.token, { types: ['attendance'] }),
    );
    await call(
      `/families/${fam.familyId}/tasks/${attendance.id}/dismiss`,
      authed(fam.admin.token),
    );
    await buildMemberTasks(db, fam.childId);
    expect((await eventTasks(db, event.id)).map((t) => t.status)).toEqual([
      'dismissed',
    ]);

    const res = await call(
      `/families/${fam.familyId}/calendar-events/${event.id}/tasks`,
      authed(fam.admin.token),
    );
    expect(res.status).toBe(200);
    const after = await eventTasks(db, event.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: 'unowned', createdVia: 'manual' });

    // ...and it survives the next task-gen pass rather than being re-dismissed.
    await buildMemberTasks(db, fam.childId);
    expect((await eventTasks(db, event.id))[0]).toMatchObject({
      status: 'unowned',
    });
  });

  it('builds the tasks for an eligible event that has none at all', async () => {
    const fam = await setupFamily('event-tasks-none@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    // Built once, then the rows are gone (a link teardown, an old bug) while the
    // event's build stamp says it's already been considered.
    const event = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: `ev:${link.id}:ortho`,
      linkId: link.id,
    });
    await buildMemberTasks(db, fam.childId);
    await db.delete(tasks).where(eq(tasks.calendarEventId, event.id));
    await buildMemberTasks(db, fam.childId);
    expect(await eventTasks(db, event.id)).toHaveLength(0); // stamped, so skipped

    const res = await call(
      `/families/${fam.familyId}/calendar-events/${event.id}/tasks`,
      authed(fam.admin.token),
    );
    expect(res.status).toBe(200);
    // The link's own default did the typing (attendance), not a hard-coded type.
    expect((await eventTasks(db, event.id)).map((t) => t.type)).toEqual([
      'attendance',
    ]);
  });

  it('refuses the three cases where having no tasks is the rule', async () => {
    const fam = await setupFamily('event-tasks-refuse@example.com');
    const db = getDb(env.DB);

    // A free/busy firewall block: opaque availability, never family logistics.
    const { link: busyLink } = await linkedFeed(db, fam.familyId, fam.childId, 'busy');
    const busy = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: `fb:${busyLink.id}:x`,
      linkId: busyLink.id,
      summary: 'Busy',
    });
    const busyRes = await call(
      `/families/${fam.familyId}/calendar-events/${busy.id}/tasks`,
      authed(fam.admin.token),
    );
    expect(busyRes.status).toBe(409);
    expect(await busyRes.json()).toMatchObject({ reason: 'busy_calendar' });

    // A claimed task is somebody's claim already — generating from it would echo.
    const claimed = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'task:t1',
      provenance: 'claimed_task',
    });
    const claimedRes = await call(
      `/families/${fam.familyId}/calendar-events/${claimed.id}/tasks`,
      authed(fam.admin.token),
    );
    expect(claimedRes.status).toBe(409);
    expect(await claimedRes.json()).toMatchObject({ reason: 'claimed' });

    // Generation paused for the member: a fresh unowned task would just be
    // swept on the next pass, so the rebuild is refused rather than faked.
    await db
      .update(familyMembers)
      .set({ generatesFamilyTasks: false })
      .where(eq(familyMembers.id, fam.childId));
    const paused = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ext:paused:',
      provenance: 'human',
    });
    const pausedRes = await call(
      `/families/${fam.familyId}/calendar-events/${paused.id}/tasks`,
      authed(fam.admin.token),
    );
    expect(pausedRes.status).toBe(409);
    expect(await pausedRes.json()).toMatchObject({ reason: 'paused' });
  });

  it('refuses a conflict-masked event, whose split segments carry the tasks', async () => {
    const fam = await setupFamily('event-tasks-masked@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    const masked = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: `bl:${link.id}:2026-08-06`,
      linkId: link.id,
      maskedAt: new Date(),
    });
    const res = await call(
      `/families/${fam.familyId}/calendar-events/${masked.id}/tasks`,
      authed(fam.admin.token),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'event_masked' });
  });

  it('is scoped to the caller’s family', async () => {
    const mine = await setupFamily('event-tasks-mine@example.com');
    const theirs = await setupFamily('event-tasks-theirs@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, theirs.familyId, theirs.childId);
    const event = await insertEvent(db, theirs.familyId, theirs.childId, {
      synthKey: `ev:${link.id}:ortho`,
      linkId: link.id,
    });
    const res = await call(
      `/families/${mine.familyId}/calendar-events/${event.id}/tasks`,
      authed(mine.admin.token),
    );
    expect(res.status).toBe(404);
  });
});

describe('calendar-events task eligibility', () => {
  it('names why an event can carry no tasks, and stays null when it can', async () => {
    const fam = await setupFamily('event-eligibility@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);
    const { link: busyLink } = await linkedFeed(db, fam.familyId, fam.childId, 'busy');

    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: `ev:${link.id}:ortho`,
      linkId: link.id,
      summary: 'Eligible',
    });
    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: `fb:${busyLink.id}:x`,
      linkId: busyLink.id,
      summary: 'Busy block',
    });
    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'task:t1',
      provenance: 'claimed_task',
      summary: 'A claim',
    });
    // The admin themselves is a caretaker, so their calendar is the paused one.
    await insertEvent(db, fam.familyId, fam.adminMemberId, {
      synthKey: 'ext:dentist:',
      provenance: 'human',
      summary: 'Paused',
    });

    const res = await call(
      `/families/${fam.familyId}/calendar-events`,
      bearer(fam.admin.token),
    );
    expect(res.status).toBe(200);
    const { events } = (await res.json()) as {
      events: { summary: string; taskIneligibleReason: string | null }[];
    };
    const bySummary = new Map(
      events.map((e) => [e.summary, e.taskIneligibleReason]),
    );
    expect(bySummary.get('Eligible')).toBeNull();
    expect(bySummary.get('Busy block')).toBe('busy_calendar');
    expect(bySummary.get('A claim')).toBe('claimed');
    expect(bySummary.get('Paused')).toBe('paused');
  });

  it('leaves the caretaker case eligible once generation is turned on', async () => {
    const fam = await setupFamily('event-eligibility-on@example.com');
    const db = getDb(env.DB);
    await db
      .update(familyMembers)
      .set({ generatesFamilyTasks: true })
      .where(
        and(
          eq(familyMembers.id, fam.adminMemberId),
          eq(familyMembers.familyId, fam.familyId),
        ),
      );
    await insertEvent(db, fam.familyId, fam.adminMemberId, {
      synthKey: 'ext:dentist:',
      provenance: 'human',
      summary: 'Dentist',
    });

    const res = await call(
      `/families/${fam.familyId}/calendar-events`,
      bearer(fam.admin.token),
    );
    const { events } = (await res.json()) as {
      events: { summary: string; taskIneligibleReason: string | null }[];
    };
    expect(events.find((e) => e.summary === 'Dentist')!.taskIneligibleReason)
      .toBeNull();
  });
});

describe('un-masking an event after a conflict', () => {
  it('rebuilds the tasks the mask swept, instead of leaving it permanently bare', async () => {
    const fam = await setupFamily('event-unmask@example.com');
    const db = getDb(env.DB);
    const { link } = await linkedFeed(db, fam.familyId, fam.childId);

    // A baseline school day, and a manual appointment that outranks it.
    const baseline = await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: `bl:${link.id}:2026-08-06`,
      linkId: link.id,
      summary: 'School day',
    });
    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: 'ext:ortho:',
      provenance: 'human',
      dtstart: new Date('2026-08-06T16:00:00Z'),
      dtend: new Date('2026-08-06T16:30:00Z'),
      summary: 'Orthodontist',
    });
    await reconcileMemberConflicts(db, fam.childId);
    await buildMemberTasks(db, fam.childId);
    expect(await eventTasks(db, baseline.id)).toHaveLength(1);

    const conflict = (
      await db.select().from(conflicts).where(eq(conflicts.familyMemberId, fam.childId))
    )[0]!;

    // Resolving masks the baseline — its cf: split segments carry the tasks now,
    // so task-gen sweeps the baseline's own.
    const resolve = await call(
      `/families/${fam.familyId}/conflicts/${conflict.id}/resolve`,
      authed(fam.admin.token),
    );
    expect(resolve.status).toBe(200);
    expect(await eventTasks(db, baseline.id)).toHaveLength(0);

    // Reverting un-masks it. Its content never changed, so before the fix the
    // build stamp still matched and task-gen skipped it forever — the day came
    // back to the calendar with nothing to claim on it, permanently.
    const revert = await call(
      `/families/${fam.familyId}/conflicts/${conflict.id}/revert`,
      authed(fam.admin.token),
    );
    expect(revert.status).toBe(200);
    expect((await eventTasks(db, baseline.id)).map((t) => t.status)).toEqual([
      'unowned',
    ]);
  });
});
