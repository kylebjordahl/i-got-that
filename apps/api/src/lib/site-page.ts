/** Escape text for an HTML element body or a quoted attribute value. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The shell for the worker's few server-rendered public pages (the homepage
 * and the legal documents): one readable column, light/dark from the system.
 * `title` and `description` are text (escaped here); `body` and `css` are
 * trusted markup — escape anything interpolated into them with [escapeHtml].
 */
export function sitePage(opts: { title: string; body: string; description?: string; css?: string }): string {
  const description = opts.description
    ? `\n<meta name="description" content="${escapeHtml(opts.description)}">`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${description}
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1d1a22; --muted: #5d5866; --accent: #6b4fd8; --card: #f4f1f9; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15121b; --fg: #ece8f2; --muted: #a59fb0; --accent: #a996ff; --card: #211c2a; } }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 1.9rem; line-height: 1.2; }
  h2 { font-size: 1.3rem; margin-top: 2em; }
  h3 { font-size: 1.05rem; margin-top: 1.5em; }
  a { color: var(--accent); }
  code { font-size: 0.9em; }
  nav, footer { font-size: 0.9rem; color: var(--muted); }
${opts.css ?? ''}
</style>
</head>
<body>
<main>
${opts.body}
</main>
</body>
</html>`;
}
