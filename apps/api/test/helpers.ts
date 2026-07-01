import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { expect } from 'vitest';
import app from '../src/index.js';

export async function call(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://api.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
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

/** Create a family as the given user; returns the family id (creator is admin). */
export async function createFamily(token: string, name: string): Promise<string> {
  const res = await call('/families', authed(token, { name }));
  const { family } = (await res.json()) as { family: { id: string } };
  return family.id;
}
