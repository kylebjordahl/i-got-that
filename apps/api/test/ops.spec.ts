import {
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { call, login, setupFamily } from './helpers.js';

function opsAuth(password: string): RequestInit {
  return { headers: { Authorization: 'Basic ' + btoa('ops:' + password) } };
}

describe('ops dashboard auth', () => {
  it('401s with no credentials', async () => {
    const res = await call('/ops/summary');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('gates the analytics endpoint too', async () => {
    expect((await call('/ops/requests')).status).toBe(401);
  });

  it('401s with the wrong password', async () => {
    const res = await call('/ops/summary', opsAuth('not-it'));
    expect(res.status).toBe(401);
  });

  it('401s unconditionally when OPS_DASHBOARD_PASSWORD is unset', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://api.test/ops/summary', opsAuth(env.OPS_DASHBOARD_PASSWORD!)),
      { ...env, OPS_DASHBOARD_PASSWORD: undefined },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });

  it('200s with the right password', async () => {
    const res = await call('/ops/summary', opsAuth(env.OPS_DASHBOARD_PASSWORD!));
    expect(res.status).toBe(200);
  });

  it('serves the dashboard page', async () => {
    const res = await call('/ops', opsAuth(env.OPS_DASHBOARD_PASSWORD!));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ops dashboard');
  });
});

describe('ops dashboard data', () => {
  it('summary reflects seeded families/members', async () => {
    const before = await (
      await call('/ops/summary', opsAuth(env.OPS_DASHBOARD_PASSWORD!))
    ).json() as { users: number; families: number; members: number };

    await setupFamily('ops-summary@test.dev');

    const after = await (
      await call('/ops/summary', opsAuth(env.OPS_DASHBOARD_PASSWORD!))
    ).json() as { users: number; families: number; members: number };

    expect(after.users).toBe(before.users + 1);
    expect(after.families).toBe(before.families + 1);
    // setupFamily creates an admin caretaker + one dependent child.
    expect(after.members).toBe(before.members + 2);
  });

  it('timeseries buckets by day and respects the days param', async () => {
    await login('ops-timeseries@test.dev');

    const res = await call('/ops/timeseries?days=7', opsAuth(env.OPS_DASHBOARD_PASSWORD!));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      series: { signups: { key: string; n: number }[] };
    };
    expect(body.days).toBe(7);
    const today = new Date().toISOString().slice(0, 10);
    expect(body.series.signups.some((row) => row.key === today && row.n >= 1)).toBe(true);
  });

  it('timeseries clamps days to the 1-90 range', async () => {
    const res = await call('/ops/timeseries?days=500', opsAuth(env.OPS_DASHBOARD_PASSWORD!));
    expect(((await res.json()) as { days: number }).days).toBe(90);
  });

  it('clients reports the login-provider mix', async () => {
    await login('ops-clients@test.dev');

    const res = await call('/ops/clients', opsAuth(env.OPS_DASHBOARD_PASSWORD!));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      loginProviders: { key: string; n: number }[];
    };
    const magicLink = body.loginProviders.find((row) => row.key === 'magic_link');
    expect(magicLink && magicLink.n).toBeGreaterThan(0);
  });
});

describe('ops traffic (Analytics Engine)', () => {
  const configured = {
    CF_ACCOUNT_ID: 'acct-1',
    CF_ANALYTICS_API_TOKEN: 'tok-1',
    OPS_ANALYTICS_DATASET: 'igt_ops_test',
  };

  async function requests(path = '/ops/requests', extra: Record<string, string> = {}) {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request(`https://api.test${path}`, opsAuth(env.OPS_DASHBOARD_PASSWORD!)),
      { ...env, ...extra },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());

  /** One stub per query, told apart by a column only that query selects. */
  function stubSql(marker: string, rows: unknown[], seen = new Set<string>()) {
    fetchMock
      .get('https://api.cloudflare.com')
      .intercept({
        path: '/client/v4/accounts/acct-1/analytics_engine/sql',
        method: 'POST',
        headers: { authorization: 'Bearer tok-1' },
        body: (body: string) => {
          const hit = body.includes(marker);
          // undici may evaluate a matcher more than once per request; a Set dedupes.
          if (hit) seen.add(body);
          return hit;
        },
      })
      .reply(200, JSON.stringify({ data: rows }), {
        headers: { 'content-type': 'application/json' },
      });
  }

  it('reports configured:false until the account id, token and dataset are set', async () => {
    const res = await requests();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, days: 30 });
  });

  it('treats a dataset name that is not a bare identifier as unconfigured', async () => {
    // Interpolated into SQL as the table name; disableNetConnect would fail any fetch.
    const res = await requests('/ops/requests', {
      ...configured,
      OPS_ANALYTICS_DATASET: 'igt_ops; DROP TABLE x',
    });
    expect(((await res.json()) as { configured: boolean }).configured).toBe(false);
  });

  it('shapes the four queries into per-day, per-status and per-route series', async () => {
    const seen = new Set<string>();
    // The SQL API returns 64-bit aggregates as strings.
    stubSql('GROUP BY day, client', [
      { day: '2026-09-29 00:00:00', client: 'web', n: '40' },
      { day: '2026-09-29 00:00:00', client: 'native', n: '12' },
    ], seen);
    stubSql('GROUP BY day, cls', [
      { day: '2026-09-29 00:00:00', cls: '2xx', n: '50' },
      { day: '2026-09-29 00:00:00', cls: '5xx', n: '2' },
    ], seen);
    stubSql('quantileWeighted(0.95)(double2, _sample_interval)', [
      { route: '/tasks', n: '30', p95: '181.7' },
      { route: '/me', n: '22', p95: '40' },
    ], seen);
    stubSql('GROUP BY route, cls', [
      { route: '/tasks', cls: '5xx', n: '2' },
      { route: '/tasks', cls: '4xx', n: '1' },
      { route: '/me', cls: '2xx', n: '22' },
    ], seen);

    const res = await requests('/ops/requests?days=7', configured);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true,
      days: 7,
      byClient: [
        { day: '2026-09-29', client: 'web', n: 40 },
        { day: '2026-09-29', client: 'native', n: 12 },
      ],
      byStatus: [
        { day: '2026-09-29', cls: '2xx', n: 50 },
        { day: '2026-09-29', cls: '5xx', n: 2 },
      ],
      routes: [
        { route: '/tasks', n: 30, p95Ms: 182, e4xx: 1, e5xx: 2 },
        { route: '/me', n: 22, p95Ms: 40, e4xx: 0, e5xx: 0 },
      ],
    });
    expect(seen.size).toBe(4);
    for (const sql of seen) {
      expect(sql).toContain('FROM igt_ops_test');
      expect(sql).toContain("INTERVAL '7' DAY");
    }
  });

  it('surfaces an upstream failure as a 502 the dashboard can display', async () => {
    for (let i = 0; i < 4; i++) {
      fetchMock
        .get('https://api.cloudflare.com')
        .intercept({ path: '/client/v4/accounts/acct-1/analytics_engine/sql', method: 'POST' })
        .reply(403, 'invalid token');
    }

    const res = await requests('/ops/requests', configured);

    expect(res.status).toBe(502);
    const body = (await res.json()) as { configured: boolean; error: string };
    expect(body.configured).toBe(true);
    expect(body.error).toContain('403');
  });
});
