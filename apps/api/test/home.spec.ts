import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import handler from '../src/index.js';
import { appLinkBase } from '../src/lib/hosts.js';

/** Stands in for the deployed web client: echoes the asset path it was asked for. */
const assets = {
  fetch: async (req: Request) => new Response(`asset ${new URL(req.url).pathname}`),
} as unknown as Fetcher;
/** The deployed layout: ASSETS bound, routing on the app + site hosts. */
const deployed = {
  ...env,
  ASSETS: assets,
  PUBLIC_ORIGIN: 'https://app.igt.test',
  SITE_ORIGIN: 'https://www.igt.test',
};

async function call(url: string, bindings: object = deployed) {
  const ctx = createExecutionContext();
  const res = await handler.fetch(new Request(url), bindings as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('homepage', () => {
  it('serves a public page at the site root describing the app and its Google Calendar use', async () => {
    const res = await call('https://www.igt.test/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const html = await res.text();
    expect(html).toContain('href="https://app.igt.test/"');
    expect(html).toContain('src="https://app.igt.test/assets/assets/images/app_icon.png"');
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
      const res = await call(`https://app.igt.test${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('is served at the root in local dev, where the API has no prefix', async () => {
    const res = await call('https://api.test/', env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>I Got That</h1>');
  });
});

describe('host routing', () => {
  it('serves the web client at the app host root, with an SPA fallback', async () => {
    expect(await (await call('https://app.igt.test/')).text()).toBe('asset /');
    expect(await (await call('https://app.igt.test/main.dart.js')).text()).toBe(
      'asset /main.dart.js',
    );
    const notFound = {
      fetch: async (req: Request) =>
        new URL(req.url).pathname === '/'
          ? new Response('app shell')
          : new Response('', { status: 404 }),
    } as unknown as Fetcher;
    const res = await call('https://app.igt.test/some/route', { ...deployed, ASSETS: notFound });
    expect(await res.text()).toBe('app shell');
  });

  it('serves the API under /api on the app host', async () => {
    const res = await call('https://app.igt.test/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ service: 'igt-api' });
  });

  it('moves the old /app prefix to the root of the app host', async () => {
    for (const [path, to] of [
      ['/app', '/'],
      ['/app/', '/'],
      ['/app/?invite=x', '/?invite=x'],
    ]) {
      const res = await call(`https://app.igt.test${path}`);
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(`https://app.igt.test${to}`);
    }
  });

  it('sends legal pages on the app host to the site', async () => {
    const res = await call('https://app.igt.test/legal/privacy');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.igt.test/legal/privacy');
  });

  it('serves legal pages on the app host when no site is configured', async () => {
    const res = await call('https://app.igt.test/legal/privacy', {
      ...deployed,
      SITE_ORIGIN: undefined,
    });
    expect(res.status).toBe(200);
  });

  it('never serves the API or the web client on the site host', async () => {
    for (const [path, to] of [
      ['/api/health', 'https://app.igt.test/api/health'],
      ['/app/', 'https://app.igt.test/'],
      ['/index.html', 'https://app.igt.test/index.html'],
    ]) {
      const res = await call(`https://www.igt.test${path}`);
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(to);
    }
  });

  it('sends /legal itself to the site homepage from every host, never the web app', async () => {
    for (const host of ['https://app.igt.test', 'https://www.igt.test', 'https://igt.kylebjordahl.test']) {
      for (const path of ['/legal', '/legal/', '/legal?x=1']) {
        const res = await call(`${host}${path}`);
        expect(res.status).toBe(301);
        expect(res.headers.get('location')).toBe('https://www.igt.test/');
      }
    }
  });

  it('never redirects off our hosts, whatever the path', async () => {
    for (const url of [
      'https://igt.kylebjordahl.test//evil.com/x',
      'https://igt.kylebjordahl.test/app//evil.com',
      'https://www.igt.test//evil.com',
      'https://app.igt.test/app//evil.com',
      'https://app.igt.test/legal//evil.com',
    ]) {
      const res = await call(url);
      expect(res.status).toBe(301);
      expect(new URL(res.headers.get('location')!).host).toMatch(/^(app|www)\.igt\.test$/);
    }
  });

  describe('a legacy host', () => {
    const legacy = 'https://igt.kylebjordahl.test';

    it('keeps serving the API for app builds that still point at it', async () => {
      const res = await call(`${legacy}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ service: 'igt-api' });
    });

    it('starts a web sign-in on the app host, where its callback lands', async () => {
      const res = await call(`${legacy}/api/auth/google/start?link=1`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://app.igt.test/api/auth/google/start?link=1');
    });

    it('moves the homepage and legal pages to the site', async () => {
      for (const path of ['/', '/legal/terms']) {
        const res = await call(`${legacy}${path}`);
        expect(res.status).toBe(301);
        expect(res.headers.get('location')).toBe(`https://www.igt.test${path}`);
      }
    });

    it('moves the web client (and anything else) to the app host root', async () => {
      for (const [path, to] of [
        ['/app/', '/'],
        ['/app', '/'],
        ['/app/?invite=x', '/?invite=x'],
        ['/somewhere', '/somewhere'],
      ]) {
        const res = await call(`${legacy}${path}`);
        expect(res.status).toBe(301);
        expect(res.headers.get('location')).toBe(`https://app.igt.test${to}`);
      }
    });
  });
});

describe('appLinkBase', () => {
  const hosts = { PUBLIC_ORIGIN: 'https://app.igt.test', SITE_ORIGIN: 'https://www.igt.test' };

  it('points links at the web client on the app host', () => {
    expect(appLinkBase(hosts, 'https://app.igt.test/auth/magic-link/request')).toBe(
      'https://app.igt.test/',
    );
  });

  it("keeps a legacy host's /app/ for requests from older app builds", () => {
    expect(appLinkBase(hosts, 'https://igt.kylebjordahl.test/auth/magic-link/request')).toBe(
      'https://igt.kylebjordahl.test/app/',
    );
  });

  it('is null without a public origin', () => {
    expect(appLinkBase({}, 'https://api.test/x')).toBeNull();
  });
});
