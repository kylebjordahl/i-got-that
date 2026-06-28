/** Assemble a single-part text/calendar (iMIP) email as raw RFC 5322 MIME. */
export function buildInviteEmailMime(opts: {
  from: string;
  to: string;
  subject: string;
  ics: string;
  method: 'REQUEST' | 'CANCEL';
}): string {
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: text/calendar; method=${opts.method}; charset=UTF-8`,
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.ics,
  ].join('\r\n');
}
