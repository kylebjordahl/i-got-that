import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import handler from '../src/index.js';

const assets = { fetch: async () => new Response('app shell') } as unknown as Fetcher;
/** The deployed single-origin layout (ASSETS bound) unless told otherwise. */
const deployed = { ...env, ASSETS: assets };

async function call(path: string, bindings: object = deployed) {
  const ctx = createExecutionContext();
  const res = await handler.fetch(
    new Request(`https://api.test${path}`),
    bindings as typeof env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('homepage', () => {
  it('serves a public page at the apex describing the app and its Google Calendar use', async () => {
    const res = await call('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const html = await res.text();
    expect(html).toContain('href="/app/"');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
    // What Google's verification reviewers look for.
    expect(html).toContain('<h2>How IGT uses Google Calendar</h2>');
    expect(html).toContain(
      'href="https://developers.google.com/terms/api-services-user-data-policy"',
    );
  });

  it('is not duplicated under /api', async () => {
    for (const path of ['/api', '/api/']) {
      const res = await call(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('is served at the root in local dev, where the API has no prefix', async () => {
    const res = await call('/', env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>I Got That</h1>');
  });

  it('still sends `/app` and other unknown paths to the web app', async () => {
    for (const path of ['/app', '/somewhere']) {
      const res = await call(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://api.test/app/');
    }
  });
});
