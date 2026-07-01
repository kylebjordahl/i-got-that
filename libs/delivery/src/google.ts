import type {
  AccessTokenRefresher,
  DeliveryEvent,
  DeliveryProvider,
  DeliveryResult,
  DeliveryTarget,
} from './index.js';

/**
 * Google Calendar via the REST API (the Node `googleapis` SDK is too heavy for
 * Workers). The credential carries an access token and/or a refresh token; when
 * only a refresh token is present we exchange it for an access token via the
 * injected `refresh` callback (the host holds the OAuth client secret).
 * `fetchImpl` is injectable for tests.
 */
export class GoogleCalendarProvider implements DeliveryProvider {
  readonly method = 'google' as const;

  constructor(
    // Bound to the global scope so a bare global `fetch` doesn't throw "Illegal
    // invocation" when invoked as `this.fetchImpl(...)` on Cloudflare Workers.
    private readonly fetchImpl: typeof fetch = fetch.bind(globalThis),
    private readonly refresh?: AccessTokenRefresher,
  ) {}

  /** Resolve a usable access token from the credential (refreshing if needed). */
  private async accessToken(target: DeliveryTarget): Promise<string> {
    const cred = target.credential;
    if (cred?.kind !== 'oauth') {
      throw new Error('google target requires an oauth credential');
    }
    if (cred.accessToken) return cred.accessToken;
    if (cred.refreshToken && this.refresh) return this.refresh(cred.refreshToken);
    throw new Error('google credential has no usable access token');
  }

  async upsert(event: DeliveryEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    const accessToken = await this.accessToken(target);
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
          Authorization: `Bearer ${accessToken}`,
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
    const accessToken = await this.accessToken(target);
    const calId = target.externalCalendarId ?? 'primary';
    await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(event.uid)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
  }
}
