import { geoKey, type GeoLocation } from '@igt/domain';
import ICAL from 'ical.js';
import ical, {
  ICalAlarmType,
  ICalCalendarMethod,
  ICalEventStatus,
  type ICalEvent,
  type ICalLocation,
} from 'ical-generator';
import { createDAVClient, fetchCalendarObjects } from 'tsdav';

/**
 * Resolve a display `location` string plus optional geocode into what
 * ical-generator's `event.location()` accepts. With coords we return the
 * structured form (title + address + `geo`), which makes ical-generator emit
 * both `GEO` and Apple's `X-APPLE-STRUCTURED-LOCATION` — the properties Apple
 * Calendar reads to compute travel time without re-geocoding. Without coords we
 * fall back to the plain string (today's behaviour); with neither, `undefined`.
 */
function resolveIcalLocation(
  location: string | null | undefined,
  geo: GeoLocation | null | undefined,
): ICalLocation | string | undefined {
  if (geo) {
    return {
      title: geo.title ?? location ?? geo.address ?? 'Location',
      address: geo.address ?? location ?? undefined,
      // ical-generator only emits X-APPLE-STRUCTURED-LOCATION when a radius is
      // present, and Apple needs that property (not bare GEO) to drive travel
      // time — so default a metres radius when the geocode didn't supply one.
      radius: geo.radius ?? 100,
      geo: { lat: geo.lat, lon: geo.lon },
    };
  }
  return location ? location : undefined;
}

/**
 * Thin wrappers over OSS libraries — we do NOT hand-roll iCalendar/CalDAV.
 *  - ical.js          → parse + RRULE expansion
 *  - ical-generator   → VEVENT generation (REQUEST/CANCEL MIME)
 *  - tsdav            → CalDAV client (iCloud + generic)
 */

/**
 * Longest description kept per occurrence. Feeds routinely carry whole
 * newsletters in DESCRIPTION, and the text is stored once per expanded
 * occurrence; a rule only needs to find a phrase, and the phrases that matter
 * ("early release", "no school") sit near the top. A longer body is cut here,
 * at ingest, so everything downstream (the row, the hash, the matcher) sees the
 * same text.
 */
export const MAX_DESCRIPTION_CHARS = 2000;

/**
 * Normalize a source's free-text body for storage: blank means none, and a long
 * body is cut to `MAX_DESCRIPTION_CHARS`. (ical.js has already unescaped
 * `\n`, `\,` and friends by the time an ICS value gets here.)
 */
export function normalizeDescription(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  return text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS) : text;
}

export interface Occurrence {
  /** Stable iCalendar UID of the source VEVENT. */
  uid: string;
  /**
   * ISO string of the instance's ORIGINAL start (RFC 5545 RECURRENCE-ID) for
   * recurring events, else null. It names which slot of the series this is, so
   * it must NOT follow the instance when it's rescheduled: `start` moves with
   * the reschedule, `recurrenceId` doesn't. Everything downstream hangs off
   * `(feed, uid, recurrenceId)` — the `ev:` calendar event, its tasks, claims
   * and mirror — so a key that tracked the moved start would turn "move one
   * practice" into delete + add.
   */
  recurrenceId: string | null;
  start: Date;
  end: Date | null;
  summary: string | null;
  location: string | null;
  /**
   * Coordinates the source event carried for `location` (its `GEO` and/or
   * Apple's `X-APPLE-STRUCTURED-LOCATION`). Null when the source only gave
   * free text — most feeds do, but anything authored in Apple Calendar or a
   * mapped Google place carries coords, and they're what let the events (and
   * the tasks they generate) drive travel time on the way back out.
   */
  locationGeo: GeoLocation | null;
  /**
   * The source event's free-text body (VEVENT `DESCRIPTION`, Google
   * `description`), unescaped and truncated to `MAX_DESCRIPTION_CHARS`. It is
   * carried for RULE MATCHING only (a `description` / `any_text` link or task
   * rule): it is stored on `source_events` but deliberately does not flow onto
   * the synthesized calendar events, so it never reaches a member's mirror
   * calendar or an email invite. Null when the source gave none.
   */
  description: string | null;
  /**
   * True for `VALUE=DATE` (all-day) events, which carry no time. Their `start`/
   * `end` are anchored to UTC midnight of the calendar date (see
   * `icalTimeToDate`) so the day is tz-independent; consumers must render them
   * as a bare date and must NOT convert through a local timezone.
   */
  allDay: boolean;
}

/**
 * Read a VEVENT's geocode: Apple's `X-APPLE-STRUCTURED-LOCATION` when present
 * (it carries the place's title/address/radius alongside the coords), else the
 * bare RFC 5545 `GEO`. Both are optional in the wild — a feed whose events give
 * only free-text `LOCATION` yields null, which is the pre-existing behaviour.
 */
function occurrenceGeo(component: ICAL.Component): GeoLocation | null {
  const structured = component.getFirstProperty('x-apple-structured-location');
  if (structured) {
    // VALUE=URI of the form `geo:<lat>,<lon>`; the human-readable parts ride
    // along as parameters.
    const uri = String(structured.getFirstValue() ?? '');
    const match = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(uri.trim());
    if (match) {
      const radius = Number(structured.getParameter('x-apple-radius'));
      const title = structured.getParameter('x-title');
      const address = structured.getParameter('x-address');
      return {
        lat: Number(match[1]),
        lon: Number(match[2]),
        ...(typeof title === 'string' && title ? { title } : {}),
        ...(typeof address === 'string' && address ? { address } : {}),
        ...(Number.isFinite(radius) && radius > 0 ? { radius } : {}),
      };
    }
  }
  // ical.js parses GEO's `lat;lon` into a two-number array.
  const geo = component.getFirstPropertyValue('geo');
  if (Array.isArray(geo) && geo.length === 2) {
    const [lat, lon] = geo.map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat: lat!, lon: lon! };
  }
  return null;
}

/**
 * Resolve a wall-clock date/time in an IANA zone to the instant it denotes,
 * DST-aware. `Intl.DateTimeFormat` can only format an instant *into* a zone,
 * not parse one back out, so this guesses UTC==wall-clock, reads back what
 * that guess renders as in `tz`, and corrects by the difference — exact
 * except in the (here irrelevant) instant of a DST fall-back repeat.
 */
function zonedWallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(guess))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  // h23 can render midnight as 24; normalize back to 0 for Date.UTC.
  const renderedAsUtc = Date.UTC(
    p.year!,
    p.month! - 1,
    p.day!,
    p.hour === 24 ? 0 : p.hour!,
    p.minute!,
    p.second!,
  );
  return new Date(guess - (renderedAsUtc - guess));
}

/**
 * Convert an ICAL.Time to a JS Date.
 *
 * Date-only (all-day) values: ical.js's `toJSDate()` resolves the *floating*
 * date using the host runtime's timezone (UTC on workerd, machine-local
 * elsewhere) — which shifts all-day events by the offset. Anchor them
 * explicitly to UTC midnight from the y/m/d parts so the calendar date is
 * stable everywhere.
 *
 * Timed values with an explicit TZID or trailing `Z` already resolve to the
 * correct instant via ical.js's own VTIMEZONE handling — keep `toJSDate()`.
 * Timed values with *neither* (RFC 5545 "floating" time — no zone info at
 * all, e.g. many booking-software exports) are a genuine ambiguity: the wall
 * clock is meaningless without a zone. `toJSDate()` would resolve it using
 * the host runtime's timezone, silently misinterpreting an 11:00 appointment
 * as 11:00 UTC on workerd — hours off for any non-UTC provider. Given a
 * `defaultTimezone` hint (the feed's known IANA zone), interpret the floating
 * wall-clock time in that zone instead; with no hint, fall back to the old
 * (host-timezone-dependent) behavior since that's the best information
 * available.
 */
function icalTimeToDate(t: ICAL.Time, defaultTimezone?: string): Date {
  if (t.isDate) return new Date(Date.UTC(t.year, t.month - 1, t.day));
  if (defaultTimezone && t.zone === ICAL.Timezone.localTimezone) {
    return zonedWallTimeToInstant(t.year, t.month, t.day, t.hour, t.minute, t.second, defaultTimezone);
  }
  return t.toJSDate();
}

/**
 * An occurrence belongs in [windowStart, windowEnd) if it starts before the
 * window closes, and either starts on/after windowStart or — being multi-day
 * — is still ongoing (its end is after windowStart). Without the second
 * clause, a still-relevant multi-day/all-day span that began before "now"
 * (e.g. a closure spanning today through tomorrow) would be dropped from
 * ingestion entirely, taking tomorrow's coverage down with it. Mirrors the
 * overlap check the synthesis DB query already uses (`synthesisWindow`'s
 * `dtstart < window.end AND (dtstart >= window.start OR dtend > window.start)`).
 */
function occurrenceInWindow(
  start: Date,
  end: Date | null,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  if (start >= windowEnd) return false;
  if (start >= windowStart) return true;
  return end != null && end > windowStart;
}

/**
 * Parse an ICS document into its root VCALENDAR component. `ICAL.parse` is the
 * most CPU-heavy step of an ingest, so parse once here and hand the component to
 * `parseAndExpand` / `extractTimezone` / `extractCalendarName`. Throws on a
 * document ical.js can't parse (the extractors below swallow that; this doesn't).
 */
export function parseCalendar(icsText: string): ICAL.Component {
  return new ICAL.Component(ICAL.parse(icsText));
}

/** An ICS document: raw text, or the root component `parseCalendar` returned for it. */
export type IcsSource = string | ICAL.Component;

function asRoot(source: IcsSource): ICAL.Component {
  return typeof source === 'string' ? parseCalendar(source) : source;
}

export interface ExpandOptions {
  /** Inclusive lower bound (default: now). */
  windowStart?: Date;
  /** Exclusive upper bound (default: now + 90 days). */
  windowEnd?: Date;
  /** Safety cap on expanded occurrences per recurring event. */
  maxPerEvent?: number;
  /**
   * IANA zone to interpret "floating" timed values in (no TZID, no trailing
   * `Z` — RFC 5545 leaves these ambiguous). Typically the document's own
   * `extractTimezone` result, else the feed's previously-stored one; without
   * it, floating times fall back to the host runtime's timezone (see
   * `icalTimeToDate`).
   */
  defaultTimezone?: string;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Parse an ICS document and expand recurring events into concrete occurrences
 * within [windowStart, windowEnd).
 *
 * VEVENTs carrying a RECURRENCE-ID are *overrides* of one occurrence of a
 * recurring master, not independent events — ical.js only recognizes that
 * relationship when the override is explicitly related via the master's
 * `exceptions` option (isRecurring() is false for the override itself, since
 * it has no RRULE of its own). Treating every VEVENT independently would
 * both double-count overridden dates (stale master occurrence + moved
 * override) and, since every override falls through to `recurrenceId: null`,
 * collapse two or more overrides of the same series onto the same
 * (uid, recurrenceId) key.
 *
 * Takes the document as text, or as the root already parsed by `parseCalendar`
 * so a caller that also needs `extractTimezone`/`extractCalendarName` parses
 * once instead of once per helper.
 */
export function parseAndExpand(
  source: IcsSource,
  opts: ExpandOptions = {},
): Occurrence[] {
  const windowStart = opts.windowStart ?? new Date();
  const windowEnd = opts.windowEnd ?? new Date(Date.now() + 90 * DAY);
  const maxPerEvent = opts.maxPerEvent ?? 750;

  const root = asRoot(source);
  const vevents = root.getAllSubcomponents('vevent');
  const out: Occurrence[] = [];

  const masters = new Map<string, ICAL.Component>();
  const overridesByUid = new Map<string, ICAL.Component[]>();
  const standalone: ICAL.Component[] = [];

  for (const ve of vevents) {
    const event = new ICAL.Event(ve);
    if (event.recurrenceId) {
      const list = overridesByUid.get(event.uid) ?? [];
      list.push(ve);
      overridesByUid.set(event.uid, list);
    } else if (event.isRecurring()) {
      masters.set(event.uid, ve);
    } else {
      standalone.push(ve);
    }
  }

  for (const ve of standalone) {
    const event = new ICAL.Event(ve);
    if (!event.startDate) continue;
    const start = icalTimeToDate(event.startDate, opts.defaultTimezone);
    const end = event.endDate ? icalTimeToDate(event.endDate, opts.defaultTimezone) : null;
    if (!occurrenceInWindow(start, end, windowStart, windowEnd)) continue;
    out.push({
      uid: event.uid,
      recurrenceId: null,
      start,
      end,
      summary: event.summary ?? null,
      location: event.location ?? null,
      locationGeo: occurrenceGeo(ve),
      description: normalizeDescription(event.description),
      allDay: event.startDate.isDate,
    });
  }

  for (const [uid, masterVe] of masters) {
    const exceptions = overridesByUid.get(uid) ?? [];
    overridesByUid.delete(uid);
    const event = new ICAL.Event(masterVe, { exceptions });

    const iterator = event.iterator();
    let count = 0;
    let next: ICAL.Time | null;
    while ((next = iterator.next())) {
      // Compute the (possibly floating-timezone-corrected) start before the
      // windowEnd break check — comparing the raw `next.toJSDate()` here would
      // use the host runtime's timezone instead of `defaultTimezone`, which
      // for zones behind UTC breaks the loop too early and silently drops
      // trailing in-window occurrences.
      const details = event.getOccurrenceDetails(next);
      const start = icalTimeToDate(details.startDate, opts.defaultTimezone);
      if (start >= windowEnd) break;
      if (++count > maxPerEvent) break;

      const end = details.endDate ? icalTimeToDate(details.endDate, opts.defaultTimezone) : null;
      if (!occurrenceInWindow(start, end, windowStart, windowEnd)) continue;

      out.push({
        uid: event.uid,
        // Key on the series slot (`next`, surfaced as `details.recurrenceId`),
        // not `start`: when a RECURRENCE-ID override moved this instance,
        // `start` is the new time but the slot is still the original — and it's
        // the same key the orphan-override path below derives from the
        // override's own RECURRENCE-ID, so a document with or without its
        // master agrees.
        recurrenceId: icalTimeToDate(details.recurrenceId, opts.defaultTimezone).toISOString(),
        start,
        end,
        summary: details.item.summary ?? null,
        location: details.item.location ?? null,
        // `details.item` is the master, or the RECURRENCE-ID override when one
        // covers this date — either way, that occurrence's own VEVENT.
        locationGeo: occurrenceGeo(details.item.component),
        description: normalizeDescription(details.item.description),
        allDay: details.startDate.isDate,
      });
    }
  }

  // Overrides whose master didn't appear in this document (e.g. a CalDAV
  // time-range REPORT that returned the exception object but not the master)
  // still get a stable key from their own RECURRENCE-ID — the same original
  // start the master path above keys the overridden instance by.
  for (const exVeList of overridesByUid.values()) {
    for (const ve of exVeList) {
      const event = new ICAL.Event(ve);
      if (!event.startDate || !event.recurrenceId) continue;
      const start = icalTimeToDate(event.startDate, opts.defaultTimezone);
      const end = event.endDate ? icalTimeToDate(event.endDate, opts.defaultTimezone) : null;
      if (!occurrenceInWindow(start, end, windowStart, windowEnd)) continue;
      out.push({
        uid: event.uid,
        recurrenceId: icalTimeToDate(event.recurrenceId, opts.defaultTimezone).toISOString(),
        start,
        end,
        summary: event.summary ?? null,
        location: event.location ?? null,
        locationGeo: occurrenceGeo(ve),
        description: normalizeDescription(event.description),
        allDay: event.startDate.isDate,
      });
    }
  }

  return out;
}

/**
 * The calendar's timezone (IANA, e.g. "America/Los_Angeles") — the calendar-wide
 * X-WR-TIMEZONE property if present (Google/Apple .ics exports include it),
 * else the TZID of the document's first VTIMEZONE (CalDAV time-range REPORTs
 * return per-object VCALENDARs that carry one instead). Used to interpret
 * configured baseline wall-times for exception feeds. Null if absent/unparseable.
 */
export function extractTimezone(source: IcsSource): string | null {
  try {
    const root = asRoot(source);
    const tz = root.getFirstPropertyValue('x-wr-timezone');
    if (typeof tz === 'string' && tz.length > 0) return tz;
    const vtimezone = root.getFirstSubcomponent('vtimezone');
    const tzid = vtimezone?.getFirstPropertyValue('tzid');
    return typeof tzid === 'string' && tzid.length > 0 ? tzid : null;
  } catch {
    return null;
  }
}

/**
 * The calendar's own display name from X-WR-CALNAME (Google/Apple exports set
 * it). Used to backfill an ICS feed's title when the user didn't supply one.
 * Null if absent/unparseable.
 */
export function extractCalendarName(source: IcsSource): string | null {
  try {
    const root = asRoot(source);
    const name = root.getFirstPropertyValue('x-wr-calname');
    return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Stable content hash for an occurrence — used to detect feed changes
 * (source_events.content_hash). djb2 over the meaningful fields; cheap and
 * synchronous (no SubtleCrypto await needed in the hot path).
 */
export function hashOccurrence(o: Occurrence): string {
  const parts = [
    o.uid,
    o.recurrenceId ?? '',
    o.start.toISOString(),
    o.end ? o.end.toISOString() : '',
    o.summary ?? '',
    o.location ?? '',
    // A place re-pinned upstream (same text, new/changed coords) has to count
    // as a change, or synthesis never carries the geocode down to the events.
    geoKey(o.locationGeo),
    o.allDay ? 'AD' : '',
    // A description-only edit has to count as a change: rules match on it, so
    // synthesis must re-run (and the ingest upsert's `content_hash <>` guard
    // must let the new text through).
    o.description ?? '',
  ].join(' ');
  let h = 5381;
  for (let i = 0; i < parts.length; i++) {
    h = ((h << 5) + h) ^ parts.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
}

/**
 * Turn on Apple Calendar's travel time for a located event.
 *
 * Two properties are needed, and they do different jobs:
 *  - `X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC` opts the event into the
 *    "time to leave" advisory, which Apple recomputes from live traffic.
 *  - `X-APPLE-TRAVEL-DURATION` is the travel block itself — the reserved time
 *    Calendar draws *before* the event. Without it Apple shows no travel time
 *    at all until a human opens the event and picks one by hand, which is
 *    exactly what a mirrored drop-off/pickup must not require.
 *
 * The duration rides on the property *name* because ical-generator's `x()`
 * emits `KEY:value` verbatim and has no parameter support; Apple (and the
 * RFC 5545 grammar) want `;VALUE=DURATION` on this one. Travel time is
 * meaningless without coordinates to route to, so callers only pass minutes
 * for events that carry a geocode.
 */
function addTravelTime(event: ICalEvent, minutes: number | null | undefined): void {
  event.x('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR', 'AUTOMATIC');
  if (minutes != null && minutes > 0) {
    event.x('X-APPLE-TRAVEL-DURATION;VALUE=DURATION', `PT${Math.round(minutes)}M`);
  }
}

/** Add display VALARMs that fire `n` minutes before the event start. */
function addAlarms(event: ICalEvent, alertMinutes: number[] | undefined): void {
  for (const minutes of alertMinutes ?? []) {
    event.createAlarm({ type: ICalAlarmType.display, trigger: minutes * 60 });
  }
}

/**
 * A Date whose *local* getters (`getHours()` …) equal `instant`'s wall-clock time
 * in `tz`. This is the only host-independent way to drive ical-generator's
 * Date+TZID path: given a timezone it formats a JS Date with the runtime's local
 * getters (not the absolute instant), so we hand it a Date built from the zoned
 * wall-clock parts. Returns null for an unknown/unresolvable zone.
 */
function toZonedLocal(instant: Date, tz: string): Date | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const p: Record<string, number> = {};
    for (const part of dtf.formatToParts(instant)) {
      if (part.type !== 'literal') p[part.type] = Number(part.value);
    }
    return new Date(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  } catch {
    return null;
  }
}

/**
 * Resolve the start/end/timezone to hand ical-generator. With a usable IANA zone
 * we tag the VEVENT with its TZID (so iCloud/Apple render it in that zone instead
 * of "GMT") and pass wall-clock-anchored Dates; otherwise we fall back to bare
 * UTC (`Z`) output. `endInstant` is the caller's end or a 1-hour default.
 */
function timedFields(
  startInstant: Date,
  endInstant: Date,
  tz: string | undefined,
): { start: Date; end: Date; timezone?: string } {
  if (tz && tz !== 'UTC') {
    const start = toZonedLocal(startInstant, tz);
    const end = toZonedLocal(endInstant, tz);
    if (start && end) return { start, end, timezone: tz };
  }
  return { start: startInstant, end: endInstant };
}

export interface InviteEventInput {
  uid: string;
  sequence: number;
  start: Date;
  end: Date | null;
  summary: string;
  description?: string;
  location?: string;
  /** Geocoded coords for `location` (emits GEO + X-APPLE-STRUCTURED-LOCATION). */
  locationGeo?: GeoLocation | null;
  /** Travel-time block (minutes) Apple should reserve before the event start. */
  travelTimeMinutes?: number | null;
  /** Minutes before start for display alarms (VALARM). */
  alertMinutes?: number[];
  /** IANA timezone (from the source feed) to render DTSTART/DTEND in; UTC if absent. */
  timezone?: string;
  organizerEmail: string;
  organizerName?: string;
  attendeeEmail: string;
  attendeeName?: string;
}

/** Build a full-detail iMIP invite (METHOD:REQUEST) as an iCalendar string. */
export function buildInviteICalendar(input: InviteEventInput): string {
  return buildICalendar(input, ICalCalendarMethod.REQUEST, ICalEventStatus.CONFIRMED);
}

/** Build a cancellation (METHOD:CANCEL) for a previously-sent invite. */
export function buildCancelICalendar(input: InviteEventInput): string {
  return buildICalendar(input, ICalCalendarMethod.CANCEL, ICalEventStatus.CANCELLED);
}

/** "+0530" / "-0700": `tz`'s UTC offset at `instant`, as an iCalendar UTC-OFFSET. */
function utcOffset(instant: Date, tz: string): string | null {
  const local = toZonedLocal(instant, tz);
  if (!local) return null;
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  const minutes = Math.round((Date.UTC(
    local.getFullYear(), local.getMonth(), local.getDate(),
    local.getHours(), local.getMinutes(), local.getSeconds(),
  ) - whole) / 60000);
  const abs = Math.abs(minutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/**
 * A VTIMEZONE defining `tz` as the single observance in force at `instant`.
 * A bare TZID isn't enough for iMIP: Outlook/Exchange ignore a TZID the message
 * doesn't define and show the time as UTC. One observance is exact for these
 * invites (one non-recurring VEVENT) and, unlike a full rule table, needs no
 * bundled tz database — which can't be read on Workers. Null for an unknown zone.
 */
function vtimezoneFor(tz: string, instant: Date): string | null {
  const offset = utcOffset(instant, tz);
  if (!offset) return null;
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(instant)
      .find((p) => p.type === 'timeZoneName')?.value ?? tz;
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tz}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    `TZNAME:${name}`,
    'END:STANDARD',
    'END:VTIMEZONE',
    '',
  ].join('\r\n');
}

function buildICalendar(
  input: InviteEventInput,
  method: ICalCalendarMethod,
  status: ICalEventStatus,
): string {
  const cal = ical({ prodId: { company: 'igt', product: 'caretaker' } });
  cal.method(method);
  const endInstant = input.end ?? new Date(input.start.getTime() + 60 * 60 * 1000);
  const { start, end, timezone } = timedFields(input.start, endInstant, input.timezone);
  const event = cal.createEvent({
    id: input.uid,
    sequence: input.sequence,
    start,
    end,
    timezone,
    summary: input.summary,
    status,
  });
  if (input.description) event.description(input.description);
  const inviteLocation = resolveIcalLocation(input.location, input.locationGeo);
  if (inviteLocation) {
    event.location(inviteLocation);
    addTravelTime(event, input.travelTimeMinutes);
  }
  if (method === ICalCalendarMethod.REQUEST) addAlarms(event, input.alertMinutes);
  event.organizer({
    name: input.organizerName ?? 'Family Logistics',
    email: input.organizerEmail,
  });
  event.createAttendee({
    name: input.attendeeName,
    email: input.attendeeEmail,
    rsvp: true,
  });
  const ics = cal.toString();
  const vtimezone = timezone ? vtimezoneFor(timezone, input.start) : null;
  return vtimezone ? ics.replace('BEGIN:VEVENT', `${vtimezone}BEGIN:VEVENT`) : ics;
}

/**
 * A plain stored VEVENT (no METHOD/ORGANIZER/ATTENDEE) for direct CalDAV/Google
 * writes — full detail, no invite semantics.
 */
export function buildStoredEventICalendar(input: {
  uid: string;
  sequence: number;
  start: Date;
  end: Date | null;
  summary: string;
  description?: string;
  location?: string;
  /** Geocoded coords for `location` (emits GEO + X-APPLE-STRUCTURED-LOCATION). */
  locationGeo?: GeoLocation | null;
  /** Travel-time block (minutes) Apple should reserve before the event start. */
  travelTimeMinutes?: number | null;
  /** Minutes before start for display alarms (VALARM). */
  alertMinutes?: number[];
  /** IANA timezone (from the source feed) to render DTSTART/DTEND in; UTC if absent. */
  timezone?: string;
}): string {
  const cal = ical({ prodId: { company: 'igt', product: 'caretaker' } });
  const endInstant = input.end ?? new Date(input.start.getTime() + 60 * 60 * 1000);
  const { start, end, timezone } = timedFields(input.start, endInstant, input.timezone);
  const event = cal.createEvent({
    id: input.uid,
    sequence: input.sequence,
    start,
    end,
    timezone,
    summary: input.summary,
    status: ICalEventStatus.CONFIRMED,
  });
  if (input.description) event.description(input.description);
  const storedLocation = resolveIcalLocation(input.location, input.locationGeo);
  if (storedLocation) {
    // Opt the event into Apple Calendar's travel time, and reserve the block
    // when the caller sized one, so it shows up without anyone having to open
    // the event. Whether a given event deserves minutes — and how many — is the
    // caller's call (see the mirror); this just emits what it's handed.
    // Harmless on Google/other clients, which ignore X-APPLE-* props.
    event.location(storedLocation);
    addTravelTime(event, input.travelTimeMinutes);
  }
  addAlarms(event, input.alertMinutes);
  return cal.toString();
}

export interface CalDavConfig {
  serverUrl: string;
  username: string;
  password: string;
  /**
   * Transport for every request the client makes, discovery hops included.
   * The API passes its SSRF-guarded fetch here — `serverUrl` is user-supplied,
   * and so are the collection hrefs discovery walks to from it.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Create a CalDAV client (tsdav). Used by the CalDavProvider for iCloud and
 * generic servers. tsdav auto-detects the runtime's native `fetch`, so it runs
 * under Cloudflare Workers / workerd.
 */
export function createCalDavClient(config: CalDavConfig) {
  return createDAVClient({
    serverUrl: config.serverUrl,
    credentials: {
      username: config.username,
      password: config.password,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
  });
}

// --- Input feed source readers (account-backed feeds) --------------------

export interface CalDavSourceConfig {
  /** The collection URL to read (the feed's immutable target calendar). */
  collectionUrl: string;
  username: string;
  password: string;
}

export interface AccountOccurrences {
  occurrences: Occurrence[];
  /** IANA timezone of the source calendar, if discoverable; null otherwise. */
  timezone: string | null;
}

export interface CalDavOccurrences extends AccountOccurrences {
  /**
   * UIDs found in objects the server returned but we couldn't parse. An event
   * we failed to *read* is not an event that was *deleted*, so the caller's
   * stale sweep must leave rows with these UIDs alone.
   */
  failedUids: string[];
  /**
   * How many unparseable objects had no UID we could pull out of their raw
   * text. We can't tell what those objects held, so when this is non-zero the
   * caller must skip the stale sweep for this fetch entirely.
   */
  unidentifiedFailures: number;
}

/**
 * Best-effort UID extraction from an iCalendar body that failed to parse: every
 * `UID` line (parameters allowed), after undoing line folding so a UID wrapped
 * across lines isn't truncated into one that matches nothing. Deliberately a
 * regex, not a parser — it only runs on text the parser has just rejected.
 */
function extractRawUids(data: string): string[] {
  const unfolded = data.replace(/\r?\n[ \t]/g, '');
  const uids = new Set<string>();
  for (const m of unfolded.matchAll(/^UID(?:;[^:\r\n]*)?:(.+)$/gim)) {
    const uid = m[1]?.trim();
    if (uid) uids.add(uid);
  }
  return [...uids];
}

/**
 * Read occurrences from a CalDAV collection via a single time-ranged REPORT
 * (tsdav's standalone `fetchCalendarObjects`, no account discovery — we already
 * know the collection URL). Each returned object is a VCALENDAR expanded with
 * `parseAndExpand`, so RRULEs window identically to the ICS path. `fetchImpl` is
 * injectable for tests / bound to the global scope for Workers. The collection's
 * timezone (needed for exception-feed baselines) is read off whichever fetched
 * object's VCALENDAR carries it first — a time-range REPORT returns per-object
 * VCALENDARs, not one calendar-wide document.
 *
 * An object that fails to parse is skipped rather than failing the feed, but
 * it is *reported* (`failedUids` / `unidentifiedFailures`): its events are
 * missing from `occurrences` because we couldn't read them, not because the
 * server dropped them, and a caller that treats absence as deletion has to be
 * told the difference.
 */
export async function fetchCalDavOccurrences(
  config: CalDavSourceConfig,
  opts: ExpandOptions = {},
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<CalDavOccurrences> {
  const windowStart = opts.windowStart ?? new Date();
  const windowEnd = opts.windowEnd ?? new Date(Date.now() + 90 * DAY);
  const authorization = `Basic ${btoa(`${config.username}:${config.password}`)}`;
  const objects = await fetchCalendarObjects({
    calendar: { url: config.collectionUrl },
    timeRange: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
    headers: { authorization },
    fetch: fetchImpl,
  });
  const out: Occurrence[] = [];
  const failedUids = new Set<string>();
  let unidentifiedFailures = 0;
  let timezone: string | null = null;
  for (const obj of objects) {
    const data = typeof obj.data === 'string' ? obj.data : '';
    if (!data) continue;
    // Each time-range REPORT object is its own per-object VCALENDAR, so its
    // floating times (if any) need its own TZID/X-WR-TIMEZONE, not another
    // object's — falling back to the caller's hint (or the collection's
    // first-seen zone) only when this object carries none itself.
    const objTimezone = extractTimezone(data) ?? opts.defaultTimezone ?? timezone ?? undefined;
    if (!timezone) timezone = extractTimezone(data);
    try {
      out.push(
        ...parseAndExpand(data, {
          windowStart,
          windowEnd,
          maxPerEvent: opts.maxPerEvent,
          defaultTimezone: objTimezone,
        }),
      );
    } catch {
      // Skip an individual unparseable object rather than failing the feed —
      // but remember whose it was, so its existing events aren't swept as if
      // the server had deleted them.
      const uids = extractRawUids(data);
      if (uids.length === 0) unidentifiedFailures += 1;
      for (const uid of uids) failedUids.add(uid);
    }
  }
  return { occurrences: out, timezone, failedUids: [...failedUids], unidentifiedFailures };
}

interface GoogleApiTime {
  date?: string;
  dateTime?: string;
}
interface GoogleApiEvent {
  id?: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: GoogleApiTime;
  end?: GoogleApiTime;
  recurringEventId?: string;
  originalStartTime?: GoogleApiTime;
}
interface GoogleEventsResponse {
  items?: GoogleApiEvent[];
  nextPageToken?: string;
  /** IANA timezone of the calendar being queried (Google always includes it). */
  timeZone?: string;
}

/** All-day google times carry `date` (YYYY-MM-DD); anchor to UTC midnight like ICS. */
function googleTimeToDate(t: GoogleApiTime | undefined): { date: Date; allDay: boolean } | null {
  if (!t) return null;
  if (t.date) return { date: new Date(`${t.date}T00:00:00Z`), allDay: true };
  if (t.dateTime) return { date: new Date(t.dateTime), allDay: false };
  return null;
}

function googleEventToOccurrence(ev: GoogleApiEvent): Occurrence | null {
  if (ev.status === 'cancelled') return null;
  const start = googleTimeToDate(ev.start);
  if (!start) return null;
  const end = googleTimeToDate(ev.end);
  // Recurrence instances (singleEvents=true) share iCalUID; distinguish them by
  // their ORIGINAL start (`originalStartTime`, Google's RECURRENCE-ID) so
  // (feedId, icalUid, recurrenceId) stays unique AND stable when an instance is
  // rescheduled — `start` is the current time and moves with it. Google sets
  // `originalStartTime` on every instance; fall back to `start` only if a
  // response omits it.
  const recurrenceId = ev.recurringEventId
    ? (googleTimeToDate(ev.originalStartTime) ?? start).date.toISOString()
    : null;
  return {
    uid: ev.iCalUID ?? ev.id ?? crypto.randomUUID(),
    recurrenceId,
    start: start.date,
    end: end?.date ?? null,
    summary: ev.summary ?? null,
    location: ev.location ?? null,
    // events.list gives `location` as free text only — no coordinates.
    locationGeo: null,
    description: normalizeDescription(ev.description),
    allDay: start.allDay,
  };
}

/**
 * Read occurrences from a Google calendar via `events.list` (singleEvents=true so
 * recurrences arrive pre-expanded). The caller supplies a valid access token
 * (the host exchanges the stored refresh token). Paginates fully. Also returns
 * the calendar's own IANA timezone (the response's top-level `timeZone` field —
 * calendar-wide, not per-event), needed for exception-feed baselines.
 */
export async function fetchGoogleOccurrences(
  accessToken: string,
  calendarId: string,
  opts: ExpandOptions = {},
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<AccountOccurrences> {
  const windowStart = opts.windowStart ?? new Date();
  const windowEnd = opts.windowEnd ?? new Date(Date.now() + 90 * DAY);
  const out: Occurrence[] = [];
  let timezone: string | null = null;
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      maxResults: '2500',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw await googleApiError('events.list', res);
    const json = (await res.json()) as GoogleEventsResponse;
    if (!timezone && json.timeZone) timezone = json.timeZone;
    for (const ev of json.items ?? []) {
      const occ = googleEventToOccurrence(ev);
      if (occ) out.push(occ);
    }
    pageToken = json.nextPageToken;
  } while (pageToken);
  return { occurrences: out, timezone };
}

/**
 * A failed Google Calendar API call, carrying Google's own reason. The bare
 * status says almost nothing: a 403 is a missing OAuth scope, a disabled API,
 * a quota or a rate limit, and only the body says which. The message lands in
 * `feeds.lastErrorMessage`, so it has to be enough to act on.
 */
async function googleApiError(call: string, res: Response): Promise<GoogleApiError> {
  let detail = '';
  let reason: string | undefined;
  try {
    const json = (await res.json()) as {
      error?: { message?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] };
    };
    reason = json.error?.details?.[0]?.reason ?? json.error?.errors?.[0]?.reason;
    detail = [reason, json.error?.message].filter(Boolean).join(': ');
  } catch {
    // Not JSON: the status alone will have to do.
  }
  return new GoogleApiError(
    `google ${call} failed: ${res.status}${detail ? ` ${detail}` : ''}`,
    res.status,
    reason,
  );
}

interface GoogleFreeBusyInterval {
  start?: string;
  end?: string;
}
interface GoogleFreeBusyResponse {
  calendars?: Record<
    string,
    { busy?: GoogleFreeBusyInterval[]; errors?: { domain?: string; reason?: string }[] }
  >;
}

/**
 * Deterministic UID for a busy interval. Free/busy responses carry no event
 * identity at all, so the interval itself is the identity: a moved/merged/split
 * block is a *different* row, and busy ingest reconciles by deleting stale keys
 * (see `ingest.ts`) rather than relying on per-UID updates.
 */
export function busyIntervalUid(start: Date, end: Date): string {
  return `fb:${start.toISOString()}/${end.toISOString()}`;
}

/**
 * Read opaque busy intervals from a calendar via `freebusy.query`. This is the
 * privacy-preserving read behind busy-mode feeds: with only freeBusyReader
 * access (e.g. a work calendar shared to the personal account as "see only
 * free/busy"), Google returns start/end intervals and nothing else — the
 * detail-stripping is enforced by Google's ACL, not by this code. A calendar
 * that is unshared/nonexistent comes back as a per-calendar `errors` entry
 * (reason `notFound` for both), which throws so the feed is marked 'error'.
 * Returns `timezone: null`: intervals are absolute instants, not wall times.
 */
export async function fetchGoogleFreeBusy(
  accessToken: string,
  calendarId: string,
  opts: ExpandOptions = {},
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<AccountOccurrences> {
  const windowStart = opts.windowStart ?? new Date();
  const windowEnd = opts.windowEnd ?? new Date(Date.now() + 90 * DAY);
  const res = await fetchImpl('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      items: [{ id: calendarId }],
    }),
  });
  if (!res.ok) throw await googleApiError('freebusy', res);
  const json = (await res.json()) as GoogleFreeBusyResponse;
  // Google keys the response by the requested id; fall back to the single
  // entry in case it canonicalizes (we only ever query one calendar).
  const cal =
    json.calendars?.[calendarId] ?? Object.values(json.calendars ?? {})[0];
  if (!cal) throw new Error('google freebusy: calendar missing from response');
  if (cal.errors && cal.errors.length > 0) {
    const reasons = cal.errors.map((e) => e.reason ?? 'unknown').join(',');
    throw new Error(`google freebusy calendar error: ${reasons}`);
  }
  const occurrences: Occurrence[] = [];
  for (const b of cal.busy ?? []) {
    if (!b.start || !b.end) continue;
    const start = new Date(b.start);
    const end = new Date(b.end);
    occurrences.push({
      uid: busyIntervalUid(start, end),
      recurrenceId: null,
      start,
      end,
      // Free/busy intervals are opaque availability: no title, no place.
      locationGeo: null,
      summary: null,
      location: null,
      description: null,
      allDay: false,
    });
  }
  return { occurrences, timezone: null };
}

export interface CalendarChoice {
  /** CalDAV collection URL or Google calendar id (the feed/target's source). */
  id: string;
  name: string;
}

/** A Google API call that failed; `status` is Google's HTTP status. A 401/403
 *  means the stored grant can't do this (token revoked, or a scope the account
 *  was connected without) — the person has to reconnect, not retry. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Google's machine-readable reason, e.g. `ACCESS_TOKEN_SCOPE_INSUFFICIENT`. */
    readonly reason?: string,
  ) {
    super(message);
  }

  /**
   * The stored grant itself can't do this — only its owner reconnecting fixes
   * it. A 401 is a dead/revoked token; a 403 counts only for a missing scope,
   * not a quota, rate limit or disabled API, which reconnecting wouldn't help.
   */
  get needsReauth(): boolean {
    if (this.status === 401) return true;
    return (
      this.status === 403 &&
      (this.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || this.reason === 'insufficientPermissions')
    );
  }
}

/** List the calendars in a Google account (for the input/output feed picker). */
export async function fetchGoogleCalendars(
  accessToken: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<CalendarChoice[]> {
  const res = await fetchImpl(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw await googleApiError('calendarList', res);
  const json = (await res.json()) as {
    items?: { id?: string; summary?: string; summaryOverride?: string }[];
  };
  return (json.items ?? [])
    .filter((c): c is { id: string; summary?: string; summaryOverride?: string } => Boolean(c.id))
    .map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id }));
}
