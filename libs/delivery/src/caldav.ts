import { buildStoredEventICalendar, createCalDavClient } from '@igt/ical';
import type {
  DeliveryEvent,
  DeliveryProvider,
  DeliveryResult,
  DeliveryTarget,
} from './index.js';

/**
 * Direct CalDAV write (iCloud + generic) via tsdav — full-detail stored events,
 * no invite/RSVP semantics. Requires a basic credential (e.g. iCloud
 * app-specific password). Network-dependent; verified against a live server
 * rather than in unit tests.
 */
export class CalDavProvider implements DeliveryProvider {
  readonly method = 'caldav' as const;

  async upsert(event: DeliveryEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    if (target.credential?.kind !== 'basic') {
      throw new Error('caldav target requires a basic credential');
    }
    const client = await createCalDavClient({
      serverUrl: target.addressOrUrl,
      username: target.credential.username,
      password: target.credential.password,
    });
    const iCalString = buildStoredEventICalendar({
      uid: event.uid,
      sequence: event.sequence,
      start: event.start,
      end: event.end,
      summary: event.summary,
      description: event.description,
      location: event.location,
    });
    await client.createCalendarObject({
      calendar: { url: target.addressOrUrl } as never,
      filename: `${event.uid}.ics`,
      iCalString,
    });
    return { externalRef: event.uid, sequence: event.sequence };
  }

  async cancel(event: DeliveryEvent, target: DeliveryTarget): Promise<void> {
    if (target.credential?.kind !== 'basic') return;
    const client = await createCalDavClient({
      serverUrl: target.addressOrUrl,
      username: target.credential.username,
      password: target.credential.password,
    });
    await client.deleteCalendarObject({
      calendarObject: {
        url: `${target.addressOrUrl}/${event.uid}.ics`,
        etag: '',
      } as never,
    });
  }
}
