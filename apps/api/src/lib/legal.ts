import privacyPolicy from '../../legal/privacy-policy.md';
import termsOfService from '../../legal/terms-of-service.md';
import { sitePage } from './site-page.js';

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Only absolute http(s)/mailto links and same-site paths become anchors. */
function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:|\/)/i.test(url) ? url : null;
}

/** Inline spans: `code`, **bold**, *italic*, [text](url). Escapes first. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
      const href = safeHref(url.replace(/&amp;/g, '&'));
      return href ? `<a href="${escapeHtml(href)}">${label}</a>` : whole;
    });
}

/**
 * Render the small Markdown subset the legal documents use: `#`–`###`
 * headings, paragraphs (consecutive lines join), `-` / `1.` lists (an
 * indented line continues the item above it), and the inline spans above.
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
    } else if (bullet) {
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
  const md = LEGAL_DOCS[doc];
  const title = /^#\s+(.*)$/m.exec(md)?.[1] ?? 'Legal';
  return sitePage({
    title: `${title} · I Got That`,
    body: `<nav><a href="/">I Got That</a> · <a href="/legal/privacy">Privacy Policy</a> · <a href="/legal/terms">Terms of Service</a></nav>
${renderMarkdown(md)}`,
  });
}
