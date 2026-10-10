import { env } from 'cloudflare:test';
import { calendarEvents, getDb, taskOwners, tasks } from '@igt/db';
import { describe, expect, it } from 'vitest';
import {
  coverageAnswer,
  matchesQuery,
  spokenDay,
} from '../src/services/assistant.js';
import { authed, bearer, call, createFamily, login, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

const TZ = 'America/Los_Angeles';
// Friday 2026-10-16, Pacific (UTC-7).
const DAY = '2026-10-16';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00-07:00`);

async function addMember(token: string, familyId: string, body: Record<string, unknown>) {
  const res = await call(`/families/${familyId}/members`, authed(token, body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { member: { id: string } }).member.id;
}

/** An event on the child's calendar plus one task generated from it. */
async function seedTask(
  db: Db,
  familyId: string,
  childId: string,
  opts: {
    key: string;
    type: 'pickup' | 'dropoff' | 'attendance';
    summary: string;
    start: Date;
    end: Date;
    taskStart?: Date;
    owners?: string[];
    status?: 'unowned' | 'owned' | 'dismissed';
  },
) {
  const event = (
    await db
      .insert(calendarEvents)
      .values({
        familyId,
        familyMemberId: childId,
        synthKey: opts.key,
        provenance: 'synthesized',
        summary: opts.summary,
        dtstart: opts.start,
        dtend: opts.end,
        allDay: false,
        contentHash: `${opts.key}-h`,
      })
      .returning()
  )[0]!;
  const owners = opts.owners ?? [];
  const task = (
    await db
      .insert(tasks)
      .values({
        familyId,
        familyMemberId: childId,
        calendarEventId: event.id,
        type: opts.type,
        dtstart: opts.taskStart ?? (opts.type === 'pickup' ? opts.end : opts.start),
        status: opts.status ?? (owners.length > 0 ? 'owned' : 'unowned'),
        createdVia: 'generated',
      })
      .returning()
  )[0]!;
  for (const familyMemberId of owners) {
    await db.insert(taskOwners).values({ taskId: task.id, familyMemberId });
  }
  return task;
}

async function fixture(email: string) {
  const base = await setupFamily(email);
  const sam = await addMember(base.admin.token, base.familyId, {
    relationName: 'Sam',
    isCaretaker: true,
  });
  const felix = await addMember(base.admin.token, base.familyId, {
    relationName: 'Felix',
    requiresCaretaker: true,
  });
  return { ...base, sam, felix };
}

describe('GET /assistant/members', () => {
  it("lists the members of every family the caller is in, and nobody else's", async () => {
    const { admin, familyId, felix } = await fixture('assistant-members@example.com');
    const second = await createFamily(admin.token, 'Cabin');
    const outsider = await setupFamily('assistant-members-outsider@example.com', 'Other');

    const res = await call('/assistant/members', bearer(admin.token));
    expect(res.status).toBe(200);
    const { members } = (await res.json()) as {
      members: { id: string; name: string; familyId: string; familyName: string }[];
    };
    expect(members.find((m) => m.id === felix)).toMatchObject({
      name: 'Felix',
      familyId,
      familyName: 'Test Fam',
    });
    expect(members.some((m) => m.familyId === second)).toBe(true);
    expect(members.some((m) => m.familyId === outsider.familyId)).toBe(false);
  });

  it('requires a session', async () => {
    expect((await call('/assistant/members')).status).toBe(401);
  });
});

describe('GET /assistant/coverage', () => {
  it("names who's picking up, and leaves the other days and members out", async () => {
    const { admin, familyId, felix, sam, childId } = await fixture(
      'assistant-pickup@example.com',
    );
    const db = getDb(env.DB);
    await seedTask(db, familyId, felix, {
      key: 'a:1',
      type: 'pickup',
      summary: 'School',
      start: at('08:00'),
      end: at('15:15'),
      owners: [sam],
    });
    // Same member, the next day; another member, the same day.
    await seedTask(db, familyId, felix, {
      key: 'a:2',
      type: 'pickup',
      summary: 'School',
      start: new Date('2026-10-17T08:00:00-07:00'),
      end: new Date('2026-10-17T15:15:00-07:00'),
    });
    await seedTask(db, familyId, childId, {
      key: 'a:3',
      type: 'pickup',
      summary: 'Daycare',
      start: at('08:00'),
      end: at('17:00'),
    });

    const res = await call(
      `/assistant/coverage?memberId=${felix}&date=${DAY}&tz=${TZ}&type=pickup`,
      bearer(admin.token),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; speech: string };
    expect(body.items).toHaveLength(1);
    expect(body.speech).toMatch(/Sam is picking Felix up from School at 3:15 PM\.$/);
  });

  it('says "you" for the caller and flags what nobody has claimed', async () => {
    const { admin, adminMemberId, familyId, felix, sam } = await fixture(
      'assistant-any@example.com',
    );
    const db = getDb(env.DB);
    await seedTask(db, familyId, felix, {
      key: 'b:1',
      type: 'dropoff',
      summary: 'School',
      start: at('08:00'),
      end: at('15:00'),
      taskStart: at('07:45'),
      owners: [adminMemberId],
    });
    await seedTask(db, familyId, felix, {
      key: 'b:2',
      type: 'attendance',
      summary: 'Doctor appointment',
      start: at('16:30'),
      end: at('17:30'),
      owners: [adminMemberId, sam],
    });
    await seedTask(db, familyId, felix, {
      key: 'b:3',
      type: 'pickup',
      summary: 'Soccer',
      start: at('17:00'),
      end: at('18:00'),
    });
    await seedTask(db, familyId, felix, {
      key: 'b:4',
      type: 'pickup',
      summary: 'Dismissed thing',
      start: at('12:00'),
      end: at('13:00'),
      status: 'dismissed',
    });

    const answer = await coverageAnswer(
      db,
      admin.userId,
      { memberId: felix, date: DAY, tz: TZ, type: 'any' },
      new Date('2026-10-15T20:00:00-07:00'),
    );
    expect(answer!.items.map((i) => i.type)).toEqual(['dropoff', 'attendance', 'pickup']);
    expect(answer!.speech).toBe(
      "Tomorrow, you're dropping Felix off at School at 8 AM. " +
        "You and Sam are going to Felix's Doctor appointment at 4:30 PM. " +
        "Nobody has Felix's pickup from Soccer at 6 PM yet.",
    );
  });

  it('narrows by spoken text, and says so when nothing matches', async () => {
    const { admin, familyId, felix, sam } = await fixture('assistant-q@example.com');
    const db = getDb(env.DB);
    await seedTask(db, familyId, felix, {
      key: 'c:1',
      type: 'attendance',
      summary: 'Doctor appointment',
      start: at('16:30'),
      end: at('17:30'),
      owners: [sam],
    });
    await seedTask(db, familyId, felix, {
      key: 'c:2',
      type: 'pickup',
      summary: 'School',
      start: at('08:00'),
      end: at('15:00'),
    });
    const now = new Date('2026-10-12T09:00:00-07:00');

    const hit = await coverageAnswer(
      db,
      admin.userId,
      { memberId: felix, date: DAY, tz: TZ, type: 'any', q: "the doctor's appointment" },
      now,
    );
    expect(hit!.speech).toBe("On Friday, Sam is going to Felix's Doctor appointment at 4:30 PM.");

    const miss = await coverageAnswer(
      db,
      admin.userId,
      { memberId: felix, date: DAY, tz: TZ, type: 'any', q: 'dentist' },
      now,
    );
    expect(miss!.queryUnmatched).toBe(true);
    expect(miss!.items).toHaveLength(2);
    expect(miss!.speech).toMatch(/^I couldn't find anything matching "dentist"/);
  });

  it('answers an empty day plainly', async () => {
    const { admin, felix } = await fixture('assistant-empty@example.com');
    const res = await call(
      `/assistant/coverage?memberId=${felix}&date=${DAY}&tz=${TZ}&type=dropoff`,
      bearer(admin.token),
    );
    const { speech } = (await res.json()) as { speech: string };
    expect(speech).toMatch(/^Felix has no drop-off on /);
  });

  it("404s for a member of a family the caller isn't in", async () => {
    const { felix } = await fixture('assistant-owner@example.com');
    const stranger = await login('assistant-stranger@example.com');
    const res = await call(
      `/assistant/coverage?memberId=${felix}&date=${DAY}&tz=${TZ}`,
      bearer(stranger.token),
    );
    expect(res.status).toBe(404);
  });

  it('rejects a malformed date or zone', async () => {
    const { admin, felix } = await fixture('assistant-invalid@example.com');
    for (const qs of [`date=2026-02-30&tz=${TZ}`, `date=${DAY}&tz=Mars/Base`]) {
      const res = await call(`/assistant/coverage?memberId=${felix}&${qs}`, bearer(admin.token));
      expect(res.status).toBe(400);
    }
  });
});

describe('spoken phrasing', () => {
  it('says the day relative to the asker', () => {
    expect(spokenDay('2026-10-16', '2026-10-16')).toBe('today');
    expect(spokenDay('2026-10-17', '2026-10-16')).toBe('tomorrow');
    expect(spokenDay('2026-10-20', '2026-10-16')).toBe('on Tuesday');
    expect(spokenDay('2026-10-30', '2026-10-16')).toBe('on Friday, October 30');
  });

  it('matches loosely on words, not exact titles', () => {
    expect(matchesQuery('Doctor — Dr. Patel', "Poppy's doctor's appointment")).toBe(true);
    expect(matchesQuery('Swim lessons', 'swimming')).toBe(true);
    expect(matchesQuery('Piano', 'the doctor')).toBe(false);
    expect(matchesQuery(null, 'doctor')).toBe(false);
  });
});
