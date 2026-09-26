import { env } from 'cloudflare:test';
import {
  calendarEvents,
  emailOutputMirrors,
  emailOutputs,
  eq,
  familyMemberFeeds,
  familyMembers,
  feeds,
  getDb,
  taskOwners,
  tasks,
} from '@igt/db';
import type { EmailOutputFilters } from '@igt/domain';
import { describe, expect, it } from 'vitest';
import { DevOutbox } from '../src/lib/email.js';
import {
  EMAIL_INVITE_SENDS_PER_RUN,
  EMAIL_VERIFICATION_DAILY_CAP,
  sendVerification,
  syncMemberEmailOutputs,
} from '../src/services/email-outputs.js';
import { hashCalendarEvent } from '../src/services/synthesis.js';
import { authed, bearer, call, linkMember, login, patched, setupFamily } from './helpers.js';

type Db = ReturnType<typeof getDb>;

const NOW = new Date('2026-07-01T12:00:00Z');

function del(token: string): RequestInit {
  return { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } };
}

/** The decoded text/calendar part of a captured invite. */
function ics(mime: string): string {
  const at = mime.indexOf('Content-Type: text/calendar');
  const body = mime.slice(mime.indexOf('\r\n\r\n', at) + 4).split('\r\n--')[0]!;
  const bin = atob(body.replace(/\r\n/g, ''));
  const text = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  return text.replace(/\r\n /g, ''); // unfold RFC 5545 continuation lines
}

function summaries(outbox: DevOutbox): string[] {
  return outbox.sent.map((m) => /SUMMARY:(.*)/.exec(ics(m.mime))![1]!.trim());
}

async function createOutput(
  token: string,
  familyId: string,
  memberId: string,
  body: Record<string, unknown>,
) {
  return call(`/families/${familyId}/members/${memberId}/email-outputs`, authed(token, body));
}

/** Add an output and open its verification link, as the recipient would. */
async function verifiedOutput(
  token: string,
  familyId: string,
  memberId: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await createOutput(token, familyId, memberId, body);
  expect(res.status).toBe(201);
  const { output, devToken } = (await res.json()) as { output: { id: string }; devToken: string };
  const confirmed = await call(`/email-outputs/verify/${devToken}`, { method: 'POST' });
  expect(confirmed.status).toBe(200);
  return output;
}

async function insertEvent(
  db: Db,
  familyId: string,
  familyMemberId: string,
  values: Partial<typeof calendarEvents.$inferInsert> & { synthKey: string },
) {
  const payload = {
    dtstart: values.dtstart ?? new Date('2026-07-06T15:30:00Z'),
    dtend: values.dtend === undefined ? new Date('2026-07-06T16:30:00Z') : values.dtend,
    allDay: false,
    summary: values.summary ?? 'Event',
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
        linkId: values.linkId ?? null,
        taskId: values.taskId ?? null,
        contentHash: hashCalendarEvent(payload as never),
        ...payload,
        synthKey: values.synthKey,
      })
      .returning()
  )[0]!;
}

/**
 * A caretaker's calendar with one of each kind: a schedule event and a busy
 * block from their own linked calendars, a claimed drop-off and a claimed
 * attendance (both generated from the child's school calendar).
 */
async function seedCalendar(db: Db, fam: Awaited<ReturnType<typeof setupFamily>>) {
  const link = async (memberId: string) => {
    const feed = (
      await db
        .insert(feeds)
        .values({
          familyId: fam.familyId,
          kind: 'ics',
          url: `https://example.com/${crypto.randomUUID()}.ics`,
          mode: 'standard',
        })
        .returning()
    )[0]!;
    return (
      await db
        .insert(familyMemberFeeds)
        .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId: memberId })
        .returning()
    )[0]!;
  };
  const ownLink = await link(fam.adminMemberId);
  const busyLink = await link(fam.adminMemberId);
  const schoolLink = await link(fam.childId);

  const school = await insertEvent(db, fam.familyId, fam.childId, {
    synthKey: `bl:${schoolLink.id}:2026-07-06`,
    linkId: schoolLink.id,
    summary: 'School day',
  });
  const claim = async (type: 'dropoff' | 'attendance', summary: string, hour: number) => {
    const task = (
      await db
        .insert(tasks)
        .values({
          familyId: fam.familyId,
          calendarEventId: school.id,
          familyMemberId: fam.childId,
          type,
          ...(type === 'attendance' ? { attendanceRequirement: 'any' as const } : {}),
          dtstart: new Date(`2026-07-06T${hour}:00:00Z`),
          dtend: new Date(`2026-07-06T${hour}:30:00Z`),
          status: 'owned',
          createdVia: 'generated',
        })
        .returning()
    )[0]!;
    await db.insert(taskOwners).values({ taskId: task.id, familyMemberId: fam.adminMemberId });
    return insertEvent(db, fam.familyId, fam.adminMemberId, {
      synthKey: `task:${task.id}`,
      provenance: 'claimed_task',
      taskId: task.id,
      summary,
      dtstart: new Date(`2026-07-06T${hour}:00:00Z`),
      dtend: new Date(`2026-07-06T${hour}:30:00Z`),
    });
  };
  const dropoff = await claim('dropoff', 'Drop-off', 14);
  const recital = await claim('attendance', 'Recital', 18);
  const meeting = await insertEvent(db, fam.familyId, fam.adminMemberId, {
    synthKey: `ev:${ownLink.id}:m1`,
    linkId: ownLink.id,
    summary: 'Book club',
    dtstart: new Date('2026-07-06T20:00:00Z'),
    dtend: new Date('2026-07-06T21:00:00Z'),
  });
  const busy = await insertEvent(db, fam.familyId, fam.adminMemberId, {
    synthKey: `fb:${busyLink.id}:b1`,
    linkId: busyLink.id,
    summary: 'Busy (work)',
    dtstart: new Date('2026-07-06T16:00:00Z'),
    dtend: new Date('2026-07-06T17:00:00Z'),
  });
  return { ownLink, busyLink, schoolLink, dropoff, recital, meeting, busy };
}

describe('email output routes', () => {
  it('sends nothing until the address confirms, and a prefetch does not confirm', async () => {
    const fam = await setupFamily('eo-verify@example.com');
    const db = getDb(env.DB);
    const res = await createOutput(fam.admin.token, fam.familyId, fam.adminMemberId, {
      email: 'Grandma@Example.com',
      label: 'Grandma',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      output: { id: string; email: string; verified: boolean; filters: EmailOutputFilters };
      verificationSent: boolean;
      devToken: string;
    };
    expect(body.output.email).toBe('grandma@example.com');
    expect(body.output.verified).toBe(false);
    expect(body.output.filters).toEqual({
      include: ['claimed_task'],
      taskTypes: null,
      sourceLinkIds: null,
    });
    expect(body.verificationSent).toBe(true);

    // An unverified output sends no invites.
    await seedCalendar(db, fam);
    const outbox = new DevOutbox();
    await syncMemberEmailOutputs(db, outbox, fam.adminMemberId, NOW);
    expect(outbox.sent).toHaveLength(0);

    // Opening the link (GET — what a mail scanner does) only shows a button.
    const page = await call(`/email-outputs/verify/${body.devToken}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post">');
    const [stillPending] = await db
      .select()
      .from(emailOutputs)
      .where(eq(emailOutputs.id, body.output.id));
    expect(stillPending!.verifiedAt).toBeNull();

    // Pressing it verifies; the token is then spent.
    const confirmed = await call(`/email-outputs/verify/${body.devToken}`, { method: 'POST' });
    expect(confirmed.status).toBe(200);
    const again = await call(`/email-outputs/verify/${body.devToken}`, { method: 'POST' });
    expect(again.status).toBe(410);

    const list = await call(
      `/families/${fam.familyId}/members/${fam.adminMemberId}/email-outputs`,
      bearer(fam.admin.token),
    );
    const { outputs, emailEnabled } = (await list.json()) as {
      outputs: { verified: boolean }[];
      emailEnabled: boolean;
    };
    expect(outputs.map((o) => o.verified)).toEqual([true]);
    // No `send_email` binding in tests: the reconcile the confirmation
    // enqueued must not have recorded captured mail as sent.
    expect(emailEnabled).toBe(false);
    expect(await db.select().from(emailOutputMirrors)).toHaveLength(0);
  });

  it('caps verification mail per user per day, and deleting does not refund it', async () => {
    const fam = await setupFamily('eo-cap@example.com');
    const db = getDb(env.DB);
    for (let i = 0; i < EMAIL_VERIFICATION_DAILY_CAP - 1; i++) {
      const r = await createOutput(fam.admin.token, fam.familyId, fam.adminMemberId, {
        email: `stranger${i}@example.com`,
      });
      expect(r.status).toBe(201);
    }
    // Spend the last one on the child, then take it back.
    const last = await createOutput(fam.admin.token, fam.familyId, fam.childId, {
      email: 'last@example.com',
    });
    const { output } = (await last.json()) as { output: { id: string } };
    const removed = await call(
      `/families/${fam.familyId}/members/${fam.childId}/email-outputs/${output.id}`,
      del(fam.admin.token),
    );
    expect(removed.status).toBe(200);

    const over = await createOutput(fam.admin.token, fam.familyId, fam.childId, {
      email: 'one-too-many@example.com',
    });
    expect(over.status).toBe(429);
    // Refused ⇒ no half-made output left behind that could never verify.
    const rows = await db
      .select()
      .from(emailOutputs)
      .where(eq(emailOutputs.email, 'one-too-many@example.com'));
    expect(rows).toHaveLength(0);

    // Resending counts too.
    const first = (
      await db.select().from(emailOutputs).where(eq(emailOutputs.email, 'stranger0@example.com'))
    )[0]!;
    const resend = await call(
      `/families/${fam.familyId}/members/${fam.adminMemberId}/email-outputs/${first.id}/resend-verification`,
      authed(fam.admin.token),
    );
    expect(resend.status).toBe(429);
  });

  it('reuses a verification the same user already completed for that address', async () => {
    const fam = await setupFamily('eo-reuse@example.com');
    await verifiedOutput(fam.admin.token, fam.familyId, fam.adminMemberId, {
      email: 'nanny@example.com',
    });
    const second = await createOutput(fam.admin.token, fam.familyId, fam.childId, {
      email: 'nanny@example.com',
      filters: { include: ['schedule'] },
    });
    expect(second.status).toBe(201);
    const body = (await second.json()) as {
      output: { verified: boolean };
      verificationSent: boolean;
    };
    expect(body.output.verified).toBe(true);
    expect(body.verificationSent).toBe(false);

    // …but only for that user: someone else adding the address must verify it.
    const other = await setupFamily('eo-reuse-other@example.com');
    const theirs = await createOutput(other.admin.token, other.familyId, other.adminMemberId, {
      email: 'nanny@example.com',
    });
    const theirBody = (await theirs.json()) as { output: { verified: boolean } };
    expect(theirBody.output.verified).toBe(false);

    const dup = await createOutput(fam.admin.token, fam.familyId, fam.childId, {
      email: 'nanny@example.com',
    });
    expect(dup.status).toBe(409);
  });

  it('is managed only by the member or an admin for an unlinked member', async () => {
    const fam = await setupFamily('eo-perm@example.com');
    const partner = await login('eo-perm-partner@example.com');
    const add = await call(
      `/families/${fam.familyId}/members`,
      authed(fam.admin.token, { relationName: 'partner', isCaretaker: true }),
    );
    const { member } = (await add.json()) as { member: { id: string } };
    await linkMember(fam.admin.token, fam.familyId, member.id, partner.token);

    // Admin → the partner's own member: private to the partner.
    expect(
      (await createOutput(fam.admin.token, fam.familyId, member.id, { email: 'x@example.com' }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          `/families/${fam.familyId}/members/${member.id}/email-outputs`,
          bearer(fam.admin.token),
        )
      ).status,
    ).toBe(403);
    // Non-admin partner → the child: not theirs to configure.
    expect(
      (await createOutput(partner.token, fam.familyId, fam.childId, { email: 'y@example.com' }))
        .status,
    ).toBe(403);
    // Partner → themselves: fine.
    expect(
      (await createOutput(partner.token, fam.familyId, member.id, { email: 'z@example.com' }))
        .status,
    ).toBe(201);
  });

  it("refuses a source filter naming a calendar that isn't the member's", async () => {
    const fam = await setupFamily('eo-links@example.com');
    const db = getDb(env.DB);
    const cal = await seedCalendar(db, fam);
    const res = await createOutput(fam.admin.token, fam.familyId, fam.adminMemberId, {
      email: 'links@example.com',
      filters: { include: ['schedule'], sourceLinkIds: [cal.ownLink.id, cal.schoolLink.id] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'unknown_source',
      linkIds: [cal.schoolLink.id],
    });
  });
});

describe('email output reconcile', () => {
  it('invites only what the filter selects, and re-filtering cancels the rest', async () => {
    const fam = await setupFamily('eo-filter@example.com');
    const db = getDb(env.DB);
    const cal = await seedCalendar(db, fam);
    const output = await verifiedOutput(fam.admin.token, fam.familyId, fam.adminMemberId, {
      email: 'claims@example.com',
    });

    // Default filter: claimed tasks only — no schedule, no busy blocks.
    const outbox = new DevOutbox();
    const r1 = await syncMemberEmailOutputs(db, outbox, fam.adminMemberId, NOW);
    expect(r1.created).toBe(2);
    expect(summaries(outbox)).toEqual(['Drop-off', 'Recital']);
    expect(outbox.sent.every((m) => m.to === 'claims@example.com')).toBe(true);
    expect(ics(outbox.sent[0]!.mime)).toContain('METHOD:REQUEST');
    expect(ics(outbox.sent[0]!.mime)).toContain(`UID:igt-em-${output.id}-${cal.dropoff.id}`);

    // Unchanged ⇒ nothing re-sent.
    const quiet = new DevOutbox();
    await syncMemberEmailOutputs(db, quiet, fam.adminMemberId, NOW);
    expect(quiet.sent).toHaveLength(0);

    // Narrow to attendance only, from the school calendar: the drop-off is cancelled.
    const patchedRes = await call(
      `/families/${fam.familyId}/members/${fam.adminMemberId}/email-outputs/${output.id}`,
      patched(fam.admin.token, {
        filters: {
          include: ['claimed_task'],
          taskTypes: ['attendance'],
          sourceLinkIds: [cal.schoolLink.id],
        },
      }),
    );
    // The school calendar is the child's, not the caretaker's, so the source
    // filter can't name it on the caretaker's output.
    expect(patchedRes.status).toBe(400);
    await call(
      `/families/${fam.familyId}/members/${fam.adminMemberId}/email-outputs/${output.id}`,
      patched(fam.admin.token, {
        filters: { include: ['claimed_task'], taskTypes: ['attendance'] },
      }),
    );
    const narrowed = new DevOutbox();
    const r2 = await syncMemberEmailOutputs(db, narrowed, fam.adminMemberId, NOW);
    expect(r2.removed).toBe(1);
    expect(narrowed.sent).toHaveLength(1);
    expect(ics(narrowed.sent[0]!.mime)).toContain('METHOD:CANCEL');
    expect(summaries(narrowed)).toEqual(['Drop-off']);

    // Schedule from one linked calendar, never the busy blocks.
    await call(
      `/families/${fam.familyId}/members/${fam.adminMemberId}/email-outputs/${output.id}`,
      patched(fam.admin.token, {
        filters: {
          include: ['schedule', 'busy'],
          sourceLinkIds: [cal.ownLink.id],
        },
      }),
    );
    const schedule = new DevOutbox();
    await syncMemberEmailOutputs(db, schedule, fam.adminMemberId, NOW);
    // Recital cancelled; Book club invited; the busy block's link isn't listed.
    expect(summaries(schedule).sort()).toEqual(['Book club', 'Recital']);
    const mirrors = await db
      .select()
      .from(emailOutputMirrors)
      .where(eq(emailOutputMirrors.emailOutputId, output.id));
    expect(mirrors.map((m) => m.calendarEventId)).toEqual([cal.meeting.id]);
  });

  it('includes busy blocks only when asked', async () => {
    const fam = await setupFamily('eo-busy@example.com');
    const db = getDb(env.DB);
    await seedCalendar(db, fam);
    await verifiedOutput(fam.admin.token, fam.familyId, fam.adminMemberId, {
      email: 'busy@example.com',
      filters: { include: ['busy'] },
    });
    const outbox = new DevOutbox();
    await syncMemberEmailOutputs(db, outbox, fam.adminMemberId, NOW);
    expect(summaries(outbox)).toEqual(['Busy (work)']);
  });

  it('forgets finished events without mailing a cancellation, and skips the past', async () => {
    const fam = await setupFamily('eo-past@example.com');
    const db = getDb(env.DB);
    await seedCalendar(db, fam);
    await verifiedOutput(fam.admin.token, fam.familyId, fam.adminMemberId, {
      email: 'past@example.com',
    });
    await syncMemberEmailOutputs(db, new DevOutbox(), fam.adminMemberId, NOW);
    expect(await db.select().from(emailOutputMirrors)).toHaveLength(2);

    // A week later both claims are over: rows dropped, nothing mailed.
    const later = new DevOutbox();
    await syncMemberEmailOutputs(db, later, fam.adminMemberId, new Date('2026-07-08T00:00:00Z'));
    expect(later.sent).toHaveLength(0);
    expect(await db.select().from(emailOutputMirrors)).toHaveLength(0);
  });

  it('holds events past the horizon back, and paces a backlog', async () => {
    const fam = await setupFamily('eo-pace@example.com');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({ familyId: fam.familyId, kind: 'ics', url: 'https://example.com/b.ics', mode: 'standard' })
        .returning()
    )[0]!;
    const link = (
      await db
        .insert(familyMemberFeeds)
        .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId: fam.childId })
        .returning()
    )[0]!;
    const total = EMAIL_INVITE_SENDS_PER_RUN + 5;
    for (let d = 0; d < total; d++) {
      const start = new Date(NOW.getTime() + (d + 1) * 24 * 3600_000);
      await insertEvent(db, fam.familyId, fam.childId, {
        synthKey: `bl:${link.id}:${d}`,
        linkId: link.id,
        summary: `Day ${d}`,
        dtstart: start,
        dtend: new Date(start.getTime() + 3600_000),
      });
    }
    await insertEvent(db, fam.familyId, fam.childId, {
      synthKey: `bl:${link.id}:far`,
      linkId: link.id,
      summary: 'Far future',
      dtstart: new Date('2026-12-01T15:00:00Z'),
      dtend: new Date('2026-12-01T16:00:00Z'),
    });
    await verifiedOutput(fam.admin.token, fam.familyId, fam.childId, {
      email: 'pace@example.com',
      filters: { include: ['schedule'] },
    });

    const first = new DevOutbox();
    await syncMemberEmailOutputs(db, first, fam.childId, NOW);
    expect(first.sent).toHaveLength(EMAIL_INVITE_SENDS_PER_RUN);
    // Nearest first.
    expect(summaries(first)[0]).toBe('Day 0');
    const second = new DevOutbox();
    await syncMemberEmailOutputs(db, second, fam.childId, NOW);
    expect(second.sent).toHaveLength(5);
    expect(summaries(second)).not.toContain('Far future');
  });

  it('pausing cancels outstanding invites', async () => {
    const fam = await setupFamily('eo-pause@example.com');
    const db = getDb(env.DB);
    await seedCalendar(db, fam);
    const output = await verifiedOutput(fam.admin.token, fam.familyId, fam.adminMemberId, {
      email: 'pause@example.com',
    });
    await syncMemberEmailOutputs(db, new DevOutbox(), fam.adminMemberId, NOW);
    await call(
      `/families/${fam.familyId}/members/${fam.adminMemberId}/email-outputs/${output.id}`,
      patched(fam.admin.token, { active: false }),
    );
    const paused = new DevOutbox();
    const r = await syncMemberEmailOutputs(db, paused, fam.adminMemberId, NOW);
    expect(r.removed).toBe(2);
    expect(paused.sent.every((m) => ics(m.mime).includes('METHOD:CANCEL'))).toBe(true);
  });
});

describe('unsubscribing', () => {
  /** The unsubscribe URL from a captured mail's text part. */
  function unsubscribeLink(mime: string): string {
    const at = mime.indexOf('Content-Type: text/plain');
    const body = mime.slice(mime.indexOf('\r\n\r\n', at) + 4).split('\r\n--')[0]!;
    const bin = atob(body.replace(/\r\n/g, ''));
    const text = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
    return /(\/email\/unsubscribe\/[0-9a-f]+)/.exec(text)![1]!;
  }

  it('every invite carries the link, and opting out stops everything until undone', async () => {
    const fam = await setupFamily('eo-unsub@example.com');
    const db = getDb(env.DB);
    await seedCalendar(db, fam);
    const output = await verifiedOutput(fam.admin.token, fam.familyId, fam.adminMemberId, {
      email: 'optout@example.com',
    });
    const outbox = new DevOutbox();
    await syncMemberEmailOutputs(db, outbox, fam.adminMemberId, NOW, 'https://igt.test/api');
    expect(outbox.sent).toHaveLength(2);
    // One-click headers for mail clients' own Unsubscribe button.
    expect(outbox.sent[0]!.mime).toMatch(
      /^List-Unsubscribe: <https:\/\/igt\.test\/api\/email\/unsubscribe\/[0-9a-f]+>$/m,
    );
    expect(outbox.sent[0]!.mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    const link = unsubscribeLink(outbox.sent[0]!.mime);

    // GET (a mail scanner) changes nothing; POST — also what one-click sends — opts out.
    expect(await (await call(link)).text()).toContain('<form method="post">');
    const done = await call(link, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(done.status).toBe(200);
    const donePage = await done.text();
    expect(donePage).toContain('Undo');

    // The person who set it up can see why the invites stopped.
    const listed = await call(
      `/families/${fam.familyId}/members/${fam.adminMemberId}/email-outputs`,
      bearer(fam.admin.token),
    );
    const { outputs } = (await listed.json()) as {
      outputs: { id: string; unsubscribed: boolean; unsubscribedAt: string | null }[];
    };
    expect(outputs).toEqual([
      expect.objectContaining({ id: output.id, unsubscribed: true, unsubscribedAt: expect.any(String) }),
    ]);
    // Re-adding it elsewhere is refused even for the user who already verified it
    // (that path mails nothing, so it must check too).
    const readd = await createOutput(fam.admin.token, fam.familyId, fam.childId, {
      email: 'optout@example.com',
    });
    expect(readd.status).toBe(409);

    // Nothing more is mailed — not even the cancellations a narrowed filter would send…
    await call(
      `/families/${fam.familyId}/members/${fam.adminMemberId}/email-outputs/${output.id}`,
      patched(fam.admin.token, { filters: { include: ['busy'] } }),
    );
    const silent = new DevOutbox();
    await syncMemberEmailOutputs(db, silent, fam.adminMemberId, NOW);
    expect(silent.sent).toHaveLength(0);
    // …and nobody can send the address a new confirmation request.
    const other = await setupFamily('eo-unsub-other@example.com');
    const refused = await createOutput(other.admin.token, other.familyId, other.adminMemberId, {
      email: 'optout@example.com',
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'recipient_unsubscribed' });

    // Reopening the link offers the undo; taking it resumes the confirmed output.
    const revisit = await (await call(link)).text();
    expect(revisit).toContain('Allow them again');
    const token = link.split('/').pop()!;
    const undone = await call(`/email/resubscribe/${token}`, { method: 'POST' });
    expect(undone.status).toBe(200);
    const relisted = (await (
      await call(
        `/families/${fam.familyId}/members/${fam.adminMemberId}/email-outputs`,
        bearer(fam.admin.token),
      )
    ).json()) as { outputs: { unsubscribed: boolean }[] };
    expect(relisted.outputs[0]!.unsubscribed).toBe(false);
    const resumed = new DevOutbox();
    await syncMemberEmailOutputs(db, resumed, fam.adminMemberId, NOW);
    // The filter now picks the busy block; the two claims are cancelled.
    expect(resumed.sent).toHaveLength(3);
  });

  it('the confirmation request itself can be unsubscribed from', async () => {
    const fam = await setupFamily('eo-unsub-verify@example.com');
    const outbox = new DevOutbox();
    const db = getDb(env.DB);
    const [member] = await db
      .select()
      .from(familyMembers)
      .where(eq(familyMembers.id, fam.adminMemberId));
    const [row] = await db
      .insert(emailOutputs)
      .values({
        familyId: fam.familyId,
        familyMemberId: fam.adminMemberId,
        email: 'stranger@example.com',
        filters: { include: ['claimed_task'], taskTypes: null, sourceLinkIds: null },
      })
      .returning();
    await sendVerification(db, outbox, {
      userId: fam.admin.userId,
      output: row!,
      memberName: member!.relationName,
      requesterName: 'Admin',
      linkBase: 'https://igt.test/api',
    });
    const mime = outbox.sent[0]!.mime;
    expect(mime).toMatch(/^List-Unsubscribe: <https:\/\/igt\.test\/api\/email\/unsubscribe\//m);
    const link = /igt\.test\/api(\/email\/unsubscribe\/[0-9a-f]+)/.exec(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(
            mime
              .slice(mime.indexOf('\r\n\r\n', mime.indexOf('Content-Type: text/plain')) + 4)
              .replace(/\r\n/g, ''),
          ),
          (ch) => ch.charCodeAt(0),
        ),
      ),
    )![1]!;
    expect((await call(link, { method: 'POST' })).status).toBe(200);
    await expect(
      sendVerification(db, outbox, {
        userId: fam.admin.userId,
        output: row!,
        memberName: 'x',
        requesterName: 'y',
        linkBase: '',
      }),
    ).rejects.toThrow(/unsubscribed/);
  });

  it('an unknown token is refused', async () => {
    expect((await call('/email/unsubscribe/deadbeef', { method: 'POST' })).status).toBe(404);
  });
});
