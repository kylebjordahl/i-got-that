import { env } from 'cloudflare:test';
import {
  eq,
  externalAccounts,
  familyMemberFeeds,
  feeds,
  getDb,
  pushDevices,
  users,
} from '@igt/db';
import { describe, expect, it } from 'vitest';
import { DevPusher } from '../src/lib/apns.js';
import { connectGoogleAccount } from '../src/lib/google-account.js';
import { GoogleTokenRefreshError } from '../src/lib/google-oauth.js';
import { storeSecret } from '../src/lib/secrets.js';
import { ingestFeed } from '../src/services/ingest.js';
import {
  dispatchReauthAlerts,
  inQuietHours,
  REAUTH_ALERT_DELAY_MS,
} from '../src/services/reauth-alerts.js';
import { bearer, call, patched, setupFamily, testKeys } from './helpers.js';

const db = () => getDb(env.DB);
const WORK_CAL = 'kyle@work.example';
const LA = 'America/Los_Angeles';

/** A family whose admin owns a Google account backing a busy feed. */
async function setup(email: string) {
  const fam = await setupFamily(email, 'Reauth Fam');
  const credentialsRef = await storeSecret(
    db(),
    testKeys(),
    null,
    JSON.stringify({ kind: 'oauth', refreshToken: 'rt' }),
  );
  const account = (
    await db()
      .insert(externalAccounts)
      .values({
        userId: fam.admin.userId,
        kind: 'google',
        name: 'kyle@example.com',
        username: 'kyle@example.com',
        credentialsRef,
      })
      .returning()
  )[0]!;
  const feed = (
    await db()
      .insert(feeds)
      .values({
        familyId: fam.familyId,
        kind: 'google',
        externalAccountId: account.id,
        sourceCalendarId: WORK_CAL,
        sourceCalendarName: 'Work (busy)',
        mode: 'busy',
      })
      .returning()
  )[0]!;
  await db()
    .insert(familyMemberFeeds)
    .values({ familyId: fam.familyId, feedId: feed.id, familyMemberId: fam.adminMemberId });
  const accountRow = async () =>
    (await db().select().from(externalAccounts).where(eq(externalAccounts.id, account.id)))[0]!;
  const ingest = (opts: { googleRefresh: (rt: string) => Promise<string>; fetchImpl?: typeof fetch }) =>
    ingestFeed(db(), feed, { kek: testKeys(), ...opts }).catch(() => undefined);
  const addDevice = (timezone: string | null, token = 'a'.repeat(64)) =>
    db().insert(pushDevices).values({
      userId: fam.admin.userId,
      deviceToken: token,
      bundleId: 'com.kylebjordahl.igt.staging',
      environment: 'development',
      timezone,
    });
  return { ...fam, account, feed, accountRow, ingest, addDevice };
}

const deadGrant = async () => {
  throw new GoogleTokenRefreshError('google token refresh failed: 400 invalid_grant', 400, 'invalid_grant');
};
const okToken = async () => 'access-token';
const freeBusy = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const emptyFreeBusy = freeBusy(200, { calendars: { [WORK_CAL]: { busy: [] } } });

/** An instant at local `hour`:00 in LA, safely past the alert delay. */
function laAt(hour: number): Date {
  const d = new Date('2026-10-15T00:00:00Z');
  // LA is UTC-7 in October.
  d.setUTCHours(hour + 7);
  return d;
}

describe('reauth: spotting an account only its owner can fix', () => {
  it('flags the account when Google refuses the refresh token', async () => {
    const t = await setup('reauth-invalid-grant@example.com');
    await t.ingest({ googleRefresh: deadGrant });
    const row = await t.accountRow();
    expect(row.authFailedAt).toBeInstanceOf(Date);
    expect(row.authFailureMessage).toContain('invalid_grant');
  });

  it('flags a missing-scope 403, but not a rate limit', async () => {
    const scope = await setup('reauth-scope@example.com');
    await scope.ingest({
      googleRefresh: okToken,
      fetchImpl: freeBusy(403, { error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }),
    });
    expect((await scope.accountRow()).authFailedAt).toBeInstanceOf(Date);

    const limited = await setup('reauth-ratelimit@example.com');
    await limited.ingest({
      googleRefresh: okToken,
      fetchImpl: freeBusy(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }),
    });
    expect((await limited.accountRow()).authFailedAt).toBeNull();
  });

  it('keeps the first failure time across repeated failures, and clears on the next good sync', async () => {
    const t = await setup('reauth-clear@example.com');
    await t.ingest({ googleRefresh: deadGrant });
    const first = (await t.accountRow()).authFailedAt!;
    await t.ingest({ googleRefresh: deadGrant });
    expect((await t.accountRow()).authFailedAt!.getTime()).toBe(first.getTime());

    await t.ingest({ googleRefresh: okToken, fetchImpl: emptyFreeBusy });
    const row = await t.accountRow();
    expect(row.authFailedAt).toBeNull();
    expect(row.authFailureMessage).toBeNull();
  });

  it('a reconnect clears the flag', async () => {
    const t = await setup('reauth-reconnect@example.com');
    await t.ingest({ googleRefresh: deadGrant });
    await connectGoogleAccount(db(), testKeys(), {
      userId: t.admin.userId,
      refreshToken: 'fresh',
      accountId: t.account.id,
    });
    expect((await t.accountRow()).authFailedAt).toBeNull();
  });

  it('the account list tells the owner which account needs reconnecting', async () => {
    const t = await setup('reauth-list@example.com');
    await t.ingest({ googleRefresh: deadGrant });
    const res = await call('/accounts', bearer(t.admin.token));
    const { accounts } = (await res.json()) as {
      accounts: { id: string; authFailedAt: string | null }[];
    };
    expect(accounts.find((a) => a.id === t.account.id)!.authFailedAt).not.toBeNull();
  });
});

describe('reauth: the push', () => {
  /** Flag the account as failing since `failedAt`. */
  async function failingSince(email: string, failedAt: Date) {
    const t = await setup(email);
    await db()
      .update(externalAccounts)
      .set({ authFailedAt: failedAt, authFailureMessage: 'invalid_grant' })
      .where(eq(externalAccounts.id, t.account.id));
    return t;
  }

  it('alerts once, after the delay, in the daytime, naming the account', async () => {
    const now = laAt(10);
    const t = await failingSince('reauth-push@example.com', new Date(now.getTime() - REAUTH_ALERT_DELAY_MS));
    await t.addDevice(LA);
    const pusher = new DevPusher();

    expect(await dispatchReauthAlerts(env, now, pusher)).toBe(1);
    expect(pusher.sent).toHaveLength(1);
    expect(pusher.sent[0]!.title).toBe('Reconnect your Google account');
    expect(pusher.sent[0]!.body).toContain('kyle@example.com');
    expect(pusher.sent[0]!.data).toEqual({ type: 'reauth', accountId: t.account.id });

    // Same failure, next tick: nothing more.
    expect(await dispatchReauthAlerts(env, new Date(now.getTime() + 15 * 60_000), pusher)).toBe(0);
    expect(pusher.sent).toHaveLength(1);
  });

  it('waits out a failure that just started', async () => {
    const now = laAt(10);
    const t = await failingSince('reauth-fresh@example.com', new Date(now.getTime() - 60_000));
    await t.addDevice(LA);
    const pusher = new DevPusher();
    expect(await dispatchReauthAlerts(env, now, pusher)).toBe(0);
    expect(pusher.sent).toHaveLength(0);
  });

  it('holds overnight (device-local) and sends after 8am', async () => {
    const failedAt = laAt(1);
    const t = await failingSince('reauth-overnight@example.com', failedAt);
    await t.addDevice(LA);
    const pusher = new DevPusher();

    expect(await dispatchReauthAlerts(env, laAt(3), pusher)).toBe(0);
    expect(await dispatchReauthAlerts(env, laAt(7), pusher)).toBe(0);
    expect(pusher.sent).toHaveLength(0);
    expect(await dispatchReauthAlerts(env, laAt(8), pusher)).toBe(1);
  });

  it('respects the Me-screen toggle', async () => {
    const now = laAt(10);
    const t = await failingSince('reauth-off@example.com', new Date(now.getTime() - REAUTH_ALERT_DELAY_MS));
    await t.addDevice(LA);
    const off = await call('/notifications/settings', patched(t.admin.token, { reauthAlerts: false }));
    expect(off.status).toBe(200);
    const settings = await call('/notifications/settings', bearer(t.admin.token));
    expect(await settings.json()).toEqual({ settings: { reauthAlerts: false } });

    const pusher = new DevPusher();
    expect(await dispatchReauthAlerts(env, now, pusher)).toBe(0);
    expect(pusher.sent).toHaveLength(0);
    const user = (await db().select().from(users).where(eq(users.id, t.admin.userId)))[0]!;
    expect(user.reauthAlertsEnabled).toBe(false);
  });

  it('a new failure after a recovery alerts again', async () => {
    const now = laAt(10);
    const t = await failingSince('reauth-again@example.com', new Date(now.getTime() - REAUTH_ALERT_DELAY_MS));
    await t.addDevice(LA);
    const pusher = new DevPusher();
    await dispatchReauthAlerts(env, now, pusher);
    // Recovers, then breaks again.
    await t.ingest({ googleRefresh: okToken, fetchImpl: emptyFreeBusy });
    await db()
      .update(externalAccounts)
      .set({ authFailedAt: new Date(now.getTime() - REAUTH_ALERT_DELAY_MS) })
      .where(eq(externalAccounts.id, t.account.id));
    expect(await dispatchReauthAlerts(env, now, pusher)).toBe(1);
    expect(pusher.sent).toHaveLength(2);
  });
});

describe('inQuietHours', () => {
  it('is overnight from 21:00 to 08:00 local, and never for an unknown zone', () => {
    expect(inQuietHours(LA, laAt(20))).toBe(false);
    expect(inQuietHours(LA, laAt(21))).toBe(true);
    expect(inQuietHours(LA, laAt(7))).toBe(true);
    expect(inQuietHours(LA, laAt(8))).toBe(false);
    expect(inQuietHours(null, laAt(3))).toBe(false);
    expect(inQuietHours('Not/AZone', laAt(3))).toBe(false);
  });
});
