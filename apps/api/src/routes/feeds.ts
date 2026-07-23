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
  ReorderMemberFeedLinksInput,
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
import { fetchGoogleFreeBusy } from '@igt/ical';
import { Hono } from 'hono';
import type { Bindings, HonoEnv } from '../env.js';
import { resolveAccountCredential } from '../lib/account-credentials.js';
import { googleRefresherFor } from '../lib/google-oauth.js';
import { requireAdmin, requireFamilyMember } from '../middleware/auth.js';
import { reconcileClaimEvents } from '../services/claim.js';
import {
  reconcileFamilyConflicts,
  reconcileMemberConflicts,
} from '../services/conflicts.js';
import { ingestFamilyFeeds, ingestFeed } from '../services/ingest.js';
import { enqueueReconcile } from '../services/mirror.js';
import { readBackFamily } from '../services/readback.js';
import { synthesizeFeed } from '../services/synthesis.js';
import { buildFamilyTasks, buildMemberTasks } from '../services/task-gen.js';

/** Ingest secrets (KEK + Google refresher) needed to read account-backed feeds. */
function ingestSecrets(env: Bindings) {
  return { kek: env.KEK, googleRefresh: googleRefresherFor(env) };
}

/**
 * Creation-time probe for busy feeds: verify the target calendar actually
 * answers `freebusy.query` for this account BEFORE the feed row exists, so a
 * missing "share as see-only-free/busy" grant (or a pre-freebusy-scope token)
 * surfaces as an actionable setup error instead of a feed stuck in 'error'.
 * Returns null on success, else a short reason string.
 */
async function probeFreeBusy(
  db: ReturnType<typeof getDb>,
  env: Bindings,
  accountId: string,
  calendarId: string,
): Promise<string | null> {
  try {
    const credential = await resolveAccountCredential(db, env.KEK, accountId);
    if (!credential || credential.kind !== 'oauth') return 'no_account_credential';
    const refresh = googleRefresherFor(env);
    const accessToken =
      credential.accessToken ??
      (credential.refreshToken && refresh
        ? await refresh(credential.refreshToken)
        : undefined);
    if (!accessToken) return 'no_access_token';
    const now = new Date();
    await fetchGoogleFreeBusy(accessToken, calendarId, {
      windowStart: now,
      windowEnd: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'freebusy_probe_failed';
  }
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
    // Optional display title; blank ⇒ backfilled from X-WR-CALNAME on first sync.
    values.sourceCalendarName = d.name ?? null;
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
    // Busy feeds point at a calendar shared to this account as free/busy-only
    // (it won't appear in the account's own calendarList) — probe the grant now
    // so a mis-set share fails the creation with guidance, not the first sync.
    if (d.mode === 'busy') {
      const probeError = await probeFreeBusy(db, c.env, account.id, d.sourceCalendarId!);
      if (probeError) {
        return c.json({ error: 'freebusy_unavailable', detail: probeError }, 400);
      }
    }
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
  // A brand-new feed has never been ingested (lastSyncedAt is null), so
  // source_events is empty — a rule created right after setup (e.g. one meant
  // to override a near-term occurrence) would otherwise have nothing to match
  // until the next cron tick or a manual "Refresh feeds" tap. Ingest once,
  // synchronously, before the first synthesis. Best-effort: a failed ingest
  // here shouldn't block the mutation that already committed (the rule/link/
  // etc. row); it also isn't retried on every subsequent edit, since a failed
  // ingest marks the feed 'error' and cron only re-ingests 'active' feeds — an
  // 'error' feed already requires a manual "Refresh feeds" tap to recover, so
  // there's nothing this call could usefully retry once that's happened.
  if (!feed.lastSyncedAt && feed.status !== 'error') {
    try {
      await ingestFeed(db, feed, ingestSecrets(c.env));
    } catch {
      // swallow — ingestFeed already marked the feed 'error'.
    }
  }
  await synthesizeFeed(db, feed);
  const links = await db
    .select({ familyMemberId: familyMemberFeeds.familyMemberId })
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.feedId, feed.id));
  for (const familyMemberId of new Set(links.map((l) => l.familyMemberId))) {
    // Re-resolve overlaps before task-gen so a config change re-applies (or
    // clears) any splits on this member's agenda.
    await reconcileMemberConflicts(db, familyMemberId);
    await buildMemberTasks(db, familyMemberId);
  }
  enqueueReconcile(c, { kind: 'family', familyId: feed.familyId });
}

/**
 * Update an input feed's config (admin). Only `mode` / `refreshMinutes` /
 * `status` / `timezone` are editable — the source (ICS url or the account's
 * target calendar) is immutable; change it by deleting and recreating the
 * feed. A mode change resynthesizes the feed (mode drives the whole pipeline
 * shape); a timezone change re-ingests it (source_events' own dtstart/dtend
 * may need reinterpreting, not just resynthesizing).
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
  // The busy keyspace (interval-derived source events, `fb:` synthKeys) is
  // incompatible with the UID-keyed standard/exception pipelines — a mode
  // transition would strand rows on both sides. Recreate the feed instead.
  if (
    d.mode !== undefined &&
    d.mode !== feed.mode &&
    (d.mode === 'busy' || feed.mode === 'busy')
  ) {
    return c.json({ error: 'busy_mode_immutable' }, 400);
  }
  const timezoneChanged = d.timezone !== undefined && d.timezone !== feed.timezone;
  const set: Partial<typeof feeds.$inferInsert> = {};
  if (d.mode !== undefined) set.mode = d.mode;
  if (d.refreshMinutes !== undefined) set.refreshMinutes = d.refreshMinutes;
  if (d.status !== undefined) set.status = d.status;
  if (d.timezone !== undefined) set.timezone = d.timezone;
  if (timezoneChanged) {
    // The ICS document itself may be byte-for-byte unchanged (this is a
    // manual correction, not a source-side edit) — clear the etag so the
    // re-ingest below can't 304 its way out of reinterpreting the feed's
    // already-stored (wrong) floating-time occurrences.
    set.etag = null;
  }
  if (Object.keys(set).length > 0) {
    await db.update(feeds).set(set).where(eq(feeds.id, feed.id));
  }

  let updated = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
  if (timezoneChanged) {
    try {
      await ingestFeed(db, updated, ingestSecrets(c.env));
    } catch {
      // swallow — ingestFeed already marked the feed 'error'; admin can retry via /refresh.
    }
    updated = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
  }
  if ((d.mode !== undefined && d.mode !== feed.mode) || timezoneChanged) {
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
    .select({
      id: feeds.id,
      familyId: feeds.familyId,
      kind: feeds.kind,
      url: feeds.url,
      externalAccountId: feeds.externalAccountId,
      sourceCalendarId: feeds.sourceCalendarId,
      sourceCalendarName: feeds.sourceCalendarName,
      mode: feeds.mode,
      timezone: feeds.timezone,
      refreshMinutes: feeds.refreshMinutes,
      etag: feeds.etag,
      lastSyncedAt: feeds.lastSyncedAt,
      lastRefreshRequestedAt: feeds.lastRefreshRequestedAt,
      status: feeds.status,
      createdAt: feeds.createdAt,
      // Account-backed feeds only: the connected account's kind, so the
      // client can distinguish "iCloud Calendar" from a generic "CalDAV
      // Calendar" (both collapse to feed kind 'caldav').
      accountKind: externalAccounts.kind,
    })
    .from(feeds)
    .leftJoin(externalAccounts, eq(externalAccounts.id, feeds.externalAccountId))
    .where(eq(feeds.familyId, c.get('member').familyId));
  return c.json({ feeds: rows });
});

/**
 * Reorder one member's feed links by priority (admin): every link id of that
 * member exactly once, in the new order (index 0 = highest priority). Priority
 * breaks conflict ties on that member's unified calendar — the earlier link
 * wins and the later one is masked (manual events always outrank feeds).
 * Persist-only for now; conflict resolution keys off these positions once it
 * lands.
 */
feedRoutes.put('/member-links/order', requireAdmin, async (c) => {
  const parsed = ReorderMemberFeedLinksInput.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const { familyMemberId, linkIds } = parsed.data;

  const existing = await db
    .select({ id: familyMemberFeeds.id })
    .from(familyMemberFeeds)
    .where(
      and(
        eq(familyMemberFeeds.familyId, familyId),
        eq(familyMemberFeeds.familyMemberId, familyMemberId),
      ),
    );
  const existingIds = new Set(existing.map((l) => l.id));
  if (
    linkIds.length !== existing.length ||
    !linkIds.every((id) => existingIds.has(id)) ||
    new Set(linkIds).size !== linkIds.length
  ) {
    return c.json({ error: 'order_mismatch' }, 400);
  }

  for (let i = 0; i < linkIds.length; i++) {
    await db
      .update(familyMemberFeeds)
      .set({ position: i })
      .where(
        and(
          eq(familyMemberFeeds.id, linkIds[i]!),
          eq(familyMemberFeeds.familyId, familyId),
        ),
      );
  }

  const rows = await db
    .select({ id: familyMemberFeeds.id, position: familyMemberFeeds.position })
    .from(familyMemberFeeds)
    .where(
      and(
        eq(familyMemberFeeds.familyId, familyId),
        eq(familyMemberFeeds.familyMemberId, familyMemberId),
      ),
    )
    .orderBy(asc(familyMemberFeeds.position));
  return c.json({ links: rows });
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

  // Append the new link at the end of this member's priority order (lowest
  // priority) — admins reorder afterwards via PUT /feeds/member-links/order.
  const memberLinks = await db
    .select({ position: familyMemberFeeds.position })
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.familyMemberId, parsed.data.familyMemberId));
  const nextPosition = memberLinks.reduce((m, l) => Math.max(m, l.position + 1), 0);

  const link = (
    await db
      .insert(familyMemberFeeds)
      .values({
        familyId,
        feedId,
        familyMemberId: parsed.data.familyMemberId,
        position: nextPosition,
        weekdayMask: parsed.data.weekdayMask ?? null,
        dayStart: parsed.data.dayStart ?? null,
        dayEnd: parsed.data.dayEnd ?? null,
        location: parsed.data.location ?? null,
        locationGeo: parsed.data.locationGeo ?? null,
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
      position: familyMemberFeeds.position,
      weekdayMask: familyMemberFeeds.weekdayMask,
      dayStart: familyMemberFeeds.dayStart,
      dayEnd: familyMemberFeeds.dayEnd,
      location: familyMemberFeeds.location,
      locationGeo: familyMemberFeeds.locationGeo,
      defaultTaskType: familyMemberFeeds.defaultTaskType,
      defaultDropoffWindowMin: familyMemberFeeds.defaultDropoffWindowMin,
      defaultPickupWindowMin: familyMemberFeeds.defaultPickupWindowMin,
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
  if (d.location !== undefined) set.location = d.location;
  if (d.locationGeo !== undefined) set.locationGeo = d.locationGeo;
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

/** Override rules only shape an exception feed's baseline; standard feeds pass through. */
function outcomeAllowed(feedMode: string, _outcome: string): boolean {
  return feedMode === 'exception';
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

/**
 * Force-refresh a single feed now: ingest → synthesize → read-back (family,
 * so human edits on member target calendars aren't left stale between cron
 * ticks) → task-gen → claim true-up → mirror.
 */
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
  await readBackFamily(db, familyId, ingestSecrets(c.env));
  const links = await db
    .select({ familyMemberId: familyMemberFeeds.familyMemberId })
    .from(familyMemberFeeds)
    .where(eq(familyMemberFeeds.feedId, feed.id));
  for (const familyMemberId of new Set(links.map((l) => l.familyMemberId))) {
    await reconcileMemberConflicts(db, familyMemberId);
    await buildMemberTasks(db, familyMemberId);
  }
  await reconcileClaimEvents(db, familyId);
  enqueueReconcile(c, { kind: 'family', familyId });
  return c.json({ ingest, synthesis });
});

/**
 * Force-refresh all of a family's feeds now — mirrors the cron tick's
 * pipeline order: ingest+synthesize → read-back → task-gen → claim
 * true-up → mirror. Without the read-back step, human edits made directly
 * on a member's target calendar wouldn't show up until the next cron tick.
 */
feedRoutes.post('/refresh-all', async (c) => {
  const db = getDb(c.env.DB);
  const familyId = c.get('member').familyId;
  const ingest = await ingestFamilyFeeds(db, familyId, ingestSecrets(c.env));

  const familyFeeds = await db.select().from(feeds).where(eq(feeds.familyId, familyId));
  const synthesis = [];
  for (const feed of familyFeeds) {
    synthesis.push(await synthesizeFeed(db, feed));
  }
  await readBackFamily(db, familyId, ingestSecrets(c.env));
  await reconcileFamilyConflicts(db, familyId);
  await buildFamilyTasks(db, familyId);
  await reconcileClaimEvents(db, familyId);
  enqueueReconcile(c, { kind: 'family', familyId });
  return c.json({ ingest, synthesis });
});
