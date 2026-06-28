import { and, eq, familyMembers, getDb } from '@igt/db';
import { createMiddleware } from 'hono/factory';
import type { HonoEnv } from '../env.js';
import { getUserBySessionToken } from '../services/auth.js';

/** Require a valid session (Authorization: Bearer <token>); sets `user`. */
export const authMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return c.json({ error: 'unauthorized' }, 401);

  const user = await getUserBySessionToken(getDb(c.env.DB), token);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  c.set('user', user);
  await next();
});

/**
 * Tenant guard: require the authenticated user to be a member of the
 * `:familyId` in the path; sets `member`. The security backbone — every
 * family-scoped route mounts this after `authMiddleware`.
 */
export const requireFamilyMember = createMiddleware<HonoEnv>(async (c, next) => {
  const user = c.get('user');
  const familyId = c.req.param('familyId');
  if (!familyId) return c.json({ error: 'family_required' }, 400);

  const rows = await getDb(c.env.DB)
    .select()
    .from(familyMembers)
    .where(
      and(
        eq(familyMembers.familyId, familyId),
        eq(familyMembers.userId, user.id),
      ),
    )
    .limit(1);
  const member = rows[0];
  if (!member) return c.json({ error: 'forbidden' }, 403);

  c.set('member', member);
  await next();
});

/** Require the current `member` to be a family admin. Mount after requireFamilyMember. */
export const requireAdmin = createMiddleware<HonoEnv>(async (c, next) => {
  const member = c.get('member');
  if (!member?.isAdmin) return c.json({ error: 'forbidden_admin' }, 403);
  await next();
});
