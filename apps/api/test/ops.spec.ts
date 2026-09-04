import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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
