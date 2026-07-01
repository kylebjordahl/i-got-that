import { env } from 'cloudflare:test';
import {
  and,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  sourceEvents,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { buildFeedTasks } from '../src/services/tasks.js';
import { authed, bearer, call, createFamily, login, patched } from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function nextMonday(from: Date): Date {
  const d = startOfUtcDay(from);
  while ((d.getUTCDay() + 6) % 7 !== 0) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

async function feedRow(feedId: string) {
  const db = getDb(env.DB);
  return (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0]!;
}

async function seedEvent(opts: {
  feedId: string;
  familyId: string;
  uid: string;
  start: Date;
  end?: Date;
  allDay?: boolean;
  summary: string;
}) {
  await getDb(env.DB)
    .insert(sourceEvents)
    .values({
      feedId: opts.feedId,
      familyId: opts.familyId,
      icalUid: opts.uid,
      recurrenceId: '',
      dtstart: opts.start,
      dtend: opts.end ?? null,
      allDay: opts.allDay ?? false,
      summary: opts.summary,
      location: null,
      raw: null,
      contentHash: `h-${opts.uid}`,
    });
}

describe('exception/inverted task generation', () => {
  it('cancels a no-school day but keeps picture day', async () => {
    const admin = await login('sched-admin@example.com');
    const familyId = await createFamily(admin.token, 'School Fam');

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(admin.token, { url: 'https://x/cal.ics', mode: 'exception' }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };

    const childRes = await call(
      `/families/${familyId}/members`,
      authed(admin.token, { relationName: 'child', requiresCaretaker: true }),
    );
    const { member } = (await childRes.json()) as { member: { id: string } };

    await call(
      `/families/${familyId}/feeds/${feed.id}/member-links`,
      authed(admin.token, {
        familyMemberId: member.id,
        weekdayMask: 31, // Mon–Fri
        dayStart: '08:00',
        dayEnd: '15:00',
        generatesTypes: ['dropoff', 'pickup'],
        defaultAttendance: 'any',
      }),
    );

    // A feed-scoped rule: "Closed" cancels the day.
    await call(
      `/families/${familyId}/classification-rules`,
      authed(admin.token, {
        feedId: feed.id,
        priority: 10,
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'Closed',
        effect: 'cancel',
      }),
    );

    // Deterministic one-week window (Mon–Sun).
    const ws = nextMonday(new Date(Date.UTC(2026, 0, 1)));
    const we = new Date(ws.getTime() + 7 * DAY_MS);
    const wed = new Date(ws.getTime() + 2 * DAY_MS);
    const thu = new Date(ws.getTime() + 3 * DAY_MS);

    await seedEvent({
      feedId: feed.id,
      familyId,
      uid: 'closed-wed',
      start: new Date(wed.getTime() + 10 * 60 * 60 * 1000),
      summary: 'MCH Closed - Holiday',
    });
    await seedEvent({
      feedId: feed.id,
      familyId,
      uid: 'photos-thu',
      start: new Date(thu.getTime() + 9 * 60 * 60 * 1000),
      summary: 'School Photos',
    });

    const db = getDb(env.DB);
    const result = await buildFeedTasks(db, await feedRow(feed.id), {
      windowStart: ws,
      windowEnd: we,
    });
    // Mon,Tue,Thu,Fri × 2 types = 8 (Wed cancelled).
    expect(result.tasksCreated).toBe(8);

    const list = await call(`/families/${familyId}/tasks`, bearer(admin.token));
    const { tasks } = (await list.json()) as {
      tasks: { dtstart: number; type: string }[];
    };
    expect(tasks).toHaveLength(8);

    // No tasks on the cancelled Wednesday.
    const wedTasks = tasks.filter(
      (t) => startOfUtcDay(new Date(t.dtstart)).getTime() === wed.getTime(),
    );
    expect(wedTasks).toHaveLength(0);

    // Picture-day Thursday is a normal school day (2 tasks).
    const thuTasks = tasks.filter(
      (t) => startOfUtcDay(new Date(t.dtstart)).getTime() === thu.getTime(),
    );
    expect(thuTasks).toHaveLength(2);

    // Idempotent: re-build adds nothing.
    const again = await buildFeedTasks(db, await feedRow(feed.id), {
      windowStart: ws,
      windowEnd: we,
    });
    expect(again.tasksCreated).toBe(0);
  });

  it('cancels every day of a multi-day all-day closure, not just the first', async () => {
    const admin = await login('span-admin@example.com');
    const familyId = await createFamily(admin.token, 'Break Fam');

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(admin.token, { url: 'https://x/break.ics', mode: 'exception' }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };

    const childRes = await call(
      `/families/${familyId}/members`,
      authed(admin.token, { relationName: 'child', requiresCaretaker: true }),
    );
    const { member } = (await childRes.json()) as { member: { id: string } };

    await call(
      `/families/${familyId}/feeds/${feed.id}/member-links`,
      authed(admin.token, {
        familyMemberId: member.id,
        weekdayMask: 31, // Mon–Fri
        dayStart: '08:00',
        dayEnd: '15:00',
        generatesTypes: ['dropoff', 'pickup'],
        defaultAttendance: 'any',
      }),
    );
    await call(
      `/families/${familyId}/classification-rules`,
      authed(admin.token, {
        feedId: feed.id,
        priority: 10,
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'Closed',
        effect: 'cancel',
      }),
    );

    const ws = nextMonday(new Date(Date.UTC(2026, 0, 1)));
    const we = new Date(ws.getTime() + 7 * DAY_MS);

    // All-day span covering Wed–Fri: DTSTART=Wed 00:00Z, DTEND=Sat 00:00Z
    // (exclusive). All three weekdays should be cancelled.
    await seedEvent({
      feedId: feed.id,
      familyId,
      uid: 'winter-break',
      start: new Date(ws.getTime() + 2 * DAY_MS),
      end: new Date(ws.getTime() + 5 * DAY_MS),
      allDay: true,
      summary: 'MCH Closed - Winter Break',
    });

    const db = getDb(env.DB);
    const result = await buildFeedTasks(db, await feedRow(feed.id), {
      windowStart: ws,
      windowEnd: we,
    });
    // Only Mon,Tue survive × 2 types = 4 (Wed,Thu,Fri all cancelled).
    expect(result.tasksCreated).toBe(4);

    const list = await call(`/families/${familyId}/tasks`, bearer(admin.token));
    const { tasks } = (await list.json()) as { tasks: { dtstart: number }[] };
    expect(tasks).toHaveLength(4);
    const cancelledDays = [2, 3, 4].map((n) => ws.getTime() + n * DAY_MS);
    for (const t of tasks) {
      expect(cancelledDays).not.toContain(startOfUtcDay(new Date(t.dtstart)).getTime());
    }
  });
});

describe('explicit task generation + assignment', () => {
  it('creates a task, claims it, and releases it (idempotent, owner preserved)', async () => {
    const admin = await login('explicit-admin@example.com');
    const familyId = await createFamily(admin.token, 'Activity Fam');

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(admin.token, { url: 'https://x/soccer.ics', mode: 'explicit' }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };

    const childRes = await call(
      `/families/${familyId}/members`,
      authed(admin.token, { relationName: 'child', requiresCaretaker: true }),
    );
    const { member } = (await childRes.json()) as { member: { id: string } };

    await call(
      `/families/${familyId}/feeds/${feed.id}/member-links`,
      authed(admin.token, { familyMemberId: member.id }),
    );

    await call(
      `/families/${familyId}/classification-rules`,
      authed(admin.token, {
        priority: 100,
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'Soccer',
        effect: 'create',
        producesTypes: ['pickup'],
        defaultAttendance: 'any',
      }),
    );

    await seedEvent({
      feedId: feed.id,
      familyId,
      uid: 'soccer-1',
      start: new Date(Date.UTC(2026, 2, 10, 17)),
      summary: 'Soccer practice',
    });

    const db = getDb(env.DB);
    const built = await buildFeedTasks(db, await feedRow(feed.id));
    expect(built.tasksCreated).toBe(1);

    const unowned = await call(
      `/families/${familyId}/tasks?status=unowned`,
      bearer(admin.token),
    );
    const { tasks } = (await unowned.json()) as { tasks: { id: string }[] };
    expect(tasks).toHaveLength(1);
    const taskId = tasks[0]!.id;

    // Claim it (defaults to the calling admin caretaker).
    const claim = await call(
      `/families/${familyId}/tasks/${taskId}/assign`,
      authed(admin.token),
    );
    expect(claim.status).toBe(200);
    const claimed = (await claim.json()) as { task: { status: string; ownerMemberId: string } };
    expect(claimed.task.status).toBe('owned');

    // Rebuild is a no-op and preserves ownership (event already built).
    const rebuilt = await buildFeedTasks(db, await feedRow(feed.id));
    expect(rebuilt.tasksCreated).toBe(0);
    const stillOwned = await call(
      `/families/${familyId}/tasks?status=owned`,
      bearer(admin.token),
    );
    expect(((await stillOwned.json()) as { tasks: unknown[] }).tasks).toHaveLength(1);

    // Release back to the pool.
    const release = await call(
      `/families/${familyId}/tasks/${taskId}/unassign`,
      authed(admin.token),
    );
    expect(release.status).toBe(200);
    const afterRelease = await call(
      `/families/${familyId}/tasks?status=unowned`,
      bearer(admin.token),
    );
    expect(((await afterRelease.json()) as { tasks: unknown[] }).tasks).toHaveLength(1);
  });
});

describe('feed member-links management', () => {
  it('lists links and removes a child + its unowned tasks', async () => {
    const admin = await login('links-admin@example.com');
    const familyId = await createFamily(admin.token, 'Links Fam');
    const db = getDb(env.DB);

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(admin.token, { url: 'https://x/cal.ics', mode: 'exception' }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };

    const childRes = await call(
      `/families/${familyId}/members`,
      authed(admin.token, { relationName: 'Adeline', requiresCaretaker: true }),
    );
    const { member } = (await childRes.json()) as { member: { id: string } };

    const linkRes = await call(
      `/families/${familyId}/feeds/${feed.id}/member-links`,
      authed(admin.token, {
        familyMemberId: member.id,
        weekdayMask: 31,
        dayStart: '08:00',
        dayEnd: '15:00',
        generatesTypes: ['dropoff', 'pickup'],
        defaultAttendance: 'any',
      }),
    );
    const { link } = (await linkRes.json()) as { link: { id: string } };

    // List shows the link with the child's name.
    const list = await call(`/families/${familyId}/feeds/${feed.id}/member-links`, bearer(admin.token));
    const { links } = (await list.json()) as {
      links: { id: string; memberRelation: string }[];
    };
    expect(links).toHaveLength(1);
    expect(links[0]!.memberRelation).toBe('Adeline');

    // Build baseline tasks for the next week, then delete the link.
    const ws = new Date();
    await buildFeedTasks(db, (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!, {
      windowStart: ws,
      windowEnd: new Date(ws.getTime() + 7 * DAY_MS),
    });
    const beforeCount = (
      await db.select().from(tasks).where(and(eq(tasks.feedId, feed.id), eq(tasks.familyMemberId, member.id)))
    ).length;
    expect(beforeCount).toBeGreaterThan(0);

    const del = await call(`/families/${familyId}/feeds/${feed.id}/member-links/${link.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    expect(del.status).toBe(200);

    const afterLinks = await call(`/families/${familyId}/feeds/${feed.id}/member-links`, bearer(admin.token));
    expect(((await afterLinks.json()) as { links: unknown[] }).links).toHaveLength(0);
    const afterCount = (
      await db.select().from(tasks).where(and(eq(tasks.feedId, feed.id), eq(tasks.familyMemberId, member.id)))
    ).length;
    expect(afterCount).toBe(0);
  });
});

describe('baseline timezone handling', () => {
  it('interprets baseline wall-times in the feed timezone', async () => {
    const admin = await login('tz-admin@example.com');
    const familyId = await createFamily(admin.token, 'TZ Fam');
    const db = getDb(env.DB);

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(admin.token, { url: 'https://x/cal.ics', mode: 'exception' }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };
    await db.update(feeds).set({ timezone: 'America/Los_Angeles' }).where(eq(feeds.id, feed.id));

    const childRes = await call(
      `/families/${familyId}/members`,
      authed(admin.token, { relationName: 'Kid', requiresCaretaker: true }),
    );
    const { member } = (await childRes.json()) as { member: { id: string } };
    await call(
      `/families/${familyId}/feeds/${feed.id}/member-links`,
      authed(admin.token, {
        familyMemberId: member.id,
        weekdayMask: 31,
        dayStart: '08:00',
        dayEnd: '15:00',
        durationMinutes: 20,
        location: "Children's House",
        generatesTypes: ['dropoff', 'pickup'],
        defaultAttendance: 'any',
      }),
    );

    // A July Monday — Pacific is on PDT (UTC-7).
    const monday = nextMonday(new Date(Date.UTC(2026, 6, 1)));
    const feedRow = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    await buildFeedTasks(db, feedRow, {
      windowStart: monday,
      windowEnd: new Date(monday.getTime() + DAY_MS),
    });

    const built = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.feedId, feed.id), eq(tasks.familyMemberId, member.id)));
    const dropoff = built.find((t) => t.type === 'dropoff')!;
    const pickup = built.find((t) => t.type === 'pickup')!;
    expect(dropoff.dtstart.getUTCHours()).toBe(15); // 08:00 PDT
    expect(pickup.dtstart.getUTCHours()).toBe(22); // 15:00 PDT
    // The configured block length + location land on every baseline task.
    expect(dropoff.location).toBe("Children's House");
    expect(dropoff.dtend!.getTime() - dropoff.dtstart.getTime()).toBe(20 * 60_000);
    expect(pickup.dtend!.getTime() - pickup.dtstart.getTime()).toBe(20 * 60_000);
  });

  it('heals block length + location when the baseline changes', async () => {
    const admin = await login('tz-heal@example.com');
    const familyId = await createFamily(admin.token, 'Heal Fam');
    const db = getDb(env.DB);

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(admin.token, { url: 'https://x/heal.ics', mode: 'exception' }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };

    const childRes = await call(
      `/families/${familyId}/members`,
      authed(admin.token, { relationName: 'Kid', requiresCaretaker: true }),
    );
    const { member } = (await childRes.json()) as { member: { id: string } };
    const linkRes = await call(
      `/families/${familyId}/feeds/${feed.id}/member-links`,
      authed(admin.token, {
        familyMemberId: member.id,
        weekdayMask: 31,
        dayStart: '08:00',
        dayEnd: '15:00',
        durationMinutes: 15,
        generatesTypes: ['pickup'],
        defaultAttendance: 'any',
      }),
    );
    const { link } = (await linkRes.json()) as { link: { id: string } };

    const monday = nextMonday(new Date(Date.UTC(2026, 6, 1)));
    const window = { windowStart: monday, windowEnd: new Date(monday.getTime() + DAY_MS) };
    const feedRowVal = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    await buildFeedTasks(db, feedRowVal, window);
    const before = (
      await db.select().from(tasks).where(eq(tasks.feedId, feed.id))
    ).find((t) => t.type === 'pickup')!;

    // Widen the block + add a location on the link, then rebuild in place — the
    // existing (same id) baseline task is healed, not recreated.
    await db
      .update(familyMemberFeeds)
      .set({ durationMinutes: 45, location: 'Gym' })
      .where(eq(familyMemberFeeds.id, link.id));
    await buildFeedTasks(db, feedRowVal, window);

    const healed = (
      await db.select().from(tasks).where(eq(tasks.feedId, feed.id))
    ).find((t) => t.type === 'pickup')!;
    expect(healed.id).toBe(before.id); // same row, healed in place
    expect(healed.location).toBe('Gym');
    expect(healed.dtend!.getTime() - healed.dtstart.getTime()).toBe(45 * 60_000);
  });
});

describe('classification rules CRUD', () => {
  // Helper: create a rule and return its id.
  async function createRule(
    token: string,
    familyId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await call(
      `/families/${familyId}/classification-rules`,
      authed(token, {
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'Soccer',
        effect: 'create',
        producesTypes: ['pickup'],
        priority: 100,
        ...overrides,
      }),
    );
    expect(res.status).toBe(201);
    const { rule } = (await res.json()) as { rule: { id: string } };
    return rule.id;
  }

  it('creates → patches priority and matchValue → GET reflects changes', async () => {
    const admin = await login('crud-rules-admin@example.com');
    const familyId = await createFamily(admin.token, 'Rules Fam A');

    const ruleId = await createRule(admin.token, familyId);

    // Patch priority and matchValue; leave other fields untouched.
    const patchRes = await call(
      `/families/${familyId}/classification-rules/${ruleId}`,
      patched(admin.token, { priority: 5, matchValue: 'Practice' }),
    );
    expect(patchRes.status).toBe(200);
    const { rule: patchedRule } = (await patchRes.json()) as { rule: { id: string; priority: number; matchValue: string; effect: string } };
    expect(patchedRule.priority).toBe(5);
    expect(patchedRule.matchValue).toBe('Practice');
    expect(patchedRule.effect).toBe('create'); // untouched

    // GET list must reflect the change.
    const listRes = await call(`/families/${familyId}/classification-rules`, bearer(admin.token));
    expect(listRes.status).toBe(200);
    const { rules } = (await listRes.json()) as { rules: { id: string; priority: number; matchValue: string }[] };
    const found = rules.find((r) => r.id === ruleId);
    expect(found?.priority).toBe(5);
    expect(found?.matchValue).toBe('Practice');
  });

  it('effect change to cancel clears producesTypes and defaultAttendance', async () => {
    const admin = await login('crud-rules-cancel@example.com');
    const familyId = await createFamily(admin.token, 'Rules Fam B');

    const ruleId = await createRule(admin.token, familyId, {
      effect: 'create',
      producesTypes: ['pickup'],
      defaultAttendance: 'any',
    });

    const patchRes = await call(
      `/families/${familyId}/classification-rules/${ruleId}`,
      patched(admin.token, {
        effect: 'cancel',
        producesTypes: null,
        defaultAttendance: null,
        defaultOwnerMemberId: null,
      }),
    );
    expect(patchRes.status).toBe(200);
    const { rule } = (await patchRes.json()) as {
      rule: { effect: string; producesTypes: unknown; defaultAttendance: unknown };
    };
    expect(rule.effect).toBe('cancel');
    expect(rule.producesTypes).toBeNull();
    expect(rule.defaultAttendance).toBeNull();
  });

  it('partial patch preserves untouched fields', async () => {
    const admin = await login('crud-rules-partial@example.com');
    const familyId = await createFamily(admin.token, 'Rules Fam C');

    const ruleId = await createRule(admin.token, familyId, {
      matchValue: 'Original',
      effect: 'create',
      producesTypes: ['dropoff'],
    });

    // Only patch priority — everything else must be unchanged.
    const patchRes = await call(
      `/families/${familyId}/classification-rules/${ruleId}`,
      patched(admin.token, { priority: 42 }),
    );
    expect(patchRes.status).toBe(200);
    const { rule } = (await patchRes.json()) as {
      rule: { priority: number; matchValue: string; effect: string; producesTypes: string[] | null };
    };
    expect(rule.priority).toBe(42);
    expect(rule.matchValue).toBe('Original');
    expect(rule.effect).toBe('create');
    expect(rule.producesTypes).toEqual(['dropoff']);
  });

  it('delete removes the rule from the list', async () => {
    const admin = await login('crud-rules-delete@example.com');
    const familyId = await createFamily(admin.token, 'Rules Fam D');

    const ruleId = await createRule(admin.token, familyId);

    const delRes = await call(
      `/families/${familyId}/classification-rules/${ruleId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } },
    );
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as { ok: boolean }).ok).toBe(true);

    const listRes = await call(`/families/${familyId}/classification-rules`, bearer(admin.token));
    const { rules } = (await listRes.json()) as { rules: { id: string }[] };
    expect(rules.find((r) => r.id === ruleId)).toBeUndefined();
  });

  it('PATCH with unknown ruleId returns 404', async () => {
    const admin = await login('crud-rules-404-patch@example.com');
    const familyId = await createFamily(admin.token, 'Rules Fam E');

    const res = await call(
      `/families/${familyId}/classification-rules/00000000-0000-0000-0000-000000000000`,
      patched(admin.token, { priority: 1 }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('rule_not_found');
  });

  it('DELETE with unknown ruleId returns 404', async () => {
    const admin = await login('crud-rules-404-delete@example.com');
    const familyId = await createFamily(admin.token, 'Rules Fam F');

    const res = await call(
      `/families/${familyId}/classification-rules/00000000-0000-0000-0000-000000000000`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('rule_not_found');
  });

  it('cross-family PATCH and DELETE return 404 (tenant isolation)', async () => {
    // Family A creates a rule; Family B admin must not be able to touch it.
    const adminA = await login('crud-rules-tenant-a@example.com');
    const familyIdA = await createFamily(adminA.token, 'Tenant Fam A');
    const ruleId = await createRule(adminA.token, familyIdA);

    const adminB = await login('crud-rules-tenant-b@example.com');
    await createFamily(adminB.token, 'Tenant Fam B');

    const patchRes = await call(
      `/families/${familyIdA}/classification-rules/${ruleId}`,
      patched(adminB.token, { priority: 1 }),
    );
    // adminB is not a member of familyA → requireFamilyMember returns 403
    // before even reaching the tenant check.
    expect(patchRes.status === 403 || patchRes.status === 404).toBe(true);

    const delRes = await call(
      `/families/${familyIdA}/classification-rules/${ruleId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${adminB.token}` } },
    );
    expect(delRes.status === 403 || delRes.status === 404).toBe(true);
  });

  // Note: admin-gating (403 for non-admin members on PATCH/DELETE) is covered
  // by requireAdmin's own middleware tests. No non-admin session helper exists
  // in helpers.ts to wire up a second test here without significant scaffolding.
});

describe('task & event dismissal', () => {
  it('dismisses a task and restores it (survives rebuild)', async () => {
    const admin = await login('dismiss-admin@example.com');
    const familyId = await createFamily(admin.token, 'Dismiss Fam');
    const db = getDb(env.DB);

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(admin.token, { url: 'https://x/soccer.ics', mode: 'explicit' }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };
    const childRes = await call(
      `/families/${familyId}/members`,
      authed(admin.token, { relationName: 'kid', requiresCaretaker: true }),
    );
    const { member } = (await childRes.json()) as { member: { id: string } };
    await call(
      `/families/${familyId}/feeds/${feed.id}/member-links`,
      authed(admin.token, { familyMemberId: member.id }),
    );
    await call(
      `/families/${familyId}/classification-rules`,
      authed(admin.token, {
        feedId: feed.id,
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'Soccer',
        effect: 'create',
        producesTypes: ['pickup'],
      }),
    );
    await seedEvent({
      feedId: feed.id,
      familyId,
      uid: 'soccer-d',
      start: new Date(Date.UTC(2026, 2, 10, 17)),
      summary: 'Soccer practice',
    });
    await buildFeedTasks(db, await feedRow(feed.id));

    const taskId = (await db.select().from(tasks).where(eq(tasks.feedId, feed.id)))[0]!.id;

    // Dismiss → out of the unowned queue, marked dismissed.
    const dis = await call(`/families/${familyId}/tasks/${taskId}/dismiss`, authed(admin.token));
    expect(dis.status).toBe(200);
    const unowned = await call(`/families/${familyId}/tasks?status=unowned`, bearer(admin.token));
    expect(((await unowned.json()) as { tasks: unknown[] }).tasks).toHaveLength(0);
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.status).toBe('dismissed');

    // A rebuild does not resurrect it.
    await buildFeedTasks(db, await feedRow(feed.id));
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.status).toBe('dismissed');

    // Restore → back in the queue.
    const res = await call(`/families/${familyId}/tasks/${taskId}/restore`, authed(admin.token));
    expect(res.status).toBe(200);
    const back = await call(`/families/${familyId}/tasks?status=unowned`, bearer(admin.token));
    expect(((await back.json()) as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it('dismissing a closure event restores the baseline; source-events lists it', async () => {
    const admin = await login('evt-dismiss@example.com');
    const familyId = await createFamily(admin.token, 'Evt Fam');
    const db = getDb(env.DB);

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(admin.token, { url: 'https://x/cal.ics', mode: 'exception' }),
    );
    const { feed } = (await feedRes.json()) as { feed: { id: string } };
    const childRes = await call(
      `/families/${familyId}/members`,
      authed(admin.token, { relationName: 'kid', requiresCaretaker: true }),
    );
    const { member } = (await childRes.json()) as { member: { id: string } };
    await call(
      `/families/${familyId}/feeds/${feed.id}/member-links`,
      authed(admin.token, {
        familyMemberId: member.id,
        weekdayMask: 31,
        dayStart: '08:00',
        dayEnd: '15:00',
        generatesTypes: ['dropoff', 'pickup'],
        defaultAttendance: 'any',
      }),
    );
    await call(
      `/families/${familyId}/classification-rules`,
      authed(admin.token, {
        feedId: feed.id,
        priority: 10,
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'Closed',
        effect: 'cancel',
      }),
    );

    const ws = nextMonday(new Date(Date.UTC(2026, 0, 1)));
    const we = new Date(ws.getTime() + 7 * DAY_MS);
    const wed = new Date(ws.getTime() + 2 * DAY_MS);
    await seedEvent({
      feedId: feed.id,
      familyId,
      uid: 'closed-wed',
      start: new Date(wed.getTime() + 10 * 60 * 60 * 1000),
      summary: 'MCH Closed - Holiday',
    });

    const win = { windowStart: ws, windowEnd: we };
    await buildFeedTasks(db, await feedRow(feed.id), win);
    const wedCount = () =>
      db
        .select()
        .from(tasks)
        .where(eq(tasks.feedId, feed.id))
        .then((rows) =>
          rows.filter((t) => startOfUtcDay(t.dtstart).getTime() === wed.getTime()).length,
        );
    expect(await wedCount()).toBe(0); // Wednesday cancelled by the closure

    const eventId = (await db.select().from(sourceEvents).where(eq(sourceEvents.icalUid, 'closed-wed')))[0]!.id;

    // Dismiss the erroneous closure (admin), then rebuild → baseline restored.
    const dis = await call(
      `/families/${familyId}/feeds/${feed.id}/events/${eventId}/dismiss`,
      authed(admin.token),
    );
    expect(dis.status).toBe(200);
    await buildFeedTasks(db, await feedRow(feed.id), win);
    expect(await wedCount()).toBe(2);

    // It surfaces in source-events with dismissedAt set.
    const evRes = await call(`/families/${familyId}/source-events`, bearer(admin.token));
    const { events } = (await evRes.json()) as {
      events: { id: string; dismissedAt: number | null }[];
    };
    expect(events.find((e) => e.id === eventId)?.dismissedAt).toBeTruthy();

    // Restore → the closure cancels Wednesday again.
    await call(
      `/families/${familyId}/feeds/${feed.id}/events/${eventId}/restore`,
      authed(admin.token),
    );
    await buildFeedTasks(db, await feedRow(feed.id), win);
    expect(await wedCount()).toBe(0);
  });
});
