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
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('redirects a trailing slash to the canonical URL', async () => {
    const res = await call('/legal/privacy/');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/legal/privacy');
    expect((await call('/legal/cookies/')).status).toBe(404);
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

  it('keeps a wrapped line that starts with a number in its paragraph', () => {
    expect(renderMarkdown('effective January 1,\n2026. We may change it.')).toBe(
      '<p>effective January 1, 2026. We may change it.</p>',
    );
  });

  it('starts a list straight after a paragraph line', () => {
    expect(renderMarkdown('We collect:\n- your email\n- your name')).toBe(
      '<p>We collect:</p>\n<ul><li>your email</li><li>your name</li></ul>',
    );
    expect(renderMarkdown('Steps:\n1. first\n2. second')).toBe(
      '<p>Steps:</p>\n<ol><li>first</li><li>second</li></ol>',
    );
  });

  it('keeps a code span inside a link label', () => {
    expect(renderMarkdown('[the `code` label](https://e.com)')).toBe(
      '<p><a href="https://e.com">the <code>code</code> label</a></p>',
    );
  });

  it('never applies emphasis inside code spans or link URLs', () => {
    expect(renderMarkdown('[x](https://ex.com/a*b*c) and `**raw**`')).toBe(
      '<p><a href="https://ex.com/a*b*c">x</a> and <code>**raw**</code></p>',
    );
    expect(renderMarkdown('[**bold** label](/legal/terms)')).toBe(
      '<p><a href="/legal/terms"><strong>bold</strong> label</a></p>',
    );
  });

  it('nests italic in bold and leaves loose asterisks alone', () => {
    expect(renderMarkdown('**bold *nested* x** and 5 * 3 * 2')).toBe(
      '<p><strong>bold <em>nested</em> x</strong> and 5 * 3 * 2</p>',
    );
  });

  it('refuses protocol-relative links', () => {
    expect(renderMarkdown('[a](//evil.com) [b](/\\evil.com)')).not.toContain('href');
  });

  it('escapes HTML and refuses script links', () => {
    const html = renderMarkdown('<script>x</script> [bad](javascript:alert(1))');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript');
  });
});
