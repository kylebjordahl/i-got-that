/**
 * Raw RFC 5322 MIME for outbound mail. Includes Date + Message-ID so it passes
 * strict validators (e.g. Cloudflare Email Service). `from` must be on a
 * verified sending domain.
 *
 * Header values are sanitised here, not by callers: a subject is usually an
 * event summary, which comes from a third-party feed, so a CR/LF in it would
 * otherwise let the feed inject headers (a Bcc:) into mail we send. Bodies are
 * base64 so a UTF-8 summary survives any relay that enforces 7-bit.
 */

/** One line, no control characters; RFC 2047-encoded when it isn't plain ASCII. */
function headerValue(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (/^[ -~]*$/.test(flat)) return flat;
  return `=?UTF-8?B?${base64(flat)}?=`;
}

/** An address header: anything but a bare address is refused outright. */
function addressValue(address: string): string {
  if (!/^[^\s<>",;:@]+@[^\s<>",;:@]+$/.test(address)) {
    throw new Error(`refusing to mail a malformed address: ${JSON.stringify(address)}`);
  }
  return address;
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** base64, wrapped at 76 columns as RFC 2045 requires. */
function base64Body(text: string): string {
  return (base64(text).match(/.{1,76}/g) ?? []).join('\r\n');
}

/** Extra headers a caller may add (e.g. List-Unsubscribe). */
export type ExtraHeaders = Record<string, string>;

function envelope(opts: {
  from: string;
  to: string;
  subject: string;
  headers?: ExtraHeaders;
}): string[] {
  const domain = opts.from.split('@')[1] ?? 'localhost';
  const extra = Object.entries(opts.headers ?? {}).map(([name, value]) => {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`bad header name: ${name}`);
    return `${name}: ${headerValue(value)}`;
  });
  return [
    `From: ${addressValue(opts.from)}`,
    `To: ${addressValue(opts.to)}`,
    `Subject: ${headerValue(opts.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    ...extra,
    'MIME-Version: 1.0',
  ];
}

/**
 * An iMIP message (RFC 6047): multipart/alternative with a plain-text summary
 * for clients that don't render invites, and the text/calendar part that
 * carries the METHOD every calendar client acts on.
 */
export function buildInviteEmailMime(opts: {
  from: string;
  to: string;
  subject: string;
  ics: string;
  method: 'REQUEST' | 'CANCEL';
  /** Plain-text alternative; defaults to the subject. */
  text?: string;
  headers?: ExtraHeaders;
}): string {
  const boundary = `igt-${crypto.randomUUID()}`;
  return [
    ...envelope(opts),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(opts.text ?? opts.subject),
    `--${boundary}`,
    `Content-Type: text/calendar; method=${opts.method}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(opts.ics),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** A plain-text message (e.g. an address-verification mail). */
export function buildTextEmailMime(opts: {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers?: ExtraHeaders;
}): string {
  return [
    ...envelope(opts),
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(opts.text),
    '',
  ].join('\r\n');
}
