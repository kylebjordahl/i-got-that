import { env } from 'cloudflare:test';
import {
  calendarEvents,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { hashCalendarEvent } from '../src/services/synthesis.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { authed, bearer, call, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

const DAY = 86_400_000;
// Relative to now: the match list's default window is the past/next 30 days.
const at = (days: number) => new Date(Date.now() + days * DAY);

async function linkedFeed(db: Db, familyId: string, childId: string, name: string) {
  const feed = (
    await db
      .insert(feeds)
      .values({ familyId, mode: 'standard', url: `https://f.example.com/${name}.ics` })
      .returning()
  )[0]!;
  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({ familyId, feedId: feed.id, familyMemberId: childId, defaultTaskType: 'transition' })
      .returning()
  )[0]!;
  return link;
}

async function insertEvent(
  db: Db,
  familyId: string,
  familyMemberId: string,
  linkId: string | null,
  summary: string,
  days: number,
) {
  const payload = {
    dtstart: at(days),
    dtend: new Date(at(days).getTime() + 90 * 60_000),
    allDay: false,
    summary,
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
        provenance: 'synthesized',
        contentHash: hashCalendarEvent(payload),
        ...payload,
        synthKey: `ev:${linkId}:${summary}:${days}`,
        linkId,
      })
      .returning()
  )[0]!;
}

function eventTaskTypes(db: Db, eventId: string) {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.calendarEventId, eventId))
    .then((rows) => rows.map((t) => t.type).sort());
}

type Match = {
  event: { id: string; summary: string };
  status: 'applies' | 'shadowed' | 'omitted';
  decidedByRuleId: string | null;
  resultType: string;
  converted: boolean;
  tasks?: { type: string; ownerMemberIds: string[] }[];
};

async function fixture(email: string) {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const school = await linkedFeed(db, fam.familyId, fam.childId, 'school');
  const sports = await linkedFeed(db, fam.familyId, fam.childId, 'sports');
  const ev = {
    pastTrip: await insertEvent(db, fam.familyId, fam.childId, school.id, 'Field trip', -3),
    nextTrip: await insertEvent(db, fam.familyId, fam.childId, school.id, 'Field trip', 4),
    museumTrip: await insertEvent(db, fam.familyId, fam.childId, school.id, 'Museum field trip', 6),
    farTrip: await insertEvent(db, fam.familyId, fam.childId, school.id, 'Field trip', 45),
    otherCal: await insertEvent(db, fam.familyId, fam.childId, sports.id, 'Field trip', 5),
    unrelated: await insertEvent(db, fam.familyId, fam.childId, school.id, 'Spelling bee', 2),
  };
  await buildMemberTasks(db, fam.childId);
  const base = `/families/${fam.familyId}/members/${fam.childId}/task-rules`;
  return { fam, db, school, sports, ev, base };
}

async function createRule(base: string, token: string, body: Record<string, unknown>) {
  const res = await call(base, authed(token, body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { rule: { id: string } }).rule.id;
}

async function matchesOf(base: string, token: string, ruleId: string) {
  const res = await call(`${base}/${ruleId}/matches`, bearer(token));
  expect(res.status).toBe(200);
  return ((await res.json()) as { matches: Match[] }).matches;
}

describe('a task rule’s match list', () => {
  it('lists what it catches on its calendars in the window, and whether it decides each', async () => {
    const { fam, school, ev, base } = await fixture('trm-list@example.com');
    const museum = await createRule(base, fam.admin.token, {
      linkId: school.id,
      matchValue: '/museum/i',
      resultType: 'none',
    });
    const trips = await createRule(base, fam.admin.token, {
      linkId: school.id,
      matchValue: '/field trip/i',
      resultType: 'attendance',
    });

    const matches = await matchesOf(base, fam.admin.token, trips);
    // In date order; the far-off trip (outside ±30 days), the sports calendar's
    // trip (outside a this-calendar rule's scope) and the non-match are absent.
    expect(matches.map((m) => m.event.id)).toEqual([
      ev.pastTrip.id,
      ev.nextTrip.id,
      ev.museumTrip.id,
    ]);
    const byId = new Map(matches.map((m) => [m.event.id, m]));
    expect(byId.get(ev.nextTrip.id)).toMatchObject({
      status: 'applies',
      decidedByRuleId: trips,
      resultType: 'attendance',
      converted: false,
    });
    expect(byId.get(ev.nextTrip.id)!.tasks!.map((t) => t.type)).toEqual(['attendance']);
    // The museum trip is caught too, but the earlier rule decides it.
    expect(byId.get(ev.museumTrip.id)).toMatchObject({
      status: 'shadowed',
      decidedByRuleId: museum,
      resultType: 'none',
      tasks: [],
    });
  });

  it('omitting an event makes it fall through, and restoring it puts it back', async () => {
    const { fam, db, school, ev, base } = await fixture('trm-omit@example.com');
    const trips = await createRule(base, fam.admin.token, {
      linkId: school.id,
      matchValue: '/field trip/i',
      resultType: 'attendance',
    });
    expect(await eventTaskTypes(db, ev.nextTrip.id)).toEqual(['attendance']);

    const omit = await call(
      `${base}/${trips}/exceptions`,
      authed(fam.admin.token, { calendarEventId: ev.nextTrip.id }),
    );
    expect(omit.status).toBe(201);
    // Falls through to the school calendar's default (drop-off + pickup); the
    // rule's other matches are untouched.
    expect(await eventTaskTypes(db, ev.nextTrip.id)).toEqual(['dropoff', 'pickup']);
    expect(await eventTaskTypes(db, ev.pastTrip.id)).toEqual(['attendance']);

    const omitted = (await matchesOf(base, fam.admin.token, trips)).find(
      (m) => m.event.id === ev.nextTrip.id,
    );
    expect(omitted).toMatchObject({
      status: 'omitted',
      decidedByRuleId: null,
      resultType: 'transition',
    });

    // Omitting twice is harmless.
    expect(
      (
        await call(
          `${base}/${trips}/exceptions`,
          authed(fam.admin.token, { calendarEventId: ev.nextTrip.id }),
        )
      ).status,
    ).toBe(201);

    const restore = await call(`${base}/${trips}/exceptions/${ev.nextTrip.id}`, {
      ...bearer(fam.admin.token),
      method: 'DELETE',
    });
    expect(restore.status).toBe(200);
    expect(await eventTaskTypes(db, ev.nextTrip.id)).toEqual(['attendance']);
  });

  it('an omission goes with its rule', async () => {
    const { fam, db, school, ev, base } = await fixture('trm-omit-delete@example.com');
    const trips = await createRule(base, fam.admin.token, {
      linkId: school.id,
      matchValue: '/field trip/i',
      resultType: 'attendance',
    });
    await call(
      `${base}/${trips}/exceptions`,
      authed(fam.admin.token, { calendarEventId: ev.nextTrip.id }),
    );
    await call(`${base}/${trips}`, { ...bearer(fam.admin.token), method: 'DELETE' });
    // Recreating the same rule doesn't inherit the old one-off.
    const again = await createRule(base, fam.admin.token, {
      linkId: school.id,
      matchValue: '/field trip/i',
      resultType: 'attendance',
    });
    const m = (await matchesOf(base, fam.admin.token, again)).find(
      (x) => x.event.id === ev.nextTrip.id,
    );
    expect(m?.status).toBe('applies');
    expect(await eventTaskTypes(db, ev.nextTrip.id)).toEqual(['attendance']);
  });

  it('refuses an outsider, another member’s event and a bad window', async () => {
    const { fam, db, school, ev, base } = await fixture('trm-authz@example.com');
    const trips = await createRule(base, fam.admin.token, {
      linkId: school.id,
      matchValue: '/field trip/i',
      resultType: 'attendance',
    });
    const other = await setupFamily('trm-authz-other@example.com');
    expect((await call(`${base}/${trips}/matches`, bearer(other.admin.token))).status).toBe(403);
    expect(
      (
        await call(
          `${base}/${trips}/exceptions`,
          authed(other.admin.token, { calendarEventId: ev.nextTrip.id }),
        )
      ).status,
    ).toBe(403);

    // An event on the admin's own calendar isn't this child's to omit.
    const adminEvent = await insertEvent(db, fam.familyId, fam.adminMemberId, null, 'Field trip', 1);
    const wrong = await call(
      `${base}/${trips}/exceptions`,
      authed(fam.admin.token, { calendarEventId: adminEvent.id }),
    );
    expect(wrong.status).toBe(404);

    const backwards = await call(
      `${base}/${trips}/matches?from=${at(5).toISOString()}&to=${at(1).toISOString()}`,
      bearer(fam.admin.token),
    );
    expect(backwards.status).toBe(400);
    const tooWide = await call(
      `${base}/${trips}/matches?from=${at(-200).toISOString()}&to=${at(1).toISOString()}`,
      bearer(fam.admin.token),
    );
    expect(tooWide.status).toBe(400);
  });
});

describe('previewing an unsaved task rule', () => {
  it('shows what a new rule would catch, and whether it would decide each', async () => {
    const { fam, school, ev, base } = await fixture('trm-preview@example.com');
    const trips = await createRule(base, fam.admin.token, {
      linkId: school.id,
      matchValue: '/field trip/i',
      resultType: 'attendance',
    });
    const draft = { linkId: school.id, matchValue: '/museum/i', resultType: 'none' };

    // Appended (a create's default), the existing rule still decides it.
    const appended = await call(`${base}/preview`, authed(fam.admin.token, { rule: draft }));
    expect(appended.status).toBe(200);
    const { matches: a } = (await appended.json()) as { matches: Match[] };
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      event: { id: ev.museumTrip.id },
      status: 'shadowed',
      decidedByRuleId: trips,
    });
    expect(a[0]!.tasks).toBeUndefined();

    // First in line, it would take over.
    const first = await call(
      `${base}/preview`,
      authed(fam.admin.token, { rule: { ...draft, position: 0 } }),
    );
    const { matches: b } = (await first.json()) as { matches: Match[] };
    expect(b[0]).toMatchObject({ status: 'applies', decidedByRuleId: 'draft', resultType: 'none' });

    // Nothing was saved.
    const list = await call(base, bearer(fam.admin.token));
    expect(((await list.json()) as { rules: unknown[] }).rules).toHaveLength(1);
  });

  it('an edit keeps the rule’s place and its omissions', async () => {
    const { fam, school, ev, base } = await fixture('trm-preview-edit@example.com');
    const trips = await createRule(base, fam.admin.token, {
      linkId: school.id,
      matchValue: '/^field trip$/i',
      resultType: 'attendance',
    });
    await call(
      `${base}/${trips}/exceptions`,
      authed(fam.admin.token, { calendarEventId: ev.nextTrip.id }),
    );

    // Loosening the match to every trip (all calendars) while editing.
    const res = await call(
      `${base}/preview`,
      authed(fam.admin.token, {
        ruleId: trips,
        rule: { scope: 'all_calendars', matchValue: '/field trip/i', resultType: 'attendance' },
      }),
    );
    expect(res.status).toBe(200);
    const { matches } = (await res.json()) as { matches: Match[] };
    const byId = new Map(matches.map((m) => [m.event.id, m.status]));
    expect(byId.get(ev.nextTrip.id)).toBe('omitted');
    expect(byId.get(ev.pastTrip.id)).toBe('applies');
    expect(byId.get(ev.museumTrip.id)).toBe('applies');
    expect(byId.get(ev.otherCal.id)).toBe('applies'); // now in scope
    expect(byId.has(ev.unrelated.id)).toBe(false);

    const missing = await call(
      `${base}/preview`,
      authed(fam.admin.token, { ruleId: 'nope', rule: { matchValue: '/x/', resultType: 'none' } }),
    );
    expect(missing.status).toBe(404);
  });
});
