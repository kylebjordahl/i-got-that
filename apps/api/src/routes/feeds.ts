import {
  and,
  eq,
  familyMemberFeeds,
  familyMembers,
  feeds,
  getDb,
  sourceEvents,
  tasks,
} from '@igt/db';
import {
  CreateFeedInput,
  MemberFeedLinkInput,
  UpdateMemberFeedLinkInput,
} from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { requireAdmin, requireFamilyMember } from '../middleware/auth.js';
import { ingestFamilyFeeds, ingestFeed } from '../services/ingest.js';
import { buildFeedTasks } from '../services/tasks.js';
import { deferSync, getProductionRegistry, syncFamily } from '../services/delivery.js';

/** Mounted under /families/:familyId/feeds (auth applied by parent router). */
export const feedRoutes = new Hono<HonoEnv>();
feedRoutes.use('*', requireFamilyMember);

/** Create an input feed (admin). */
feedRoutes.post('/', requireAdmin, async (c) => {
  const parsed = CreateFeedInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const feed = (
    await getDb(c.env.DB)
      .insert(feeds)
      .values({
        familyId: c.get('member').familyId,
        url: parsed.data.url,
        kind: parsed.data.kind,
        mode: parsed.data.mode,
        refreshMinutes: parsed.data.refreshMinutes,
      })
      .returning()
  )[0]!;
  return c.json({ feed }, 201);
});

/** List a family's feeds. */
feedRoutes.get('/', async (c) => {
  const rows = await getDb(c.env.DB)
    .select()
    .from(feeds)
    .where(eq(feeds.familyId, c.get('member').familyId));
  return c.json({ feeds: rows });
});

/** Link a dependent to a feed, with an optional baseline for exception feeds (admin). */
feedRoutes.post('/:feedId/member-links', requireAdmin, async (c) => {
  const parsed = MemberFeedLinkInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');

  // Tenancy: both the feed and the member must belong to this family.
  const feed = (
    await db
      .select()
      .from(feeds)
      .where(and(eq(feeds.id, feedId), eq(feeds.familyId, familyId)))
      .limit(1)
  )[0];
  const member = (
    await db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.id, parsed.data.familyMemberId),
          eq(familyMembers.familyId, familyId),
        ),
      )
      .limit(1)
  )[0];
  if (!feed || !member) return c.json({ error: 'not_found' }, 404);

  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({
        familyId,
        feedId,
        familyMemberId: parsed.data.familyMemberId,
        weekdayMask: parsed.data.weekdayMask ?? null,
        dayStart: parsed.data.dayStart ?? null,
        dayEnd: parsed.data.dayEnd ?? null,
        durationMinutes: parsed.data.durationMinutes ?? null,
        location: parsed.data.location ?? null,
        generatesTypes: parsed.data.generatesTypes ?? null,
        defaultAttendance: parsed.data.defaultAttendance ?? null,
      })
      .returning()
  )[0]!;
  return c.json({ link }, 201);
});

/** List a feed's member links (with each child's name). */
feedRoutes.get('/:feedId/member-links', async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select({
      id: familyMemberFeeds.id,
      familyMemberId: familyMemberFeeds.familyMemberId,
      memberRelation: familyMembers.relationName,
      weekdayMask: familyMemberFeeds.weekdayMask,
      dayStart: familyMemberFeeds.dayStart,
      dayEnd: familyMemberFeeds.dayEnd,
      durationMinutes: familyMemberFeeds.durationMinutes,
      location: familyMemberFeeds.location,
      generatesTypes: familyMemberFeeds.generatesTypes,
      defaultAttendance: familyMemberFeeds.defaultAttendance,
      active: familyMemberFeeds.active,
    })
    .from(familyMemberFeeds)
    .innerJoin(familyMembers, eq(familyMembers.id, familyMemberFeeds.familyMemberId))
    .where(
      and(
        eq(familyMemberFeeds.feedId, c.req.param('feedId')),
        eq(familyMemberFeeds.familyId, c.get('member').familyId),
      ),
    );
  return c.json({ links: rows });
});

/** Helper: load a link scoped to the feed + family. */
async function loadLink(
  db: ReturnType<typeof getDb>,
  familyId: string,
  feedId: string,
  linkId: string,
) {
  return (
    await db
      .select()
      .from(familyMemberFeeds)
      .where(
        and(
          eq(familyMemberFeeds.id, linkId),
          eq(familyMemberFeeds.feedId, feedId),
          eq(familyMemberFeeds.familyId, familyId),
        ),
      )
      .limit(1)
  )[0];
}

/** Update a link's baseline (admin), then rebuild that child's tasks. */
feedRoutes.patch('/:feedId/member-links/:linkId', requireAdmin, async (c) => {
  const parsed = UpdateMemberFeedLinkInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const link = await loadLink(db, familyId, feedId, c.req.param('linkId'));
  if (!link) return c.json({ error: 'not_found' }, 404);

  const d = parsed.data;
  const set: Partial<typeof familyMemberFeeds.$inferInsert> = {};
  if (d.weekdayMask !== undefined) set.weekdayMask = d.weekdayMask;
  if (d.dayStart !== undefined) set.dayStart = d.dayStart;
  if (d.dayEnd !== undefined) set.dayEnd = d.dayEnd;
  if (d.durationMinutes !== undefined) set.durationMinutes = d.durationMinutes;
  if (d.location !== undefined) set.location = d.location;
  if (d.generatesTypes !== undefined) set.generatesTypes = d.generatesTypes;
  if (d.defaultAttendance !== undefined) set.defaultAttendance = d.defaultAttendance;
  if (d.active !== undefined) set.active = d.active;
  if (Object.keys(set).length > 0) {
    await db.update(familyMemberFeeds).set(set).where(eq(familyMemberFeeds.id, link.id));
  }

  // Drop this child's unowned tasks for the feed and rebuild from scratch.
  await db
    .delete(tasks)
    .where(
      and(
        eq(tasks.feedId, feedId),
        eq(tasks.familyMemberId, link.familyMemberId),
        eq(tasks.status, 'unowned'),
      ),
    );
  await db.update(sourceEvents).set({ tasksBuiltHash: null }).where(eq(sourceEvents.feedId, feedId));
  const feed = (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0];
  if (feed) await buildFeedTasks(db, feed);
  deferSync(c.executionCtx, syncFamily(db, getProductionRegistry(c.env), c.env.KEK, familyId));

  const updated = await loadLink(db, familyId, feedId, link.id);
  return c.json({ link: updated });
});

/** Remove a link (admin) + that child's unowned tasks from the feed. */
feedRoutes.delete('/:feedId/member-links/:linkId', requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const link = await loadLink(db, familyId, feedId, c.req.param('linkId'));
  if (!link) return c.json({ error: 'not_found' }, 404);

  await db.delete(familyMemberFeeds).where(eq(familyMemberFeeds.id, link.id));
  await db
    .delete(tasks)
    .where(
      and(
        eq(tasks.feedId, feedId),
        eq(tasks.familyMemberId, link.familyMemberId),
        eq(tasks.status, 'unowned'),
      ),
    );
  deferSync(c.executionCtx, syncFamily(db, getProductionRegistry(c.env), c.env.KEK, familyId));
  return c.json({ ok: true });
});

/** Load a source event scoped to its feed + family. */
async function loadEvent(
  db: ReturnType<typeof getDb>,
  familyId: string,
  feedId: string,
  eventId: string,
) {
  return (
    await db
      .select()
      .from(sourceEvents)
      .where(
        and(
          eq(sourceEvents.id, eventId),
          eq(sourceEvents.feedId, feedId),
          eq(sourceEvents.familyId, familyId),
        ),
      )
      .limit(1)
  )[0];
}

/**
 * Mark a feed event unneeded (admin) — e.g. an erroneous closure. Its generated
 * tasks are dismissed and the feed is rebuilt so the event no longer creates
 * tasks (explicit) or cancels the baseline (exception).
 */
feedRoutes.post('/:feedId/events/:eventId/dismiss', requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const eventId = c.req.param('eventId');
  const event = await loadEvent(db, familyId, feedId, eventId);
  if (!event) return c.json({ error: 'not_found' }, 404);

  await db.update(sourceEvents).set({ dismissedAt: new Date() }).where(eq(sourceEvents.id, eventId));
  // Explicit feeds: drop this event's tasks from queues + calendars. (Exception
  // feeds have no event-linked tasks; the rebuild restores the baseline.)
  await db
    .update(tasks)
    .set({ status: 'dismissed', ownerMemberId: null })
    .where(eq(tasks.sourceEventId, eventId));

  const feed = (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0];
  if (feed) await buildFeedTasks(db, feed);
  deferSync(c.executionCtx, syncFamily(db, getProductionRegistry(c.env), c.env.KEK, familyId));
  return c.json({ ok: true });
});

/** Restore a previously-dismissed feed event (admin) + rebuild. */
feedRoutes.post('/:feedId/events/:eventId/restore', requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const eventId = c.req.param('eventId');
  const event = await loadEvent(db, familyId, feedId, eventId);
  if (!event) return c.json({ error: 'not_found' }, 404);

  await db
    .update(sourceEvents)
    .set({ dismissedAt: null, tasksBuiltHash: null })
    .where(eq(sourceEvents.id, eventId));
  // Un-dismiss its tasks so the rebuild can refresh them (explicit feeds).
  await db
    .update(tasks)
    .set({ status: 'unowned' })
    .where(and(eq(tasks.sourceEventId, eventId), eq(tasks.status, 'dismissed')));

  const feed = (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0];
  if (feed) await buildFeedTasks(db, feed);
  deferSync(c.executionCtx, syncFamily(db, getProductionRegistry(c.env), c.env.KEK, familyId));
  return c.json({ ok: true });
});

/** Force-refresh a single feed now. */
feedRoutes.post('/:feedId/refresh', async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');

  const feed = (
    await db
      .select()
      .from(feeds)
      .where(and(eq(feeds.id, feedId), eq(feeds.familyId, familyId)))
      .limit(1)
  )[0];
  if (!feed) return c.json({ error: 'not_found' }, 404);

  await db
    .update(feeds)
    .set({ lastRefreshRequestedAt: new Date() })
    .where(eq(feeds.id, feed.id));

  const ingest = await ingestFeed(db, feed);
  const build = await buildFeedTasks(db, feed);
  deferSync(c.executionCtx, syncFamily(db, getProductionRegistry(c.env), c.env.KEK, familyId));
  return c.json({ ingest, build });
});

/** Force-refresh all of a family's feeds now (ingest + rebuild tasks). */
feedRoutes.post('/refresh-all', async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const ingest = await ingestFamilyFeeds(db, familyId);

  const familyFeeds = await db.select().from(feeds).where(eq(feeds.familyId, familyId));
  const build = [];
  for (const feed of familyFeeds) {
    build.push(await buildFeedTasks(db, feed));
  }
  try {
    await syncFamily(db, getProductionRegistry(c.env), c.env.KEK, familyId);
  } catch (err) {
    console.error('syncFamily (refresh-all) failed', err);
  }
  return c.json({ ingest, build });
});
