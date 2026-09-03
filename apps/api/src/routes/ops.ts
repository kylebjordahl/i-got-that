import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { opsAuthMiddleware } from '../middleware/ops-auth.js';
import { opsDashboardHtml } from '../lib/ops-dashboard.js';

/**
 * Cross-tenant operator dashboard: platform-wide counts and trends, not
 * scoped to any one family. Deliberately outside `/families/:familyId` and
 * `authMiddleware` — gated by `opsAuthMiddleware` instead (see its docs).
 * D1-only for now; request/client telemetry needs Workers Analytics Engine
 * (Workers Paid plan), tracked as a follow-up.
 */
export const opsRoutes = new Hono<HonoEnv>();
opsRoutes.use('*', opsAuthMiddleware);

const DAY_MS = 24 * 60 * 60 * 1000;

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
  const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 30) || 30));
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

opsRoutes.get('/', (c) => c.html(opsDashboardHtml));
