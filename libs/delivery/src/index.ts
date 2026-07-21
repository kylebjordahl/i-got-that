import type { DeliveryMethod, GeoLocation, RsvpStatus } from '@igt/domain';

export { CalDavProvider } from './caldav.js';
export { EmailImipProvider, type EmailSender } from './email.js';
export { GoogleCalendarProvider } from './google.js';
export { buildInviteEmailMime } from './mime.js';

/**
 * Delivery abstraction. v1 ships three full-detail providers (email/iMIP via
 * Cloudflare Email Service, CalDAV via tsdav, Google via the Calendar REST
 * API). Block-only output (v1.1) and an ICS-feed provider slot in behind this
 * same interface without reworking callers. Concrete providers are implemented
 * in Phase 4.
 */

export interface DeliveryEvent {
  /** Stable UID we own for this (task, target) so updates/cancels are idempotent. */
  uid: string;
  sequence: number;
  start: Date;
  end: Date | null;
  summary: string;
  description?: string;
  location?: string;
  /**
   * Geocoded coords for `location`. CalDAV/iMIP emit them as GEO +
   * X-APPLE-STRUCTURED-LOCATION (Apple travel time); Google ignores them (its
   * REST location is text-only and Google geocodes server-side).
   */
  locationGeo?: GeoLocation | null;
  /** Default reminders: minutes before start, from the target config. */
  alertMinutes?: number[];
  /** IANA timezone of the source event so the delivered event isn't shown in GMT. */
  timezone?: string;
}

export interface DeliveryTarget {
  method: DeliveryMethod;
  /** email address, CalDAV collection URL, or Google calendar id. */
  addressOrUrl: string;
  externalCalendarId?: string;
  /** Resolved (decrypted) credential material, when the method needs it. */
  credential?: DeliveryCredential;
}

export type DeliveryCredential =
  | { kind: 'basic'; username: string; password: string }
  // accessToken (short-lived, e.g. a paste) and/or refreshToken (exchanged for
  // an access token at delivery time via an injected refresher).
  | { kind: 'oauth'; accessToken?: string; refreshToken?: string };

/** Exchange a stored refresh token for a fresh access token (provided by the host). */
export type AccessTokenRefresher = (refreshToken: string) => Promise<string>;

export interface DeliveryResult {
  externalRef?: string;
  sequence: number;
}

export interface DeliveryProvider {
  readonly method: DeliveryMethod;
  /** Create or update the event on the target. Returns the external reference. */
  upsert(event: DeliveryEvent, target: DeliveryTarget): Promise<DeliveryResult>;
  /** Remove a previously-delivered event (unassignment / cancellation). */
  cancel(event: DeliveryEvent, target: DeliveryTarget): Promise<void>;
}

/** Inbound iMIP REPLY parse result (Email Worker → RSVP state). */
export interface RsvpReply {
  uid: string;
  status: RsvpStatus;
}

export class DeliveryProviderRegistry {
  private readonly providers = new Map<DeliveryMethod, DeliveryProvider>();

  register(provider: DeliveryProvider): this {
    this.providers.set(provider.method, provider);
    return this;
  }

  get(method: DeliveryMethod): DeliveryProvider {
    const p = this.providers.get(method);
    if (!p) throw new Error(`No delivery provider registered for "${method}"`);
    return p;
  }

  has(method: DeliveryMethod): boolean {
    return this.providers.has(method);
  }
}
