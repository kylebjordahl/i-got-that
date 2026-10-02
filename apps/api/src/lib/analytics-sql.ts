import type { Bindings } from '../env.js';

/**
 * Read side of Workers Analytics Engine. A Worker can only *write* to its
 * dataset through the binding; reading goes through Cloudflare's account-level
 * SQL API, which needs an API token (permission: Account › Account Analytics ›
 * Read) and the account id. See docs/DEPLOYMENT.md § Request telemetry.
 */

// The dataset name is interpolated into SQL (it's the table), so it must be a bare identifier.
const DATASET_RE = /^[A-Za-z0-9_]+$/;

export interface AnalyticsConfig {
  accountId: string;
  token: string;
  dataset: string;
}

/** Null until all three of the account id, token and dataset are configured. */
export function analyticsConfig(env: Bindings): AnalyticsConfig | null {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_ANALYTICS_API_TOKEN;
  const dataset = env.OPS_ANALYTICS_DATASET;
  if (!accountId || !token || !dataset || !DATASET_RE.test(dataset)) return null;
  return { accountId, token, dataset };
}

export class AnalyticsQueryError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`analytics query failed (${status}): ${detail}`);
  }
}

export async function queryAnalytics<T>(
  cfg: AnalyticsConfig,
  sql: string,
): Promise<T[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/analytics_engine/sql`,
    { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}` }, body: sql },
  );
  const body = await res.text();
  if (!res.ok) throw new AnalyticsQueryError(res.status, body.slice(0, 300));
  return (JSON.parse(body) as { data?: T[] }).data ?? [];
}

/** The SQL API returns 64-bit aggregates as JSON strings; coerce to a number. */
export function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
