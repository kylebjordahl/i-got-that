import { describe, expect, it } from 'vitest';
import { DevOutbox } from '../src/lib/email.js';
import { magicLinkUrl, OutboxMailer } from '../src/lib/mailer.js';

/** The decoded text/plain body of a captured mail. */
function body(mime: string): string {
  const b64 = mime.slice(mime.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, '');
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

describe('magic-link mail', () => {
  it('puts the token in the fragment, where no server logs it', () => {
    expect(magicLinkUrl('https://igt.test/', 'abc')).toBe('https://igt.test/app/#magic=abc');
    expect(magicLinkUrl('https://igt.test', 'abc', 'link')).toBe(
      'https://igt.test/app/#link-email=abc',
    );
  });

  it('mails a sign-in link, or an add-this-email link, to the address', async () => {
    const outbox = new DevOutbox('noreply@igt.test');
    const mailer = new OutboxMailer(outbox, 'https://igt.test');
    await mailer.sendMagicLink({ to: 'a@example.com', token: 't1' });
    await mailer.sendMagicLink({ to: 'b@example.com', token: 't2', purpose: 'link' });

    expect(outbox.sent.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com']);
    expect(outbox.sent[0]!.mime).toContain('Subject: Your I Got That sign-in link');
    expect(body(outbox.sent[0]!.mime)).toContain('https://igt.test/app/#magic=t1');
    expect(outbox.sent[1]!.mime).toContain('Subject: Add this email to your I Got That account');
    expect(body(outbox.sent[1]!.mime)).toContain('https://igt.test/app/#link-email=t2');
  });
});
