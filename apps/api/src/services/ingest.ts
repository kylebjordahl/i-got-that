import { startOfUtcDay } from '@igt/classification';
import {
  and,
  type Db,
  eq,
  externalAccounts,
  feeds,
  inArray,
  isNotNull,
  sourceEvents,
  sql,
} from '@igt/db';
import {
  extractCalendarName,
  extractTimezone,
  fetchCalDavOccurrences,
  fetchGoogleFreeBusy,
  fetchGoogleOccurrences,
  GoogleApiError,
  hashOccurrence,
  type Occurrence,
  parseAndExpand,
  parseCalendar,
} from '@igt/ical';
import { resolveAccountCredential } from '../lib/account-credentials.js';
import { batchChunked, runChunked } from '../lib/d1.js';
import { GoogleTokenRefreshError } from '../lib/google-oauth.js';
import type { KekKeySet } from '../lib/secrets.js';
import { overlapsWindow, SYNTHESIS_WINDOW_MS } from './synthesis.js';

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

/**
 * What a reader hands back to `ingestFeed`: the public result, plus the feed-row
 * fields it learned along the way. The readers only read and upsert
 * `source_events`; `ingestFeed` writes the row once, folding this patch into the
 * attempt stamp, so a sync is one `UPDATE feeds` rather than one per layer.
 */
interface ReaderOutcome {
  result: IngestResult;
  feedPatch: Partial<typeof feeds.$inferInsert>;
}

/** Default fetch/reconcile window when the caller doesn't pin one — mirrors `@igt/ical`'s own default. */
const DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How much expansion an ICS feed must have left, beyond what synthesis reads,
 * before its ETag may be trusted again. Re-expansion happens once the stored
 * horizon (`feeds.expanded_through`) is closer than
 * `SYNTHESIS_WINDOW_MS + EXPANSION_MARGIN_MS` — 45 days — from now.
 *
 * Why the ETag can't be trusted forever: `source_events` only holds the
 * recurrence instances expanded inside the window of the feed's last *full*
 * parse, and a 304 never parses. A publisher with a stable ETag (a static file,
 * a rarely-edited booking export) answers 304 indefinitely while synthesis's
 * 30-day window keeps moving, so the last occurrences of every series run out
 * from under it — silently, with the feed still reading 'active'.
 *
 * 15 days of margin on top of the 30 means the unconditional GET goes out about
 * every 45 days (the default window is 90) and lands with the synthesis window
 * still comfortably inside the old expansion, so a poll that is late, retried
 * after an error, or skipped for a paused feed doesn't open a gap. It costs one
 * parse per feed per ~45 days — nothing next to what a feed whose ETag does
 * change pays on every edit.
 */
const EXPANSION_MARGIN_MS = 15 * 24 * 60 * 60 * 1000;

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
 * The stale-sweep guard's thresholds. Absence from one fetch is the only signal
 * a sweep has, and a bad read (an outage page that still parses as an empty
 * VCALENDAR, a CMS mid-republish, a truncated export, a CalDAV 207 with no
 * objects during an auth/ACL blip) looks exactly like "everything was
 * deleted". So a sweep that would remove ALL of a feed's in-window rows (once
 * there are at least `SWEEP_GUARD_ALL_MIN_ROWS` of them), or MORE THAN
 * `SWEEP_GUARD_MAJORITY_SHARE` of them (once there are at least
 * `SWEEP_GUARD_MAJORITY_MIN_ROWS`), is held back until `SUSPICIOUS_SWEEP_LIMIT`
 * consecutive fetches have all asked for it AND `SUSPICIOUS_HOLD_MIN_MS` has
 * passed since the first of them.
 *
 * The time floor is what makes the count mean anything. Fetches are cheap and
 * close together — "Refresh feeds" has only a 60 s cooldown, and a person
 * mashes it exactly when the feed looks broken, so three refreshes release the
 * wipe in about two minutes; a feed polled every 15 minutes gets there in 45.
 * Real outages (a CMS republish, an auth/ACL blip, a publisher's bad deploy)
 * last hours, so the hold has to outlast that, not just count attempts. Six
 * hours is the default poll interval (`refreshMinutes`), i.e. "still the same
 * picture a full normal cycle later".
 *
 * The trade-off: the guard costs a genuine mass removal (a school wiping a term
 * and starting over) up to six hours-plus-a-poll before it lands, and a
 * small feed (fewer than the minimums) isn't protected at all, because losing
 * both of two events is indistinguishable from an outage. Being wrong the other
 * way is far worse: the deletes cascade into `calendar_events`, orphan claims,
 * cancel mirrored events (and mail cancellations), and when the next good fetch
 * re-creates everything under NEW ids the claims, travel overrides and conflict
 * decisions don't come back.
 */
const SWEEP_GUARD_ALL_MIN_ROWS = 3;
const SWEEP_GUARD_MAJORITY_MIN_ROWS = 10;
const SWEEP_GUARD_MAJORITY_SHARE = 0.5;
const SUSPICIOUS_SWEEP_LIMIT = 3;
const SUSPICIOUS_HOLD_MIN_MS = 6 * 60 * 60 * 1000;

/** Would deleting `stale` of a feed's `total` in-window rows look like a bad read, not a real removal? */
function isSuspiciousSweep(stale: number, total: number): boolean {
  if (stale === 0) return false;
  if (total >= SWEEP_GUARD_ALL_MIN_ROWS && stale === total) return true;
  return total >= SWEEP_GUARD_MAJORITY_MIN_ROWS && stale / total > SWEEP_GUARD_MAJORITY_SHARE;
}

/**
 * Where a fetch fell short of the whole calendar without throwing: CalDAV
 * objects the server returned that we couldn't parse (see
 * `fetchCalDavOccurrences`). Their events are missing from the fresh set
 * because they were unreadable, not because they were deleted.
 */
interface FetchGaps {
  /** UIDs of unparseable objects — rows with these UIDs are never swept. */
  failedUids: readonly string[];
  /** Unparseable objects we couldn't even identify: no row is safe, so don't sweep at all. */
  unidentifiedFailures: number;
}

const NO_FETCH_GAPS: FetchGaps = { failedUids: [], unidentifiedFailures: 0 };

/**
 * What a stale sweep tells `ingestFeed` to record on the feed row. Folded into
 * the reader's `feedPatch` (rather than written separately) so the one combined
 * `UPDATE` that stamps a successful attempt can't clear the warning it carries.
 */
interface SweepOutcome {
  /** Why the sweep was held back or narrowed, for whoever wonders why the feed looks off; null when it ran clean. */
  lastErrorMessage: string | null;
  /** Consecutive held sweeps. Omitted (left alone) when the sweep didn't run at all. */
  suspiciousSweepCount?: number;
  /** When the current run of held sweeps began (null once it ends); omitted alongside the count. */
  suspiciousSince?: Date | null;
  /** The deletion was held back, so the fetched document must not be recorded as accepted (see the ETag in `ingestIcsFeed`). */
  held: boolean;
}

/** The part of a sweep's outcome that lands on the feed row. */
function sweepPatch({
  lastErrorMessage,
  suspiciousSweepCount,
  suspiciousSince,
}: SweepOutcome): Pick<
  Partial<typeof feeds.$inferInsert>,
  'lastErrorMessage' | 'suspiciousSweepCount' | 'suspiciousSince'
> {
  return { lastErrorMessage, suspiciousSweepCount, suspiciousSince };
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
 * forever, re-synthesized on every run. The shared `overlapsWindow` predicate
 * (`dtstart < end AND (dtstart >= start OR dtend > start)`) — the same one
 * synthesis and read-back use. It is load-bearing
 * for busy feeds in particular: an ongoing interval is clipped to the window
 * start (see `busyIngestWindow`), so at each UTC-day rollover the block's key
 * moves forward a day and yesterday's row — which starts *before* the new
 * window — is the stale one to drop.
 *
 * Absence is only evidence of deletion if the fetch was complete, so two things
 * temper the sweep (see `SWEEP_GUARD_MAJORITY_SHARE` and friends above): rows
 * whose CalDAV object we failed to parse are left alone (and if a failed object
 * couldn't even be identified, the sweep is skipped outright), and a sweep that
 * would take out all or most of the feed is held for `SUSPICIOUS_SWEEP_LIMIT`
 * consecutive fetches and `SUSPICIOUS_HOLD_MIN_MS` before it goes through. The
 * returned outcome carries the warning and the held-sweep state for the caller
 * to write onto the feed row.
 */
async function deleteStaleSourceEvents(
  db: Db,
  feed: FeedRow,
  window: { windowStart: Date; windowEnd: Date },
  fresh: Occurrence[],
  gaps: FetchGaps = NO_FETCH_GAPS,
): Promise<SweepOutcome> {
  const unreadable = gaps.failedUids.length + gaps.unidentifiedFailures;
  const unreadableNote = (consequence: string) =>
    `${unreadable} calendar ${unreadable === 1 ? 'object' : 'objects'} couldn't be parsed — ${consequence}`;
  if (gaps.unidentifiedFailures > 0) {
    // We can't tell which events the unreadable object(s) held, so any row
    // could be one of them. Leave the feed's rows (and its held-sweep count)
    // exactly as they are until a fetch reads cleanly.
    return { lastErrorMessage: unreadableNote('not removing any events this sync'), held: false };
  }

  const key = (uid: string, recurrenceId: string | null) => `${uid}:${recurrenceId ?? ''}`;
  const freshKeys = new Set(fresh.map((o) => key(o.uid, o.recurrenceId)));
  const unreadableUids = new Set(gaps.failedUids);
  const rows = await db
    .select({ id: sourceEvents.id, icalUid: sourceEvents.icalUid, recurrenceId: sourceEvents.recurrenceId })
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.feedId, feed.id),
        overlapsWindow(sourceEvents.dtstart, sourceEvents.dtend, {
          start: window.windowStart,
          end: window.windowEnd,
        }),
      ),
    );
  // A row we couldn't re-read isn't a row the server dropped: it is neither
  // stale nor part of the population the guard below judges.
  const sweepable = rows.filter((r) => !unreadableUids.has(r.icalUid));
  const staleIds = sweepable
    .filter((r) => !freshKeys.has(key(r.icalUid, r.recurrenceId)))
    .map((r) => r.id);
  const keptNote = unreadable > 0 ? unreadableNote('events already stored for them are kept') : null;

  if (isSuspiciousSweep(staleIds.length, sweepable.length)) {
    // Read the count back rather than trust the row the caller loaded: it may
    // be a whole tick old, and the decision to delete rides on it.
    const stored = (
      await db
        .select({ count: feeds.suspiciousSweepCount, since: feeds.suspiciousSince })
        .from(feeds)
        .where(eq(feeds.id, feed.id))
        .limit(1)
    )[0];
    const now = Date.now();
    const seen = (stored?.count ?? 0) + 1;
    // The clock starts at the first held sweep (count 0 -> 1); a run with no
    // recorded start (count and start are always written together, so only a
    // hand-edited row) starts now rather than releasing early.
    const since = seen > 1 && stored?.since ? stored.since : new Date(now);
    const releaseAt = since.getTime() + SUSPICIOUS_HOLD_MIN_MS;
    if (seen < SUSPICIOUS_SWEEP_LIMIT || now < releaseAt) {
      // The fresh rows were already upserted; only the deletion waits. Past the
      // count but short of the time floor the count keeps rising and we say
      // when the hold ends instead.
      const progress =
        seen < SUSPICIOUS_SWEEP_LIMIT
          ? `(${seen}/${SUSPICIOUS_SWEEP_LIMIT})`
          : `until ${new Date(releaseAt).toISOString().slice(0, 16)}Z`;
      const holding = `suspicious fetch: ${staleIds.length} of ${sweepable.length} in-window events missing — holding them ${progress}`;
      return {
        lastErrorMessage: keptNote ? `${holding}; ${keptNote}` : holding,
        suspiciousSweepCount: seen,
        suspiciousSince: since,
        held: true,
      };
    }
    // The same picture on N consecutive fetches over at least the hold time:
    // believe it.
  }

  // Chunked to stay under D1's bound-parameter limit.
  await runChunked(staleIds, (chunk) =>
    db.delete(sourceEvents).where(inArray(sourceEvents.id, chunk)),
  );
  return { lastErrorMessage: keptNote, suspiciousSweepCount: 0, suspiciousSince: null, held: false };
}

/**
 * Upsert expanded occurrences into `source_events`, keyed by
 * (feedId, icalUid, recurrenceId). Idempotent: an unchanged event keeps its
 * `contentHash` (and thus its `tasksBuiltHash`), while a changed event gets a new
 * `contentHash` so Phase 3 reprocesses it. Single (non-recurring) events use
 * recurrenceId='' so SQLite's unique index dedupes them.
 *
 * The upserts go out as `db.batch()` calls rather than one awaited statement per
 * occurrence — a 90-day account feed is hundreds of rows, and each used to be
 * its own round trip and its own subrequest. And an unchanged row is not
 * rewritten: the `DO UPDATE` is guarded by `setWhere`, so when the incoming
 * `content_hash` equals the stored one SQLite skips the update (0 rows changed,
 * 0 rows written — D1 bills on rows written, and a feed with no ETag is
 * re-read in full on every poll). The hash covers every column the update sets
 * (`hashOccurrence`), so equal hashes mean there's nothing to write.
 */
async function upsertOccurrences(
  db: Db,
  feed: FeedRow,
  occurrences: Occurrence[],
): Promise<void> {
  const upserts = occurrences.map((occ) => {
    const contentHash = hashOccurrence(occ);
    return db
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
        setWhere: sql`${sourceEvents.contentHash} <> excluded.content_hash`,
      });
  });
  await batchChunked(db, upserts);
}

/**
 * Fetch an ICS feed (conditional GET via ETag), expand occurrences, and upsert
 * `source_events`. Skips the parse on a 304 — but only while the expansion the
 * last full parse left behind still covers the synthesis window with headroom
 * (`EXPANSION_MARGIN_MS`); past that the GET goes out unconditionally, so a
 * feed that never changes still gets its recurring series expanded further out.
 *
 * Only ICS feeds have this problem: account feeds (CalDAV/Google) fetch the
 * whole window from the server on every poll, and busy feeds re-ask free/busy
 * for theirs, so neither ever relies on a stored expansion.
 */
async function ingestIcsFeed(
  db: Db,
  feed: FeedRow,
  opts: IngestOptions,
): Promise<ReaderOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!feed.url) throw new Error(`feed ${feed.id}: ics feed has no url`);

  const windowStart = opts.windowStart ?? new Date();
  const windowEnd = opts.windowEnd ?? new Date(windowStart.getTime() + DEFAULT_WINDOW_MS);

  // Is what a 304 would leave in `source_events` still enough? Null is a feed
  // that has never recorded its expansion (one from before the column existed).
  const expansionLasts =
    feed.expandedThrough != null &&
    feed.expandedThrough.getTime() >= windowStart.getTime() + SYNTHESIS_WINDOW_MS + EXPANSION_MARGIN_MS;

  const headers: Record<string, string> = {};
  if (opts.force) headers['cache-control'] = 'no-cache';
  else if (feed.etag && expansionLasts) headers['If-None-Match'] = feed.etag;

  const res = await fetchImpl(feed.url, { headers });

  if (res.status === 304) {
    return {
      result: { feedId: feed.id, fetched: false, processed: 0 },
      // "Unchanged since the document we last accepted" (a held-back document
      // never has its ETag stored — see below), so any warning about a
      // suspicious sweep is moot.
      feedPatch: {
        lastSyncedAt: new Date(),
        status: 'active',
        suspiciousSweepCount: 0,
        suspiciousSince: null,
      },
    };
  }
  if (!res.ok) throw new Error(`feed ${feed.id} fetch failed: ${res.status}`);

  // Bounded by the guarded fetch's body cap, which surfaces here — the read,
  // not the request, is where an oversized "ICS" gets caught.
  const text = await res.text();
  const etag = res.headers.get('etag');
  // Parse once: the parse is the most CPU-heavy step of an ingest, and the
  // timezone / calendar-name lookups only need the root it produces.
  const root = parseCalendar(text);
  // The document's own zone (X-WR-TIMEZONE / VTIMEZONE) is read *before*
  // expanding, to resolve its floating (zone-less) timed values — some sources
  // (e.g. booking-software exports) never carry timezone metadata at all, and
  // then `feed.timezone` (what a prior sync detected, or an admin set) is the
  // fallback. Reading it only afterwards left a feed's first sync, which has no
  // stored zone yet, resolving floating times in the host zone (UTC on workerd),
  // and flipped every row's contentHash on the next sync once the zone was known.
  const timezone = extractTimezone(root) ?? feed.timezone;
  const occurrences = parseAndExpand(root, {
    windowStart,
    windowEnd,
    defaultTimezone: timezone ?? undefined,
  });

  await upsertOccurrences(db, feed, occurrences);
  const sweep = await deleteStaleSourceEvents(db, feed, { windowStart, windowEnd }, occurrences);

  return {
    result: { feedId: feed.id, fetched: true, processed: occurrences.length },
    feedPatch: {
      ...sweepPatch(sweep),
      lastSyncedAt: new Date(),
      // A document whose deletions we held back isn't accepted yet: keep the
      // previous ETag so the next poll re-reads it (a 304 would skip the sweep
      // and the held count would never get to the limit), and by the same token
      // don't advance `expandedThrough` — it records what an *accepted* parse
      // covered, and the previous value is still what the stored rows reflect.
      etag: sweep.held ? feed.etag : (etag ?? feed.etag),
      // What this parse expanded through; a later 304 leaves it alone.
      ...(sweep.held ? {} : { expandedThrough: windowEnd }),
      timezone,
      // Backfill the display title from the feed's own X-WR-CALNAME when the
      // user didn't supply one on creation.
      sourceCalendarName: feed.sourceCalendarName ?? extractCalendarName(root),
      status: 'active',
    },
  };
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
): Promise<ReaderOutcome> {
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
  let gaps = NO_FETCH_GAPS;
  // Busy feeds reconcile (delete stale interval keys) over the exact window
  // they fetched, so the window is pinned here rather than in the reader.
  let busyWindow: { windowStart: Date; windowEnd: Date } | null = null;
  if (feed.kind === 'caldav') {
    if (credential.kind !== 'basic') throw new Error('caldav feed requires a basic credential');
    let failedUids: string[];
    let unidentifiedFailures: number;
    ({ occurrences, timezone, failedUids, unidentifiedFailures } = await fetchCalDavOccurrences(
      {
        collectionUrl: feed.sourceCalendarId,
        username: credential.username,
        password: credential.password,
      },
      window,
      opts.fetchImpl,
    ));
    gaps = { failedUids, unidentifiedFailures };
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
  const sweep = await deleteStaleSourceEvents(db, feed, busyWindow ?? window, occurrences, gaps);

  return {
    result: { feedId: feed.id, fetched: true, processed: occurrences.length },
    feedPatch: {
      ...sweepPatch(sweep),
      lastSyncedAt: new Date(),
      status: 'active',
      timezone: timezone ?? feed.timezone,
    },
  };
}

/**
 * A failure only the account's owner can fix, by reconnecting it: Google
 * refused the refresh token, or the grant can't do the read. Anything else
 * (network, a quota, a calendar that was unshared) retries on its own or needs
 * a different fix, so it doesn't ask anyone to sign in again.
 */
function needsReauth(err: unknown): boolean {
  return (
    (err instanceof GoogleTokenRefreshError || err instanceof GoogleApiError) && err.needsReauth
  );
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
 * just to read and throw (handing back what they learned about the feed in a
 * patch); recording *why* a feed is stuck (and how long to wait before trying
 * again) happens once, here, so no path can fail silently.
 */
export async function ingestFeed(
  db: Db,
  feed: FeedRow,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const attemptedAt = new Date();
  try {
    const { result, feedPatch } =
      feed.kind === 'caldav' || feed.kind === 'google'
        ? await ingestAccountFeed(db, feed, opts)
        : await ingestIcsFeed(db, feed, opts);
    await db
      .update(feeds)
      .set({
        ...feedPatch,
        lastAttemptedAt: attemptedAt,
        consecutiveFailures: 0,
        // Healthy unless the reader has a warning to leave on the row (a sweep
        // it held back, objects it couldn't parse) — the patch is where that
        // travels, so it must not be overwritten here.
        lastErrorMessage: feedPatch.lastErrorMessage ?? null,
      })
      .where(eq(feeds.id, feed.id));
    if (feed.externalAccountId) {
      // The account reads fine again: drop its reconnect prompt.
      await db
        .update(externalAccounts)
        .set({ authFailedAt: null, authFailureMessage: null, reauthNotifiedAt: null })
        .where(
          and(eq(externalAccounts.id, feed.externalAccountId), isNotNull(externalAccounts.authFailedAt)),
        );
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (feed.externalAccountId && needsReauth(err)) {
      // Keep the *first* failure time: the reauth alert waits on how long the
      // account has been broken, not on how recently it last failed.
      await db
        .update(externalAccounts)
        .set({
          authFailedAt: sql`coalesce(${externalAccounts.authFailedAt}, ${attemptedAt.getTime()})`,
          authFailureMessage: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
        })
        .where(eq(externalAccounts.id, feed.externalAccountId));
    }
    await db
      .update(feeds)
      .set({
        status: 'error',
        lastAttemptedAt: attemptedAt,
        // Incremented in SQL, not from the in-memory row: two attempts at the
        // same feed (cron + a user's refresh) both read the old count, and
        // writing `old + 1` back would lose one of the two increments.
        consecutiveFailures: sql`${feeds.consecutiveFailures} + 1`,
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
