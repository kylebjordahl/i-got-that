/**
 * Outbound email abstraction. v1 sends via Cloudflare Email Service; that
 * concrete sender is wired in Phase 4 (Email Worker + raw MIME). For now a
 * DevMailer captures the most recent magic-link token so local dev and tests
 * can complete the flow without sending real email.
 */
import type { Bindings } from '../env.js';

export interface MagicLinkMessage {
  to: string;
  token: string;
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

/** Choose a mailer for the environment. Production wiring comes in Phase 4. */
export function getMailer(env: Pick<Bindings, 'ENVIRONMENT' | 'ALLOW_DEV_TOKENS'>): Mailer {
  // TODO(Phase 4): return a CloudflareEmailMailer in production.
  return new DevMailer(env.ALLOW_DEV_TOKENS === 'true');
}
