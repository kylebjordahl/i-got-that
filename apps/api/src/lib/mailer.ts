/**
 * Magic-link mail. Deployed envs with outbound email (the `EMAIL` binding plus
 * `PUBLIC_ORIGIN` to build the link from) get an `OutboxMailer` that sends
 * through the same outbox as email outputs; everywhere else a DevMailer
 * captures the most recent token so local dev and tests can complete the flow
 * without a mailbox.
 */
import { buildTextEmailMime } from '@igt/delivery';
import type { MagicLinkPurpose } from '@igt/domain';
import type { Bindings } from '../env.js';
import { emailEnabled, getOutbox, type Outbox } from './email.js';

export interface MagicLinkMessage {
  to: string;
  token: string;
  purpose?: MagicLinkPurpose;
}

export interface Mailer {
  sendMagicLink(message: MagicLinkMessage): Promise<void>;
}

export class DevMailer implements Mailer {
  lastToken: string | null = null;

  /**
   * `logTokens` echoes the raw token to the console so local dev can grab it
   * from the `wrangler dev` output. It's a working login credential, so it's
   * gated the same way the `devToken` response field is — a deployed env would
   * otherwise persist it into the observability logs.
   */
  constructor(private readonly logTokens = false) {}

  async sendMagicLink(message: MagicLinkMessage): Promise<void> {
    this.lastToken = message.token;
    if (this.logTokens) {
      console.log(`[dev-mailer] magic link for ${message.to}: ${message.token}`);
    }
  }
}

/**
 * The link opens the web app with the token in the FRAGMENT, the same handoff
 * the Apple/Google callbacks use for `#session=`: a fragment never reaches a
 * server, so the credential stays out of access logs and Referer headers.
 * `#magic=` signs in (or, opened while signed in, attaches the address);
 * `#link-email=` only attaches, and the API refuses it for sign-in. The app
 * consumes either and strips it. iOS opens the same URL in the app
 * (Universal Links cover `/app/*`).
 */
export function magicLinkUrl(
  publicOrigin: string,
  token: string,
  purpose: MagicLinkPurpose = 'sign_in',
): string {
  const key = purpose === 'link' ? 'link-email' : 'magic';
  return `${publicOrigin.replace(/\/$/, '')}/app/#${key}=${token}`;
}

export class OutboxMailer implements Mailer {
  constructor(
    private readonly outbox: Outbox,
    private readonly publicOrigin: string,
  ) {}

  async sendMagicLink(message: MagicLinkMessage): Promise<void> {
    const linking = message.purpose === 'link';
    const link = magicLinkUrl(this.publicOrigin, message.token, message.purpose);
    await this.outbox.send(
      buildTextEmailMime({
        from: this.outbox.from,
        to: message.to,
        subject: linking
          ? 'Add this email to your I Got That account'
          : 'Your I Got That sign-in link',
        text: [
          linking
            ? 'Open this link where you are signed in to I Got That to add this address as a way to sign in:'
            : 'Open this link to sign in to I Got That:',
          link,
          '',
          'It works once and expires in 15 minutes.',
          "If you didn't ask for this, ignore this email — nobody can use the link without it.",
        ].join('\n'),
      }),
      message.to,
    );
  }
}

/** Choose a mailer for the environment. */
export function getMailer(
  env: Pick<Bindings, 'ALLOW_DEV_TOKENS' | 'EMAIL' | 'ORGANIZER_EMAIL' | 'PUBLIC_ORIGIN'>,
): Mailer {
  if (emailEnabled(env) && env.PUBLIC_ORIGIN) {
    return new OutboxMailer(getOutbox(env), env.PUBLIC_ORIGIN);
  }
  return new DevMailer(env.ALLOW_DEV_TOKENS === 'true');
}
