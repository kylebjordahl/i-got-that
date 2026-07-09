import { describe, expect, it } from 'vitest';
import { authed, bearer, call, createFamily, login } from './helpers.js';

type Account = { id: string; kind: string; serverUrl: string | null };

function createCalDavAccount(token: string, name = 'My CalDAV') {
  return call(
    '/accounts',
    authed(token, {
      kind: 'caldav',
      name,
      serverUrl: 'https://dav.example.com',
      username: 'u',
      password: 'p',
    }),
  );
}

describe('external accounts', () => {
  it('connects a caldav account and never leaks the credential', async () => {
    const user = await login('acct-user@example.com');
    const res = await createCalDavAccount(user.token);
    expect(res.status).toBe(201);
    const { account } = (await res.json()) as { account: Account };
    expect(account.kind).toBe('caldav');
    expect(account.serverUrl).toBe('https://dav.example.com');
    expect('credentialsRef' in (account as Record<string, unknown>)).toBe(false);

    const list = await call('/accounts', bearer(user.token));
    const { accounts } = (await list.json()) as { accounts: Account[] };
    expect(accounts).toHaveLength(1);
    expect('credentialsRef' in (accounts[0] as Record<string, unknown>)).toBe(false);
  });

  it('scopes accounts to their owner', async () => {
    const owner = await login('acct-owner@example.com');
    const other = await login('acct-other@example.com');
    const created = await createCalDavAccount(owner.token);
    const accountId = ((await created.json()) as { account: Account }).account.id;

    // A different user neither sees nor can delete it.
    const otherList = await call('/accounts', bearer(other.token));
    expect(((await otherList.json()) as { accounts: Account[] }).accounts).toHaveLength(0);

    const del = await call(`/accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(del.status).toBe(404);
  });

  it('blocks deletion while a feed uses the account (409)', async () => {
    const user = await login('acct-feed@example.com');
    const familyId = await createFamily(user.token, 'Acct Fam');
    const created = await createCalDavAccount(user.token);
    const accountId = ((await created.json()) as { account: Account }).account.id;

    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(user.token, {
        kind: 'caldav',
        externalAccountId: accountId,
        sourceCalendarId: 'https://dav.example.com/cal/home/',
        sourceCalendarName: 'Home',
        mode: 'standard',
      }),
    );
    expect(feedRes.status).toBe(201);

    const del = await call(`/accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(del.status).toBe(409);
  });

  it('deletes an unused account', async () => {
    const user = await login('acct-del@example.com');
    const created = await createCalDavAccount(user.token);
    const accountId = ((await created.json()) as { account: Account }).account.id;

    const del = await call(`/accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(del.status).toBe(200);

    const list = await call('/accounts', bearer(user.token));
    expect(((await list.json()) as { accounts: Account[] }).accounts).toHaveLength(0);
  });

  it('rejects an account-backed feed referencing another user’s account', async () => {
    const owner = await login('acct-owner2@example.com');
    const created = await createCalDavAccount(owner.token);
    const accountId = ((await created.json()) as { account: Account }).account.id;

    // A different user (admin of their own family) can't draw the owner's account.
    const intruder = await login('acct-intruder@example.com');
    const familyId = await createFamily(intruder.token, 'Intruder Fam');
    const feedRes = await call(
      `/families/${familyId}/feeds`,
      authed(intruder.token, {
        kind: 'caldav',
        externalAccountId: accountId,
        sourceCalendarId: 'https://dav.example.com/cal/home/',
        mode: 'standard',
      }),
    );
    expect(feedRes.status).toBe(404);
  });
});
