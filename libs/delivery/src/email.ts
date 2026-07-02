import { buildCancelICalendar, buildInviteICalendar } from '@igt/ical';
import type {
  DeliveryEvent,
  DeliveryProvider,
  DeliveryResult,
  DeliveryTarget,
} from './index.js';
import { buildInviteEmailMime } from './mime.js';

export type EmailSender = (rawMime: string, to: string) => Promise<void>;

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
      }),
      target.addressOrUrl,
    );
  }
}
