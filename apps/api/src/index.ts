import { eq, families, familyMembers, getDb } from '@igt/db';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Bindings, HonoEnv } from './env.js';
import { authMiddleware } from './middleware/auth.js';
import { deliveryQueueConsumer } from './services/mirror.js';
import { accountRoutes } from './routes/accounts.js';
import { authRoutes } from './routes/auth.js';
import { familyRoutes } from './routes/families.js';
import { inviteRoutes } from './routes/invites.js';
import { scheduled } from './scheduled.js';

/**
 * API worker entrypoint. Phase 1 adds identity (magic-link auth + sessions),
 * the unified family_member model, and the family_id tenant guard. Feeds/tasks/
 * delivery routes are filled in across Phases 2–4.
 */
const app = new Hono<HonoEnv>();

// Allow the Flutter web client (and other origins) to call the API. We use
// bearer tokens (no cookies), so permissive CORS is safe here; restrict
// `origin` for production if desired.
app.use('*', cors());

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

// Member-claim invites (accept links a logged-in user to a pre-created member).
app.route('/invites', inviteRoutes);

// User-owned external calendar accounts (Google/iCloud/CalDAV) — private to the
// user and reusable across their families; not family-scoped.
app.route('/accounts', accountRoutes);

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

// Family-scoped feeds (CRUD + force-refresh) live under
// /families/:familyId/feeds (mounted inside familyRoutes).
app.route('/families', familyRoutes);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

/**
 * Serve the Flutter web client from the static-assets binding, falling back to
 * the app shell for client-side (deep-link) routes.
 */
async function serveWebApp(request: Request, assets: Fetcher): Promise<Response> {
  const res = await assets.fetch(request);
  if (res.status !== 404) return res;
  const url = new URL(request.url);
  url.pathname = '/app/index.html';
  return assets.fetch(new Request(url.toString(), request));
}

/**
 * Single-origin layout for deployed envs (when the ASSETS binding is present):
 *   /api/*  → the API (the prefix is stripped; routes live at the root)
 *   /app/*  → the Flutter web client (static assets, SPA fallback)
 *   /       → redirect to /app/
 * Without ASSETS (local dev / tests) the API is served directly at the root, so
 * the existing test paths and `wrangler dev` are unchanged.
 */
const handler = {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    if (!env.ASSETS) return app.fetch(request, env, ctx);

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api' || path.startsWith('/api/')) {
      url.pathname = path.slice('/api'.length) || '/';
      return app.fetch(new Request(url.toString(), request), env, ctx);
    }
    if (path.startsWith('/app/')) {
      return serveWebApp(request, env.ASSETS);
    }
    // Bare domain, `/app` (no trailing slash), and anything else → the web app.
    url.pathname = '/app/';
    url.search = '';
    return Response.redirect(url.toString(), 302);
  },
  scheduled,
  queue: deliveryQueueConsumer,
};

export default handler;
