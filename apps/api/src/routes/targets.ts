import {
  and,
  calendarTargets,
  type Db,
  eq,
  familyMembers,
  getDb,
  secrets,
} from '@igt/db';
import {
  CalDavDiscoverInput,
  CreateCalendarTargetInput,
  GoogleAuthorizeUrlInput,
  UpdateCalendarTargetInput,
} from '@igt/domain';
import { createCalDavClient } from '@igt/ical';
import { Hono } from 'hono';
import type { Bindings, HonoEnv } from '../env.js';
import { requireFamilyMember } from '../middleware/auth.js';
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleCode,
  googleOAuthConfigured,
} from '../lib/google-oauth.js';
import { storeSecret } from '../lib/secrets.js';
import {
  enqueueReconcile,
  getProductionRegistry,
  purgeTargetRemote,
} from '../services/delivery.js';

/** Load a target with the family it belongs to (for tenancy + ownership checks). */
async function loadTarget(db: Db, targetId: string) {
  const rows = await db
    .select({ target: calendarTargets, familyId: familyMembers.familyId })
    .from(calendarTargets)
    .innerJoin(familyMembers, eq(familyMembers.id, calendarTargets.memberId))
    .where(eq(calendarTargets.id, targetId))
    .limit(1);
  return rows[0] ?? null;
}

type Credential =
  | { username?: string; password?: string; accessToken?: string; authCode?: string; redirectUri?: string }
  | undefined;

/**
 * Build the (JSON) credential payload to encrypt for a target, or null if none.
 * For Google, an authCode + redirectUri is exchanged for a stored refresh token;
 * a pasted accessToken is still accepted as a fallback.
 */
async function buildCredentialPayload(
  env: Bindings,
  method: string,
  cred: Credential,
): Promise<{ payload: string } | { error: string; status: 400 | 500 } | null> {
  if (!cred) return null;
  const hasMaterial = cred.password || cred.accessToken || cred.authCode;
  if (!hasMaterial) return null;

  if (method === 'google') {
    if (cred.authCode && cred.redirectUri) {
      try {
        const tokens = await exchangeGoogleCode(env, {
          code: cred.authCode,
          redirectUri: cred.redirectUri,
        });
        if (!tokens.refreshToken) return { error: 'google_no_refresh_token', status: 400 };
        return { payload: JSON.stringify({ kind: 'oauth', refreshToken: tokens.refreshToken }) };
      } catch (err) {
        console.error('google code exchange failed', err);
        return { error: 'google_exchange_failed', status: 400 };
      }
    }
    if (cred.accessToken) {
      return { payload: JSON.stringify({ kind: 'oauth', accessToken: cred.accessToken }) };
    }
    return null;
  }
  return {
    payload: JSON.stringify({ kind: 'basic', username: cred.username, password: cred.password }),
  };
}

/** Mounted under /families/:familyId (auth applied by parent router). */
export const targetRoutes = new Hono<HonoEnv>();
targetRoutes.use('*', requireFamilyMember);

/** Build a Google OAuth consent URL (the client opens it, then sends us the code). */
targetRoutes.post('/google/authorize-url', async (c) => {
  if (!googleOAuthConfigured(c.env)) return c.json({ error: 'google_oauth_not_configured' }, 501);
  const parsed = GoogleAuthorizeUrlInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  return c.json({ url: buildGoogleAuthorizeUrl(c.env, { redirectUri: parsed.data.redirectUri }) });
});

/**
 * Create a calendar target for a caretaker. A member manages their own targets;
 * admins may manage anyone's. Credentials (caldav password / google token) are
 * envelope-encrypted into a `secret`.
 */
targetRoutes.post('/calendar-targets', async (c) => {
  const parsed = CreateCalendarTargetInput.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const me = c.get('member');
  if (parsed.data.memberId !== me.id && !me.isAdmin) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const db = getDb(c.env.DB);

  // Target member must belong to this family.
  const target = (
    await db
      .select()
      .from(familyMembers)
      .where(
        and(
          eq(familyMembers.id, parsed.data.memberId),
          eq(familyMembers.familyId, me.familyId),
        ),
      )
      .limit(1)
  )[0];
  if (!target) return c.json({ error: 'member_not_found' }, 404);

  // Encrypt any provided credential (Google: exchange the auth code first).
  let credentialsRef: string | null = null;
  const built = await buildCredentialPayload(c.env, parsed.data.method, parsed.data.credential);
  if (built && 'error' in built) return c.json({ error: built.error }, built.status);
  if (built) {
    if (!c.env.KEK) return c.json({ error: 'kek_unconfigured' }, 500);
    credentialsRef = await storeSecret(db, c.env.KEK, me.familyId, built.payload);
  }

  const row = (
    await db
      .insert(calendarTargets)
      .values({
        memberId: parsed.data.memberId,
        name: parsed.data.name,
        method: parsed.data.method,
        providerHint: parsed.data.providerHint ?? null,
        addressOrUrl: parsed.data.addressOrUrl,
        externalCalendarId: parsed.data.externalCalendarId ?? null,
        alertMinutes: parsed.data.alertMinutes ?? null,
        credentialsRef,
      })
      .returning()
  )[0]!;

  // Reflect the owner's existing owned tasks onto the new calendar (queued).
  enqueueReconcile(c, { kind: 'member', memberId: parsed.data.memberId });

  // Never return credential material.
  const { credentialsRef: _omit, ...safe } = row;
  return c.json({ target: safe }, 201);
});

/** List calendar targets (own; admins see the whole family). Credentials are never returned. */
targetRoutes.get('/calendar-targets', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');

  const projection = {
    id: calendarTargets.id,
    memberId: calendarTargets.memberId,
    memberRelation: familyMembers.relationName,
    name: calendarTargets.name,
    method: calendarTargets.method,
    providerHint: calendarTargets.providerHint,
    addressOrUrl: calendarTargets.addressOrUrl,
    externalCalendarId: calendarTargets.externalCalendarId,
    alertMinutes: calendarTargets.alertMinutes,
    active: calendarTargets.active,
  };
  const base = db
    .select(projection)
    .from(calendarTargets)
    .innerJoin(familyMembers, eq(familyMembers.id, calendarTargets.memberId));

  const rows = me.isAdmin
    ? await base.where(eq(familyMembers.familyId, me.familyId))
    : await base.where(eq(calendarTargets.memberId, me.id));

  return c.json({ targets: rows });
});

/**
 * Discover the CalDAV calendars available for a set of credentials (no storage).
 * The client uses this to let the caretaker pick which calendar to write to.
 */
targetRoutes.post('/caldav/discover', async (c) => {
  const parsed = CalDavDiscoverInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  try {
    const client = await createCalDavClient({
      serverUrl: parsed.data.serverUrl,
      username: parsed.data.username,
      password: parsed.data.password,
    });
    const calendars = await client.fetchCalendars();
    const list = calendars.map((cal) => ({
      url: cal.url,
      displayName:
        typeof cal.displayName === 'string' && cal.displayName.length > 0
          ? cal.displayName
          : cal.url,
    }));
    return c.json({ calendars: list });
  } catch (err) {
    return c.json({ error: 'discover_failed', message: String(err) }, 400);
  }
});

/** Update a calendar target (own; admins any). Credentials are re-encrypted. */
targetRoutes.patch('/calendar-targets/:targetId', async (c) => {
  const parsed = UpdateCalendarTargetInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const found = await loadTarget(db, c.req.param('targetId'));
  if (!found || found.familyId !== me.familyId) return c.json({ error: 'not_found' }, 404);
  if (found.target.memberId !== me.id && !me.isAdmin) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const d = parsed.data;
  const set: Partial<typeof calendarTargets.$inferInsert> = {};
  if (d.name !== undefined) set.name = d.name;
  if (d.active !== undefined) set.active = d.active;
  if (d.addressOrUrl !== undefined) set.addressOrUrl = d.addressOrUrl;
  if (d.externalCalendarId !== undefined) set.externalCalendarId = d.externalCalendarId;
  if (d.providerHint !== undefined) set.providerHint = d.providerHint;
  if (d.alertMinutes !== undefined) set.alertMinutes = d.alertMinutes;

  const built = await buildCredentialPayload(c.env, found.target.method, d.credential);
  if (built && 'error' in built) return c.json({ error: built.error }, built.status);
  if (built) {
    if (!c.env.KEK) return c.json({ error: 'kek_unconfigured' }, 500);
    set.credentialsRef = await storeSecret(db, c.env.KEK, me.familyId, built.payload);
    if (found.target.credentialsRef) {
      await db.delete(secrets).where(eq(secrets.id, found.target.credentialsRef));
    }
  }

  if (Object.keys(set).length > 0) {
    await db.update(calendarTargets).set(set).where(eq(calendarTargets.id, found.target.id));
  }
  const updated = (
    await db.select().from(calendarTargets).where(eq(calendarTargets.id, found.target.id)).limit(1)
  )[0]!;

  // Reconcile after the change (active toggle, calendar switch, etc.) off the
  // request path so the response returns promptly.
  enqueueReconcile(c, { kind: 'member', memberId: found.target.memberId });

  const { credentialsRef: _omit, ...safe } = updated;
  return c.json({ target: safe });
});

/** Delete a calendar target (own; admins any) + its stored credential. */
targetRoutes.delete('/calendar-targets/:targetId', async (c) => {
  const db = getDb(c.env.DB);
  const me = c.get('member');
  const found = await loadTarget(db, c.req.param('targetId'));
  if (!found || found.familyId !== me.familyId) return c.json({ error: 'not_found' }, 404);
  if (found.target.memberId !== me.id && !me.isAdmin) {
    return c.json({ error: 'forbidden' }, 403);
  }

  // Remove the events we put on the remote calendar before dropping the target.
  try {
    await purgeTargetRemote(db, getProductionRegistry(c.env), c.env.KEK, found.target);
  } catch (err) {
    console.error('purgeTargetRemote failed', err);
  }

  await db.delete(calendarTargets).where(eq(calendarTargets.id, found.target.id));
  if (found.target.credentialsRef) {
    await db.delete(secrets).where(eq(secrets.id, found.target.credentialsRef));
  }
  return c.json({ ok: true });
});
