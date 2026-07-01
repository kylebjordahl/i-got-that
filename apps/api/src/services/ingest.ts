import { type Db, eq, feeds, sourceEvents } from '@igt/db';
import { extractTimezone, hashOccurrence, parseAndExpand } from '@igt/ical';

export interface IngestOptions {
  fetchImpl?: typeof fetch;
  windowStart?: Date;
  windowEnd?: Date;
}

export interface IngestResult {
  feedId: string;
  fetched: boolean;
  processed: number;
}

type FeedRow = typeof feeds.$inferSelect;

/**
 * Fetch a feed's ICS (conditional GET via ETag), expand occurrences, and upsert
 * `source_events` keyed by (feedId, icalUid, recurrenceId). Idempotent: an
 * unchanged event keeps its `contentHash` (and thus its `tasksBuiltHash`),
 * while a changed event gets a new `contentHash` so Phase 3 reprocesses it.
 *
 * Single (non-recurring) events use recurrenceId='' so SQLite's unique index
 * dedupes them (NULLs would be treated as distinct).
 */
export async function ingestFeed(
  db: Db,
  feed: FeedRow,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;

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

  await db
    .update(feeds)
    .set({
      lastSyncedAt: new Date(),
      etag: etag ?? feed.etag,
      timezone: extractTimezone(text) ?? feed.timezone,
      status: 'active',
    })
    .where(eq(feeds.id, feed.id));

  return { feedId: feed.id, fetched: true, processed: occurrences.length };
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
