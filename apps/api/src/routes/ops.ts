import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { analyticsConfig, num, queryAnalytics } from '../lib/analytics-sql.js';
import { opsDashboardHtml } from '../lib/ops-dashboard.js';
import { opsAuthMiddleware } from '../middleware/ops-auth.js';

/**
 * Cross-tenant operator dashboard: platform-wide counts and trends, not
 * scoped to any one family. Deliberately outside `/families/:familyId` and
 * `authMiddleware` — gated by `opsAuthMiddleware` instead (see its docs).
 * Two data sources: D1 for platform state and processing volume (summary,
 * timeseries, clients), and Workers Analytics Engine for API traffic
 * (`/requests`, written by middleware/telemetry.ts).
 */
export const opsRoutes = new Hono<HonoEnv>();
opsRoutes.use('*', opsAuthMiddleware);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default 30, clamped to 1–90 (also Analytics Engine's retention). */
function clampDays(raw: string | undefined): number {
  return Math.min(90, Math.max(1, Math.floor(Number(raw ?? 30)) || 30));
}

async function scalar(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function grouped(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<{ key: string; n: number }[]> {
  const res = await db
    .prepare(sql)
    .bind(...binds)
    .all<{ key: string; n: number }>();
  return res.results ?? [];
}

opsRoutes.get('/summary', async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const since7d = now - 7 * DAY_MS;
  const since30d = now - 30 * DAY_MS;

  const [
    users,
    families,
    members,
    activeFeeds,
    pausedFeeds,
    erroredFeeds,
    calendarEvents7d,
    calendarEvents30d,
    sourceEvents30d,
    tasksByStatus,
  ] = await Promise.all([
    scalar(db, 'select count(*) as n from users'),
    scalar(db, 'select count(*) as n from families'),
    scalar(db, 'select count(*) as n from family_members'),
    scalar(db, "select count(*) as n from feeds where status = 'active'"),
    scalar(db, "select count(*) as n from feeds where status = 'paused'"),
    scalar(db, "select count(*) as n from feeds where status = 'error'"),
    scalar(db, 'select count(*) as n from calendar_events where created_at >= ?', since7d),
    scalar(db, 'select count(*) as n from calendar_events where created_at >= ?', since30d),
    scalar(db, 'select count(*) as n from source_events where created_at >= ?', since30d),
    grouped(db, 'select status as key, count(*) as n from tasks group by status'),
  ]);

  return c.json({
    users,
    families,
    members,
    feeds: { active: activeFeeds, paused: pausedFeeds, error: erroredFeeds },
    calendarEvents: { last7d: calendarEvents7d, last30d: calendarEvents30d },
    sourceEvents: { last30d: sourceEvents30d },
    tasksByStatus,
  });
});

/** Daily counts for the last `days` (default 30, max 90) — one row per day that had any activity. */
opsRoutes.get('/timeseries', async (c) => {
  const db = c.env.DB;
  const days = clampDays(c.req.query('days'));
  const since = Date.now() - days * DAY_MS;

  const dailyCounts = (table: string) =>
    grouped(
      db,
      `select strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') as key, count(*) as n
       from ${table} where created_at >= ? group by key order by key`,
      since,
    );

  const [signups, calendarEventsCreated, sourceEventsIngested, tasksCreated] = await Promise.all([
    dailyCounts('users'),
    dailyCounts('calendar_events'),
    dailyCounts('source_events'),
    dailyCounts('tasks'),
  ]);

  return c.json({
    days,
    series: { signups, calendarEventsCreated, sourceEventsIngested, tasksCreated },
  });
});

opsRoutes.get('/clients', async (c) => {
  const db = c.env.DB;
  const [loginProviders, calendarTargets, externalAccountKinds] = await Promise.all([
    grouped(db, 'select provider as key, count(*) as n from identities group by provider'),
    grouped(
      db,
      'select target_method as key, count(*) as n from member_calendars group by target_method',
    ),
    grouped(db, 'select kind as key, count(*) as n from external_accounts group by kind'),
  ]);

  return c.json({ loginProviders, calendarTargets, externalAccountKinds });
});

type DayRow = { day: string; n: unknown };

/**
 * API traffic from Analytics Engine: requests per day by client kind, per day
 * by status class, and per-route volume / p95 latency / error counts. Counts
 * are `SUM(_sample_interval)` — AE samples under load, and that column is the
 * weight that undoes it. Column layout is defined in middleware/telemetry.ts.
 *
 * `configured: false` (not an error) until the account id, token and dataset
 * are set, so the dashboard can say so instead of failing the page.
 */
opsRoutes.get('/requests', async (c) => {
  const days = clampDays(c.req.query('days'));
  const cfg = analyticsConfig(c.env);
  if (!cfg) return c.json({ configured: false, days });

  const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
  const day = "toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day";
  const run = <T>(sql: string) => queryAnalytics<T>(cfg, sql);

  try {
    const [byClient, byStatus, routeStats, routeStatus] = await Promise.all([
      run<DayRow & { client: string }>(
        `SELECT ${day}, blob3 AS client, SUM(_sample_interval) AS n
         FROM ${cfg.dataset} WHERE ${since} GROUP BY day, client ORDER BY day`,
      ),
      run<DayRow & { cls: string }>(
        `SELECT ${day}, blob4 AS cls, SUM(_sample_interval) AS n
         FROM ${cfg.dataset} WHERE ${since} GROUP BY day, cls ORDER BY day`,
      ),
      run<{ route: string; n: unknown; p95: unknown }>(
        `SELECT blob1 AS route, SUM(_sample_interval) AS n,
                quantileWeighted(0.95)(double2, _sample_interval) AS p95
         FROM ${cfg.dataset} WHERE ${since} GROUP BY route ORDER BY n DESC LIMIT 25`,
      ),
      run<{ route: string; cls: string; n: unknown }>(
        `SELECT blob1 AS route, blob4 AS cls, SUM(_sample_interval) AS n
         FROM ${cfg.dataset} WHERE ${since} GROUP BY route, cls LIMIT 500`,
      ),
    ]);

    const errors = new Map<string, { e4xx: number; e5xx: number }>();
    for (const r of routeStatus) {
      const entry = errors.get(r.route) ?? { e4xx: 0, e5xx: 0 };
      if (r.cls === '4xx') entry.e4xx += num(r.n);
      if (r.cls === '5xx') entry.e5xx += num(r.n);
      errors.set(r.route, entry);
    }

    return c.json({
      configured: true,
      days,
      byClient: byClient.map((r) => ({ day: r.day.slice(0, 10), client: r.client, n: num(r.n) })),
      byStatus: byStatus.map((r) => ({ day: r.day.slice(0, 10), cls: r.cls, n: num(r.n) })),
      routes: routeStats.map((r) => ({
        route: r.route,
        n: num(r.n),
        p95Ms: Math.round(num(r.p95)),
        e4xx: errors.get(r.route)?.e4xx ?? 0,
        e5xx: errors.get(r.route)?.e5xx ?? 0,
      })),
    });
  } catch (err) {
    console.error('ops requests query failed', err);
    return c.json(
      { configured: true, days, error: err instanceof Error ? err.message : 'query_failed' },
      502,
    );
  }
});

opsRoutes.get('/', (c) => c.html(opsDashboardHtml));
