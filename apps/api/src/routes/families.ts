import { and, eq, families, familyMembers, getDb } from '@igt/db';
import {
  CreateFamilyInput,
  CreateFamilyMemberInput,
  UpdateFamilyInput,
  UpdateFamilyMemberInput,
} from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import {
  authMiddleware,
  requireAdmin,
  requireFamilyMember,
} from '../middleware/auth.js';
import { enqueueReconcile } from '../services/mirror.js';
import { rebuildMemberTasks } from '../services/task-gen.js';
import { createMemberClaimInvite } from '../services/invites.js';
import { feedRoutes } from './feeds.js';
import { memberCalendarRoutes } from './member-calendars.js';
import { taskRoutes } from './tasks.js';
import { taskRuleRoutes } from './task-rules.js';

export const familyRoutes = new Hono<HonoEnv>();

// Caretakers default to NOT generating claimable logistics tasks from their
// own events (they're the ones claiming, not the ones tasks get generated
// for); dependents default to generating them. Independent of claim
// eligibility, which stays gated on `isCaretaker` alone (see tasks.ts).
const defaultGeneratesFamilyTasks = (isCaretaker: boolean): boolean => !isCaretaker;

// Every family route requires a session.
familyRoutes.use('*', authMiddleware);

// Feed ingest routes live under /families/:familyId/feeds.
familyRoutes.route('/:familyId/feeds', feedRoutes);

// Tasks + pending decisions + calendar events under /families/:familyId/...
familyRoutes.route('/:familyId', taskRoutes);

// Per-member unified-calendar targets under /families/:familyId/members/...
familyRoutes.route('/:familyId', memberCalendarRoutes);

// Per-member task-rule pipeline under /families/:familyId/members/:memberId/task-rules.
familyRoutes.route('/:familyId', taskRuleRoutes);

/**
 * Create a family and seed the creator as an admin caretaker. (Prototype:
 * open creation; v1.1 gates this behind operator-issued `new_family` invites.)
 */
familyRoutes.post('/', async (c) => {
  const parsed = CreateFamilyInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }

  const db = getDb(c.env.DB);
  const user = c.get('user');
  const family = (
    await db.insert(families).values({ name: parsed.data.name }).returning()
  )[0]!;
  const member = (
    await db
      .insert(familyMembers)
      .values({
        familyId: family.id,
        userId: user.id,
        relationName: parsed.data.relationName,
        isCaretaker: true,
        isAdmin: true,
        requiresCaretaker: false,
        generatesFamilyTasks: defaultGeneratesFamilyTasks(true),
      })
      .returning()
  )[0]!;

  return c.json({ family, member }, 201);
});

/** Fetch the family row (any member) — carries the threading threshold. */
familyRoutes.get('/:familyId', requireFamilyMember, async (c) => {
  const db = getDb(c.env.DB);
  const family = (
    await db
      .select()
      .from(families)
      .where(eq(families.id, c.get('member').familyId))
      .limit(1)
  )[0];
  if (!family) return c.json({ error: 'not_found' }, 404);
  return c.json({ family });
});

/** Update family settings — name, threading threshold (admin). */
familyRoutes.patch('/:familyId', requireFamilyMember, requireAdmin, async (c) => {
  const parsed = UpdateFamilyInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const set: Partial<typeof families.$inferInsert> = {};
  if (parsed.data.name !== undefined) set.name = parsed.data.name;
  if (parsed.data.threadingThresholdMinutes !== undefined) {
    set.threadingThresholdMinutes = parsed.data.threadingThresholdMinutes;
  }
  if (Object.keys(set).length > 0) {
    await db.update(families).set(set).where(eq(families.id, familyId));
  }
  const family = (
    await db.select().from(families).where(eq(families.id, familyId)).limit(1)
  )[0]!;
  return c.json({ family });
});

/**
 * Delete the family (admin). FKs cascade: members, feeds, tasks, calendar
 * events, and calendar targets all go with it. `event_mirrors` rows
 * deliberately have no FK (see schema note) and are left behind — same
 * best-effort gap as member removal today; a future reconcile would need to
 * run before the cascade to cancel remote copies.
 */
familyRoutes.delete('/:familyId', requireFamilyMember, requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  await db.delete(families).where(eq(families.id, c.get('member').familyId));
  return c.body(null, 204);
});

/** List members of a family (any member). */
familyRoutes.get('/:familyId/members', requireFamilyMember, async (c) => {
  const db = getDb(c.env.DB);
  const members = await db
    .select()
    .from(familyMembers)
    .where(eq(familyMembers.familyId, c.req.param('familyId')));
  return c.json({ members });
});

/** Add a member — caretaker or dependent (admin only). */
familyRoutes.post(
  '/:familyId/members',
  requireFamilyMember,
  requireAdmin,
  async (c) => {
    const parsed = CreateFamilyMemberInput.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
    }

    const db = getDb(c.env.DB);
    const member = (
      await db
        .insert(familyMembers)
        .values({
          familyId: c.req.param('familyId'),
          userId: parsed.data.userId ?? null,
          relationName: parsed.data.relationName,
          isCaretaker: parsed.data.isCaretaker,
          isAdmin: parsed.data.isAdmin,
          requiresCaretaker: parsed.data.requiresCaretaker,
          generatesFamilyTasks:
            parsed.data.generatesFamilyTasks ??
            defaultGeneratesFamilyTasks(parsed.data.isCaretaker),
          color: parsed.data.color ?? null,
        })
        .returning()
    )[0]!;

    return c.json({ member }, 201);
  },
);

/**
 * Issue a member-claim invite (admin) — a share token that links whoever
 * accepts it (after logging in) to this pre-created member. Returns the token
 * plus an absolute deep-link `url` (when PUBLIC_ORIGIN is set) the client can
 * share directly. Works for users who already have an account (no new user is
 * created on accept).
 */
familyRoutes.post(
  '/:familyId/members/:memberId/invite',
  requireFamilyMember,
  requireAdmin,
  async (c) => {
    const db = getDb(c.env.DB);
    const me = c.get('member');
    const memberId = c.req.param('memberId');

    const member = (
      await db
        .select()
        .from(familyMembers)
        .where(and(eq(familyMembers.id, memberId), eq(familyMembers.familyId, me.familyId)))
        .limit(1)
    )[0];
    if (!member) return c.json({ error: 'not_found' }, 404);
    if (member.userId) return c.json({ error: 'already_linked' }, 409);

    const invite = await createMemberClaimInvite(db, me.familyId, memberId, me.id);
    // Compose the shareable deep-link URL from the deployment's public origin.
    // On iOS this opens the app (Universal Links); on web it drives the same
    // join flow via the existing `?invite=` parser. Local dev / tests have no
    // public origin ⇒ `url` is null and the client falls back to the raw token.
    const url = c.env.PUBLIC_ORIGIN
      ? `${c.env.PUBLIC_ORIGIN}/app/?invite=${invite.token}`
      : null;
    return c.json({ token: invite.token, expiresAt: invite.expiresAt, url }, 201);
  },
);

/**
 * Update a member. Admins may edit anyone (incl. role flags); a non-admin may
 * edit only their own display name — role/structure changes are admin-only.
 */
familyRoutes.patch('/:familyId/members/:memberId', requireFamilyMember, async (c) => {
  const parsed = UpdateFamilyMemberInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const memberId = c.req.param('memberId');

  const target = (
    await db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.id, memberId), eq(familyMembers.familyId, me.familyId)))
      .limit(1)
  )[0];
  if (!target) return c.json({ error: 'not_found' }, 404);

  const d = parsed.data;
  const changingFlags =
    d.isCaretaker !== undefined ||
    d.isAdmin !== undefined ||
    d.requiresCaretaker !== undefined ||
    d.generatesFamilyTasks !== undefined;
  if (!me.isAdmin) {
    if (memberId !== me.id) return c.json({ error: 'forbidden' }, 403);
    if (changingFlags) return c.json({ error: 'forbidden_roles' }, 403);
  }

  const set: Partial<typeof familyMembers.$inferInsert> = {};
  if (d.relationName !== undefined) set.relationName = d.relationName;
  // Accent color isn't a role flag — the member (or an admin) may set their own.
  if (d.color !== undefined) set.color = d.color;
  if (me.isAdmin) {
    if (d.isCaretaker !== undefined) set.isCaretaker = d.isCaretaker;
    if (d.isAdmin !== undefined) set.isAdmin = d.isAdmin;
    if (d.requiresCaretaker !== undefined) set.requiresCaretaker = d.requiresCaretaker;
    if (d.generatesFamilyTasks !== undefined) set.generatesFamilyTasks = d.generatesFamilyTasks;
  }
  if (Object.keys(set).length > 0) {
    await db.update(familyMembers).set(set).where(eq(familyMembers.id, memberId));
  }
  const updated = (
    await db.select().from(familyMembers).where(eq(familyMembers.id, memberId)).limit(1)
  )[0]!;

  // Toggling generation on/off changes the member's tasks; rebuild them.
  if (d.generatesFamilyTasks !== undefined) {
    await rebuildMemberTasks(db, memberId);
  }

  // The child's name appears in event titles — reconcile calendars off the
  // request path (queue when deployed) so the edit doesn't block on slow writes.
  enqueueReconcile(c, { kind: 'family', familyId: me.familyId });
  return c.json({ member: updated });
});

/**
 * Remove a member from the family (admin). Member FKs cascade, so their tasks,
 * calendar targets, and feed links are cleaned up. You can't remove yourself,
 * and the last remaining admin can't be removed (avoid orphaning the family).
 */
familyRoutes.delete(
  '/:familyId/members/:memberId',
  requireFamilyMember,
  requireAdmin,
  async (c) => {
    const db = getDb(c.env.DB);
    const me = c.get('member');
    const memberId = c.req.param('memberId');
    if (memberId === me.id) return c.json({ error: 'cannot_remove_self' }, 409);

    const target = (
      await db
        .select()
        .from(familyMembers)
        .where(and(eq(familyMembers.id, memberId), eq(familyMembers.familyId, me.familyId)))
        .limit(1)
    )[0];
    if (!target) return c.json({ error: 'not_found' }, 404);

    if (target.isAdmin) {
      const admins = await db
        .select({ id: familyMembers.id })
        .from(familyMembers)
        .where(and(eq(familyMembers.familyId, me.familyId), eq(familyMembers.isAdmin, true)));
      if (admins.length <= 1) return c.json({ error: 'last_admin' }, 409);
    }

    await db.delete(familyMembers).where(eq(familyMembers.id, memberId));
    // Their claimed tasks are gone — reconcile the family's calendars.
    enqueueReconcile(c, { kind: 'family', familyId: me.familyId });
    return c.body(null, 204);
  },
);
