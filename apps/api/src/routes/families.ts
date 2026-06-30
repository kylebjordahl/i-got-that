import { and, eq, families, familyMembers, getDb } from '@igt/db';
import {
  CreateFamilyInput,
  CreateFamilyMemberInput,
  UpdateFamilyMemberInput,
} from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import {
  authMiddleware,
  requireAdmin,
  requireFamilyMember,
} from '../middleware/auth.js';
import { getProductionRegistry, syncFamily } from '../services/delivery.js';
import { feedRoutes } from './feeds.js';
import { targetRoutes } from './targets.js';
import { taskRoutes } from './tasks.js';

export const familyRoutes = new Hono<HonoEnv>();

// Every family route requires a session.
familyRoutes.use('*', authMiddleware);

// Feed ingest routes live under /families/:familyId/feeds.
familyRoutes.route('/:familyId/feeds', feedRoutes);

// Classification rules + tasks live under /families/:familyId/...
familyRoutes.route('/:familyId', taskRoutes);

// Calendar targets (delivery destinations) under /families/:familyId/...
familyRoutes.route('/:familyId', targetRoutes);

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
      })
      .returning()
  )[0]!;

  return c.json({ family, member }, 201);
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
        })
        .returning()
    )[0]!;

    return c.json({ member }, 201);
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
    d.isCaretaker !== undefined || d.isAdmin !== undefined || d.requiresCaretaker !== undefined;
  if (!me.isAdmin) {
    if (memberId !== me.id) return c.json({ error: 'forbidden' }, 403);
    if (changingFlags) return c.json({ error: 'forbidden_roles' }, 403);
  }

  const set: Partial<typeof familyMembers.$inferInsert> = {};
  if (d.relationName !== undefined) set.relationName = d.relationName;
  if (me.isAdmin) {
    if (d.isCaretaker !== undefined) set.isCaretaker = d.isCaretaker;
    if (d.isAdmin !== undefined) set.isAdmin = d.isAdmin;
    if (d.requiresCaretaker !== undefined) set.requiresCaretaker = d.requiresCaretaker;
  }
  if (Object.keys(set).length > 0) {
    await db.update(familyMembers).set(set).where(eq(familyMembers.id, memberId));
  }
  const updated = (
    await db.select().from(familyMembers).where(eq(familyMembers.id, memberId)).limit(1)
  )[0]!;

  // The child's name appears in event titles — refresh calendars best-effort.
  try {
    await syncFamily(db, getProductionRegistry(c.env), c.env.KEK, me.familyId);
  } catch (err) {
    console.error('syncFamily (member update) failed', err);
  }
  return c.json({ member: updated });
});
