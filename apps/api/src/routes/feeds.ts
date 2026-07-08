import {
  and,
  asc,
  calendarEvents,
  eq,
  externalAccounts,
  familyMemberFeeds,
  familyMembers,
  feeds,
  getDb,
  inArray,
  linkRules,
  sourceEvents,
  tasks,
} from '@igt/db';
import {
  CreateFeedInput,
  CreateLinkRuleInput,
  MemberFeedLinkInput,
  OverrideMatchField,
  OverrideMatchOp,
  OverrideOutcome,
  ReorderLinkRulesInput,
  UpdateFeedInput,
  UpdateLinkRuleInput,
  UpdateMemberFeedLinkInput,
  validateOverrideRuleShape,
} from '@igt/domain';
import { z } from 'zod';

/** Cross-field validation of a merged (PATCHed) rule shape. */
const MergedRuleShape = z
  .object({
    matchField: OverrideMatchField,
    matchOp: OverrideMatchOp,
    matchValue: z.string().nullable().optional(),
    outcome: OverrideOutcome,
    params: z.unknown().optional(),
  })
  .superRefine(validateOverrideRuleShape);
import { Hono } from 'hono';
import type { Bindings, HonoEnv } from '../env.js';
import { googleRefresherFor } from '../lib/google-oauth.js';
import { requireAdmin, requireFamilyMember } from '../middleware/auth.js';
import { ingestFamilyFeeds, ingestFeed } from '../services/ingest.js';
import { enqueueReconcile } from '../services/mirror.js';
import { synthesizeFeed } from '../services/synthesis.js';
import { buildFamilyTasks, buildMemberTasks } from '../services/task-gen.js';

/** Ingest secrets (KEK + Google refresher) needed to read account-backed feeds. */
function ingestSecrets(env: Bindings) {
  return { kek: env.KEK, googleRefresh: googleRefresherFor(env) };
}

/** Mounted under /families/:familyId/feeds (auth applied by parent router). */
export const feedRoutes = new Hono<HonoEnv>();
feedRoutes.use('*', requireFamilyMember);

/**
 * Create an input feed (admin). A public ICS URL (`kind: 'ics'`), or a calendar
 * from a connected external account (`kind: 'caldav' | 'google'`). Account-backed
 * feeds require the caller to be the account's owner, and the account kind must
 * match (google account → google feed; caldav/icloud account → caldav feed).
 */
feedRoutes.post('/', requireAdmin, async (c) => {
  const parsed = CreateFeedInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const d = parsed.data;

  const values: typeof feeds.$inferInsert = {
    familyId,
    kind: d.kind,
    mode: d.mode,
    refreshMinutes: d.refreshMinutes,
    url: null,
    externalAccountId: null,
    sourceCalendarId: null,
    sourceCalendarName: null,
  };

  if (d.kind === 'ics') {
    values.url = d.url ?? null;
  } else {
    // Owner-only: only the account's owner may draw its calendars into a feed.
    const account = (
      await db
        .select()
        .from(externalAccounts)
        .where(
          and(
            eq(externalAccounts.id, d.externalAccountId!),
            eq(externalAccounts.userId, c.get('user').id),
          ),
        )
        .limit(1)
    )[0];
    if (!account) return c.json({ error: 'account_not_found' }, 404);
    const expectedKind = account.kind === 'google' ? 'google' : 'caldav';
    if (d.kind !== expectedKind) return c.json({ error: 'account_kind_mismatch' }, 400);
    values.externalAccountId = account.id;
    values.sourceCalendarId = d.sourceCalendarId ?? null;
    values.sourceCalendarName = d.sourceCalendarName ?? null;
  }

  const feed = (await db.insert(feeds).values(values).returning())[0]!;
  return c.json({ feed }, 201);
});

/** Resynthesize a feed and regenerate its linked members' tasks, then mirror. */
async function resynthesize(
  c: { env: Bindings; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  db: ReturnType<typeof getDb>,
  feed: typeof feeds.$inferSelect,
): Promise<void> {
  await synthesizeFeed(db, feed);
  const links = await db
    .select({ familyMemberId: familyMemberFeeds.familyMemberId })
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.feedId, feed.id));
  for (const familyMemberId of new Set(links.map((l) => l.familyMemberId))) {
    await buildMemberTasks(db, familyMemberId);
  }
  enqueueReconcile(c, { kind: 'family', familyId: feed.familyId });
}

/**
 * Update an input feed's config (admin). Only `mode` / `refreshMinutes` /
 * `status` are editable — the source (ICS url or the account's target calendar)
 * is immutable; change it by deleting and recreating the feed. A mode change
 * resynthesizes the feed (mode drives the whole pipeline shape).
 */
feedRoutes.patch('/:feedId', requireAdmin, async (c) => {
  const parsed = UpdateFeedInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
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

  const d = parsed.data;
  const set: Partial<typeof feeds.$inferInsert> = {};
  if (d.mode !== undefined) set.mode = d.mode;
  if (d.refreshMinutes !== undefined) set.refreshMinutes = d.refreshMinutes;
  if (d.status !== undefined) set.status = d.status;
  if (Object.keys(set).length > 0) {
    await db.update(feeds).set(set).where(eq(feeds.id, feed.id));
  }

  const updated = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
  if (d.mode !== undefined && d.mode !== feed.mode) {
    await db
      .update(sourceEvents)
      .set({ synthesizedHash: null })
      .where(eq(sourceEvents.feedId, feed.id));
    await resynthesize(c, db, updated);
  }
  return c.json({ feed: updated });
});

/** List a family's feeds. */
feedRoutes.get('/', async (c) => {
  const rows = await getDb(c.env.DB)
    .select()
    .from(feeds)
    .where(eq(feeds.familyId, c.get('member').familyId));
  return c.json({ feeds: rows });
});

/** Link a member to a feed, with an optional baseline for exception feeds (admin). */
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

  // Synthesize the new link's events right away (its rules can refine later).
  await resynthesize(c, db, feed);
  return c.json({ link }, 201);
});

/** List a feed's member links (with each member's name). */
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

/** Update a link's baseline/config (admin), then resynthesize. */
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

  // A deactivated link's synthesized events are no longer desired.
  if (d.active === false) {
    await db
      .delete(calendarEvents)
      .where(
        and(
          eq(calendarEvents.linkId, link.id),
          eq(calendarEvents.provenance, 'synthesized'),
        ),
      );
  }

  const feed = (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0];
  if (feed) await resynthesize(c, db, feed);

  const updated = await loadLink(db, familyId, feedId, link.id);
  return c.json({ link: updated });
});

/**
 * Remove a link (admin). Its synthesized events + pending decisions cascade;
 * that member's event-derived tasks (any status) are removed explicitly, and
 * the family mirror reconcile cancels the remote copies.
 */
feedRoutes.delete('/:feedId/member-links/:linkId', requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const link = await loadLink(db, familyId, feedId, c.req.param('linkId'));
  if (!link) return c.json({ error: 'not_found' }, 404);

  // Collect the link's event ids before the cascade removes them.
  const linkEvents = await db
    .select({ id: calendarEvents.id })
    .from(calendarEvents)
    .where(eq(calendarEvents.linkId, link.id));
  const eventIds = linkEvents.map((e) => e.id);

  await db.delete(familyMemberFeeds).where(eq(familyMemberFeeds.id, link.id));
  if (eventIds.length > 0) {
    // Deleting the tasks also cascades their claimed events off the owners'
    // calendars; the family reconcile then cancels every remote copy.
    await db.delete(tasks).where(inArray(tasks.calendarEventId, eventIds));
  }
  enqueueReconcile(c, { kind: 'family', familyId });
  return c.json({ ok: true });
});

// --- Override rules (the link's event pipeline) ------------------------------

/** Baseline-day outcomes only make sense against an exception feed's baseline. */
function outcomeAllowed(feedMode: string, outcome: string): boolean {
  if (outcome === 'cancel_day' || outcome === 'modify_day') {
    return feedMode === 'exception';
  }
  return true;
}

/** List a link's rules in pipeline order. */
feedRoutes.get('/:feedId/member-links/:linkId/rules', async (c) => {
  const db = getDb(c.env.DB);
  const link = await loadLink(
    db,
    c.get('member').familyId,
    c.req.param('feedId'),
    c.req.param('linkId'),
  );
  if (!link) return c.json({ error: 'not_found' }, 404);
  const rows = await db
    .select()
    .from(linkRules)
    .where(eq(linkRules.linkId, link.id))
    .orderBy(asc(linkRules.position));
  return c.json({ rules: rows });
});

/** Insert a rule into the pipeline (admin); omitted position appends. */
feedRoutes.post('/:feedId/member-links/:linkId/rules', requireAdmin, async (c) => {
  const parsed = CreateLinkRuleInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const link = await loadLink(db, familyId, feedId, c.req.param('linkId'));
  if (!link) return c.json({ error: 'not_found' }, 404);
  const feed = (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0]!;

  const d = parsed.data;
  if (!outcomeAllowed(feed.mode, d.outcome)) {
    return c.json({ error: 'outcome_requires_exception_feed' }, 400);
  }

  const existing = await db
    .select()
    .from(linkRules)
    .where(eq(linkRules.linkId, link.id))
    .orderBy(asc(linkRules.position));
  const position = Math.min(d.position ?? existing.length, existing.length);

  // Shift everything at/after the insert position down one.
  for (let i = existing.length - 1; i >= position; i--) {
    await db
      .update(linkRules)
      .set({ position: i + 1 })
      .where(eq(linkRules.id, existing[i]!.id));
  }
  const rule = (
    await db
      .insert(linkRules)
      .values({
        familyId,
        linkId: link.id,
        position,
        matchField: d.matchField,
        matchOp: d.matchOp,
        matchValue: d.matchValue ?? null,
        outcome: d.outcome,
        params: (d.params as Record<string, unknown> | undefined) ?? null,
        generatesTypes: d.generatesTypes ?? null,
        defaultAttendance: d.defaultAttendance ?? null,
      })
      .returning()
  )[0]!;

  await resynthesize(c, db, feed);
  return c.json({ rule }, 201);
});

/** Update a rule (admin); the merged shape is re-validated. */
feedRoutes.patch('/:feedId/member-links/:linkId/rules/:ruleId', requireAdmin, async (c) => {
  const parsed = UpdateLinkRuleInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const link = await loadLink(db, familyId, feedId, c.req.param('linkId'));
  if (!link) return c.json({ error: 'not_found' }, 404);
  const feed = (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0]!;

  const rule = (
    await db
      .select()
      .from(linkRules)
      .where(
        and(eq(linkRules.id, c.req.param('ruleId')), eq(linkRules.linkId, link.id)),
      )
      .limit(1)
  )[0];
  if (!rule) return c.json({ error: 'rule_not_found' }, 404);

  const d = parsed.data;
  const merged = {
    matchField: d.matchField ?? rule.matchField,
    matchOp: d.matchOp ?? rule.matchOp,
    matchValue: 'matchValue' in d ? (d.matchValue ?? null) : rule.matchValue,
    outcome: d.outcome ?? rule.outcome,
    params: 'params' in d ? (d.params ?? undefined) : (rule.params ?? undefined),
  };
  if (!outcomeAllowed(feed.mode, merged.outcome)) {
    return c.json({ error: 'outcome_requires_exception_feed' }, 400);
  }
  // Re-run the cross-field checks against the merged rule shape.
  const mergedCheck = MergedRuleShape.safeParse(merged);
  if (!mergedCheck.success) {
    return c.json({ error: 'invalid', issues: mergedCheck.error.issues }, 400);
  }

  const set: Partial<typeof linkRules.$inferInsert> = {};
  if ('matchField' in d) set.matchField = d.matchField;
  if ('matchOp' in d) set.matchOp = d.matchOp;
  if ('matchValue' in d) set.matchValue = d.matchValue ?? null;
  if ('outcome' in d) set.outcome = d.outcome;
  if ('params' in d) set.params = (d.params as Record<string, unknown> | null) ?? null;
  if ('generatesTypes' in d) set.generatesTypes = d.generatesTypes ?? null;
  if ('defaultAttendance' in d) set.defaultAttendance = d.defaultAttendance ?? null;
  const updated = (
    await db.update(linkRules).set(set).where(eq(linkRules.id, rule.id)).returning()
  )[0]!;

  await resynthesize(c, db, feed);
  return c.json({ rule: updated });
});

/** Delete a rule (admin) and close the pipeline gap. */
feedRoutes.delete('/:feedId/member-links/:linkId/rules/:ruleId', requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const link = await loadLink(db, familyId, feedId, c.req.param('linkId'));
  if (!link) return c.json({ error: 'not_found' }, 404);

  const deleted = (
    await db
      .delete(linkRules)
      .where(
        and(eq(linkRules.id, c.req.param('ruleId')), eq(linkRules.linkId, link.id)),
      )
      .returning()
  )[0];
  if (!deleted) return c.json({ error: 'rule_not_found' }, 404);

  const remaining = await db
    .select()
    .from(linkRules)
    .where(eq(linkRules.linkId, link.id))
    .orderBy(asc(linkRules.position));
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i]!.position !== i) {
      await db.update(linkRules).set({ position: i }).where(eq(linkRules.id, remaining[i]!.id));
    }
  }

  const feed = (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0];
  if (feed) await resynthesize(c, db, feed);
  return c.json({ ok: true });
});

/** Reorder the whole pipeline (admin): every rule id exactly once, new order. */
feedRoutes.put('/:feedId/member-links/:linkId/rules/order', requireAdmin, async (c) => {
  const parsed = ReorderLinkRulesInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const link = await loadLink(db, familyId, feedId, c.req.param('linkId'));
  if (!link) return c.json({ error: 'not_found' }, 404);

  const existing = await db
    .select()
    .from(linkRules)
    .where(eq(linkRules.linkId, link.id));
  const existingIds = new Set(existing.map((r) => r.id));
  const requested = parsed.data.ruleIds;
  if (
    requested.length !== existing.length ||
    !requested.every((id) => existingIds.has(id)) ||
    new Set(requested).size !== requested.length
  ) {
    return c.json({ error: 'order_mismatch' }, 400);
  }

  for (let i = 0; i < requested.length; i++) {
    await db.update(linkRules).set({ position: i }).where(eq(linkRules.id, requested[i]!));
  }

  const feed = (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0];
  if (feed) await resynthesize(c, db, feed);

  const rules = await db
    .select()
    .from(linkRules)
    .where(eq(linkRules.linkId, link.id))
    .orderBy(asc(linkRules.position));
  return c.json({ rules });
});

// --- Source events (dismiss / restore) ---------------------------------------

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
 * Mark a feed event unneeded (admin) — e.g. an erroneous closure. The
 * resynthesis removes anything it produced (its synthesized events cascade
 * their tasks; a cancel-day it caused is undone; its pending decision goes).
 */
feedRoutes.post('/:feedId/events/:eventId/dismiss', requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const eventId = c.req.param('eventId');
  const event = await loadEvent(db, familyId, feedId, eventId);
  if (!event) return c.json({ error: 'not_found' }, 404);

  await db.update(sourceEvents).set({ dismissedAt: new Date() }).where(eq(sourceEvents.id, eventId));

  const feed = (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0];
  if (feed) await resynthesize(c, db, feed);
  return c.json({ ok: true });
});

/** Restore a previously-dismissed feed event (admin) + resynthesize. */
feedRoutes.post('/:feedId/events/:eventId/restore', requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const feedId = c.req.param('feedId');
  const eventId = c.req.param('eventId');
  const event = await loadEvent(db, familyId, feedId, eventId);
  if (!event) return c.json({ error: 'not_found' }, 404);

  await db
    .update(sourceEvents)
    .set({ dismissedAt: null, synthesizedHash: null })
    .where(eq(sourceEvents.id, eventId));

  const feed = (await db.select().from(feeds).where(eq(feeds.id, feedId)).limit(1))[0];
  if (feed) await resynthesize(c, db, feed);
  return c.json({ ok: true });
});

// --- Refresh ------------------------------------------------------------------

/** Force-refresh a single feed now (ingest → synthesize → task-gen → mirror). */
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

  const ingest = await ingestFeed(db, feed, ingestSecrets(c.env));
  const synthesis = await synthesizeFeed(db, feed);
  const links = await db
    .select({ familyMemberId: familyMemberFeeds.familyMemberId })
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.feedId, feed.id));
  for (const familyMemberId of new Set(links.map((l) => l.familyMemberId))) {
    await buildMemberTasks(db, familyMemberId);
  }
  enqueueReconcile(c, { kind: 'family', familyId });
  return c.json({ ingest, synthesis });
});

/** Force-refresh all of a family's feeds now (full pipeline). */
feedRoutes.post('/refresh-all', async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const ingest = await ingestFamilyFeeds(db, familyId, ingestSecrets(c.env));

  const familyFeeds = await db.select().from(feeds).where(eq(feeds.familyId, familyId));
  const synthesis = [];
  for (const feed of familyFeeds) {
    synthesis.push(await synthesizeFeed(db, feed));
  }
  await buildFamilyTasks(db, familyId);
  enqueueReconcile(c, { kind: 'family', familyId });
  return c.json({ ingest, synthesis });
});
