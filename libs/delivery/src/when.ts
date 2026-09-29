/**
 * Human-readable event times for mail text, in the event's own IANA zone (UTC
 * when it has none) — so the same event mailed twice reads identically and a
 * duplicate is easy to spot. en-US, like the rest of the app's copy.
 */

function zoned(timezone: string | undefined): string {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

/** "8:30 AM" */
export function formatEventTime(date: Date, timezone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zoned(timezone),
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** "Mon, Jul 6, 8:30 AM" */
export function formatEventStart(start: Date, timezone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zoned(timezone),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(start);
}

/** "Mon, Jul 6, 8:30 AM – 9:00 AM MDT", or across days "… – Tue, Jul 7, 9:00 AM MDT". */
export function formatEventWhen(start: Date, end: Date | null, timezone?: string): string {
  const tz = zoned(timezone);
  const zoneName =
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(start)
      .find((p) => p.type === 'timeZoneName')?.value ?? tz;
  const from = formatEventStart(start, tz);
  if (!end || end.getTime() <= start.getTime()) return `${from} ${zoneName}`;
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, dateStyle: 'short' }).format(d);
  const to = day(start) === day(end) ? formatEventTime(end, tz) : formatEventStart(end, tz);
  return `${from} – ${to} ${zoneName}`;
}
