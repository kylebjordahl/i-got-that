import { buildCancelICalendar, buildInviteICalendar } from '@igt/ical';
import type {
  DeliveryEvent,
  DeliveryProvider,
  DeliveryResult,
  DeliveryTarget,
} from './index.js';
import { buildInviteEmailMime, type ExtraHeaders } from './mime.js';

export type EmailSender = (rawMime: string, to: string) => Promise<void>;

/**
 * RFC 8058 one-click unsubscribe headers. Mail clients (Gmail, Apple Mail)
 * only offer their built-in "Unsubscribe" for an absolute https URL that
 * accepts a POST, so a relative dev link gets none.
 */
export function unsubscribeHeaders(url: string | undefined): ExtraHeaders {
  if (!url?.startsWith('https://')) return {};
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/** Plain-text body: what the invite is, plus how to stop them. */
function textBody(summary: string, target: DeliveryTarget, lead: string): string {
  const lines = [`${lead}: ${summary}`];
  if (target.unsubscribeUrl) {
    lines.push('', `Stop receiving these calendar invites: ${target.unsubscribeUrl}`);
  }
  return lines.join('\n');
}

/**
 * Full-detail iMIP invites. Builds the VEVENT (METHOD:REQUEST/CANCEL) and a raw
 * MIME message, then hands it to an injected sender (Cloudflare Email Service in
 * production; a capturing sender in tests). The attendee address is the target's
 * addressOrUrl.
 */
export class EmailImipProvider implements DeliveryProvider {
  readonly method = 'email' as const;

  constructor(
    private readonly send: EmailSender,
    private readonly organizerEmail: string,
  ) {}

  async upsert(event: DeliveryEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    const ics = buildInviteICalendar({
      uid: event.uid,
      sequence: event.sequence,
      start: event.start,
      end: event.end,
      summary: event.summary,
      description: event.description,
      location: event.location,
      locationGeo: event.locationGeo,
      travelTimeMinutes: event.travelTimeMinutes,
      alertMinutes: event.alertMinutes,
      timezone: event.timezone,
      organizerEmail: this.organizerEmail,
      attendeeEmail: target.addressOrUrl,
    });
    await this.send(
      buildInviteEmailMime({
        from: this.organizerEmail,
        to: target.addressOrUrl,
        subject: event.summary,
        ics,
        method: 'REQUEST',
        text: textBody(event.summary, target, 'Calendar invite'),
        headers: unsubscribeHeaders(target.unsubscribeUrl),
      }),
      target.addressOrUrl,
    );
    return { externalRef: event.uid, sequence: event.sequence };
  }

  async cancel(event: DeliveryEvent, target: DeliveryTarget): Promise<void> {
    const ics = buildCancelICalendar({
      uid: event.uid,
      sequence: event.sequence,
      start: event.start,
      end: event.end,
      summary: event.summary,
      organizerEmail: this.organizerEmail,
      attendeeEmail: target.addressOrUrl,
    });
    await this.send(
      buildInviteEmailMime({
        from: this.organizerEmail,
        to: target.addressOrUrl,
        subject: `Cancelled: ${event.summary}`,
        ics,
        method: 'CANCEL',
        text: textBody(event.summary, target, 'Cancelled'),
        headers: unsubscribeHeaders(target.unsubscribeUrl),
      }),
      target.addressOrUrl,
    );
  }
}
