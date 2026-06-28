import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../src/index.js';

async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function authed(token: string, body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

/** Run the magic-link flow and return a session token + user id. */
async function login(email: string): Promise<{ token: string; userId: string }> {
  const reqRes = await call('/auth/magic-link/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(reqRes.status).toBe(200);
  const { devToken } = (await reqRes.json()) as { devToken: string };
  expect(devToken).toBeTruthy();

  const verifyRes = await call('/auth/magic-link/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: devToken }),
  });
  expect(verifyRes.status).toBe(200);
  const { sessionToken, user } = (await verifyRes.json()) as {
    sessionToken: string;
    user: { id: string };
  };
  return { token: sessionToken, userId: user.id };
}

describe('identity & tenancy', () => {
  it('rejects unauthenticated /me', async () => {
    const res = await call('/me');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid magic-link token', async () => {
    const res = await call('/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-real-token' }),
    });
    expect(res.status).toBe(401);
  });

  it('logs in, creates a family, and seeds the creator as admin', async () => {
    const alice = await login('alice@example.com');

    const me = await call('/me', { headers: { Authorization: `Bearer ${alice.token}` } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { id: string }; families: unknown[] };
    expect(meBody.user.id).toBe(alice.userId);
    expect(meBody.families).toHaveLength(0);

    const created = await call('/families', authed(alice.token, { name: 'Smith', relationName: 'mom' }));
    expect(created.status).toBe(201);
    const { family, member } = (await created.json()) as {
      family: { id: string };
      member: { isAdmin: boolean; isCaretaker: boolean };
    };
    expect(member.isAdmin).toBe(true);
    expect(member.isCaretaker).toBe(true);

    // A dependent (child) — admin adds it.
    const child = await call(
      `/families/${family.id}/members`,
      authed(alice.token, { relationName: 'child', requiresCaretaker: true }),
    );
    expect(child.status).toBe(201);

    const list = await call(`/families/${family.id}/members`, {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    const { members } = (await list.json()) as { members: unknown[] };
    expect(members).toHaveLength(2);
  });

  it('enforces tenant isolation and admin-only member creation', async () => {
    const alice = await login('alice2@example.com');
    const bob = await login('bob@example.com');

    const created = await call('/families', authed(alice.token, { name: 'Jones' }));
    const { family } = (await created.json()) as { family: { id: string } };

    // Bob is not a member → cannot read the family's members.
    const bobList = await call(`/families/${family.id}/members`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    expect(bobList.status).toBe(403);

    // Alice (admin) adds Bob as a non-admin caretaker.
    const addBob = await call(
      `/families/${family.id}/members`,
      authed(alice.token, {
        relationName: 'uncle',
        isCaretaker: true,
        isAdmin: false,
        userId: bob.userId,
      }),
    );
    expect(addBob.status).toBe(201);

    // Now Bob can read members...
    const bobListAfter = await call(`/families/${family.id}/members`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    expect(bobListAfter.status).toBe(200);

    // ...but cannot add members (not an admin).
    const bobAdd = await call(
      `/families/${family.id}/members`,
      authed(bob.token, { relationName: 'friend', isCaretaker: true }),
    );
    expect(bobAdd.status).toBe(403);
  });
});
