import { eq, families, familyMembers, getDb } from '@igt/db';
import { CreateFamilyInput, CreateFamilyMemberInput } from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import {
  authMiddleware,
  requireAdmin,
  requireFamilyMember,
} from '../middleware/auth.js';

export const familyRoutes = new Hono<HonoEnv>();

// Every family route requires a session.
familyRoutes.use('*', authMiddleware);

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
