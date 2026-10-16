import { env } from 'cloudflare:test';
import {
  and,
  calendarEvents,
  eq,
  eventMirrors,
  externalAccounts,
  getDb,
  memberCalendars,
} from '@igt/db';
import {
  type DeliveryEvent,
  DeliveryHttpError,
  type DeliveryProvider,
  DeliveryProviderRegistry,
} from '@igt/delivery';
import type { DeliveryMethod } from '@igt/domain';
import { describe, expect, it } from 'vitest';
import { GoogleTokenRefreshError } from '../src/lib/google-oauth.js';
import { storeSecret } from '../src/lib/secrets.js';
import { syncMemberMirror } from '../src/services/mirror.js';
import { readBackMember } from '../src/services/readback.js';
import { hashCalendarEvent } from '../src/services/synthesis.js';
import { authed, bearer, call, pinClockTo, setupFamily, testKeys } from './helpers.js';

// The mirror only works over the active horizon around "now".
pinClockTo('2026-07-06T12:00:00Z');

const WINDOW = {
  windowStart: new Date('2026-07-06T00:00:00Z'),
  windowEnd: new Date('2026-08-05T00:00:00Z'),
};

type Db = ReturnType<typeof getDb>;

/**
 * A member with a connected account and a target calendar on it. `google`
 * stores a refresh-token credential, `caldav` a basic one.
 */
async function targetFixture(email: string, method: 'google' | 'caldav' = 'google') {
  const fam = await setupFamily(email);
  const db = getDb(env.DB);
  const credRef = await storeSecret(
    db,
    testKeys(),
    null,
    JSON.stringify(
      method === 'google'
        ? { kind: 'oauth', refreshToken: 'rt-1' }
        : { kind: 'basic', username: 'u', password: 'p' },
    ),
  );
  const account = (
    await db
      .insert(externalAccounts)
      .values({
        userId: fam.admin.userId,
        kind: method === 'google' ? 'google' : 'icloud',
        name: 'Account',
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
        targetMethod: method,
        targetCalendarId:
          method === 'google' ? 'kid-calendar-id' : 'https://caldav.example.com/cal/kid/',
      })
      .returning()
  )[0]!;
  return { ...fam, db, account, cal };
}

const calRow = async (db: Db, id: string) =>
  (await db.select().from(memberCalendars).where(eq(memberCalendars.id, id)))[0]!;
const accountRow = async (db: Db, id: string) =>
  (await db.select().from(externalAccounts).where(eq(externalAccounts.id, id)))[0]!;

// --- read-back ---------------------------------------------------------------

const readOpts = { ...WINDOW, kek: testKeys(), googleRefresh: async () => 'access-token' };

function googleFetch(items: Record<string, unknown>[]): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items }),
  })) as unknown as typeof fetch;
}

/** A Google API that answers every call with an error status. */
function googleErrorFetch(status: number, message = 'nope'): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ error: { message } }), { status })) as unknown as typeof fetch;
}

const playdate = {
  iCalUID: 'playdate@google.com',
  status: 'confirmed',
  summary: 'Playdate',
  start: { dateTime: '2026-07-08T16:00:00Z' },
  end: { dateTime: '2026-07-08T18:00:00Z' },
};

describe('read-back health', () => {
  it('records a failed read-back on the member calendar and clears it on the next good one', async () => {
    const f = await targetFixture('th-readback-basic@example.com');
    const before = await calRow(f.db, f.cal.id);
    expect(before).toMatchObject({
      readBackAttemptedAt: null,
      readBackFailures: 0,
      lastReadBackError: null,
    });

    const failing = { ...readOpts, fetchImpl: googleErrorFetch(500, 'backend down') };
    await expect(readBackMember(f.db, f.cal, failing)).rejects.toThrow(/500/);
    const one = await calRow(f.db, f.cal.id);
    expect(one.readBackFailures).toBe(1);
    expect(one.lastReadBackError).toMatch(/500.*backend down/);
    expect(one.readBackAttemptedAt).toBeInstanceOf(Date);
    expect(one.lastReadBackAt).toBeNull(); // it never succeeded

    await expect(readBackMember(f.db, f.cal, failing)).rejects.toThrow();
    expect((await calRow(f.db, f.cal.id)).readBackFailures).toBe(2);

    const ok = await readBackMember(f.db, f.cal, { ...readOpts, fetchImpl: googleFetch([playdate]) });
    expect(ok.fetched).toBe(true);
    const healed = await calRow(f.db, f.cal.id);
    expect(healed).toMatchObject({ readBackFailures: 0, lastReadBackError: null });
    expect(healed.lastReadBackAt).toBeInstanceOf(Date);
    expect(healed.readBackAttemptedAt).toBeInstanceOf(Date);
    // A plain outage is nobody's cue to reconnect anything.
    expect((await accountRow(f.db, f.account.id)).authFailedAt).toBeNull();
  });

  it('truncates a long failure message like a feed does', async () => {
    const f = await targetFixture('th-readback-long@example.com');
    await expect(
      readBackMember(f.db, f.cal, { ...readOpts, fetchImpl: googleErrorFetch(500, 'x'.repeat(2000)) }),
    ).rejects.toThrow();
    expect((await calRow(f.db, f.cal.id)).lastReadBackError!.length).toBe(500);
  });

  it('asks the owner to reconnect when the target account’s Google refresh is refused', async () => {
    const f = await targetFixture('th-readback-reauth@example.com');
    const revoked = new GoogleTokenRefreshError('invalid_grant: Token has been revoked', 400, 'invalid_grant');
    const opts = {
      ...readOpts,
      googleRefresh: async () => {
        throw revoked;
      },
    };

    await expect(readBackMember(f.db, f.cal, opts)).rejects.toBe(revoked);
    const first = await accountRow(f.db, f.account.id);
    expect(first.authFailedAt).toBeInstanceOf(Date);
    expect(first.authFailureMessage).toMatch(/revoked/);
    expect((await calRow(f.db, f.cal.id)).readBackFailures).toBe(1);

    // The first failure's time is kept: the reauth alert waits on how long the
    // account has been broken, not on how recently it last failed.
    await expect(readBackMember(f.db, f.cal, opts)).rejects.toBe(revoked);
    const second = await accountRow(f.db, f.account.id);
    expect(second.authFailedAt!.getTime()).toBe(first.authFailedAt!.getTime());

    // Stamped as notified, as the alert pass would; a good read-back lowers it all.
    await f.db
      .update(externalAccounts)
      .set({ reauthNotifiedAt: new Date() })
      .where(eq(externalAccounts.id, f.account.id));
    await readBackMember(f.db, f.cal, { ...readOpts, fetchImpl: googleFetch([]) });
    expect(await accountRow(f.db, f.account.id)).toMatchObject({
      authFailedAt: null,
      authFailureMessage: null,
      reauthNotifiedAt: null,
    });
  });

  it('treats a Google 401 on the read itself as needing a reconnect, and a 500 as not', async () => {
    const f = await targetFixture('th-readback-401@example.com');
    await expect(
      readBackMember(f.db, f.cal, { ...readOpts, fetchImpl: googleErrorFetch(500) }),
    ).rejects.toThrow();
    expect((await accountRow(f.db, f.account.id)).authFailedAt).toBeNull();

    await expect(
      readBackMember(f.db, f.cal, { ...readOpts, fetchImpl: googleErrorFetch(401, 'Invalid Credentials') }),
    ).rejects.toThrow(/401/);
    expect((await accountRow(f.db, f.account.id)).authFailedAt).toBeInstanceOf(Date);
  });

  it('records an error instead of silently returning when there is no usable credential', async () => {
    const f = await targetFixture('th-readback-nocred@example.com');

    // Account removed: the target points at nothing.
    const orphan = { ...f.cal, targetExternalAccountId: null };
    const r = await readBackMember(f.db, orphan, readOpts);
    expect(r.fetched).toBe(false);
    expect(r.error).toMatch(/credential is unavailable/);
    const row = await calRow(f.db, f.cal.id);
    expect(row.readBackFailures).toBe(1);
    expect(row.lastReadBackError).toMatch(/credential is unavailable/);
    expect(row.readBackAttemptedAt).toBeInstanceOf(Date);

    // No encryption key configured: same story, and the count keeps climbing.
    await readBackMember(f.db, f.cal, { ...readOpts, kek: undefined });
    expect((await calRow(f.db, f.cal.id)).readBackFailures).toBe(2);

    // The wrong kind of credential for the method.
    const caldavOnGoogleAccount = { ...f.cal, targetMethod: 'caldav' as const };
    const wrong = await readBackMember(f.db, caldavOnGoogleAccount, readOpts);
    expect(wrong.error).toMatch(/CalDAV \(basic\) credential/);
    expect((await calRow(f.db, f.cal.id)).readBackFailures).toBe(3);

    // And a Google account with nothing to get an access token from.
    const noRefresh = await readBackMember(f.db, f.cal, { ...readOpts, googleRefresh: undefined });
    expect(noRefresh.error).toMatch(/no usable access token/);

    // One good read-back clears all of it.
    await readBackMember(f.db, f.cal, { ...readOpts, fetchImpl: googleFetch([]) });
    expect(await calRow(f.db, f.cal.id)).toMatchObject({ readBackFailures: 0, lastReadBackError: null });
  });

  it('does not count a paused target as failing', async () => {
    const f = await targetFixture('th-readback-paused@example.com');
    const r = await readBackMember(f.db, { ...f.cal, active: false, targetExternalAccountId: null }, readOpts);
    expect(r.fetched).toBe(false);
    expect(r.error).toBeUndefined();
    expect(await calRow(f.db, f.cal.id)).toMatchObject({ readBackFailures: 0, readBackAttemptedAt: null });
  });
});

// --- read-back vs. objects the server returned but we couldn't parse (#267) ---

function multistatusXml(entries: { href: string; etag: string; data?: string }[]): string {
  const responses = entries
    .map(
      (e) => `<D:response>
  <D:href>${e.href}</D:href>
  <D:propstat>
    <D:prop>
      <D:getetag>"${e.etag}"</D:getetag>
      ${e.data !== undefined ? `<C:calendar-data>${e.data.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</C:calendar-data>` : ''}
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">\n${responses}\n</D:multistatus>`;
}

/** Fakes tsdav's two-step REPORT (query for hrefs, then multiget for data). */
function caldavFetch(objects: { href: string; etag: string; data: string }[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    const xml = body.includes('calendar-multiget')
      ? multistatusXml(objects)
      : multistatusXml(objects.map(({ href, etag }) => ({ href, etag })));
    return new Response(xml, {
      status: 207,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    });
  }) as unknown as typeof fetch;
}

const goodObject = (uid: string, summary: string) => ({
  href: `/cal/${uid}.ics`,
  etag: `e-${uid}`,
  data: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20260710T150000Z\r\nDTEND:20260710T160000Z\r\nSUMMARY:${summary}\r\nEND:VEVENT\r\nEND:VCALENDAR`,
});
/** A VEVENT that never closes: the parser rejects the object. */
const brokenObject = (uidLine: string) => ({
  href: '/cal/broken.ics',
  etag: 'bad',
  data: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n${uidLine}DTSTART:20260711T150000Z\r\nSUMMARY:Broken\r\n`,
});

describe('read-back and objects that fail to parse', () => {
  it("doesn't prune a human event it merely failed to read, and says so", async () => {
    const f = await targetFixture('th-readback-parse@example.com', 'caldav');
    const humans = async () =>
      (
        await f.db
          .select()
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.familyMemberId, f.childId),
              eq(calendarEvents.provenance, 'human'),
            ),
          )
      )
        .map((e) => e.externalUid)
        .sort();
    const run = (objects: ReturnType<typeof goodObject>[]) =>
      readBackMember(f.db, f.cal, { ...readOpts, fetchImpl: caldavFetch(objects) });

    await run([goodObject('a-1', 'Dentist'), goodObject('b-1', 'Haircut')]);
    expect(await humans()).toEqual(['a-1', 'b-1']);

    // b-1's object stops parsing. It is not on the calendar any more, as far
    // as the parser can tell, but that is not the server deleting it.
    const r2 = await run([goodObject('a-1', 'Dentist'), brokenObject('UID:b-1\r\n')]);
    expect(r2.removed).toBe(0);
    expect(await humans()).toEqual(['a-1', 'b-1']);
    const warned = await calRow(f.db, f.cal.id);
    expect(warned.readBackFailures).toBe(0); // the read worked
    expect(warned.lastReadBackError).toMatch(/1 UID\(s\).*left untouched/);

    // A different UID genuinely gone is still pruned in the same pass.
    const r3 = await run([brokenObject('UID:b-1\r\n')]);
    expect(r3.removed).toBe(1);
    expect(await humans()).toEqual(['b-1']);

    // An object with no UID we can find: we can't say whose it was, so nothing
    // is pruned this pass — not even b-1, which is simply absent.
    const r4 = await run([brokenObject('')]);
    expect(r4.removed).toBe(0);
    expect(await humans()).toEqual(['b-1']);
    expect((await calRow(f.db, f.cal.id)).lastReadBackError).toMatch(/nothing was removed this pass/);

    // A clean read prunes what's really gone, and the note goes with it.
    const r5 = await run([goodObject('a-1', 'Dentist')]);
    expect(r5.removed).toBe(1);
    expect(await humans()).toEqual(['a-1']);
    expect((await calRow(f.db, f.cal.id)).lastReadBackError).toBeNull();
  });
});

// --- mirror -----------------------------------------------------------------

class ScriptedProvider implements DeliveryProvider {
  upserts: DeliveryEvent[] = [];
  cancels: DeliveryEvent[] = [];
  /** When set, called for every upsert; a returned error is thrown. */
  failWith: (() => Error | null) | null = null;
  constructor(readonly method: DeliveryMethod) {}
  async upsert(event: DeliveryEvent) {
    this.upserts.push(event);
    const err = this.failWith?.();
    if (err) throw err;
    return { externalRef: `fake-${event.uid}`, sequence: event.sequence };
  }
  async cancel(event: DeliveryEvent) {
    this.cancels.push(event);
  }
}

const rejected400 = () => new DeliveryHttpError('google calendar insert failed: 400', 400);

async function insertEvent(db: Db, familyId: string, memberId: string, summary = 'School day') {
  const payload = {
    dtstart: new Date('2026-07-06T15:30:00Z'),
    dtend: new Date('2026-07-06T21:45:00Z'),
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
        familyMemberId: memberId,
        provenance: 'synthesized',
        contentHash: hashCalendarEvent(payload as never),
        ...payload,
        synthKey: `bl:l1:${summary}`,
      })
      .returning()
  )[0]!;
}

const rename = (db: Db, id: string, summary: string) =>
  db.update(calendarEvents).set({ summary }).where(eq(calendarEvents.id, id));

const mirrorRow = async (db: Db, memberId: string) =>
  (await db.select().from(eventMirrors).where(eq(eventMirrors.familyMemberId, memberId)))[0];

describe('mirror health', () => {
  it('holds an event back after three identical rejections, retries it once edited, and clears everything on success', async () => {
    const f = await targetFixture('th-mirror-hold@example.com', 'caldav');
    const event = await insertEvent(f.db, f.familyId, f.childId);
    const provider = new ScriptedProvider('caldav');
    provider.failWith = rejected400;
    const registry = new DeliveryProviderRegistry().register(provider);
    const run = () => syncMemberMirror(f.db, registry, testKeys(), f.childId);

    // A NEW event that fails has no row yet: one is created to hold the failure.
    const r1 = await run();
    expect(r1.errors).toHaveLength(1);
    expect(r1.created).toBe(0);
    const row1 = (await mirrorRow(f.db, f.childId))!;
    expect(row1).toMatchObject({
      calendarEventId: event.id,
      status: 'failed',
      externalRef: null,
      sentAt: null,
      payloadHash: null,
      sequence: 0,
      failureCount: 1,
    });
    expect(row1.lastError).toBe('google calendar insert failed: 400');
    expect(row1.failedPayloadHash).toBeTruthy();
    const cal1 = await calRow(f.db, f.cal.id);
    expect(cal1.mirrorFailures).toBe(1);
    expect(cal1.lastMirrorError).toBe('google calendar insert failed: 400');
    expect(cal1.mirrorAttemptedAt).toBeInstanceOf(Date);

    await run();
    const r3 = await run();
    expect(r3.errors).toHaveLength(1);
    expect(provider.upserts).toHaveLength(3);
    expect((await mirrorRow(f.db, f.childId))!.failureCount).toBe(3);
    expect((await calRow(f.db, f.cal.id)).mirrorFailures).toBe(3);

    // Fourth pass: same content, so nothing is sent and — the point — nothing
    // is reported as an error that would retry the whole job.
    const r4 = await run();
    expect(provider.upserts).toHaveLength(3);
    expect(r4.errors).toEqual([]);
    expect(r4).toMatchObject({ created: 0, updated: 0, removed: 0 });
    // …but the target is not healthy, and the member calendar still says why.
    const cal4 = await calRow(f.db, f.cal.id);
    expect(cal4.mirrorFailures).toBe(4);
    expect(cal4.lastMirrorError).toMatch(/1 event not sent.*google calendar insert failed: 400/);
    // The held event's own row is not touched by being skipped.
    expect((await mirrorRow(f.db, f.childId))!.failureCount).toBe(3);

    // Edited: a new payload is sent at once. The target is fine now.
    provider.failWith = null;
    await rename(f.db, event.id, 'School day (early release)');
    const r5 = await run();
    expect(provider.upserts).toHaveLength(4);
    expect(provider.upserts[3]!.sequence).toBe(0); // the first real send
    expect(r5.errors).toEqual([]);
    expect(r5.created).toBe(1);
    expect(r5.updated).toBe(0);
    const row5 = (await mirrorRow(f.db, f.childId))!;
    expect(row5).toMatchObject({
      status: 'sent',
      externalRef: `fake-igt-${event.id}`,
      failureCount: 0,
      lastError: null,
      failedPayloadHash: null,
    });
    expect(row5.sentAt).toBeInstanceOf(Date);
    expect(row5.payloadHash).toBeTruthy();
    expect(await calRow(f.db, f.cal.id)).toMatchObject({ mirrorFailures: 0, lastMirrorError: null });

    // And it's an ordinary mirrored event from here on.
    const r6 = await run();
    expect(provider.upserts).toHaveLength(4);
    expect(r6.errors).toEqual([]);
  });

  it('restarts the count when the content changes but is still rejected', async () => {
    const f = await targetFixture('th-mirror-restart@example.com', 'caldav');
    const event = await insertEvent(f.db, f.familyId, f.childId);
    const provider = new ScriptedProvider('caldav');
    provider.failWith = rejected400;
    const registry = new DeliveryProviderRegistry().register(provider);
    const run = () => syncMemberMirror(f.db, registry, testKeys(), f.childId);

    for (let i = 0; i < 3; i++) await run();
    const held = (await mirrorRow(f.db, f.childId))!;
    expect(held.failureCount).toBe(3);
    await run(); // held
    expect(provider.upserts).toHaveLength(3);

    await rename(f.db, event.id, 'Edited once');
    const r = await run();
    expect(provider.upserts).toHaveLength(4); // tried again, not held
    expect(r.errors).toHaveLength(1);
    const after = (await mirrorRow(f.db, f.childId))!;
    expect(after.failureCount).toBe(1);
    expect(after.failedPayloadHash).not.toBe(held.failedPayloadHash);

    // The edit-and-fail again path: two more rejections of the new content
    // hold it back too.
    await run();
    await run();
    expect((await mirrorRow(f.db, f.childId))!.failureCount).toBe(3);
    await run();
    expect(provider.upserts).toHaveLength(6);
  });

  it('never holds back an event for trouble that is the target’s, not the event’s', async () => {
    const f = await targetFixture('th-mirror-transient@example.com', 'caldav');
    const event = await insertEvent(f.db, f.familyId, f.childId);
    const provider = new ScriptedProvider('caldav');
    const registry = new DeliveryProviderRegistry().register(provider);
    const run = () => syncMemberMirror(f.db, registry, testKeys(), f.childId);

    const outages = [
      () => new DeliveryHttpError('caldav PUT 503 for https://x/', 503),
      () => new DeliveryHttpError('caldav PUT 401 for https://x/', 401),
      () => new DeliveryHttpError('caldav PUT 429 for https://x/', 429),
      () => new TypeError('fetch failed'),
    ];
    for (let i = 0; i < 6; i++) {
      provider.failWith = outages[i % outages.length]!;
      const r = await run();
      expect(r.errors).toHaveLength(1); // retried every time, as before
    }
    expect(provider.upserts).toHaveLength(6);
    const row = (await mirrorRow(f.db, f.childId))!;
    expect(row.failureCount).toBe(0);
    expect(row.failedPayloadHash).toBeNull();
    expect(row.lastError).toBeTruthy(); // but it says what went wrong
    expect((await calRow(f.db, f.cal.id)).mirrorFailures).toBe(6);

    // The target recovers: the unchanged event goes out without needing an edit.
    provider.failWith = null;
    const r = await run();
    expect(provider.upserts).toHaveLength(7);
    expect(r.errors).toEqual([]);
    expect(r.created).toBe(1);
    expect(await calRow(f.db, f.cal.id)).toMatchObject({ mirrorFailures: 0, lastMirrorError: null });
    expect(event.id).toBeTruthy();
  });

  it('keeps an already-delivered event’s remote copy and ref when an update is rejected', async () => {
    const f = await targetFixture('th-mirror-update@example.com', 'caldav');
    const event = await insertEvent(f.db, f.familyId, f.childId);
    const provider = new ScriptedProvider('caldav');
    const registry = new DeliveryProviderRegistry().register(provider);
    const run = () => syncMemberMirror(f.db, registry, testKeys(), f.childId);

    expect((await run()).created).toBe(1);
    const delivered = (await mirrorRow(f.db, f.childId))!;

    provider.failWith = rejected400;
    await rename(f.db, event.id, 'Renamed');
    for (let i = 0; i < 3; i++) await run();
    const failing = (await mirrorRow(f.db, f.childId))!;
    expect(failing).toMatchObject({
      status: 'failed',
      failureCount: 3,
      externalRef: delivered.externalRef,
      sequence: delivered.sequence,
      payloadHash: delivered.payloadHash, // what the remote copy actually holds
    });
    expect(failing.sentAt).toBeInstanceOf(Date);
    const calls = provider.upserts.length;
    expect((await run()).errors).toEqual([]);
    expect(provider.upserts).toHaveLength(calls); // held

    // The event is deleted while held: the remote copy still gets cancelled.
    await f.db.delete(calendarEvents).where(eq(calendarEvents.id, event.id));
    const r = await run();
    expect(r.removed).toBe(1);
    expect(r.errors).toEqual([]);
    expect(provider.cancels).toHaveLength(1);
    expect(provider.cancels[0]!.externalRef).toBe(delivered.externalRef);
    expect(await mirrorRow(f.db, f.childId)).toBeUndefined();
    expect(await calRow(f.db, f.cal.id)).toMatchObject({ mirrorFailures: 0, lastMirrorError: null });
  });

  it('cancels (harmlessly) and drops the row of a never-delivered event that goes away', async () => {
    const f = await targetFixture('th-mirror-vanish@example.com', 'caldav');
    const event = await insertEvent(f.db, f.familyId, f.childId);
    const provider = new ScriptedProvider('caldav');
    provider.failWith = rejected400;
    const registry = new DeliveryProviderRegistry().register(provider);
    const run = () => syncMemberMirror(f.db, registry, testKeys(), f.childId);

    await run();
    expect((await mirrorRow(f.db, f.childId))!.status).toBe('failed');

    await f.db.delete(calendarEvents).where(eq(calendarEvents.id, event.id));
    const r = await run();
    expect(r.errors).toEqual([]);
    expect(r.removed).toBe(1);
    expect(provider.cancels).toHaveLength(1);
    expect(provider.cancels[0]!.externalRef).toBeNull();
    expect(await mirrorRow(f.db, f.childId)).toBeUndefined();
  });

  it('asks the owner to reconnect when the target’s Google refresh is refused during a mirror', async () => {
    const f = await targetFixture('th-mirror-reauth@example.com', 'google');
    await insertEvent(f.db, f.familyId, f.childId);
    const provider = new ScriptedProvider('google');
    provider.failWith = () =>
      new GoogleTokenRefreshError('invalid_grant: Token has been revoked', 400, 'invalid_grant');
    const registry = new DeliveryProviderRegistry().register(provider);

    const r = await syncMemberMirror(f.db, registry, testKeys(), f.childId);
    expect(r.errors).toHaveLength(1);
    const account = await accountRow(f.db, f.account.id);
    expect(account.authFailedAt).toBeInstanceOf(Date);
    expect(account.authFailureMessage).toMatch(/revoked/);
    expect(await calRow(f.db, f.cal.id)).toMatchObject({ mirrorFailures: 1 });
    // A dead credential is the account's state, not the event's.
    expect((await mirrorRow(f.db, f.childId))!.failureCount).toBe(0);
  });

  it('records a target whose credential is unavailable instead of going quiet — without failing the job', async () => {
    const f = await targetFixture('th-mirror-nocred@example.com', 'caldav');
    await insertEvent(f.db, f.familyId, f.childId);
    const provider = new ScriptedProvider('caldav');
    const registry = new DeliveryProviderRegistry().register(provider);
    await f.db
      .update(memberCalendars)
      .set({ targetExternalAccountId: null })
      .where(eq(memberCalendars.id, f.cal.id));

    const r = await syncMemberMirror(f.db, registry, testKeys(), f.childId);
    // Retrying the job can't fix a missing account, so it isn't an error…
    expect(r.errors).toEqual([]);
    expect(provider.upserts).toHaveLength(0);
    // …but it is a target that isn't working.
    const cal = await calRow(f.db, f.cal.id);
    expect(cal.mirrorFailures).toBe(1);
    expect(cal.lastMirrorError).toMatch(/credential is unavailable/);
    expect(cal.lastMirroredAt).toBeNull();
  });

  it('summarises several failures as the first plus a count, and clears on a clean pass', async () => {
    const f = await targetFixture('th-mirror-many@example.com', 'caldav');
    await insertEvent(f.db, f.familyId, f.childId, 'One');
    await insertEvent(f.db, f.familyId, f.childId, 'Two');
    await insertEvent(f.db, f.familyId, f.childId, 'Three');
    const provider = new ScriptedProvider('caldav');
    provider.failWith = () => new DeliveryHttpError('caldav PUT 503 for https://x/', 503);
    const registry = new DeliveryProviderRegistry().register(provider);

    const r = await syncMemberMirror(f.db, registry, testKeys(), f.childId);
    expect(r.errors).toHaveLength(3);
    const cal = await calRow(f.db, f.cal.id);
    expect(cal.lastMirrorError).toBe('caldav PUT 503 for https://x/ (and 2 more)');
    expect(cal.lastMirroredAt).toBeInstanceOf(Date); // the pass completed, as before

    provider.failWith = null;
    await syncMemberMirror(f.db, registry, testKeys(), f.childId);
    expect(await calRow(f.db, f.cal.id)).toMatchObject({ mirrorFailures: 0, lastMirrorError: null });
  });
});

// --- exposure -----------------------------------------------------------------

describe('target health on the API', () => {
  it('returns the health fields from the calendar-target route, and wipes them when the target moves', async () => {
    const fam = await setupFamily('th-route@example.com');
    const acctRes = await call(
      '/accounts',
      authed(fam.admin.token, { kind: 'icloud', name: 'iCloud', username: 'me@icloud.com', password: 'pw' }),
    );
    const account = ((await acctRes.json()) as { account: { id: string } }).account;
    const base = `/families/${fam.familyId}/members/${fam.childId}/calendar-target`;
    const putTarget = (calendarId: string) =>
      call(base, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${fam.admin.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ externalAccountId: account.id, targetCalendarId: calendarId }),
      });
    type Target = {
      readBackFailures: number;
      lastReadBackError: string | null;
      readBackAttemptedAt: string | null;
      mirrorFailures: number;
      lastMirrorError: string | null;
      mirrorAttemptedAt: string | null;
    };

    const first = await putTarget('https://caldav.example.com/cal/a/');
    expect(first.status).toBe(201);
    expect(((await first.json()) as { target: Target }).target).toMatchObject({
      readBackFailures: 0,
      lastReadBackError: null,
      mirrorFailures: 0,
      lastMirrorError: null,
    });

    const db = getDb(env.DB);
    const attemptedAt = new Date('2026-07-06T11:00:00Z');
    await db
      .update(memberCalendars)
      .set({
        readBackAttemptedAt: attemptedAt,
        readBackFailures: 4,
        lastReadBackError: 'google events.list failed: 401',
        mirrorAttemptedAt: attemptedAt,
        mirrorFailures: 2,
        lastMirrorError: 'caldav PUT 503',
      })
      .where(eq(memberCalendars.familyMemberId, fam.childId));

    const got = (await (await call(base, bearer(fam.admin.token))).json()) as { target: Target };
    expect(got.target).toMatchObject({
      readBackFailures: 4,
      lastReadBackError: 'google events.list failed: 401',
      readBackAttemptedAt: attemptedAt.toISOString(),
      mirrorFailures: 2,
      lastMirrorError: 'caldav PUT 503',
      mirrorAttemptedAt: attemptedAt.toISOString(),
    });

    // Saving the same calendar again proves nothing: the record stays.
    const same = await putTarget('https://caldav.example.com/cal/a/');
    expect(same.status).toBe(200);
    expect(((await same.json()) as { target: Target }).target).toMatchObject({
      readBackFailures: 4,
      mirrorFailures: 2,
    });

    // A different calendar starts clean — the old one's errors describe elsewhere.
    await db
      .update(memberCalendars)
      .set({ readBackFailures: 4, mirrorFailures: 2, lastMirrorError: 'caldav PUT 503' })
      .where(eq(memberCalendars.familyMemberId, fam.childId));
    const moved = await putTarget('https://caldav.example.com/cal/b/');
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { target: Target }).target).toMatchObject({
      readBackFailures: 0,
      lastReadBackError: null,
      readBackAttemptedAt: null,
      mirrorFailures: 0,
      lastMirrorError: null,
      mirrorAttemptedAt: null,
    });
  });
});
