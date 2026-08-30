import { startOfUtcDay } from '@igt/classification';
import { and, type Db, eq, feeds, gt, gte, inArray, lt, or, sourceEvents } from '@igt/db';
import {
  extractCalendarName,
  extractTimezone,
  fetchCalDavOccurrences,
  fetchGoogleFreeBusy,
  fetchGoogleOccurrences,
  hashOccurrence,
  type Occurrence,
  parseAndExpand,
} from '@igt/ical';
import { resolveAccountCredential } from '../lib/account-credentials.js';
import { runChunked } from '../lib/d1.js';
import type { KekKeySet } from '../lib/secrets.js';

export interface IngestOptions {
  fetchImpl?: typeof fetch;
  windowStart?: Date;
  windowEnd?: Date;
  /** Envelope key set — required to decrypt account credentials for caldav/google feeds. */
  kek?: KekKeySet;
  /** Exchange a Google refresh token for an access token (host holds the client secret). */
  googleRefresh?: (refreshToken: string) => Promise<string>;
  /**
   * A user pressed "Refresh feeds": read the source unconditionally.
   *
   * The background poll is happy to be told "nothing changed" — that's what the
   * stored ETag is for. A person pressing refresh has just changed something
   * and is watching for it, so the one thing that request must not do is come
   * back from a cache. `If-None-Match` is dropped (a CDN in front of the feed
   * answers it from its own copy, so a stale 304 can outlive the edit that
   * prompted the tap) and intermediaries are asked to revalidate.
   */
  force?: boolean;
}

export interface IngestResult {
  feedId: string;
  fetched: boolean;
  processed: number;
  /** Set (and fetched/processed left at their defaults) when this feed's ingest threw. */
  error?: string;
}

type FeedRow = typeof feeds.$inferSelect;

/** Default fetch/reconcile window when the caller doesn't pin one — mirrors `@igt/ical`'s own default. */
const DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Busy feeds read 35 days ahead: synthesis consumes only 30, and a short
 * window keeps `freebusy.query` calls cheap. The same window bounds the
 * stale-row reconcile below, so it must stay ≥ the synthesis window — both are
 * measured from the same `startOfUtcDay` anchor, so the 5-day margin is exact.
 */
const BUSY_WINDOW_MS = 35 * 24 * 60 * 60 * 1000;

/**
 * The fetch/reconcile window for a busy feed, **anchored to the UTC day** —
 * never to the instant the sync runs.
 *
 * `freebusy.query` clips the intervals it returns to `[timeMin, timeMax]`, so a
 * block already in progress comes back starting at `timeMin` exactly. Since a
 * busy interval has no identity of its own — the interval IS the uid
 * (`fb:<start>/<end>`) — an unanchored `new Date()` timeMin meant every sync
 * minted a *new* key for the same underlying block: an ongoing all-day
 * out-of-office arrived as `fb:<the moment the sync ran>/<its end>`, was
 * synthesized as a fresh busy block starting at that moment, and stacked up one
 * more copy on every refresh (the previous copy starting just before the new
 * window, so the stale sweep passed over it as well).
 *
 * Flooring makes the clipped bound stable: within a UTC day every sync asks the
 * same question and gets back the same key, so the upsert dedupes and nothing
 * churns. At the rollover the key does move forward a day (the block genuinely
 * starts "today" now) and the overlap sweep in `deleteStaleSourceEvents` drops
 * the previous day's row. The far bound is floored for the same reason: a block
 * running past the window end is clipped to `timeMax`.
 *
 * The start an in-progress block reports is therefore the window's start, not
 * its true start — free/busy can't tell us the latter without reading further
 * into the past than an availability mirror has any business storing. "Busy
 * from the start of today until it ends" is the honest reading of what Google
 * returned, and unlike the true start it doesn't move.
 */
function busyIngestWindow(opts: IngestOptions): {
  windowStart: Date;
  windowEnd: Date;
} {
  const windowStart = opts.windowStart ?? startOfUtcDay(new Date());
  return {
    windowStart,
    windowEnd: opts.windowEnd ?? new Date(windowStart.getTime() + BUSY_WINDOW_MS),
  };
}

/**
 * Reconcile a feed's `source_events` against the freshly fetched occurrence
 * set for the window just fetched. Every feed kind upserts (`upsertOccurrences`)
 * but, until this ran unconditionally, only busy feeds ever deleted — an event
 * removed upstream (e.g. from an iCloud calendar set up as an input feed) left
 * its `source_events` row in place forever, so it kept getting synthesized onto
 * the unified calendar and mirrored right back out to the target calendar.
 * Identity is (icalUid, recurrenceId): stable for UID-keyed feeds, and for busy
 * feeds the interval IS the uid (`fb:<start>/<end>`), so a moved/merged/split
 * block still arrives under a fresh key and the old one still reads as stale.
 * Any of this feed's rows *overlapping* the fetch window whose key isn't in the
 * fresh set is stale; deleting it cascades the synthesized calendar_events rows
 * (FK), and the next mirror reconcile cancels their remote copies. Rows wholly
 * in the past fall out of the synthesis window naturally.
 *
 * Overlap, not `dtstart >= windowStart`: every reader returns spans that began
 * before the window but are still running at its start (`occurrenceInWindow` in
 * @igt/ical), so those rows are in the fresh set and have to be sweepable too —
 * otherwise an ongoing span that changed key or vanished upstream survives
 * forever, re-synthesized on every run. Same predicate the synthesis query uses
 * (`dtstart < end AND (dtstart >= start OR dtend > start)`). It is load-bearing
 * for busy feeds in particular: an ongoing interval is clipped to the window
 * start (see `busyIngestWindow`), so at each UTC-day rollover the block's key
 * moves forward a day and yesterday's row — which starts *before* the new
 * window — is the stale one to drop.
 */
async function deleteStaleSourceEvents(
  db: Db,
  feed: FeedRow,
  window: { windowStart: Date; windowEnd: Date },
  fresh: Occurrence[],
): Promise<void> {
  const key = (uid: string, recurrenceId: string | null) => `${uid}:${recurrenceId ?? ''}`;
  const freshKeys = new Set(fresh.map((o) => key(o.uid, o.recurrenceId)));
  const rows = await db
    .select({ id: sourceEvents.id, icalUid: sourceEvents.icalUid, recurrenceId: sourceEvents.recurrenceId })
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.feedId, feed.id),
        lt(sourceEvents.dtstart, window.windowEnd),
        or(
          gte(sourceEvents.dtstart, window.windowStart),
          gt(sourceEvents.dtend, window.windowStart),
        ),
      ),
    );
  const staleIds = rows
    .filter((r) => !freshKeys.has(key(r.icalUid, r.recurrenceId)))
    .map((r) => r.id);
  // Chunked to stay under D1's bound-parameter limit.
  await runChunked(staleIds, (chunk) =>
    db.delete(sourceEvents).where(inArray(sourceEvents.id, chunk)),
  );
}

/**
 * Upsert expanded occurrences into `source_events`, keyed by
 * (feedId, icalUid, recurrenceId). Idempotent: an unchanged event keeps its
 * `contentHash` (and thus its `tasksBuiltHash`), while a changed event gets a new
 * `contentHash` so Phase 3 reprocesses it. Single (non-recurring) events use
 * recurrenceId='' so SQLite's unique index dedupes them.
 */
async function upsertOccurrences(
  db: Db,
  feed: FeedRow,
  occurrences: Occurrence[],
): Promise<void> {
  for (const occ of occurrences) {
    const contentHash = hashOccurrence(occ);
    await db
      .insert(sourceEvents)
      .values({
        feedId: feed.id,
        familyId: feed.familyId,
        icalUid: occ.uid,
        recurrenceId: occ.recurrenceId ?? '',
        dtstart: occ.start,
        dtend: occ.end ?? null,
        allDay: occ.allDay,
        summary: occ.summary,
        location: occ.location,
        locationGeo: occ.locationGeo,
        raw: null,
        contentHash,
      })
      .onConflictDoUpdate({
        target: [
          sourceEvents.feedId,
          sourceEvents.icalUid,
          sourceEvents.recurrenceId,
        ],
        set: {
          dtstart: occ.start,
          dtend: occ.end ?? null,
          allDay: occ.allDay,
          summary: occ.summary,
          location: occ.location,
          locationGeo: occ.locationGeo,
          contentHash,
        },
      });
  }
}

/**
 * Fetch an ICS feed (conditional GET via ETag), expand occurrences, and upsert
 * `source_events`. Skips the network on a 304.
 */
async function ingestIcsFeed(
  db: Db,
  feed: FeedRow,
  opts: IngestOptions,
): Promise<IngestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!feed.url) throw new Error(`feed ${feed.id}: ics feed has no url`);

  const headers: Record<string, string> = {};
  if (opts.force) headers['cache-control'] = 'no-cache';
  else if (feed.etag) headers['If-None-Match'] = feed.etag;

  const res = await fetchImpl(feed.url, { headers });

  if (res.status === 304) {
    await db
      .update(feeds)
      .set({ lastSyncedAt: new Date(), status: 'active' })
      .where(eq(feeds.id, feed.id));
    return { feedId: feed.id, fetched: false, processed: 0 };
  }
  if (!res.ok) throw new Error(`feed ${feed.id} fetch failed: ${res.status}`);

  // Bounded by the guarded fetch's body cap, which surfaces here — the read,
  // not the request, is where an oversized "ICS" gets caught.
  const text = await res.text();
  const etag = res.headers.get('etag');
  const windowStart = opts.windowStart ?? new Date();
  const windowEnd = opts.windowEnd ?? new Date(windowStart.getTime() + DEFAULT_WINDOW_MS);
  // `feed.timezone` is whatever a prior sync auto-detected (X-WR-TIMEZONE /
  // VTIMEZONE) or an admin manually set — used to resolve this document's own
  // floating (zone-less) timed values, which some sources (e.g. booking-
  // software exports) never carry timezone metadata for at all.
  const occurrences = parseAndExpand(text, {
    windowStart,
    windowEnd,
    defaultTimezone: feed.timezone ?? undefined,
  });

  await upsertOccurrences(db, feed, occurrences);
  await deleteStaleSourceEvents(db, feed, { windowStart, windowEnd }, occurrences);

  await db
    .update(feeds)
    .set({
      lastSyncedAt: new Date(),
      etag: etag ?? feed.etag,
      timezone: extractTimezone(text) ?? feed.timezone,
      // Backfill the display title from the feed's own X-WR-CALNAME when the
      // user didn't supply one on creation.
      sourceCalendarName: feed.sourceCalendarName ?? extractCalendarName(text),
      status: 'active',
    })
    .where(eq(feeds.id, feed.id));

  return { feedId: feed.id, fetched: true, processed: occurrences.length };
}

/**
 * Read events from a calendar in a connected account (CalDAV or Google) and
 * upsert them as `source_events`. The credential is drawn from the feed's linked
 * external account (never stored per-feed); Google refresh tokens are exchanged
 * for an access token via the injected `googleRefresh`.
 */
async function ingestAccountFeed(
  db: Db,
  feed: FeedRow,
  opts: IngestOptions,
): Promise<IngestResult> {
  const windowStart = opts.windowStart ?? new Date();
  const windowEnd = opts.windowEnd ?? new Date(windowStart.getTime() + DEFAULT_WINDOW_MS);
  const window = {
    windowStart,
    windowEnd,
    // Fallback for a per-object VCALENDAR that carries no TZID/X-WR-TIMEZONE
    // of its own (see fetchCalDavOccurrences's per-object detection).
    defaultTimezone: feed.timezone ?? undefined,
  };
  if (!feed.sourceCalendarId) throw new Error(`feed ${feed.id}: missing source calendar`);
  const credential = await resolveAccountCredential(db, opts.kek, feed.externalAccountId);
  if (!credential) throw new Error(`feed ${feed.id}: no account credential`);

  let occurrences: Occurrence[];
  let timezone: string | null;
  // Busy feeds reconcile (delete stale interval keys) over the exact window
  // they fetched, so the window is pinned here rather than in the reader.
  let busyWindow: { windowStart: Date; windowEnd: Date } | null = null;
  if (feed.kind === 'caldav') {
    if (credential.kind !== 'basic') throw new Error('caldav feed requires a basic credential');
    ({ occurrences, timezone } = await fetchCalDavOccurrences(
      {
        collectionUrl: feed.sourceCalendarId,
        username: credential.username,
        password: credential.password,
      },
      window,
      opts.fetchImpl,
    ));
  } else {
    if (credential.kind !== 'oauth') throw new Error('google feed requires an oauth credential');
    const accessToken =
      credential.accessToken ??
      (credential.refreshToken && opts.googleRefresh
        ? await opts.googleRefresh(credential.refreshToken)
        : undefined);
    if (!accessToken) throw new Error('google feed has no usable access token');
    if (feed.mode === 'busy') {
      busyWindow = busyIngestWindow(opts);
      ({ occurrences, timezone } = await fetchGoogleFreeBusy(
        accessToken,
        feed.sourceCalendarId,
        busyWindow,
        opts.fetchImpl,
      ));
    } else {
      ({ occurrences, timezone } = await fetchGoogleOccurrences(
        accessToken,
        feed.sourceCalendarId,
        window,
        opts.fetchImpl,
      ));
    }
  }

  await upsertOccurrences(db, feed, occurrences);
  await deleteStaleSourceEvents(db, feed, busyWindow ?? window, occurrences);
  await db
    .update(feeds)
    .set({ lastSyncedAt: new Date(), status: 'active', timezone: timezone ?? feed.timezone })
    .where(eq(feeds.id, feed.id));

  return { feedId: feed.id, fetched: true, processed: occurrences.length };
}

/** Cap on a stored failure message — enough to diagnose, not enough to bloat the row. */
const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * How long the cron waits before retrying a feed whose last ingest failed:
 * 15 min (the next tick), then 30, 60, 120, 240, and 6 h thereafter.
 *
 * A feed in 'error' used to be skipped by the cron outright, which made a
 * *transient* failure permanent: nothing re-ingested the feed until someone
 * happened to press "Refresh feeds", so every event added upstream after the
 * blip was simply never seen. The events already in `source_events` kept being
 * synthesized, so the calendar looked fine — it just silently stopped growing,
 * and what you notice missing first is whatever you added most recently.
 */
const RETRY_BACKOFF_MS = [15, 30, 60, 120, 240, 360].map((m) => m * 60_000);

/** The retry delay owed after `failures` consecutive failed ingests. */
function retryBackoffMs(failures: number): number {
  const step = Math.min(Math.max(failures, 1), RETRY_BACKOFF_MS.length) - 1;
  return RETRY_BACKOFF_MS[step]!;
}

/**
 * Is this feed due for a background (cron) ingest?
 *
 * - `paused` is a user decision — never poll it.
 * - `error` paces off `lastAttemptedAt` with the backoff above, because
 *   `lastSyncedAt` doesn't move on a failure and so can't pace anything.
 * - otherwise it's the feed's own poll interval since the last *successful*
 *   sync.
 */
export function isFeedDue(
  feed: Pick<
    FeedRow,
    'status' | 'refreshMinutes' | 'lastSyncedAt' | 'lastAttemptedAt' | 'consecutiveFailures'
  >,
  now: Date,
): boolean {
  if (feed.status === 'paused') return false;
  if (feed.status === 'error') {
    const lastAttempt = feed.lastAttemptedAt?.getTime() ?? 0;
    return now.getTime() - lastAttempt >= retryBackoffMs(feed.consecutiveFailures);
  }
  const lastSync = feed.lastSyncedAt?.getTime() ?? 0;
  return now.getTime() - lastSync >= feed.refreshMinutes * 60_000;
}

/**
 * Ingest one input feed: an ICS URL, or a calendar drawn from a connected
 * external account (CalDAV/Google). Both paths upsert `source_events` so Phase 3
 * task-building is identical regardless of source.
 *
 * Every attempt is stamped on the feed row — `lastAttemptedAt` always, and on
 * failure the count and message behind `status: 'error'`. The readers' job is
 * just to read and throw; recording *why* a feed is stuck (and how long to wait
 * before trying again) happens once, here, so no path can fail silently.
 */
export async function ingestFeed(
  db: Db,
  feed: FeedRow,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const attemptedAt = new Date();
  try {
    const result =
      feed.kind === 'caldav' || feed.kind === 'google'
        ? await ingestAccountFeed(db, feed, opts)
        : await ingestIcsFeed(db, feed, opts);
    await db
      .update(feeds)
      .set({ lastAttemptedAt: attemptedAt, consecutiveFailures: 0, lastErrorMessage: null })
      .where(eq(feeds.id, feed.id));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(feeds)
      .set({
        status: 'error',
        lastAttemptedAt: attemptedAt,
        consecutiveFailures: feed.consecutiveFailures + 1,
        lastErrorMessage: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
      })
      .where(eq(feeds.id, feed.id));
    throw err;
  }
}

/**
 * Ingest every feed in a family (used by force-refresh-all). One feed's failure
 * (e.g. a revoked Google refresh token) must not abort the rest of the family's
 * refresh — ingestFeed already records why that feed row is in 'error', so just
 * carry the message back to the caller here and keep going.
 */
export async function ingestFamilyFeeds(
  db: Db,
  familyId: string,
  opts: IngestOptions = {},
): Promise<IngestResult[]> {
  const rows = await db.select().from(feeds).where(eq(feeds.familyId, familyId));
  const results: IngestResult[] = [];
  for (const feed of rows) {
    try {
      results.push(await ingestFeed(db, feed, opts));
    } catch (err) {
      results.push({
        feedId: feed.id,
        fetched: false,
        processed: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
