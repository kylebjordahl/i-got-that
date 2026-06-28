/**
 * Outbound email abstraction. v1 sends via Cloudflare Email Service; that
 * concrete sender is wired in Phase 4 (Email Worker + raw MIME). For now a
 * DevMailer captures the most recent magic-link token so local dev and tests
 * can complete the flow without sending real email.
 */
export interface MagicLinkMessage {
  to: string;
  token: string;
}

export interface Mailer {
  sendMagicLink(message: MagicLinkMessage): Promise<void>;
}

export class DevMailer implements Mailer {
  lastToken: string | null = null;

  async sendMagicLink(message: MagicLinkMessage): Promise<void> {
    this.lastToken = message.token;
    console.log(`[dev-mailer] magic link for ${message.to}: ${message.token}`);
  }
}

/** Choose a mailer for the environment. Production wiring comes in Phase 4. */
export function getMailer(environment: string): Mailer {
  // TODO(Phase 4): return a CloudflareEmailMailer in production.
  void environment;
  return new DevMailer();
}
