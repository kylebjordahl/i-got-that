import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index.js';

async function callWithOrigin(origin: string, bindings: typeof env) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request('https://api.test/health', { headers: { Origin: origin } }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('CORS allowlist', () => {
  it('does not reflect an arbitrary Origin', async () => {
    const res = await callWithOrigin('https://evil.example', env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows the deployed PUBLIC_ORIGIN', async () => {
    const origin = 'https://staging.igt.example';
    const bindings = { ...env, PUBLIC_ORIGIN: origin };
    const res = await callWithOrigin(origin, bindings);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  });

  it('allows any localhost origin in development, for the Flutter web dev server', async () => {
    // `flutter run -d chrome` picks a random port, so dev allows any localhost
    // origin rather than one fixed port.
    const bindings = { ...env, ENVIRONMENT: 'development' };
    const res = await callWithOrigin('http://localhost:54321', bindings);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'http://localhost:54321',
    );
  });

  it('does not allow a localhost dev origin outside development', async () => {
    const bindings = {
      ...env,
      ENVIRONMENT: 'staging',
      PUBLIC_ORIGIN: 'https://staging.igt.example',
    };
    const res = await callWithOrigin('http://localhost:54321', bindings);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
