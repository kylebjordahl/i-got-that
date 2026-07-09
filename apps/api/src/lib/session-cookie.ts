import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { HonoEnv } from '../env.js';

/**
 * Mirrors the bearer session token into an HttpOnly cookie so the web SPA can
 * survive a page refresh without holding the raw token in JS-reachable
 * storage (localStorage/sessionStorage would be readable by any XSS). Native
 * clients keep using the `Authorization: Bearer` header + their own secure
 * storage; this cookie is additive and ignored by them.
 *
 * Value is the same opaque token used for the bearer header — it's already
 * validated server-side via a hash lookup (`getUserBySessionToken`), so the
 * cookie itself doesn't need to be signed.
 */
export const SESSION_COOKIE = 'igt_session';
const SESSION_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // mirrors services/auth.ts SESSION_TTL_MS

export function setSessionCookie(c: Context<HonoEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    // Same-origin in every deployed env (the API + SPA share PUBLIC_ORIGIN), and
    // "same-site" in local dev (same `localhost` host, different port) — Lax
    // covers both without the CSRF exposure SameSite=None would add.
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_S,
  });
}

export function clearSessionCookie(c: Context<HonoEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** The bearer header, if present — checked before the cookie fallback. */
export function bearerToken(c: Context<HonoEnv>): string | undefined {
  const header = c.req.header('Authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/** Bearer header first, falling back to the session cookie (web). */
export function sessionToken(c: Context<HonoEnv>): string | undefined {
  return bearerToken(c) ?? getCookie(c, SESSION_COOKIE);
}
