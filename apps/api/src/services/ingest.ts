import { type Db, eq, feeds, sourceEvents } from '@igt/db';
import {
  extractCalendarName,
  extractTimezone,
  fetchCalDavOccurrences,
  fetchGoogleOccurrences,
  hashOccurrence,
  type Occurrence,
  parseAndExpand,
} from '@igt/ical';
import { resolveAccountCredential } from '../lib/account-credentials.js';

export interface IngestOptions {
  fetchImpl?: typeof fetch;
  windowStart?: Date;
  windowEnd?: Date;
  /** Envelope key — required to decrypt account credentials for caldav/google feeds. */
  kek?: string;
  /** Exchange a Google refresh token for an access token (host holds the client secret). */
  googleRefresh?: (refreshToken: string) => Promise<string>;
}

export interface IngestResult {
  feedId: string;
  fetched: boolean;
  processed: number;
}

type FeedRow = typeof feeds.$inferSelect;

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
  if (!feed.url) {
    await db.update(feeds).set({ status: 'error' }).where(eq(feeds.id, feed.id));
    throw new Error(`feed ${feed.id}: ics feed has no url`);
  }

  const headers: Record<string, string> = {};
  if (feed.etag) headers['If-None-Match'] = feed.etag;

  const res = await fetchImpl(feed.url, { headers });

  if (res.status === 304) {
    await db
      .update(feeds)
      .set({ lastSyncedAt: new Date(), status: 'active' })
      .where(eq(feeds.id, feed.id));
    return { feedId: feed.id, fetched: false, processed: 0 };
  }
  if (!res.ok) {
    await db.update(feeds).set({ status: 'error' }).where(eq(feeds.id, feed.id));
    throw new Error(`feed ${feed.id} fetch failed: ${res.status}`);
  }

  const text = await res.text();
  const etag = res.headers.get('etag');
  const occurrences = parseAndExpand(text, {
    windowStart: opts.windowStart,
    windowEnd: opts.windowEnd,
  });

  await upsertOccurrences(db, feed, occurrences);

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
  const window = { windowStart: opts.windowStart, windowEnd: opts.windowEnd };
  const fail = async (message: string): Promise<never> => {
    await db.update(feeds).set({ status: 'error' }).where(eq(feeds.id, feed.id));
    throw new Error(message);
  };

  if (!feed.sourceCalendarId) return fail(`feed ${feed.id}: missing source calendar`);
  const credential = await resolveAccountCredential(db, opts.kek, feed.externalAccountId);
  if (!credential) return fail(`feed ${feed.id}: no account credential`);

  let occurrences: Occurrence[];
  try {
    if (feed.kind === 'caldav') {
      if (credential.kind !== 'basic') throw new Error('caldav feed requires a basic credential');
      occurrences = await fetchCalDavOccurrences(
        {
          collectionUrl: feed.sourceCalendarId,
          username: credential.username,
          password: credential.password,
        },
        window,
        opts.fetchImpl,
      );
    } else {
      if (credential.kind !== 'oauth') throw new Error('google feed requires an oauth credential');
      const accessToken =
        credential.accessToken ??
        (credential.refreshToken && opts.googleRefresh
          ? await opts.googleRefresh(credential.refreshToken)
          : undefined);
      if (!accessToken) throw new Error('google feed has no usable access token');
      occurrences = await fetchGoogleOccurrences(
        accessToken,
        feed.sourceCalendarId,
        window,
        opts.fetchImpl,
      );
    }
  } catch (err) {
    await db.update(feeds).set({ status: 'error' }).where(eq(feeds.id, feed.id));
    throw err;
  }

  await upsertOccurrences(db, feed, occurrences);
  await db
    .update(feeds)
    .set({ lastSyncedAt: new Date(), status: 'active' })
    .where(eq(feeds.id, feed.id));

  return { feedId: feed.id, fetched: true, processed: occurrences.length };
}

/**
 * Ingest one input feed: an ICS URL, or a calendar drawn from a connected
 * external account (CalDAV/Google). Both paths upsert `source_events` so Phase 3
 * task-building is identical regardless of source.
 */
export async function ingestFeed(
  db: Db,
  feed: FeedRow,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  if (feed.kind === 'caldav' || feed.kind === 'google') {
    return ingestAccountFeed(db, feed, opts);
  }
  return ingestIcsFeed(db, feed, opts);
}

/** Ingest every active feed in a family (used by force-refresh-all). */
export async function ingestFamilyFeeds(
  db: Db,
  familyId: string,
  opts: IngestOptions = {},
): Promise<IngestResult[]> {
  const rows = await db.select().from(feeds).where(eq(feeds.familyId, familyId));
  const results: IngestResult[] = [];
  for (const feed of rows) {
    results.push(await ingestFeed(db, feed, opts));
  }
  return results;
}
