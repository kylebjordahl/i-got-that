import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  externalAccounts,
  familyMemberFeeds,
  feeds,
  getDb,
  memberCalendars,
  sourceEvents,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { storeSecret } from '../src/lib/secrets.js';
import { readBackMember } from '../src/services/readback.js';
import { buildMemberTasks } from '../src/services/task-gen.js';
import { setupFamily } from './helpers.js';

const WINDOW = {
  windowStart: new Date('2026-07-06T00:00:00Z'),
  windowEnd: new Date('2026-08-05T00:00:00Z'),
};

type GoogleItem = Record<string, unknown>;

function googleFetch(items: GoogleItem[]): typeof fetch {
  return (async (url: string | URL | Request) => {
    expect(String(url)).toContain('/events');
    return { ok: true, status: 200, json: async () => ({ items }) };
  }) as unknown as typeof fetch;
}

async function googleTargetFixture(email: string) {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const credRef = await storeSecret(
    db,
    env.KEK,
    null,
    JSON.stringify({ kind: 'oauth', refreshToken: 'rt-1' }),
  );
  const account = (
    await db
      .insert(externalAccounts)
      .values({
        userId: fam.admin.userId,
        kind: 'google',
        name: 'G',
        credentialsRef: credRef,
      })
      .returning()
  )[0]!;
  const cal = (
    await db
      .insert(memberCalendars)
      .values({
        familyId: fam.familyId,
        familyMemberId: fam.childId,
        targetExternalAccountId: account.id,
        targetMethod: 'google',
        targetCalendarId: 'kid-calendar-id',
      })
      .returning()
  )[0]!;
  return { ...fam, db, cal };
}

const opts = {
  ...WINDOW,
  kek: env.KEK,
  googleRefresh: async () => 'access-token',
};

describe('read-back (human events from the target calendar)', () => {
  it('imports human events, skips our own igt- mirrored events, and prunes vanished ones', async () => {
    const f = await googleTargetFixture('readback-basic@example.com');

    const playdate = {
      iCalUID: 'playdate@google.com',
      status: 'confirmed',
      summary: 'Playdate with Sam',
      location: 'Park',
      start: { dateTime: '2026-07-08T16:00:00Z' },
      end: { dateTime: '2026-07-08T18:00:00Z' },
    };
    const mirrored = {
      iCalUID: 'igt-abc123', // one of ours — must never be re-imported
      status: 'confirmed',
      summary: 'School day',
      start: { dateTime: '2026-07-08T08:30:00Z' },
      end: { dateTime: '2026-07-08T14:45:00Z' },
    };

    const r1 = await readBackMember(f.db, f.cal, {
      ...opts,
      fetchImpl: googleFetch([playdate, mirrored]),
    });
    expect(r1.fetched).toBe(true);
    expect(r1.upserted).toBe(1);

    const humans = await f.db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.familyMemberId, f.childId),
          eq(calendarEvents.provenance, 'human'),
        ),
      );
    expect(humans).toHaveLength(1);
    expect(humans[0]).toMatchObject({
      summary: 'Playdate with Sam',
      externalUid: 'playdate@google.com',
      synthKey: 'ext:playdate@google.com:',
    });

    // Human events get a task via the member's unified default (attendance).
    await buildMemberTasks(f.db, f.childId);
    const generated = await f.db
      .select()
      .from(tasks)
      .where(eq(tasks.calendarEventId, humans[0]!.id));
    expect(generated).toHaveLength(1);
    expect(generated[0]!.type).toBe('attendance');

    // Unchanged rerun is a no-op.
    const r2 = await readBackMember(f.db, f.cal, {
      ...opts,
      fetchImpl: googleFetch([playdate, mirrored]),
    });
    expect(r2.upserted).toBe(0);
    expect(r2.removed).toBe(0);

    // The event changes remotely → healed in place.
    const moved = { ...playdate, summary: 'Playdate with Sam (moved)' };
    const r3 = await readBackMember(f.db, f.cal, {
      ...opts,
      fetchImpl: googleFetch([moved, mirrored]),
    });
    expect(r3.upserted).toBe(1);

    // The event vanishes remotely → pruned here (and its unowned task swept).
    const r4 = await readBackMember(f.db, f.cal, {
      ...opts,
      fetchImpl: googleFetch([mirrored]),
    });
    expect(r4.removed).toBe(1);
    await buildMemberTasks(f.db, f.childId);
    expect(
      await f.db.select().from(tasks).where(eq(tasks.familyMemberId, f.childId)),
    ).toHaveLength(0);
  });

  it('skips an event already ingested via a feed sourced from this same target calendar', async () => {
    // Reproduces the duplication bug: a member's own input feed can point at
    // the exact same external calendar as their read-back target (e.g. a feed
    // added to pull the member's own schedule into synthesis). An event on
    // that calendar then arrives twice — once via synthesis (`ev:`/`bl:`),
    // once via read-back (`human`) — unless read-back defers to synthesis.
    const f = await googleTargetFixture('readback-feed-overlap@example.com');
    const feed = (
      await f.db
        .insert(feeds)
        .values({
          familyId: f.familyId,
          kind: 'google',
          externalAccountId: (
            await f.db
              .select()
              .from(externalAccounts)
              .where(eq(externalAccounts.userId, f.admin.userId))
              .limit(1)
          )[0]!.id,
          sourceCalendarId: 'kid-calendar-id', // same calendar as f.cal's target
          mode: 'standard',
        })
        .returning()
    )[0]!;
    await f.db.insert(familyMemberFeeds).values({
      familyId: f.familyId,
      feedId: feed.id,
      familyMemberId: f.childId,
    });
    await f.db.insert(sourceEvents).values({
      feedId: feed.id,
      familyId: f.familyId,
      icalUid: 'flight-pdx-bil@example.com',
      recurrenceId: '',
      summary: 'Flight PDX -> BIL',
      dtstart: new Date('2026-07-09T15:00:00Z'),
      dtend: new Date('2026-07-09T17:00:00Z'),
      allDay: false,
      contentHash: 'h1',
    });

    const flight = {
      iCalUID: 'flight-pdx-bil@example.com',
      status: 'confirmed',
      summary: 'Flight PDX -> BIL',
      start: { dateTime: '2026-07-09T15:00:00Z' },
      end: { dateTime: '2026-07-09T17:00:00Z' },
    };
    const genuinelyHuman = {
      iCalUID: 'dentist@google.com',
      status: 'confirmed',
      summary: 'Dentist',
      start: { dateTime: '2026-07-10T15:00:00Z' },
      end: { dateTime: '2026-07-10T16:00:00Z' },
    };

    const r = await readBackMember(f.db, f.cal, {
      ...opts,
      fetchImpl: googleFetch([flight, genuinelyHuman]),
    });
    expect(r.upserted).toBe(1);

    const humans = await f.db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.familyMemberId, f.childId),
          eq(calendarEvents.provenance, 'human'),
        ),
      );
    expect(humans).toHaveLength(1);
    expect(humans[0]!.summary).toBe('Dentist');
  });

  it('skips an inactive target and one without a resolvable credential', async () => {
    const f = await googleTargetFixture('readback-skip@example.com');
    const db = f.db;

    await db
      .update(memberCalendars)
      .set({ active: false })
      .where(eq(memberCalendars.id, f.cal.id));
    const inactive = await readBackMember(db, { ...f.cal, active: false }, opts);
    expect(inactive.fetched).toBe(false);

    const orphan = { ...f.cal, active: true, targetExternalAccountId: null };
    const noCred = await readBackMember(db, orphan, opts);
    expect(noCred.fetched).toBe(false);
  });
});
