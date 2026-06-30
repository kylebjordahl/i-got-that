import type {
  DeliveryEvent,
  DeliveryProvider,
  DeliveryResult,
  DeliveryTarget,
} from './index.js';

/**
 * Google Calendar via the REST API (the Node `googleapis` SDK is too heavy for
 * Workers). Assumes a valid access token on the target credential; OAuth refresh
 * is handled upstream. `fetchImpl` is injectable for tests.
 */
export class GoogleCalendarProvider implements DeliveryProvider {
  readonly method = 'google' as const;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async upsert(event: DeliveryEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    if (target.credential?.kind !== 'oauth') {
      throw new Error('google target requires an oauth credential');
    }
    const calId = target.externalCalendarId ?? 'primary';
    const body = {
      iCalUID: event.uid,
      summary: event.summary,
      location: event.location,
      description: event.description,
      start: { dateTime: event.start.toISOString() },
      end: {
        dateTime: (event.end ?? new Date(event.start.getTime() + 3_600_000)).toISOString(),
      },
      // Default popup reminders from the target config; useDefault:false so an
      // empty list explicitly means "no reminders" rather than the calendar's.
      reminders: {
        useDefault: false,
        overrides: (event.alertMinutes ?? []).map((minutes) => ({
          method: 'popup',
          minutes,
        })),
      },
    };
    const res = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.credential.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`google calendar insert failed: ${res.status}`);
    const json = (await res.json()) as { id?: string };
    return { externalRef: json.id ?? event.uid, sequence: event.sequence };
  }

  async cancel(event: DeliveryEvent, target: DeliveryTarget): Promise<void> {
    if (target.credential?.kind !== 'oauth') return;
    const calId = target.externalCalendarId ?? 'primary';
    await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(event.uid)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${target.credential.accessToken}` },
      },
    );
  }
}
