import { buildStoredEventICalendar } from '@igt/ical';
import type {
  DeliveryEvent,
  DeliveryProvider,
  DeliveryResult,
  DeliveryTarget,
} from './index.js';

/**
 * Direct CalDAV write (iCloud + generic) — full-detail stored events, no
 * invite/RSVP semantics. We talk to the collection URL directly (the one the
 * caretaker picked during discovery) with a single authenticated PUT/DELETE per
 * event, rather than going through tsdav's account discovery + create-only
 * helper. This gives true upsert semantics (a plain PUT overwrites) and keeps
 * the create/cancel URLs identical. `fetchImpl` is injectable for tests.
 */
export class CalDavProvider implements DeliveryProvider {
  readonly method = 'caldav' as const;

  // Default to the global fetch bound to the global scope: on Cloudflare
  // Workers a bare `fetch` reference called as a method (`this.fetchImpl(...)`)
  // throws "Illegal invocation" because it loses its global `this`. Tests inject
  // their own fetch, so this only bites in the deployed Worker.
  constructor(private readonly fetchImpl: typeof fetch = fetch.bind(globalThis)) {}

  /** The object URL for an event within a collection (trailing slash enforced). */
  private objectUrl(collectionUrl: string, uid: string): string {
    const base = collectionUrl.endsWith('/') ? collectionUrl : `${collectionUrl}/`;
    return new URL(`${encodeURIComponent(uid)}.ics`, base).href;
  }

  private authHeader(target: DeliveryTarget): string {
    if (target.credential?.kind !== 'basic') {
      throw new Error('caldav target requires a basic credential');
    }
    const { username, password } = target.credential;
    return `Basic ${btoa(`${username}:${password}`)}`;
  }

  async upsert(event: DeliveryEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    const authorization = this.authHeader(target);
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
    const url = this.objectUrl(target.addressOrUrl, event.uid);
    // Unconditional PUT = upsert: creates on first write, overwrites on update.
    const res = await this.fetchImpl(url, {
      method: 'PUT',
      headers: {
        authorization,
        'content-type': 'text/calendar; charset=utf-8',
      },
      body: iCalString,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`caldav PUT ${res.status} for ${url}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    return { externalRef: event.uid, sequence: event.sequence };
  }

  async cancel(event: DeliveryEvent, target: DeliveryTarget): Promise<void> {
    const authorization = this.authHeader(target);
    const url = this.objectUrl(target.addressOrUrl, event.uid);
    const res = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: { authorization },
    });
    // 404/410 = already gone; anything else non-2xx is a real failure.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      const detail = await res.text().catch(() => '');
      throw new Error(`caldav DELETE ${res.status} for ${url}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
  }
}
