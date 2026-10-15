import {
  absenceNoticeSettings,
  absenceNotices,
  and,
  calendarEvents,
  eq,
  familyMemberFeeds,
  getDb,
} from '@igt/db';
import {
  AbsenceNoticeSettingsInput,
  DEFAULT_ABSENCE_BODY,
  DEFAULT_ABSENCE_SUBJECT,
  MarkAbsenceNoticeSentInput,
} from '@igt/domain';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { HonoEnv } from '../env.js';
import { requireAdmin, requireFamilyMember } from '../middleware/auth.js';
import {
  isOutstanding,
  loadAbsenceNotices,
  noticeForEvent,
  publicNotice,
} from '../services/absence-notices.js';

/**
 * Mounted under /families/:familyId (auth applied by the parent router).
 *
 * "Email school" absence notices. The server never sends anything: it
 * computes the composed notice, and records that a caretaker says they sent it.
 * Reading, composing and marking sent are open to any caretaker in the family;
 * the recipient/template settings are admin-only (like other per-link config).
 */
export const absenceNoticeRoutes = new Hono<HonoEnv>();
absenceNoticeRoutes.use('*', requireFamilyMember);

/** Dependents (a child with a login) can't send mail on the family's behalf. */
const requireCaretaker = createMiddleware<HonoEnv>(async (c, next) => {
  if (!c.get('member').isCaretaker) return c.json({ error: 'forbidden_caretaker' }, 403);
  await next();
});

// --- Settings (per child↔school-calendar link, admin-only) ------------------

async function loadLink(
  db: ReturnType<typeof getDb>,
  familyId: string,
  feedId: string,
  linkId: string,
) {
  return (
    await db
      .select()
      .from(familyMemberFeeds)
      .where(
        and(
          eq(familyMemberFeeds.id, linkId),
          eq(familyMemberFeeds.feedId, feedId),
          eq(familyMemberFeeds.familyId, familyId),
        ),
      )
      .limit(1)
  )[0];
}

function settingsBody(row: typeof absenceNoticeSettings.$inferSelect | undefined) {
  return {
    to: row?.toAddresses ?? [],
    cc: row?.ccAddresses ?? [],
    subjectTemplate: row?.subjectTemplate ?? DEFAULT_ABSENCE_SUBJECT,
    bodyTemplate: row?.bodyTemplate ?? DEFAULT_ABSENCE_BODY,
    includeReason: row?.includeReason ?? false,
    // What "Reset wording" goes back to, so clients don't duplicate the text.
    defaults: { subjectTemplate: DEFAULT_ABSENCE_SUBJECT, bodyTemplate: DEFAULT_ABSENCE_BODY },
    // No recipient ⇒ the whole feature is off for this link.
    enabled: (row?.toAddresses.length ?? 0) + (row?.ccAddresses.length ?? 0) > 0,
  };
}

absenceNoticeRoutes.get(
  '/feeds/:feedId/member-links/:linkId/absence-notice-settings',
  requireAdmin,
  async (c) => {
    const db = getDb(c.env.DB);
    const link = await loadLink(
      db,
      c.get('member').familyId,
      c.req.param('feedId'),
      c.req.param('linkId'),
    );
    if (!link) return c.json({ error: 'not_found' }, 404);
    const row = (
      await db
        .select()
        .from(absenceNoticeSettings)
        .where(eq(absenceNoticeSettings.linkId, link.id))
        .limit(1)
    )[0];
    return c.json({ settings: settingsBody(row) });
  },
);

absenceNoticeRoutes.put(
  '/feeds/:feedId/member-links/:linkId/absence-notice-settings',
  requireAdmin,
  async (c) => {
    const parsed = AbsenceNoticeSettingsInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    const db = getDb(c.env.DB);
    const familyId = c.get('member').familyId;
    const link = await loadLink(db, familyId, c.req.param('feedId'), c.req.param('linkId'));
    if (!link) return c.json({ error: 'not_found' }, 404);
    const v = {
      toAddresses: parsed.data.to,
      ccAddresses: parsed.data.cc,
      // A blank template falls back to the default rather than mailing nothing.
      subjectTemplate: parsed.data.subjectTemplate || DEFAULT_ABSENCE_SUBJECT,
      bodyTemplate: parsed.data.bodyTemplate.trim() ? parsed.data.bodyTemplate : DEFAULT_ABSENCE_BODY,
      includeReason: parsed.data.includeReason,
    };
    const row = (
      await db
        .insert(absenceNoticeSettings)
        .values({ familyId, linkId: link.id, ...v })
        .onConflictDoUpdate({ target: absenceNoticeSettings.linkId, set: v })
        .returning()
    )[0];
    return c.json({ settings: settingsBody(row) });
  },
);

// --- Notices (any caretaker) -----------------------------------------------

/** The member composing: `{parent}` is their relationName, never their account name. */
async function notices(c: {
  get: (k: 'member') => { familyId: string; relationName: string };
  env: { DB: D1Database };
}) {
  const me = c.get('member');
  return loadAbsenceNotices(getDb(c.env.DB), [me.familyId], {
    composerName: me.relationName,
  });
}

/**
 * Outstanding notices for Home: eligible, not sent for the current gap, and the
 * school day hasn't ended. `?all=true` also lists the sent ones.
 */
absenceNoticeRoutes.get('/absence-notices', requireCaretaker, async (c) => {
  const now = new Date();
  const all = (await notices(c)).filter((n) => c.req.query('all') === 'true' || isOutstanding(n, now));
  return c.json({ notices: all.map(publicNotice) });
});

async function eventInFamily(c: {
  get: (k: 'member') => { familyId: string };
  env: { DB: D1Database };
  req: { param: (k: string) => string };
}) {
  return (
    await getDb(c.env.DB)
      .select({
        id: calendarEvents.id,
        familyMemberId: calendarEvents.familyMemberId,
        synthKey: calendarEvents.synthKey,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.id, c.req.param('eventId')),
          eq(calendarEvents.familyId, c.get('member').familyId),
        ),
      )
      .limit(1)
  )[0];
}

/**
 * The composed notice for a calendar event: the appointment, the school day,
 * or one of its trimmed `cf:` segments. 200 with `available: false` when the
 * event has no notice (not a resolved school-day conflict, or no recipients).
 */
absenceNoticeRoutes.get('/calendar-events/:eventId/absence-notice', requireCaretaker, async (c) => {
  const event = await eventInFamily(c);
  if (!event) return c.json({ error: 'not_found' }, 404);
  const notice = noticeForEvent(await notices(c), event);
  if (!notice) return c.json({ available: false, reason: 'not_eligible' });
  return c.json({ available: true, ...publicNotice(notice) });
});

/**
 * Record that this caretaker sent the notice. Replaces any earlier record for
 * the same child + link + date, snapshotting the gap(s) as they stand now. If
 * the caller echoes the `gapStamp` it composed from and the times have moved
 * since, 409 — the email that went out no longer matches.
 */
absenceNoticeRoutes.post(
  '/calendar-events/:eventId/absence-notice/sent',
  requireCaretaker,
  async (c) => {
    const parsed = MarkAbsenceNoticeSentInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    const event = await eventInFamily(c);
    if (!event) return c.json({ error: 'not_found' }, 404);
    const notice = noticeForEvent(await notices(c), event);
    if (!notice) return c.json({ error: 'not_eligible' }, 409);
    if (parsed.data.gapStamp && parsed.data.gapStamp !== notice.gapStamp) {
      return c.json({ error: 'notice_changed' }, 409);
    }
    const me = c.get('member');
    const db = getDb(c.env.DB);
    const sentAt = new Date();
    const v = { sentByMemberId: me.id, sentAt, gapStamp: notice.gapStamp };
    await db
      .insert(absenceNotices)
      .values({
        familyId: me.familyId,
        familyMemberId: notice.familyMemberId,
        linkId: notice.linkId,
        date: notice.date,
        ...v,
      })
      .onConflictDoUpdate({
        target: [absenceNotices.familyMemberId, absenceNotices.linkId, absenceNotices.date],
        set: v,
      });
    return c.json({
      ok: true,
      state: 'sent',
      sentBy: me.relationName,
      sentAt,
    });
  },
);
