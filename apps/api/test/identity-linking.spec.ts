import { eq, getDb, identities } from '@igt/db';
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { linkAppleIdentity } from '../src/services/auth.js';
import { authed, bearer, call, login } from './helpers.js';

/** Request a magic link for `email` and return the raw dev token. */
async function magicToken(email: string): Promise<string> {
  const res = await call('/auth/magic-link/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const { devToken } = (await res.json()) as { devToken: string };
  expect(devToken).toBeTruthy();
  return devToken;
}

async function listIdentities(token: string) {
  const res = await call('/auth/identities', bearer(token));
  expect(res.status).toBe(200);
  return ((await res.json()) as { identities: { id: string; provider: string; providerRef: string }[] })
    .identities;
}

describe('identity linking — threading login methods into one user', () => {
  it('lists the login method the account was created with', async () => {
    const alice = await login('link-alice@example.com');
    const list = await listIdentities(alice.token);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      provider: 'magic_link',
      providerRef: 'link-alice@example.com',
    });
  });

  it('threads a second magic-link email onto the same user', async () => {
    const alice = await login('primary@example.com');

    // Request + link a second email while signed in.
    const token = await magicToken('secondary@example.com');
    const linkRes = await call('/auth/link/magic-link', authed(alice.token, { token }));
    expect(linkRes.status).toBe(200);
    expect((await linkRes.json()) as unknown).toMatchObject({ ok: true, status: 'linked' });

    const list = await listIdentities(alice.token);
    expect(list.map((i) => i.providerRef).sort()).toEqual([
      'primary@example.com',
      'secondary@example.com',
    ]);

    // Logging in via the newly-linked email lands on the SAME user.
    const secondLogin = await login('secondary@example.com');
    expect(secondLogin.userId).toBe(alice.userId);
  });

  it('threads an Apple identity onto a magic-link user (verified sub → same user)', async () => {
    const alice = await login('apple-link@example.com');
    const db = getDb(env.DB);

    // The route verifies the Apple token; here we drive the underlying service
    // with an already-verified sub (token verification is covered elsewhere).
    const result = await linkAppleIdentity(db, alice.userId, 'apple-sub-xyz');
    expect(result).toMatchObject({ ok: true, status: 'linked' });

    const rows = await db.select().from(identities).where(eq(identities.userId, alice.userId));
    expect(rows.map((r) => r.provider).sort()).toEqual(['apple', 'magic_link']);
  });

  it('is idempotent when re-linking the same email', async () => {
    const alice = await login('idem@example.com');
    const token = await magicToken('idem-extra@example.com');
    const first = await call('/auth/link/magic-link', authed(alice.token, { token }));
    expect((await first.json()) as unknown).toMatchObject({ status: 'linked' });

    // A fresh token for the same email → already linked, not a duplicate.
    const token2 = await magicToken('idem-extra@example.com');
    const second = await call('/auth/link/magic-link', authed(alice.token, { token: token2 }));
    expect(second.status).toBe(200);
    expect((await second.json()) as unknown).toMatchObject({ status: 'already_linked' });

    expect(await listIdentities(alice.token)).toHaveLength(2);
  });

  it('refuses to steal an email already threaded to another user', async () => {
    const alice = await login('owner@example.com');
    const bob = await login('other@example.com');

    // Bob tries to link Alice's login email.
    const token = await magicToken('owner@example.com');
    const res = await call('/auth/link/magic-link', authed(bob.token, { token }));
    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toMatchObject({
      error: 'identity_linked_to_other_user',
    });

    // Alice's account is untouched — still exactly one identity, still hers.
    expect(await listIdentities(alice.token)).toHaveLength(1);
  });

  it('rejects an invalid/expired link token', async () => {
    const alice = await login('badtoken@example.com');
    const res = await call('/auth/link/magic-link', authed(alice.token, { token: 'nope' }));
    expect(res.status).toBe(401);
  });

  it('unlinks a method, but never the last one', async () => {
    const alice = await login('unlink@example.com');
    const token = await magicToken('unlink-extra@example.com');
    await call('/auth/link/magic-link', authed(alice.token, { token }));

    const before = await listIdentities(alice.token);
    expect(before).toHaveLength(2);
    const extra = before.find((i) => i.providerRef === 'unlink-extra@example.com')!;

    const del = await call(`/auth/identities/${extra.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    expect(del.status).toBe(200);

    const after = await listIdentities(alice.token);
    expect(after).toHaveLength(1);

    // Removing the last remaining method is blocked.
    const blocked = await call(`/auth/identities/${after[0]!.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()) as unknown).toMatchObject({ error: 'last_identity' });
  });

  it('requires a session for identity endpoints', async () => {
    expect((await call('/auth/identities')).status).toBe(401);
    expect(
      (
        await call('/auth/link/magic-link', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'x' }),
        })
      ).status,
    ).toBe(401);
  });
});
