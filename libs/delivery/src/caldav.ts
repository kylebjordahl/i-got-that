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
/** The account/server root for a calendar collection URL (for client discovery). */
function serverRoot(collectionUrl: string): string {
  try {
    return new URL(collectionUrl).origin;
  } catch {
    return collectionUrl;
  }
}

export class CalDavProvider implements DeliveryProvider {
  readonly method = 'caldav' as const;

  async upsert(event: DeliveryEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    if (target.credential?.kind !== 'basic') {
      throw new Error('caldav target requires a basic credential');
    }
    // addressOrUrl is the specific calendar collection; the client connects to
    // the server root and writes the event into that collection.
    const client = await createCalDavClient({
      serverUrl: serverRoot(target.addressOrUrl),
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
      alertMinutes: event.alertMinutes,
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
      serverUrl: serverRoot(target.addressOrUrl),
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
