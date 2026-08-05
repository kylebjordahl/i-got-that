import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  familyMemberFeeds,
  feeds,
  getDb,
  linkRules,
  pendingDecisions,
  sourceEvents,
  tasks,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { synthesizeFeed } from '../src/services/synthesis.js';
import { authed, bearer, call, linkMember, login, patched, setupFamily } from './helpers.js';

/**
 * The shared family calendar: ONE input feed carrying several kids' events,
 * split back out per member by each link's `keep` rules. Anything no link keeps
 * is routed nowhere and raises a routing decision instead — the same "never
 * guess" contract exception feeds have, asked as "whose is this?".
 */

/**
 * Occurrences sit a couple of days out so they fall inside the *default*
 * synthesis window — the routes resynthesize with it, and these specs assert on
 * what those calls produce.
 */
const inWindow = (offsetHours = 0) =>
  new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + offsetHours * 60 * 60 * 1000);

type Db = ReturnType<typeof getDb>;

async function routedFixture(
  email: string,
  opts: { routed?: boolean; kind?: 'ics' | 'caldav' } = {},
) {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const bee = (
    (await (
      await call(
        `/families/${fam.familyId}/members`,
        authed(fam.admin.token, { relationName: 'bee', requiresCaretaker: true }),
      )
    ).json()) as { member: { id: string } }
  ).member.id;

  const feed = (
    await db
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        kind: opts.kind ?? 'ics',
        mode: 'standard',
        routed: opts.routed ?? true,
        url: opts.kind === 'caldav' ? null : 'https://feed.example.com/family.ics',
        externalAccountId: null,
        sourceCalendarId: opts.kind === 'caldav' ? 'https://dav.example.com/family/' : null,
        sourceCalendarName: 'Family',
        timezone: 'UTC',
        // Pretend it has synced: a never-synced feed makes the resynthesize
        // path try a real ingest, which these service-level specs don't stub.
        lastSyncedAt: new Date(),
      })
      .returning()
  )[0]!;

  const linkFor = async (familyMemberId: string, position: number) =>
    (
      await db
        .insert(familyMemberFeeds)
        .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId, position })
        .returning()
    )[0]!;

  return {
    ...fam,
    db,
    feed,
    beeId: bee,
    linkA: await linkFor(fam.childId, 0),
    linkB: await linkFor(bee, 1),
  };
}

let uidSeq = 0;
async function addOccurrence(
  db: Db,
  feed: { id: string; familyId: string },
  summary: string,
  opts: { start?: Date; end?: Date; contentHash?: string } = {},
) {
  return (
    await db
      .insert(sourceEvents)
      .values({
        feedId: feed.id,
        familyId: feed.familyId,
        icalUid: `routed-${uidSeq++}`,
        recurrenceId: '',
        summary,
        dtstart: opts.start ?? inWindow(),
        dtend: opts.end ?? inWindow(1),
        allDay: false,
        contentHash: opts.contentHash ?? `${summary}-v1`,
      })
      .returning()
  )[0]!;
}

async function keepRule(
  db: Db,
  f: { familyId: string },
  linkId: string,
  matchValue: string,
  matchOp: 'contains' | 'regex' = 'contains',
) {
  return (
    await db
      .insert(linkRules)
      .values({
        familyId: f.familyId,
        linkId,
        position: 0,
        matchField: 'summary',
        matchOp,
        matchValue,
        outcome: 'keep',
      })
      .returning()
  )[0]!;
}

const eventsFor = (db: Db, memberId: string) =>
  db.select().from(calendarEvents).where(eq(calendarEvents.familyMemberId, memberId));

const openDecisions = (db: Db, familyId: string) =>
  db
    .select()
    .from(pendingDecisions)
    .where(
      and(eq(pendingDecisions.familyId, familyId), eq(pendingDecisions.status, 'pending')),
    );

describe('routed feeds (shared family calendar)', () => {
  it('routes each event to the members whose keep rules match, and asks about the rest', async () => {
    const f = await routedFixture('routed-split@example.com');
    await keepRule(f.db, f, f.linkA.id, 'Aiden');
    await keepRule(f.db, f, f.linkB.id, '/^Bee\\b/i', 'regex');
    await addOccurrence(f.db, f.feed, 'Aiden swim practice');
    await addOccurrence(f.db, f.feed, 'Bee ballet');
    const orphan = await addOccurrence(f.db, f.feed, 'Dentist');

    await synthesizeFeed(f.db, f.feed);

    expect((await eventsFor(f.db, f.childId)).map((e) => e.summary)).toEqual([
      'Aiden swim practice',
    ]);
    expect((await eventsFor(f.db, f.beeId)).map((e) => e.summary)).toEqual(['Bee ballet']);

    // The unclaimed event asks every member of the feed, once per link.
    const decisions = await openDecisions(f.db, f.familyId);
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.kind === 'routing')).toBe(true);
    expect(decisions.every((d) => d.sourceEventId === orphan.id)).toBe(true);
    expect(decisions.map((d) => d.familyMemberId).sort()).toEqual(
      [f.childId, f.beeId].sort(),
    );
  });

  it('gives an event to every member who keeps it', async () => {
    const f = await routedFixture('routed-both@example.com');
    await keepRule(f.db, f, f.linkA.id, 'swim');
    await keepRule(f.db, f, f.linkB.id, 'swim');
    await addOccurrence(f.db, f.feed, 'Family swim');

    await synthesizeFeed(f.db, f.feed);

    expect(await eventsFor(f.db, f.childId)).toHaveLength(1);
    expect(await eventsFor(f.db, f.beeId)).toHaveLength(1);
    expect(await openDecisions(f.db, f.familyId)).toHaveLength(0);
  });

  it('routes an account-backed calendar the same way an ICS one is routed', async () => {
    const f = await routedFixture('routed-caldav@example.com', { kind: 'caldav' });
    await keepRule(f.db, f, f.linkA.id, 'Aiden');
    await addOccurrence(f.db, f.feed, 'Aiden swim practice');

    await synthesizeFeed(f.db, f.feed);

    expect(await eventsFor(f.db, f.childId)).toHaveLength(1);
    expect(await eventsFor(f.db, f.beeId)).toHaveLength(0);
  });

  it('passes everything through when the feed is not routed', async () => {
    const f = await routedFixture('routed-off@example.com', { routed: false });
    await addOccurrence(f.db, f.feed, 'Dentist');

    await synthesizeFeed(f.db, f.feed);

    expect(await eventsFor(f.db, f.childId)).toHaveLength(1);
    expect(await eventsFor(f.db, f.beeId)).toHaveLength(1);
    expect(await openDecisions(f.db, f.familyId)).toHaveLength(0);
  });

  it('turning routing off puts every event back on every calendar and clears the questions', async () => {
    const f = await routedFixture('routed-toggle-off@example.com');
    await addOccurrence(f.db, f.feed, 'Dentist');
    await synthesizeFeed(f.db, f.feed);
    expect(await openDecisions(f.db, f.familyId)).toHaveLength(2);

    const res = await call(
      `/families/${f.familyId}/feeds/${f.feed.id}`,
      patched(f.admin.token, { routed: false }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { feed: { routed: boolean } }).feed.routed).toBe(false);

    expect(await openDecisions(f.db, f.familyId)).toHaveLength(0);
    expect(await eventsFor(f.db, f.childId)).toHaveLength(1);
    expect(await eventsFor(f.db, f.beeId)).toHaveLength(1);
  });
});

describe('routing decisions', () => {
  /** A fixture parked on one unrouted "Dentist" event, decisions open. */
  async function undecided(email: string) {
    const f = await routedFixture(email);
    const source = await addOccurrence(f.db, f.feed, 'Dentist');
    await synthesizeFeed(f.db, f.feed);
    const decisions = await openDecisions(f.db, f.familyId);
    return {
      ...f,
      source,
      forLink: (linkId: string) => decisions.find((d) => d.linkId === linkId)!,
    };
  }

  it('lists routing decisions with their kind, so the client can group them into one card', async () => {
    const f = await undecided('routed-list@example.com');
    const res = await call(
      `/families/${f.familyId}/pending-decisions`,
      bearer(f.admin.token),
    );
    expect(res.status).toBe(200);
    const { decisions } = (await res.json()) as {
      decisions: { kind: string; sourceEventId: string; summary: string }[];
    };
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.kind === 'routing')).toBe(true);
    expect(new Set(decisions.map((d) => d.sourceEventId)).size).toBe(1);
    expect(decisions[0]!.summary).toBe('Dentist');
  });

  it('one-off routing puts the event on the chosen calendars only, and closes the question', async () => {
    const f = await undecided('routed-oneoff@example.com');
    const res = await call(
      `/families/${f.familyId}/pending-decisions/${f.forLink(f.linkA.id).id}/resolve`,
      authed(f.admin.token, { routeToLinkIds: [f.linkA.id] }),
    );
    expect(res.status).toBe(200);

    const routed = await eventsFor(f.db, f.childId);
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      summary: 'Dentist',
      synthKey: `pd:${f.forLink(f.linkA.id).id}`,
      // Stamped with the link it was routed through, so task rules for that
      // calendar (and its conflict priority) apply as they would to any event.
      linkId: f.linkA.id,
    });
    expect(await eventsFor(f.db, f.beeId)).toHaveLength(0);

    // The routed event is claimable straight away (the link's default typing).
    const generated = await f.db
      .select()
      .from(tasks)
      .where(eq(tasks.calendarEventId, routed[0]!.id));
    expect(generated.map((t) => t.type).sort()).toEqual(['dropoff', 'pickup']);

    // Nobody is asked again: the member picked is resolved, the other dismissed.
    expect(await openDecisions(f.db, f.familyId)).toHaveLength(0);
    const rows = await f.db
      .select()
      .from(pendingDecisions)
      .where(eq(pendingDecisions.sourceEventId, f.source.id));
    expect(rows.find((r) => r.linkId === f.linkA.id)!.status).toBe('resolved');
    expect(rows.find((r) => r.linkId === f.linkB.id)!.status).toBe('dismissed');

    // ...and a later sync doesn't re-raise it.
    await synthesizeFeed(f.db, f.feed);
    expect(await openDecisions(f.db, f.familyId)).toHaveLength(0);
    expect(await eventsFor(f.db, f.childId)).toHaveLength(1);
  });

  it('routes to several members at once', async () => {
    const f = await undecided('routed-multi@example.com');
    const res = await call(
      `/families/${f.familyId}/pending-decisions/${f.forLink(f.linkA.id).id}/resolve`,
      authed(f.admin.token, { routeToLinkIds: [f.linkA.id, f.linkB.id] }),
    );
    expect(res.status).toBe(200);
    expect(await eventsFor(f.db, f.childId)).toHaveLength(1);
    expect(await eventsFor(f.db, f.beeId)).toHaveLength(1);
  });

  it('"every time" writes a keep rule, so events like it route themselves from now on', async () => {
    const f = await undecided('routed-rule@example.com');
    const res = await call(
      `/families/${f.familyId}/pending-decisions/${f.forLink(f.linkB.id).id}/resolve`,
      authed(f.admin.token, {
        routeToLinkIds: [f.linkB.id],
        rule: { matchField: 'summary', matchOp: 'contains', matchValue: 'Dentist' },
      }),
    );
    expect(res.status).toBe(200);

    const rules = await f.db
      .select()
      .from(linkRules)
      .where(eq(linkRules.linkId, f.linkB.id));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ outcome: 'keep', matchValue: 'Dentist' });

    // The rule — not a one-off copy — is what puts it on the calendar.
    const routed = await eventsFor(f.db, f.beeId);
    expect(routed).toHaveLength(1);
    expect(routed[0]!.synthKey).toBe(`ev:${f.linkB.id}:${f.source.id}`);
    expect(await eventsFor(f.db, f.childId)).toHaveLength(0);

    // The next dentist appointment routes itself — nothing to decide.
    await addOccurrence(f.db, f.feed, 'Dentist follow-up');
    await synthesizeFeed(f.db, f.feed);
    expect(await openDecisions(f.db, f.familyId)).toHaveLength(0);
    expect(await eventsFor(f.db, f.beeId)).toHaveLength(2);
  });

  it('refuses a rule that does not match the event it was created from', async () => {
    const f = await undecided('routed-badrule@example.com');
    const res = await call(
      `/families/${f.familyId}/pending-decisions/${f.forLink(f.linkA.id).id}/resolve`,
      authed(f.admin.token, {
        routeToLinkIds: [f.linkA.id],
        rule: { matchField: 'summary', matchOp: 'contains', matchValue: 'Orthodontist' },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'rule_does_not_match',
    });
    expect(await openDecisions(f.db, f.familyId)).toHaveLength(2);
  });

  it('requires a routing decision to name where the event goes', async () => {
    const f = await undecided('routed-notargets@example.com');
    const res = await call(
      `/families/${f.familyId}/pending-decisions/${f.forLink(f.linkA.id).id}/resolve`,
      authed(f.admin.token, {}),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'route_targets_required',
    });
  });

  it('lets a non-admin route an event, but not write a rule for it', async () => {
    const f = await undecided('routed-perms@example.com');
    const bob = await login('routed-perms-bob@example.com');
    const addBob = await call(
      `/families/${f.familyId}/members`,
      authed(f.admin.token, { relationName: 'uncle', isCaretaker: true, isAdmin: false }),
    );
    const bobMemberId = ((await addBob.json()) as { member: { id: string } }).member.id;
    await linkMember(f.admin.token, f.familyId, bobMemberId, bob.token);

    const withRule = await call(
      `/families/${f.familyId}/pending-decisions/${f.forLink(f.linkA.id).id}/resolve`,
      authed(bob.token, {
        routeToLinkIds: [f.linkA.id],
        rule: { matchField: 'summary', matchOp: 'contains', matchValue: 'Dentist' },
      }),
    );
    expect(withRule.status).toBe(403);

    const oneOff = await call(
      `/families/${f.familyId}/pending-decisions/${f.forLink(f.linkA.id).id}/resolve`,
      authed(bob.token, { routeToLinkIds: [f.linkA.id] }),
    );
    expect(oneOff.status).toBe(200);
  });

  it('dismissing a routing decision answers it for every member', async () => {
    const f = await undecided('routed-dismiss@example.com');
    const res = await call(
      `/families/${f.familyId}/pending-decisions/${f.forLink(f.linkA.id).id}/dismiss`,
      authed(f.admin.token, {}),
    );
    expect(res.status).toBe(200);
    expect(await openDecisions(f.db, f.familyId)).toHaveLength(0);
    expect(await eventsFor(f.db, f.childId)).toHaveLength(0);
    expect(await eventsFor(f.db, f.beeId)).toHaveLength(0);
  });

  it('reopens the question when the event itself changes', async () => {
    const f = await undecided('routed-reopen@example.com');
    await call(
      `/families/${f.familyId}/pending-decisions/${f.forLink(f.linkA.id).id}/resolve`,
      authed(f.admin.token, { routeToLinkIds: [f.linkA.id] }),
    );
    expect(await openDecisions(f.db, f.familyId)).toHaveLength(0);

    await f.db
      .update(sourceEvents)
      .set({ summary: 'Dentist — moved', contentHash: 'v2' })
      .where(eq(sourceEvents.id, f.source.id));
    await synthesizeFeed(f.db, f.feed);

    expect(await openDecisions(f.db, f.familyId)).toHaveLength(2);
    // The stale routing is withdrawn along with the question.
    expect(await eventsFor(f.db, f.childId)).toHaveLength(0);
  });
});

describe('routing rules (the keep pipeline)', () => {
  it('accepts a keep rule on a routed feed and refuses the baseline outcomes', async () => {
    const f = await routedFixture('routed-rules-ok@example.com');
    const base = `/families/${f.familyId}/feeds/${f.feed.id}/member-links/${f.linkA.id}/rules`;

    const keep = await call(
      base,
      authed(f.admin.token, {
        matchField: 'summary',
        matchOp: 'regex',
        matchValue: '/^Aiden\\b/i',
        outcome: 'keep',
      }),
    );
    expect(keep.status).toBe(201);

    const cancel = await call(
      base,
      authed(f.admin.token, {
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'No School',
        outcome: 'cancel_day',
      }),
    );
    expect(cancel.status).toBe(400);
    expect((await cancel.json()) as { error: string }).toMatchObject({
      error: 'outcome_requires_exception_feed',
    });
  });

  it('refuses a keep rule on a feed that is not routed', async () => {
    const f = await routedFixture('routed-rules-off@example.com', { routed: false });
    const res = await call(
      `/families/${f.familyId}/feeds/${f.feed.id}/member-links/${f.linkA.id}/rules`,
      authed(f.admin.token, {
        matchField: 'summary',
        matchOp: 'contains',
        matchValue: 'Aiden',
        outcome: 'keep',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'outcome_requires_routed_feed',
    });
  });

  it('refuses to route an exception feed', async () => {
    const f = await routedFixture('routed-exception@example.com', { routed: false });
    await f.db.update(feeds).set({ mode: 'exception' }).where(eq(feeds.id, f.feed.id));
    const res = await call(
      `/families/${f.familyId}/feeds/${f.feed.id}`,
      patched(f.admin.token, { routed: true }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'routing_requires_standard_feed',
    });
  });

  it('clears routing when the feed stops being a standard one', async () => {
    const f = await routedFixture('routed-mode-change@example.com');
    const res = await call(
      `/families/${f.familyId}/feeds/${f.feed.id}`,
      patched(f.admin.token, { mode: 'exception' }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { feed: { routed: boolean } }).feed.routed).toBe(false);
  });
});
