import {
  and,
  calendarTargets,
  eq,
  familyMembers,
  getDb,
} from '@igt/db';
import { CreateCalendarTargetInput } from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { requireFamilyMember } from '../middleware/auth.js';
import { storeSecret } from '../lib/secrets.js';

/** Mounted under /families/:familyId (auth applied by parent router). */
export const targetRoutes = new Hono<HonoEnv>();
targetRoutes.use('*', requireFamilyMember);

/**
 * Create a calendar target for a caretaker. A member manages their own targets;
 * admins may manage anyone's. Credentials (caldav password / google token) are
 * envelope-encrypted into a `secret`.
 */
targetRoutes.post('/calendar-targets', async (c) => {
  const parsed = CreateCalendarTargetInput.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const me = c.get('member');
  if (parsed.data.memberId !== me.id && !me.isAdmin) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const db = getDb(c.env.DB);

  // Target member must belong to this family.
  const target = (
    await db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.id, parsed.data.memberId),
          eq(familyMembers.familyId, me.familyId),
        ),
      )
      .limit(1)
  )[0];
  if (!target) return c.json({ error: 'member_not_found' }, 404);

  // Encrypt any provided credential.
  let credentialsRef: string | null = null;
  const cred = parsed.data.credential;
  if (cred && (cred.password || cred.accessToken)) {
    if (!c.env.KEK) return c.json({ error: 'kek_unconfigured' }, 500);
    const payload =
      parsed.data.method === 'google'
        ? { kind: 'oauth', accessToken: cred.accessToken }
        : { kind: 'basic', username: cred.username, password: cred.password };
    credentialsRef = await storeSecret(
      db,
      c.env.KEK,
      me.familyId,
      JSON.stringify(payload),
    );
  }

  const row = (
    await db
      .insert(calendarTargets)
      .values({
        memberId: parsed.data.memberId,
        name: parsed.data.name,
        method: parsed.data.method,
        providerHint: parsed.data.providerHint ?? null,
        addressOrUrl: parsed.data.addressOrUrl,
        externalCalendarId: parsed.data.externalCalendarId ?? null,
        credentialsRef,
      })
      .returning()
  )[0]!;

  // Never return credential material.
  const { credentialsRef: _omit, ...safe } = row;
  return c.json({ target: safe }, 201);
});

/** List calendar targets (own; admins see the whole family). */
targetRoutes.get('/calendar-targets', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');

  const rows = me.isAdmin
    ? await db
        .select()
        .from(calendarTargets)
        .innerJoin(familyMembers, eq(familyMembers.id, calendarTargets.memberId))
        .where(eq(familyMembers.familyId, me.familyId))
    : await db.select().from(calendarTargets).where(eq(calendarTargets.memberId, me.id));

  return c.json({ targets: rows });
});
