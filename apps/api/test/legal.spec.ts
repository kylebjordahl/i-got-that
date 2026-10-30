import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import handler from '../src/index.js';
import { renderMarkdown } from '../src/lib/legal.js';

async function call(path: string, bindings: object = env) {
  const ctx = createExecutionContext();
  const res = await handler.fetch(
    new Request(`https://api.test${path}`),
    bindings as typeof env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe('legal pages', () => {
  it.each([
    ['/legal/privacy', 'Privacy Policy'],
    ['/legal/terms', 'Terms of Service'],
  ])('GET %s serves the document as HTML without a session', async (path, title) => {
    const res = await call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain(`<title>${title} · I Got That</title>`);
    expect(html).toContain(`<h1>${title}</h1>`);
  });

  it('404s an unknown document', async () => {
    expect((await call('/legal/cookies')).status).toBe(404);
    expect((await call('/legal/constructor')).status).toBe(404);
  });

  it('is served at the apex, not under /api, in the deployed single-origin layout', async () => {
    const assets = { fetch: async () => new Response('app shell') } as unknown as Fetcher;
    const res = await call('/legal/privacy', { ...env, ASSETS: assets });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>Privacy Policy</h1>');
  });
});

describe('renderMarkdown', () => {
  it('renders the supported subset', () => {
    const html = renderMarkdown(
      [
        '# Title',
        '',
        'A **bold** and *em* line',
        'joined with `code` and [a link](https://example.com/?a=1&b=2).',
        '',
        '## Section',
        '- one',
        '  continued',
        '- two',
        '',
        '1. first',
        '2. second',
      ].join('\n'),
    );
    expect(html).toBe(
      [
        '<h1>Title</h1>',
        '<p>A <strong>bold</strong> and <em>em</em> line joined with <code>code</code> and <a href="https://example.com/?a=1&amp;b=2">a link</a>.</p>',
        '<h2>Section</h2>',
        '<ul><li>one continued</li><li>two</li></ul>',
        '<ol><li>first</li><li>second</li></ol>',
      ].join('\n'),
    );
  });

  it('escapes HTML and refuses script links', () => {
    const html = renderMarkdown('<script>x</script> [bad](javascript:alert(1))');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript');
  });
});

describe('homepage', () => {
  it('serves a public homepage at the apex that links to the app and both legal pages', async () => {
    const assets = { fetch: async () => new Response('app shell') } as unknown as Fetcher;
    const res = await call('/', { ...env, ASSETS: assets });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain('href="/app/"');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
  });

  it('still sends other unknown paths to the web app', async () => {
    const assets = { fetch: async () => new Response('app shell') } as unknown as Fetcher;
    const res = await call('/somewhere', { ...env, ASSETS: assets });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://api.test/app/');
  });
});
