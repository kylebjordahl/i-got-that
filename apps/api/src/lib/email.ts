/**
 * Outbound mail for email invite outputs. A real `CloudflareOutbox` sends
 * through the `send_email` binding; without that binding (local dev, tests, and
 * every deployed env until #9 lands) `getOutbox` hands back a `DevOutbox` that
 * only captures. Callers that would otherwise record a capture as "sent" check
 * `emailEnabled` first — see `syncMemberEmailOutputs`' caller in `mirror.ts`.
 */
import { EmailMessage } from 'cloudflare:email';
import type { EmailSender } from '@igt/delivery';
import type { Bindings } from '../env.js';

export interface Outbox {
  /** Envelope + header From: must be on the verified sending domain. */
  readonly from: string;
  readonly send: EmailSender;
}

export class DevOutbox implements Outbox {
  readonly sent: { to: string; mime: string }[] = [];
  constructor(readonly from = 'noreply@igt.local') {}
  readonly send: EmailSender = async (mime, to) => {
    this.sent.push({ to, mime });
  };
}

class CloudflareOutbox implements Outbox {
  constructor(
    private readonly binding: SendEmail,
    readonly from: string,
  ) {}
  readonly send: EmailSender = async (mime, to) => {
    await this.binding.send(new EmailMessage(this.from, to, mime));
  };
}

/** True when this deployment can actually deliver mail. */
export function emailEnabled(env: Pick<Bindings, 'EMAIL' | 'ORGANIZER_EMAIL'>): boolean {
  return !!env.EMAIL && !!env.ORGANIZER_EMAIL;
}

export function getOutbox(env: Pick<Bindings, 'EMAIL' | 'ORGANIZER_EMAIL'>): Outbox {
  if (env.EMAIL && env.ORGANIZER_EMAIL) {
    return new CloudflareOutbox(env.EMAIL, env.ORGANIZER_EMAIL);
  }
  return new DevOutbox(env.ORGANIZER_EMAIL);
}

/**
 * Base for links in outbound mail: `<PUBLIC_ORIGIN>/api` in the single-origin
 * deploy (the API sits under /api there), relative when unset (local/tests).
 */
export function emailLinkBase(env: Pick<Bindings, 'PUBLIC_ORIGIN'>): string {
  return env.PUBLIC_ORIGIN ? `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/api` : '';
}
