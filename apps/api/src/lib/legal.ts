import privacyPolicy from '../../legal/privacy-policy.md';
import termsOfService from '../../legal/terms-of-service.md';
import { escapeHtml, sitePage } from './site-page.js';

/**
 * The public legal pages (`/legal/privacy`, `/legal/terms`). The text lives in
 * `apps/api/legal/` as Markdown and is bundled as a string
 * (wrangler's `Text` module rule for `*.md`), so publishing a change is an edit
 * there plus a deploy. They're linked from the sign-in screen and the Google
 * OAuth consent screen, so they must stay reachable without a session.
 */
export const LEGAL_DOCS = {
  privacy: privacyPolicy,
  terms: termsOfService,
} as const;

export type LegalDoc = keyof typeof LEGAL_DOCS;

export function isLegalDoc(name: string): name is LegalDoc {
  return Object.hasOwn(LEGAL_DOCS, name);
}

/** Only absolute http(s)/mailto links and same-site paths become anchors
 *  (not `//host` or `/\host`, which browsers resolve off-site). */
function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:|\/(?![/\\]))/i.test(url) ? url : null;
}

/** `**bold**` then `*italic*`, on already-escaped text. The markers must hug
 *  their text, so `5 * 3 * 2` stays arithmetic. */
function emphasis(html: string): string {
  return html
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*(?!\*)/g, '<em>$1</em>');
}

/** Private-use marker around a held-out span's index; never in our text. */
const HELD = '';

/**
 * Inline spans: `code`, [text](url), **bold**, *italic*. Code spans and links
 * are set aside first, so emphasis never reaches inside code or a URL (only a
 * link's label), then everything is escaped and the held spans put back.
 */
function inline(text: string): string {
  const held: string[] = [];
  const hold = (html: string) => `${HELD}${held.push(html) - 1}${HELD}`;
  const marked = text
    .replace(/`([^`]+)`/g, (_, code: string) => hold(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole: string, label: string, url: string) => {
      const href = safeHref(url);
      return hold(
        href
          ? `<a href="${escapeHtml(href)}">${emphasis(escapeHtml(label))}</a>`
          : escapeHtml(whole),
      );
    });
  // A link's label can itself hold a code span, so restore until none remain.
  const placeholder = new RegExp(`${HELD}(\\d+)${HELD}`, 'g');
  let html = emphasis(escapeHtml(marked));
  while (placeholder.test(html)) {
    html = html.replace(placeholder, (_, i: string) => held[Number(i)]!);
  }
  return html;
}

/**
 * Render the small Markdown subset the legal documents use: `#`–`###`
 * headings, paragraphs (consecutive lines join), `-` / `1.` lists (an
 * indented line continues the item above it; as in CommonMark, only a `-`
 * item or one numbered `1.` can interrupt a paragraph, so a wrapped
 * "…January 1,\n2026. We…" stays one paragraph), and the inline spans above.
 * Not a general Markdown renderer — the input is our own committed text.
 */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    }
    list = null;
  };

  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);

    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (heading) {
      flushPara();
      flushList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (bullet && (!para.length || bullet[1] || bullet[2] === '1')) {
      flushPara();
      const tag = bullet[1] ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(bullet[3]!);
    } else if (list && /^\s+/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join('\n');
}

/** A standalone, readable HTML page for one legal document. */
export function legalPage(doc: LegalDoc): string {
  const md = LEGAL_DOCS[doc].replace(/\r\n/g, '\n');
  // Plain text for <title>: drop the inline markers the heading may carry.
  const title = (/^#\s+(.*)$/m.exec(md)?.[1] ?? 'Legal').replace(/[*`]/g, '').trim();
  return sitePage({
    title: `${title} · I Got That`,
    body: `<nav><a href="/">I Got That</a> · <a href="/legal/privacy">Privacy Policy</a> · <a href="/legal/terms">Terms of Service</a></nav>
${renderMarkdown(md)}`,
  });
}
