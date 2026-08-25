import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { expect } from 'vitest';
import app from '../src/index.js';
import { buildKekKeySet, type KekKeySet } from '../src/lib/secrets.js';

export async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/**
 * The test env's `KekKeySet` (built from the dev-only `KEK_V1` in
 * `wrangler.jsonc`) — the versioned replacement for tests that used to pass
 * the old single `env.KEK` straight into `encryptSecret`/`storeSecret`/etc.
 */
export function testKeys(): KekKeySet {
  const keys = buildKekKeySet(env);
  if (!keys) throw new Error('test env missing KEK_V1 — check wrangler.jsonc');
  return keys;
}

export function authed(token: string, body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

export function bearer(token: string): RequestInit {
  return { headers: { Authorization: `Bearer ${token}` } };
}

export function patched(token: string, body?: unknown): RequestInit {
  return {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

export function put(token: string, body?: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

/** Complete the magic-link flow; returns a session token + user id. */
export async function login(
  email: string,
): Promise<{ token: string; userId: string }> {
  const reqRes = await call('/auth/magic-link/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const { devToken } = (await reqRes.json()) as { devToken: string };
  const verifyRes = await call('/auth/magic-link/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: devToken }),
  });
  const { sessionToken, user } = (await verifyRes.json()) as {
    sessionToken: string;
    user: { id: string };
  };
  expect(sessionToken).toBeTruthy();
  return { token: sessionToken, userId: user.id };
}

/**
 * Link a user to an existing (unlinked) family member the only sanctioned
 * way: an admin issues a member-claim invite and the user accepts it.
 * `POST /families/:familyId/members` never links a `userId` directly (#147).
 */
export async function linkMember(
  adminToken: string,
  familyId: string,
  memberId: string,
  userToken: string,
): Promise<void> {
  const issued = await call(
    `/families/${familyId}/members/${memberId}/invite`,
    authed(adminToken),
  );
  expect(issued.status).toBe(201);
  const { token } = (await issued.json()) as { token: string };
  const accepted = await call(`/invites/${token}/accept`, authed(userToken));
  expect(accepted.status).toBe(200);
}

/** Create a family as the given user; returns the family id (creator is admin). */
export async function createFamily(token: string, name: string): Promise<string> {
  const res = await call('/families', authed(token, { name }));
  const { family } = (await res.json()) as { family: { id: string } };
  return family.id;
}

/**
 * Common pipeline fixture: an admin caretaker, their family, and a dependent
 * child. Specs add feeds/links/rules on top.
 */
export async function setupFamily(email: string, name = 'Test Fam') {
  const admin = await login(email);
  const res = await call('/families', authed(admin.token, { name }));
  const { family, member } = (await res.json()) as {
    family: { id: string };
    member: { id: string };
  };
  const childRes = await call(
    `/families/${family.id}/members`,
    authed(admin.token, { relationName: 'child', requiresCaretaker: true }),
  );
  const { member: child } = (await childRes.json()) as { member: { id: string } };
  return {
    admin,
    familyId: family.id,
    adminMemberId: member.id,
    childId: child.id,
  };
}
