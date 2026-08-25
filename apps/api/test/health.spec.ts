import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index.js';

async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

type Health = {
  ok: boolean;
  service: string;
  config: { secretsKek: string };
};

describe('api health', () => {
  it('GET /health returns ok', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body.ok).toBe(true);
    expect(body.service).toBe('igt-api');
    expect(body.config.secretsKek).toBe('ok');
  });

  // The deploy workflow smoke-checks this: an env missing (or holding bad)
  // KEK_V<n> still boots and serves, but can't read or write any stored
  // credential — connecting an account fails and feeds/mirrors silently skip.
  it('reports an unconfigured envelope-encryption KEK instead of looking healthy', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://api.test/health'),
      { ...env, KEK_CURRENT_VERSION: '9' },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as Health;
    expect(body.config.secretsKek).toBe('missing');
    expect(body.ok).toBe(false);
  });

  it('reports a KEK that is set but not valid AES-256 material', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request('https://api.test/health'),
      { ...env, KEK_V1: 'not-a-32-byte-key' },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const body = (await res.json()) as Health;
    expect(body.config.secretsKek).toBe('invalid');
    expect(body.ok).toBe(false);
  });

  it('never puts key material in the health payload', async () => {
    const res = await call('/health');
    expect(await res.text()).not.toContain(env.KEK_V1);
  });

  it('GET /health/db reaches the D1 binding', async () => {
    const res = await call('/health/db');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ db: 'up' });
  });

  it('unknown routes 404', async () => {
    const res = await call('/nope');
    expect(res.status).toBe(404);
  });
});
