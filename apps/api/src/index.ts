import { eq, families, familyMembers, getDb } from '@igt/db';
import { Hono } from 'hono';
import type { HonoEnv } from './env.js';
import { authMiddleware } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { familyRoutes } from './routes/families.js';

/**
 * API worker entrypoint. Phase 1 adds identity (magic-link auth + sessions),
 * the unified family_member model, and the family_id tenant guard. Feeds/tasks/
 * delivery routes are filled in across Phases 2–4.
 */
const app = new Hono<HonoEnv>();

app.get('/health', (c) =>
  c.json({
    ok: true,
    service: 'igt-api',
    environment: c.env.ENVIRONMENT,
    time: new Date().toISOString(),
  }),
);

app.get('/health/db', async (c) => {
  const row = await c.env.DB.prepare('select 1 as ok').first<{ ok: number }>();
  return c.json({ db: row?.ok === 1 ? 'up' : 'down' });
});

// --- Auth + identity -----------------------------------------------------

app.route('/auth', authRoutes);

/** Current user + the families they belong to (with their member record). */
app.get('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const rows = await getDb(c.env.DB)
    .select({ family: families, member: familyMembers })
    .from(familyMembers)
    .innerJoin(families, eq(families.id, familyMembers.familyId))
    .where(eq(familyMembers.userId, user.id));

  return c.json({
    user: { id: user.id, username: user.username, displayName: user.displayName },
    families: rows,
  });
});

app.route('/families', familyRoutes);

// --- Feed refresh (force) — Phase 2 implements the enqueue/parse ----------

app.post('/feeds/:id/refresh', (c) =>
  c.json(
    { feedId: c.req.param('id'), queued: true, note: 'stub — implemented in Phase 2' },
    202,
  ),
);

app.post('/feeds/refresh-all', (c) =>
  c.json({ queued: true, note: 'stub — implemented in Phase 2' }, 202),
);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
