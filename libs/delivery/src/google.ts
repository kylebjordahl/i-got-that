import type {
  AccessTokenRefresher,
  DeliveryEvent,
  DeliveryProvider,
  DeliveryResult,
  DeliveryTarget,
  OwnedRemoteEvent,
} from './index.js';
import { DeliveryHttpError } from './errors.js';

/** Private extended property naming the deployment that wrote an event. */
const ORIGIN_PROPERTY = 'igtOrigin';

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
    /**
     * Which deployment writes here (e.g. `production`), stamped on every event
     * as a private extended property. `listOwned` passes over events stamped
     * by a *different* deployment, so two environments mirroring into one
     * calendar never sweep each other's events.
     */
    private readonly origin?: string,
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

  private eventsUrl(target: DeliveryTarget, eventId?: string): string {
    const calId = target.externalCalendarId ?? 'primary';
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
    return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
  }

  /**
   * Google's own id for the event carrying `uid` (our iCalUID), or null.
   * Google addresses events by that opaque id — `events/{eventId}` — never by
   * iCalUID; this is the documented way back from one to the other. Includes
   * cancelled events so a re-created UID can revive its tombstone.
   */
  private async findEventId(
    uid: string,
    target: DeliveryTarget,
    accessToken: string,
  ): Promise<string | null> {
    const url = `${this.eventsUrl(target)}?iCalUID=${encodeURIComponent(uid)}&showDeleted=true`;
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new DeliveryHttpError(`google calendar lookup failed: ${res.status}`, res.status);
    const json = (await res.json()) as { items?: { id?: string; status?: string }[] };
    const items = (json.items ?? []).filter((i) => i.id);
    const live = items.find((i) => i.status !== 'cancelled') ?? items[0];
    return live?.id ?? null;
  }

  /**
   * Create or update. An event we already delivered is updated in place by
   * Google's id (`externalRef`); inserting it again is a 409, because the
   * iCalUID already exists on the calendar. A 409 on insert means we lost the
   * ref (or the UID left a cancelled tombstone), so the id is looked up and the
   * event updated instead. A ref Google no longer knows (404/410: the user
   * deleted it from the calendar) falls back to a fresh insert.
   */
  async upsert(event: DeliveryEvent, target: DeliveryTarget): Promise<DeliveryResult> {
    const accessToken = await this.accessToken(target);
    const body = {
      iCalUID: event.uid,
      // Revives a cancelled tombstone when an update lands on one.
      status: 'confirmed',
      summary: event.summary,
      location: event.location,
      description: event.description,
      // timeZone tags the (UTC) instant with the source zone so Google renders it
      // there rather than the account's default; omitted ⇒ Google uses the offset.
      start: { dateTime: event.start.toISOString(), timeZone: event.timezone },
      end: {
        dateTime: (event.end ?? new Date(event.start.getTime() + 3_600_000)).toISOString(),
        timeZone: event.timezone,
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
      ...(this.origin
        ? { extendedProperties: { private: { [ORIGIN_PROPERTY]: this.origin } } }
        : {}),
    };
    const send = (method: 'POST' | 'PUT', eventId?: string) =>
      this.fetchImpl(this.eventsUrl(target, eventId), {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const result = async (res: Response, fallbackId?: string): Promise<DeliveryResult> => {
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      return { externalRef: json.id ?? fallbackId ?? event.uid, sequence: event.sequence };
    };

    if (event.externalRef) {
      const res = await send('PUT', event.externalRef);
      if (res.ok) return result(res, event.externalRef);
      if (res.status !== 404 && res.status !== 410) {
        throw new DeliveryHttpError(`google calendar update failed: ${res.status}`, res.status);
      }
    }
    const res = await send('POST');
    if (res.ok) return result(res);
    if (res.status !== 409) throw new DeliveryHttpError(`google calendar insert failed: ${res.status}`, res.status);
    const existingId = await this.findEventId(event.uid, target, accessToken);
    if (!existingId) throw new Error('google calendar insert failed: 409 with no event for its UID');
    const updated = await send('PUT', existingId);
    if (!updated.ok) throw new DeliveryHttpError(`google calendar update failed: ${updated.status}`, updated.status);
    return result(updated, existingId);
  }

  /**
   * Delete by Google's id. Already gone (404/410, or no event for the UID) is
   * success; any other failure throws, so the mirror keeps its row and retries
   * rather than forgetting a copy that is still on the calendar.
   */
  async cancel(event: DeliveryEvent, target: DeliveryTarget): Promise<void> {
    if (target.credential?.kind !== 'oauth') return;
    const accessToken = await this.accessToken(target);
    const eventId =
      event.externalRef ?? (await this.findEventId(event.uid, target, accessToken));
    if (!eventId) return;
    const res = await this.fetchImpl(this.eventsUrl(target, eventId), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new DeliveryHttpError(`google calendar delete failed: ${res.status}`, res.status);
    }
  }

  async listOwned(
    target: DeliveryTarget,
    query: { uidPrefix: string; start: Date; end: Date },
  ): Promise<OwnedRemoteEvent[]> {
    const accessToken = await this.accessToken(target);
    const out: OwnedRemoteEvent[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        timeMin: query.start.toISOString(),
        timeMax: query.end.toISOString(),
        singleEvents: 'true',
        maxResults: '2500',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.fetchImpl(`${this.eventsUrl(target)}?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new DeliveryHttpError(`google calendar list failed: ${res.status}`, res.status);
      const json = (await res.json()) as {
        items?: {
          id?: string;
          iCalUID?: string;
          updated?: string;
          extendedProperties?: { private?: Record<string, string> };
        }[];
        nextPageToken?: string;
      };
      for (const item of json.items ?? []) {
        if (!item.id || !item.iCalUID?.startsWith(query.uidPrefix)) continue;
        // Unstamped events predate the stamp and count as ours.
        const origin = item.extendedProperties?.private?.[ORIGIN_PROPERTY];
        if (origin && origin !== this.origin) continue;
        out.push({
          uid: item.iCalUID,
          externalRef: item.id,
          updatedAt: item.updated ? new Date(item.updated) : null,
        });
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
    return out;
  }
}
