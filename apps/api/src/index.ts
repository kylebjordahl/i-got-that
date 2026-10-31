import { eq, families, familyMembers, getDb } from '@igt/db';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Bindings, HonoEnv } from './env.js';
import { homeResponse } from './lib/home.js';
import { hostRole } from './lib/hosts.js';
import { isLegalDoc, legalPage } from './lib/legal.js';
import { kekStatus, kekUsable } from './lib/secrets.js';
import { authMiddleware } from './middleware/auth.js';
import { requestTelemetry } from './middleware/telemetry.js';
import { deliveryQueueConsumer } from './services/mirror.js';
import { accountRoutes } from './routes/accounts.js';
import { authRoutes } from './routes/auth.js';
import { emailUnsubscribeRoutes, emailVerifyRoutes } from './routes/email-outputs.js';
import { familyRoutes } from './routes/families.js';
import { inviteRoutes } from './routes/invites.js';
import { notificationRoutes } from './routes/notifications.js';
import { opsRoutes } from './routes/ops.js';
import { scheduled } from './scheduled.js';

/**
 * API worker entrypoint. Phase 1 adds identity (magic-link auth + sessions),
 * the unified family_member model, and the family_id tenant guard. Feeds/tasks/
 * delivery routes are filled in across Phases 2–4.
 */
const app = new Hono<HonoEnv>();

/**
 * Allow only known origins to make credentialed requests. Deployed envs serve
 * the SPA same-origin (under /api on PUBLIC_ORIGIN), so in practice this only
 * matters for local dev, where the Flutter web dev server runs on a
 * different — and, since `flutter run -d chrome` picks a random port, not
 * fixed — localhost port than `wrangler dev`. The session cookie (see
 * lib/session-cookie.ts) needs `credentials: true`, which forbids a wildcard
 * `origin`, so we allowlist instead of reflecting the caller's Origin.
 */
function isAllowedOrigin(origin: string, env: Bindings): boolean {
  if (env.PUBLIC_ORIGIN && origin === env.PUBLIC_ORIGIN) return true;
  if (env.ENVIRONMENT !== 'development') return false;
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

app.use(
  '*',
  cors({
    origin: (origin, c) => (isAllowedOrigin(origin, c.env as Bindings) ? origin : null),
    credentials: true,
  }),
);

// Per-request Analytics Engine data point for the /ops traffic charts (no-op when unbound).
app.use('*', requestTelemetry);

/**
 * Liveness + the one piece of configuration whose absence is otherwise silent.
 * A missing/invalid envelope-encryption KEK (`KEK_V<n>`, see lib/secrets.ts)
 * doesn't stop the Worker booting — it just makes every stored credential
 * unreadable, so feeds and mirrors skip and connecting an account fails. Report
 * it as a bare `ok`/`legacy`/`missing`/`invalid` (never any key material) so a
 * deploy can be checked from outside; `ok` goes false only when the key is
 * unusable — `legacy` (the pre-split `KEK` fallback) works and stays healthy.
 *
 * Read by a human, in a browser: CI doesn't probe this, because the Cloudflare
 * edge 403s a plain curl at both public hostnames. See docs/DEPLOYMENT.md § 6.
 */
app.get('/health', (c) => {
  const kek = kekStatus(c.env);
  return c.json({
    ok: kekUsable(kek),
    service: 'igt-api',
    environment: c.env.ENVIRONMENT,
    time: new Date().toISOString(),
    config: { secretsKek: kek },
  });
});

app.get('/health/db', async (c) => {
  const row = await c.env.DB.prepare('select 1 as ok').first<{ ok: number }>();
  return c.json({ db: row?.ok === 1 ? 'up' : 'down' });
});

/**
 * Apple App Site Association — lets iOS associate a domain with the app so
 * invite and magic links (`<PUBLIC_ORIGIN>/#invite=…`) open the app via
 * Universal Links instead of Safari. Served at the root `/.well-known/…` path
 * (see handler.fetch), never under `/api`. Empty APPLE_APP_ID_PREFIX ⇒ 404
 * (feature off). iOS matches paths only (not queries or fragments), and the app
 * filters on the fragment itself. On the app host that means every path but the
 * API (emailed unsubscribe / verify links must open in the browser) and the
 * legal redirects. A legacy host keeps the old `/app/*` match, so links already
 * sent from it still open the app in builds that list that domain.
 */
app.get('/.well-known/apple-app-site-association', (c) => {
  const appIDs = (c.env.APPLE_APP_ID_PREFIX ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (appIDs.length === 0) return c.json({ error: 'not_configured' }, 404);
  const components =
    hostRole(new URL(c.req.url).host, c.env) === 'alias'
      ? [{ '/': '/app/*', comment: 'invite + web app (legacy host)' }]
      : [
          { '/': '/api', exclude: true, comment: 'API + emailed links' },
          { '/': '/api/*', exclude: true, comment: 'API + emailed links' },
          { '/': '/legal/*', exclude: true, comment: 'redirects to the site' },
          { '/': '/*', comment: 'invite + web app' },
        ];
  return c.json({ applinks: { details: [{ appIDs, components }] } });
});

/**
 * Public homepage: what IGT does, with links to the app and the legal pages.
 * Google's OAuth verification reviews it, so it has to stay public. Deployed,
 * handler.fetch serves it at the site host's `/` itself, so `/api/` (which strips to
 * this same `/`) stays a JSON 404 instead of a second copy of the page; this
 * route is what local dev sees, where the API is served at the root.
 */
app.get('/', (c) => (c.env.ASSETS ? c.json({ error: 'not_found' }, 404) : homeResponse()));

/**
 * Public Privacy Policy / Terms of Service, rendered from `apps/api/legal/`
 * Markdown (see lib/legal.ts). Served at the site host's `/legal/…` (see
 * handler.fetch), not under `/api`: these URLs go on the Google OAuth consent
 * screen and the store listings, and need no session.
 */
app.get('/legal/:doc', (c) => {
  const doc = c.req.param('doc');
  if (!isLegalDoc(doc)) return c.json({ error: 'not_found' }, 404);
  c.header('Cache-Control', 'public, max-age=300');
  return c.html(legalPage(doc));
});
// A trailing slash is the near-miss a reviewer typing the URL hits.
app.get('/legal/:doc/', (c) => {
  const doc = c.req.param('doc');
  return isLegalDoc(doc) ? c.redirect(`/legal/${doc}`, 301) : c.json({ error: 'not_found' }, 404);
});

// --- Auth + identity -----------------------------------------------------

app.route('/auth', authRoutes);

// Member-claim invites (accept links a logged-in user to a pre-created member).
app.route('/invites', inviteRoutes);

// The unauthenticated verification link mailed to an email invite output's
// address (the token is the credential).
app.route('/email-outputs', emailVerifyRoutes);
// …and the unsubscribe link in every mail an output sends.
app.route('/email', emailUnsubscribeRoutes);

// User-owned external calendar accounts (Google/iCloud/CalDAV) — private to the
// user and reusable across their families; not family-scoped.
app.route('/accounts', accountRoutes);

// User-owned push devices + digest schedules — also not family-scoped: a digest
// aggregates across every family the user belongs to.
app.route('/notifications', notificationRoutes);

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

// Cross-tenant operator dashboard — gated by its own Basic-auth middleware,
// not a family session (see routes/ops.ts).
app.route('/ops', opsRoutes);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

/**
 * Serve the Flutter web client from the static-assets binding, falling back to
 * the app shell for client-side (deep-link) routes.
 */
async function serveWebApp(request: Request, assets: Fetcher): Promise<Response> {
  const res = await assets.fetch(request);
  if (res.status !== 404) return res;
  const url = new URL(request.url);
  url.pathname = '/';
  return assets.fetch(new Request(url.toString(), request));
}

/**
 * A redirect (permanent unless [status] says otherwise) to [path] on [origin],
 * keeping the query string. The path is set on the origin, never resolved
 * against it: `new URL('//evil.com', origin)` would leave our host.
 */
function moved(origin: string, path: string, search: string, status = 301): Response {
  const to = new URL(origin);
  to.pathname = path;
  to.search = search;
  return Response.redirect(to.toString(), status);
}

/** `/app` and `/app/…` (the web client's old prefix) → the same path at the root. */
function stripAppPrefix(path: string): string | null {
  if (path === '/app' || path === '/app/') return '/';
  return path.startsWith('/app/') ? path.slice('/app'.length) : null;
}

/** Hand `/api/…` to the API with the prefix stripped (its routes live at the root). */
function callApi(request: Request, url: URL, env: Bindings, ctx: ExecutionContext) {
  url.pathname = url.pathname.slice('/api'.length) || '/';
  return app.fetch(new Request(url.toString(), request), env, ctx);
}

const isApiPath = (path: string) => path === '/api' || path.startsWith('/api/');
const WEB_AUTH_START = /^\/api\/auth\/(apple|google)\/start$/;

/**
 * Deployed envs (the ASSETS binding present) route on the request's host — see
 * hostRole. The asset binding runs Worker-first (`run_worker_first` in
 * wrangler.jsonc), so even a path that names a static file goes through here.
 * Without ASSETS (local dev / tests) the API is served directly at the root, so
 * the existing test paths and `wrangler dev` are unchanged.
 */
const handler = {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    if (!env.ASSETS) return app.fetch(request, env, ctx);

    const url = new URL(request.url);
    const path = url.pathname;
    const appOrigin = env.PUBLIC_ORIGIN ?? url.origin;
    const role = hostRole(url.host, env);

    // `/legal` itself has no page: send it to the site's homepage, which links
    // to both documents, on every host — never to the web app.
    if (path === '/legal' || path === '/legal/') {
      return env.SITE_ORIGIN ? moved(env.SITE_ORIGIN, '/', '') : app.fetch(request, env, ctx);
    }

    if (role === 'site') {
      // The public homepage, at the site root only (see the `/` route).
      if (path === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        return homeResponse(appOrigin);
      }
      if (path.startsWith('/legal/')) return app.fetch(request, env, ctx);
      // Anything else (an old `/app/…` link, `/api/…`) belongs on the app host.
      return moved(appOrigin, stripAppPrefix(path) ?? path, url.search);
    }

    // iOS fetches the AASA at the root, with no `/api` prefix — hand it to the
    // Hono app unchanged so the well-known route resolves (per host; see there).
    if (path === '/.well-known/apple-app-site-association') {
      return app.fetch(request, env, ctx);
    }
    // A web sign-in started on an alias host (a stale tab) would set its
    // host-only state cookie there, then come back to PUBLIC_ORIGIN without
    // it. Start it on the app host instead.
    if (role === 'alias' && request.method === 'GET' && WEB_AUTH_START.test(path)) {
      return moved(appOrigin, path, url.search, 302);
    }
    if (isApiPath(path)) return callApi(request, url, env, ctx);

    const siteOrigin = env.SITE_ORIGIN;
    if (role === 'alias') {
      if (siteOrigin && (path === '/' || path.startsWith('/legal/'))) {
        return moved(siteOrigin, path, url.search);
      }
      // The browser carries the fragment (`#invite=…`, `#magic=…`) across.
      return moved(appOrigin, stripAppPrefix(path) ?? path, url.search);
    }

    // The app host.
    if (path.startsWith('/legal/')) {
      return siteOrigin ? moved(siteOrigin, path, url.search) : app.fetch(request, env, ctx);
    }
    const unprefixed = stripAppPrefix(path);
    if (unprefixed) return moved(appOrigin, unprefixed, url.search);
    return serveWebApp(request, env.ASSETS);
  },
  scheduled,
  queue: deliveryQueueConsumer,
};

export default handler;
