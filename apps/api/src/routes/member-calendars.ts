import {
  and,
  calendarEvents,
  eq,
  externalAccounts,
  familyMembers,
  getDb,
  memberCalendars,
} from '@igt/db';
import { SetMemberCalendarTargetInput } from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { googleRefresherFor } from '../lib/google-oauth.js';
import { requireFamilyMember } from '../middleware/auth.js';
import {
  deferSync,
  enqueueReconcile,
  getProductionRegistry,
  purgeMemberMirror,
} from '../services/mirror.js';
import { readBackMember } from '../services/readback.js';

/**
 * A member's unified-calendar target: the ONE writable external calendar their
 * synthesized + claimed events mirror to (and human events read back from).
 * Mounted under /families/:familyId (auth applied by parent router).
 */
export const memberCalendarRoutes = new Hono<HonoEnv>();
memberCalendarRoutes.use('*', requireFamilyMember);

async function loadMember(
  db: ReturnType<typeof getDb>,
  familyId: string,
  memberId: string,
) {
  return (
    await db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.id, memberId), eq(familyMembers.familyId, familyId)))
      .limit(1)
  )[0];
}

/**
 * Who may manage a member's target: the member themselves (their linked user)
 * or a family admin — but the credential constraint is stricter: the target
 * must draw from an account the CALLER owns, and a member linked to a
 * different user keeps their calendar config private from admins (PRD §6).
 */
function mayManage(
  me: { id: string; isAdmin: boolean },
  target: { id: string; userId: string | null },
): boolean {
  if (target.id === me.id) return true;
  // Admins configure unlinked members (children, helpers without logins);
  // another user's own member config stays theirs.
  return me.isAdmin && target.userId == null;
}

/** Read a member's target config (any family member). */
memberCalendarRoutes.get('/members/:memberId/calendar-target', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);
  const cal = (
    await db
      .select()
      .from(memberCalendars)
      .where(eq(memberCalendars.familyMemberId, member.id))
      .limit(1)
  )[0];
  return c.json({ target: cal ?? null });
});

/**
 * Set (or replace) a member's target calendar. The account must belong to the
 * caller — user-level credentials are never shared — and its kind decides the
 * mirror method. Replacing a target purges the old one's mirrored events first
 * (in the background) so the remote calendar is left clean.
 */
memberCalendarRoutes.put('/members/:memberId/calendar-target', async (c) => {
  const parsed = SetMemberCalendarTargetInput.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);
  if (!mayManage(me, member)) return c.json({ error: 'forbidden' }, 403);

  const account = (
    await db
      .select()
      .from(externalAccounts)
      .where(
        and(
          eq(externalAccounts.id, parsed.data.externalAccountId),
          eq(externalAccounts.userId, c.get('user').id),
        ),
      )
      .limit(1)
  )[0];
  if (!account) return c.json({ error: 'account_not_found' }, 404);
  const targetMethod = account.kind === 'google' ? 'google' : 'caldav';

  const prior = (
    await db
      .select()
      .from(memberCalendars)
      .where(eq(memberCalendars.familyMemberId, member.id))
      .limit(1)
  )[0];

  const values = {
    targetExternalAccountId: account.id,
    targetMethod,
    targetCalendarId: parsed.data.targetCalendarId,
    targetCalendarName: parsed.data.targetCalendarName ?? null,
    alertMinutes: parsed.data.alertMinutes ?? null,
    timezone: parsed.data.timezone ?? null,
    active: true,
  } as const;

  // Retargeting to a different calendar: cancel our events off the old one
  // first (skip when it's the same calendar — the reconcile heals in place).
  const sameCalendar =
    !!prior &&
    prior.targetCalendarId === parsed.data.targetCalendarId &&
    prior.targetExternalAccountId === account.id;
  const timezoneChanged = sameCalendar && prior!.timezone !== values.timezone;

  let row;
  if (prior) {
    if (!sameCalendar) {
      deferSync(
        c.executionCtx,
        purgeMemberMirror(db, getProductionRegistry(c.env), c.env.KEK, prior),
      );
    }
    row = (
      await db
        .update(memberCalendars)
        .set(values)
        .where(eq(memberCalendars.id, prior.id))
        .returning()
    )[0]!;
  } else {
    row = (
      await db
        .insert(memberCalendars)
        .values({ familyId: me.familyId, familyMemberId: member.id, ...values })
        .returning()
    )[0]!;
  }

  if (timezoneChanged) {
    // The target calendar's own data may be byte-for-byte unchanged (this is
    // a manual correction, not a source-side edit) — read back now so
    // already-stored (wrong) floating-time human events get reinterpreted,
    // rather than waiting for the next cron tick.
    try {
      await readBackMember(db, row, { kek: c.env.KEK, googleRefresh: googleRefresherFor(c.env) });
    } catch {
      // Best-effort — a failed read-back here shouldn't block the target
      // change that already committed; the next cron tick retries it.
    }
  }

  // Mirror the member's existing unified calendar onto the new target (queued).
  enqueueReconcile(c, { kind: 'member', memberId: member.id });
  return c.json({ target: row }, prior ? 200 : 201);
});

/**
 * Remove a member's target. Their mirrored events are cancelled remotely (in
 * the background) and their read-back `human` events remain in the unified
 * calendar until the next read-back... which never comes — so they're dropped
 * here: without the target they can no longer be observed.
 */
memberCalendarRoutes.delete('/members/:memberId/calendar-target', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const member = await loadMember(db, me.familyId, c.req.param('memberId'));
  if (!member) return c.json({ error: 'not_found' }, 404);
  if (!mayManage(me, member)) return c.json({ error: 'forbidden' }, 403);

  const cal = (
    await db
      .select()
      .from(memberCalendars)
      .where(eq(memberCalendars.familyMemberId, member.id))
      .limit(1)
  )[0];
  if (!cal) return c.json({ error: 'not_found' }, 404);

  // Cancel our remote events while the credential row still tells us where.
  deferSync(
    c.executionCtx,
    purgeMemberMirror(db, getProductionRegistry(c.env), c.env.KEK, cal),
  );
  await db.delete(memberCalendars).where(eq(memberCalendars.id, cal.id));

  await db
    .delete(calendarEvents)
    .where(
      and(
        eq(calendarEvents.familyMemberId, member.id),
        eq(calendarEvents.provenance, 'human'),
      ),
    );
  return c.json({ ok: true });
});
