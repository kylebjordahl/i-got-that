import ICAL from 'ical.js';
import ical, {
  ICalAlarmType,
  ICalCalendarMethod,
  ICalEventStatus,
  type ICalEvent,
} from 'ical-generator';
import { createDAVClient, fetchCalendarObjects } from 'tsdav';

/**
 * Thin wrappers over OSS libraries — we do NOT hand-roll iCalendar/CalDAV.
 *  - ical.js          → parse + RRULE expansion
 *  - ical-generator   → VEVENT generation (REQUEST/CANCEL MIME)
 *  - tsdav            → CalDAV client (iCloud + generic)
 */

export interface Occurrence {
  /** Stable iCalendar UID of the source VEVENT. */
  uid: string;
  /** ISO string of the occurrence start for recurring events, else null. */
  recurrenceId: string | null;
  start: Date;
  end: Date | null;
  summary: string | null;
  location: string | null;
  /**
   * True for `VALUE=DATE` (all-day) events, which carry no time. Their `start`/
   * `end` are anchored to UTC midnight of the calendar date (see
   * `icalTimeToDate`) so the day is tz-independent; consumers must render them
   * as a bare date and must NOT convert through a local timezone.
   */
  allDay: boolean;
}

/**
 * Convert an ICAL.Time to a JS Date. For date-only (all-day) values, ical.js's
 * `toJSDate()` resolves the *floating* date using the host runtime's timezone
 * (UTC on workerd, machine-local elsewhere) — which shifts all-day events by
 * the offset. Anchor them explicitly to UTC midnight from the y/m/d parts so the
 * calendar date is stable everywhere; timed values keep normal instant parsing.
 */
function icalTimeToDate(t: ICAL.Time): Date {
  if (t.isDate) return new Date(Date.UTC(t.year, t.month - 1, t.day));
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

export interface ExpandOptions {
  /** Inclusive lower bound (default: now). */
  windowStart?: Date;
  /** Exclusive upper bound (default: now + 90 days). */
  windowEnd?: Date;
  /** Safety cap on expanded occurrences per recurring event. */
  maxPerEvent?: number;
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
 */
export function parseAndExpand(
  icsText: string,
  opts: ExpandOptions = {},
): Occurrence[] {
  const windowStart = opts.windowStart ?? new Date();
  const windowEnd = opts.windowEnd ?? new Date(Date.now() + 90 * DAY);
  const maxPerEvent = opts.maxPerEvent ?? 750;

  const root = new ICAL.Component(ICAL.parse(icsText));
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
    const start = icalTimeToDate(event.startDate);
    const end = event.endDate ? icalTimeToDate(event.endDate) : null;
    if (!occurrenceInWindow(start, end, windowStart, windowEnd)) continue;
    out.push({
      uid: event.uid,
      recurrenceId: null,
      start,
      end,
      summary: event.summary ?? null,
      location: event.location ?? null,
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
      const startJs = next.toJSDate();
      if (startJs >= windowEnd) break;
      if (++count > maxPerEvent) break;

      const details = event.getOccurrenceDetails(next);
      const start = icalTimeToDate(details.startDate);
      const end = details.endDate ? icalTimeToDate(details.endDate) : null;
      if (!occurrenceInWindow(start, end, windowStart, windowEnd)) continue;

      out.push({
        uid: event.uid,
        recurrenceId: startJs.toISOString(),
        start,
        end,
        summary: details.item.summary ?? null,
        location: details.item.location ?? null,
        allDay: details.startDate.isDate,
      });
    }
  }

  // Overrides whose master didn't appear in this document (e.g. a CalDAV
  // time-range REPORT that returned the exception object but not the master)
  // still get a stable key from their own RECURRENCE-ID.
  for (const exVeList of overridesByUid.values()) {
    for (const ve of exVeList) {
      const event = new ICAL.Event(ve);
      if (!event.startDate || !event.recurrenceId) continue;
      const start = icalTimeToDate(event.startDate);
      const end = event.endDate ? icalTimeToDate(event.endDate) : null;
      if (!occurrenceInWindow(start, end, windowStart, windowEnd)) continue;
      out.push({
        uid: event.uid,
        recurrenceId: icalTimeToDate(event.recurrenceId).toISOString(),
        start,
        end,
        summary: event.summary ?? null,
        location: event.location ?? null,
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
export function extractTimezone(icsText: string): string | null {
  try {
    const root = new ICAL.Component(ICAL.parse(icsText));
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
export function extractCalendarName(icsText: string): string | null {
  try {
    const root = new ICAL.Component(ICAL.parse(icsText));
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
    o.allDay ? 'AD' : '',
  ].join(' ');
  let h = 5381;
  for (let i = 0; i < parts.length; i++) {
    h = ((h << 5) + h) ^ parts.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
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
  if (input.location) event.location(input.location);
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
  return cal.toString();
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
  if (input.location) {
    event.location(input.location);
    // Opt the event into Apple Calendar's automatic travel time. Apple only
    // computes it once it geocodes the LOCATION, but without this flag it never
    // tries. Harmless on Google/other clients, which ignore X-APPLE-* props.
    event.x('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR', 'AUTOMATIC');
  }
  addAlarms(event, input.alertMinutes);
  return cal.toString();
}

export interface CalDavConfig {
  serverUrl: string;
  username: string;
  password: string;
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

/**
 * Read occurrences from a CalDAV collection via a single time-ranged REPORT
 * (tsdav's standalone `fetchCalendarObjects`, no account discovery — we already
 * know the collection URL). Each returned object is a VCALENDAR expanded with
 * `parseAndExpand`, so RRULEs window identically to the ICS path. `fetchImpl` is
 * injectable for tests / bound to the global scope for Workers. The collection's
 * timezone (needed for exception-feed baselines) is read off whichever fetched
 * object's VCALENDAR carries it first — a time-range REPORT returns per-object
 * VCALENDARs, not one calendar-wide document.
 */
export async function fetchCalDavOccurrences(
  config: CalDavSourceConfig,
  opts: ExpandOptions = {},
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<AccountOccurrences> {
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
  let timezone: string | null = null;
  for (const obj of objects) {
    const data = typeof obj.data === 'string' ? obj.data : '';
    if (!data) continue;
    if (!timezone) timezone = extractTimezone(data);
    try {
      out.push(
        ...parseAndExpand(data, {
          windowStart,
          windowEnd,
          maxPerEvent: opts.maxPerEvent,
        }),
      );
    } catch {
      // Skip an individual unparseable object rather than failing the feed.
    }
  }
  return { occurrences: out, timezone };
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
  // their original start so (feedId, icalUid, recurrenceId) stays unique.
  const recurrenceId = ev.recurringEventId ? start.date.toISOString() : null;
  return {
    uid: ev.iCalUID ?? ev.id ?? crypto.randomUUID(),
    recurrenceId,
    start: start.date,
    end: end?.date ?? null,
    summary: ev.summary ?? null,
    location: ev.location ?? null,
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
    if (!res.ok) throw new Error(`google events.list failed: ${res.status}`);
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
  if (!res.ok) throw new Error(`google freebusy failed: ${res.status}`);
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
      summary: null,
      location: null,
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

/** List the calendars in a Google account (for the input/output feed picker). */
export async function fetchGoogleCalendars(
  accessToken: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): Promise<CalendarChoice[]> {
  const res = await fetchImpl(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`google calendarList failed: ${res.status}`);
  const json = (await res.json()) as {
    items?: { id?: string; summary?: string; summaryOverride?: string }[];
  };
  return (json.items ?? [])
    .filter((c): c is { id: string; summary?: string; summaryOverride?: string } => Boolean(c.id))
    .map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id }));
}
