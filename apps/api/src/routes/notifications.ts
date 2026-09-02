import {
  and,
  asc,
  type Db,
  eq,
  getDb,
  notificationSchedules,
  pushDevices,
} from '@igt/db';
import {
  CreateNotificationScheduleInput,
  RegisterPushDeviceInput,
  UnregisterPushDeviceInput,
  UpdateNotificationScheduleInput,
} from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { getPusher } from '../lib/apns.js';
import { authMiddleware } from '../middleware/auth.js';
import { currentBadgeCount, sendDigest } from '../services/notifications.js';

/**
 * Push notification setup — device registration and the user's digest
 * schedules. Mounted at `/notifications` under a bare session (NOT
 * family-scoped, like `/accounts`): a device and a notification preference
 * belong to the person who signs in, and a digest deliberately spans every
 * family they're a member of.
 */
export const notificationRoutes = new Hono<HonoEnv>();
notificationRoutes.use('*', authMiddleware);

/** Load a schedule scoped to the current user (ownership guard). */
async function loadOwnSchedule(db: Db, userId: string, scheduleId: string) {
  return (
    await db
      .select()
      .from(notificationSchedules)
      .where(
        and(
          eq(notificationSchedules.id, scheduleId),
          eq(notificationSchedules.userId, userId),
        ),
      )
      .limit(1)
  )[0];
}

// --- Devices ---------------------------------------------------------------

/**
 * Register (or refresh) this device's APNs token.
 *
 * Upserts on the token rather than the user: APNs re-issues the same token to
 * the same install, and signing a second account into one phone has to *move*
 * the device — otherwise the previous user's digests keep arriving on it. The
 * upsert also clears `disabledAt`, so a token Apple once rejected comes back to
 * life when the app re-registers it.
 */
notificationRoutes.post('/devices', async (c) => {
  const parsed = RegisterPushDeviceInput.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const now = new Date();

  const [row] = await db
    .insert(pushDevices)
    .values({
      userId: user.id,
      deviceToken: input.deviceToken,
      bundleId: input.bundleId,
      environment: input.environment,
      platform: input.platform,
      timezone: input.timezone ?? null,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: pushDevices.deviceToken,
      set: {
        userId: user.id,
        bundleId: input.bundleId,
        environment: input.environment,
        platform: input.platform,
        timezone: input.timezone ?? null,
        lastSeenAt: now,
        disabledAt: null,
      },
    })
    .returning();

  return c.json({ device: row });
});

/**
 * Drop a device registration — called on sign-out and when the user turns push
 * off. Scoped to the caller's own rows, and always 200: unregistering a token
 * that's already gone is the desired end state, not an error.
 */
notificationRoutes.delete('/devices', async (c) => {
  const parsed = UnregisterPushDeviceInput.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  }
  const user = c.get('user');
  await getDb(c.env.DB)
    .delete(pushDevices)
    .where(
      and(
        eq(pushDevices.userId, user.id),
        eq(pushDevices.deviceToken, parsed.data.deviceToken),
      ),
    );
  return c.json({ ok: true });
});

/** This user's registered devices — lets the client tell whether *this* one is on. */
notificationRoutes.get('/devices', async (c) => {
  const user = c.get('user');
  const rows = await getDb(c.env.DB)
    .select()
    .from(pushDevices)
    .where(eq(pushDevices.userId, user.id))
    .orderBy(asc(pushDevices.createdAt));
  return c.json({ devices: rows });
});

// --- Badge -----------------------------------------------------------------

/**
 * What the app-icon badge should read right now.
 *
 * The push that set the badge is a snapshot of one moment; this is the live
 * answer, so the client can put the badge back in step whenever it comes to
 * the foreground — and drop it to zero once the last thing that needed a human
 * has been claimed, decided or resolved, whoever did it and wherever. See
 * `currentBadgeCount` for what counts.
 */
notificationRoutes.get('/badge', async (c) => {
  const user = c.get('user');
  const count = await currentBadgeCount(getDb(c.env.DB), user.id);
  return c.json({ count });
});

// --- Schedules -------------------------------------------------------------

notificationRoutes.get('/schedules', async (c) => {
  const user = c.get('user');
  const rows = await getDb(c.env.DB)
    .select()
    .from(notificationSchedules)
    .where(eq(notificationSchedules.userId, user.id))
    .orderBy(asc(notificationSchedules.sendAt));
  return c.json({ schedules: rows });
});

notificationRoutes.post('/schedules', async (c) => {
  const parsed = CreateNotificationScheduleInput.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  }
  const user = c.get('user');
  const [row] = await getDb(c.env.DB)
    .insert(notificationSchedules)
    .values({ userId: user.id, ...parsed.data })
    .returning();
  return c.json({ schedule: row }, 201);
});

notificationRoutes.patch('/schedules/:scheduleId', async (c) => {
  const parsed = UpdateNotificationScheduleInput.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  }
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const existing = await loadOwnSchedule(db, user.id, c.req.param('scheduleId'));
  if (!existing) return c.json({ error: 'not_found' }, 404);

  // Changing *when* or *what* a digest covers makes the slot already stamped
  // for today meaningless — clear it so an edited schedule can fire again the
  // same day rather than going quiet until tomorrow.
  const retimed =
    (parsed.data.sendAt !== undefined && parsed.data.sendAt !== existing.sendAt) ||
    (parsed.data.timezone !== undefined &&
      parsed.data.timezone !== existing.timezone);

  const [row] = await db
    .update(notificationSchedules)
    .set({ ...parsed.data, ...(retimed ? { lastSentSlot: null } : {}) })
    .where(eq(notificationSchedules.id, existing.id))
    .returning();
  return c.json({ schedule: row });
});

notificationRoutes.delete('/schedules/:scheduleId', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const existing = await loadOwnSchedule(db, user.id, c.req.param('scheduleId'));
  if (!existing) return c.json({ error: 'not_found' }, 404);
  await db
    .delete(notificationSchedules)
    .where(eq(notificationSchedules.id, existing.id));
  return c.json({ ok: true });
});

/**
 * Send this schedule's digest right now.
 *
 * Returns the computed digest as well as the delivery outcome, so the client
 * can show what the notification *would* say even where the push itself can't
 * be verified — a browser, the simulator, or a deployment without the APNs
 * secrets set. `force` bypasses `skipWhenEmpty`, because "nothing outstanding"
 * is a useful answer when you're testing the configuration.
 */
notificationRoutes.post('/schedules/:scheduleId/test', async (c) => {
  const user = c.get('user');
  const db = getDb(c.env.DB);
  const schedule = await loadOwnSchedule(db, user.id, c.req.param('scheduleId'));
  if (!schedule) return c.json({ error: 'not_found' }, 404);

  const now = new Date();
  const outcome = await sendDigest(db, getPusher(c.env), schedule, now, {
    force: true,
    collapseId: `digest-test:${schedule.id}`,
  });
  return c.json({
    digest: outcome.digest,
    delivered: outcome.delivered,
    skipped: outcome.skipped ?? null,
    failures: outcome.failures,
  });
});
