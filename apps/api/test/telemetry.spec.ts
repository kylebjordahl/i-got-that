import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index.js';
import { bearer, login } from './helpers.js';

type Point = {
  indexes?: string[];
  blobs?: (string | null)[];
  doubles?: number[];
};

/** Run one request against an env whose ANALYTICS binding records what it's given. */
async function tracked(
  path: string,
  init?: RequestInit,
  dataset?: AnalyticsEngineDataset,
) {
  const points: Point[] = [];
  const recorder = {
    writeDataPoint: (p: Point) => void points.push(p),
  } as AnalyticsEngineDataset;
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`https://api.test${path}`, init),
    { ...env, ANALYTICS: dataset ?? recorder },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { res, points };
}

/** The single data point a request should have produced. */
function only(points: Point[]): Point {
  expect(points).toHaveLength(1);
  return points[0]!;
}

describe('request telemetry', () => {
  it('records the matched route pattern, method, status class and timing', async () => {
    const { token } = await login('telemetry-route@test.dev');

    const { res, points } = await tracked('/families/some-family-id/feeds', bearer(token));

    expect(res.status).toBe(403);
    const point = only(points);
    const [route, method, client, cls] = point.blobs!;
    expect(route).toMatch(/^\/families\/:familyId\/feeds/);
    expect(route).not.toContain('some-family-id');
    expect(point.indexes).toEqual([route]);
    expect([method, client, cls]).toEqual(['GET', 'native', '4xx']);
    expect(point.doubles![0]).toBe(403);
    expect(point.doubles![1]).toBeGreaterThanOrEqual(0);
  });

  it('labels requests no route handled as "unmatched"', async () => {
    const { res, points } = await tracked('/no/such/route');

    expect(res.status).toBe(404);
    const point = only(points);
    expect(point.blobs![0]).toBe('unmatched');
    expect(point.blobs![3]).toBe('4xx');
  });

  it('does not track health probes or the ops dashboard', async () => {
    expect((await tracked('/health')).points).toHaveLength(0);
    expect((await tracked('/health/db')).points).toHaveLength(0);
    expect((await tracked('/ops/summary')).points).toHaveLength(0);
  });

  it('keeps serving when the binding throws', async () => {
    const { res } = await tracked('/me', undefined, {
      writeDataPoint: () => {
        throw new Error('boom');
      },
    } as unknown as AnalyticsEngineDataset);

    expect(res.status).toBe(401);
  });

  it('is a no-op when ANALYTICS is unbound', async () => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request('https://api.test/me'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});

describe('client classification', () => {
  const kind = async (headers: Record<string, string>) =>
    only((await tracked('/me', { headers })).points).blobs![2];

  it('calls browser requests web, by Sec-Fetch-* or the session cookie', async () => {
    expect(await kind({ 'Sec-Fetch-Site': 'same-origin' })).toBe('web');
    expect(await kind({ 'Sec-Fetch-Mode': 'cors' })).toBe('web');
    expect(await kind({ Cookie: 'igt_session=abc' })).toBe('web');
  });

  it('does not take a bearer as native when the request is a browser one', async () => {
    // The Flutter web client sends its session token as a bearer too.
    expect(
      await kind({ Authorization: 'Bearer abc', 'Sec-Fetch-Site': 'same-origin' }),
    ).toBe('web');
    expect(await kind({ Authorization: 'Bearer abc', Cookie: 'igt_session=abc' })).toBe(
      'web',
    );
  });

  it('calls the Flutter app native, by bearer or the Dart user-agent', async () => {
    expect(await kind({ Authorization: 'Bearer abc' })).toBe('native');
    // Signed-out login requests have no bearer yet.
    expect(await kind({ 'User-Agent': 'Dart/3.12 (dart:io)' })).toBe('native');
  });

  it('files everything else under other', async () => {
    expect(await kind({ 'User-Agent': 'curl/8.0' })).toBe('other');
    expect(await kind({})).toBe('other');
  });
});
