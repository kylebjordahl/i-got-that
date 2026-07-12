import { getDb } from '@igt/db';
import {
  AppleSignInInput,
  MagicLinkRequestInput,
  MagicLinkVerifyInput,
} from '@igt/domain';
import { Hono } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import type { HonoEnv } from '../env.js';
import { verifyAppleIdentityToken, verifyAppleNotificationToken } from '../lib/apple.js';
import { randomToken } from '../lib/crypto.js';
import { getMailer } from '../lib/mailer.js';
import { clearSessionCookie, sessionToken, setSessionCookie } from '../lib/session-cookie.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  accountDeletionBlocked,
  createSession,
  deleteSession,
  deleteUserAccount,
  findOrCreateUserByApple,
  getUserBySessionToken,
  handleAppleAccountEvent,
  linkAppleIdentity,
  linkMagicLinkIdentity,
  listIdentities,
  requestMagicLink,
  unlinkIdentity,
  verifyMagicLink,
} from '../services/auth.js';

export const authRoutes = new Hono<HonoEnv>();

/** Short-lived cookie carrying the `state.nonce` we minted for an Apple flow. */
const APPLE_OAUTH_COOKIE = 'igt_apple_oauth';
const APPLE_OAUTH_TTL_S = 10 * 60; // 10 minutes to complete the round-trip
const APPLE_AUTHORIZE_URL = 'https://appleid.apple.com/auth/authorize';
/** Public path Apple form-POSTs the identity token to (behind the `/api` prefix). */
const APPLE_CALLBACK_PATH = '/api/auth/apple/callback';

authRoutes.post('/magic-link/request', async (c) => {
  const parsed = MagicLinkRequestInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid', issues: parsed.error.issues }, 400);
  }

  const rawToken = await requestMagicLink(getDb(c.env.DB), parsed.data.email);
  await getMailer(c.env.ENVIRONMENT).sendMagicLink({
    to: parsed.data.email,
    token: rawToken,
  });

  // Outside production, return the token so dev + tests can complete the flow
  // without a live mailbox.
  const devToken = c.env.ENVIRONMENT === 'production' ? undefined : rawToken;
  return c.json({ sent: true, ...(devToken ? { devToken } : {}) });
});

/** Allowed Apple `aud` values (bundle id / Services ID), from APPLE_CLIENT_IDS. */
function appleAudience(env: HonoEnv['Bindings']): string[] {
  return (env.APPLE_CLIENT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The signing secret for the state cookie — reuses the per-env KEK. */
function cookieSecret(env: HonoEnv['Bindings']): string {
  return env.KEK ?? 'insecure-dev-cookie-secret';
}

/**
 * Config for the web redirect flow, derived from PUBLIC_ORIGIN + the Services ID.
 * Null when either is unset (⇒ the web routes report 501). `redirectUri` is the
 * Apple Return URL (must be registered on the Services ID); `appBase` is where we
 * send the browser back with the session.
 */
function appleWebConfig(
  env: HonoEnv['Bindings'],
): { clientId: string; redirectUri: string; appBase: URL } | null {
  if (!env.APPLE_WEB_CLIENT_ID || !env.PUBLIC_ORIGIN) return null;
  return {
    clientId: env.APPLE_WEB_CLIENT_ID,
    redirectUri: new URL(APPLE_CALLBACK_PATH, env.PUBLIC_ORIGIN).toString(),
    appBase: new URL('/app/', env.PUBLIC_ORIGIN),
  };
}

/**
 * Sign in with Apple (native). The iOS client obtains an identity token from
 * Apple and posts it here; we verify it against Apple's JWKS and the configured
 * audience(s), then issue a session. Works without outbound email, so it's the
 * primary login for deployed environments. (Web uses the redirect flow below.)
 */
authRoutes.post('/apple', async (c) => {
  const audience = appleAudience(c.env);
  if (audience.length === 0) {
    return c.json({ error: 'apple_not_configured' }, 501);
  }
  const parsed = AppleSignInInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  let identity;
  try {
    identity = await verifyAppleIdentityToken(parsed.data.identityToken, { audience });
  } catch (err) {
    return c.json({ error: 'invalid_apple_token', message: String(err) }, 401);
  }

  const db = getDb(c.env.DB);
  const user = await findOrCreateUserByApple(db, identity.sub, identity.email);
  const token = await createSession(db, user.id);
  setSessionCookie(c, token);
  return c.json({
    sessionToken: token,
    user: { id: user.id, username: user.username, displayName: user.displayName },
  });
});

/**
 * Web Sign in with Apple — step 1. The browser navigates here (full-page); we
 * mint a `state` + `nonce`, stash them in a short-lived signed cookie, and 302
 * to Apple's authorize endpoint. Apple then form-POSTs back to `/apple/callback`
 * (the registered Return URL) with the identity token. `state`/`nonce` guard
 * against login-CSRF and token replay.
 *
 * Requires APPLE_WEB_CLIENT_ID (the Services ID) + PUBLIC_ORIGIN; unset ⇒ 501
 * (web Apple login disabled), matching the native `/apple` route.
 */
authRoutes.get('/apple/start', async (c) => {
  const web = appleWebConfig(c.env);
  if (!web) {
    return c.json({ error: 'apple_web_not_configured' }, 501);
  }

  // Optional link mode: when `?link=1` and a valid session rides along (the web
  // SPA is same-origin, so the `igt_session` cookie is sent on this navigation),
  // the callback threads Apple onto the current user instead of starting a fresh
  // session. Without a session it degrades to a normal login.
  let linkUserId = '';
  if (c.req.query('link') === '1') {
    const token = sessionToken(c);
    const user = token ? await getUserBySessionToken(getDb(c.env.DB), token) : null;
    if (user) linkUserId = user.id;
  }

  const state = randomToken();
  const nonce = randomToken();
  await setSignedCookie(c, APPLE_OAUTH_COOKIE, `${state}.${nonce}.${linkUserId}`, cookieSecret(c.env), {
    httpOnly: true,
    secure: true,
    // Apple's form-POST is a cross-site top-level navigation, so the cookie must
    // be SameSite=None to ride along on the callback.
    sameSite: 'None',
    path: '/',
    maxAge: APPLE_OAUTH_TTL_S,
  });

  const authorize = new URL(APPLE_AUTHORIZE_URL);
  authorize.search = new URLSearchParams({
    client_id: web.clientId,
    redirect_uri: web.redirectUri,
    // `id_token` in the response + `form_post` are both required when we ask for
    // name/email scope.
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
    state,
    nonce,
  }).toString();
  return c.redirect(authorize.toString(), 302);
});

/**
 * Web Sign in with Apple — step 2. Apple form-POSTs the identity token here. We
 * validate the `state` against the cookie, verify the token (audience + the
 * round-tripped `nonce`), issue a session, and hand it to the SPA via the URL
 * fragment (`/app/#session=…`) — fragments aren't sent to servers or logged.
 * Failures redirect to `/app/#auth_error=…` so the client can surface them.
 */
authRoutes.post('/apple/callback', async (c) => {
  const web = appleWebConfig(c.env);
  const audience = appleAudience(c.env);
  if (!web || audience.length === 0) {
    return c.json({ error: 'apple_web_not_configured' }, 501);
  }
  const back = (fragment: string) => {
    // The SPA lives at `/app/` on PUBLIC_ORIGIN; hand it the result via fragment.
    const to = new URL(web.appBase);
    to.hash = fragment;
    return c.redirect(to.toString(), 302);
  };

  const cookie = await getSignedCookie(c, cookieSecret(c.env), APPLE_OAUTH_COOKIE);
  deleteCookie(c, APPLE_OAUTH_COOKIE, { path: '/' });

  const form = await c.req.parseBody();
  const errorParam = typeof form.error === 'string' ? form.error : undefined;
  const state = typeof form.state === 'string' ? form.state : undefined;
  const idToken = typeof form.id_token === 'string' ? form.id_token : undefined;

  // The user cancelled at Apple, or Apple reported a problem.
  if (errorParam) return back(`auth_error=${encodeURIComponent(errorParam)}`);

  // CSRF guard: the echoed `state` must match the one bound to this browser.
  // A third segment (possibly empty) carries the user id for link mode.
  const [expectedState, nonce, linkUserId] = (cookie || '').split('.');
  if (!cookie || !state || !expectedState || state !== expectedState) {
    return back('auth_error=state_mismatch');
  }
  if (!idToken) return back('auth_error=missing_token');

  let identity;
  try {
    identity = await verifyAppleIdentityToken(idToken, { audience, nonce });
  } catch {
    return back('auth_error=invalid_token');
  }

  const db = getDb(c.env.DB);

  // Link mode: thread Apple onto the already-signed-in user; keep their session.
  if (linkUserId) {
    const result = await linkAppleIdentity(db, linkUserId, identity.sub);
    if (!result.ok) return back(`auth_error=${result.error}`);
    return back('linked=apple');
  }

  const user = await findOrCreateUserByApple(db, identity.sub, identity.email);
  const token = await createSession(db, user.id);
  setSessionCookie(c, token);
  return back(`session=${encodeURIComponent(token)}`);
});

/**
 * Apple **server-to-server notifications** (configured on the primary App ID).
 * Apple POSTs `{ payload: <JWS> }` out-of-band when a user disables their relay
 * email, revokes our app's access, or deletes their Apple ID. We verify the JWS
 * (signature + issuer + audience) and apply the event to our identity/session
 * tables. Trust is the signature, not the caller — the endpoint is public.
 *
 * Always answer 200 on a valid (or unknown-subject) event so Apple doesn't retry;
 * only signature/shape failures return 4xx.
 */
authRoutes.post('/apple/notifications', async (c) => {
  const audience = appleAudience(c.env);
  if (audience.length === 0) {
    return c.json({ error: 'apple_not_configured' }, 501);
  }
  const body = (await c.req.json().catch(() => null)) as { payload?: unknown } | null;
  if (!body || typeof body.payload !== 'string') {
    return c.json({ error: 'invalid' }, 400);
  }

  let event;
  try {
    event = await verifyAppleNotificationToken(body.payload, { audience });
  } catch (err) {
    return c.json({ error: 'invalid_notification', message: String(err) }, 401);
  }

  await handleAppleAccountEvent(getDb(c.env.DB), event);
  return c.body(null, 200);
});

authRoutes.post('/magic-link/verify', async (c) => {
  const parsed = MagicLinkVerifyInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  const result = await verifyMagicLink(getDb(c.env.DB), parsed.data.token);
  if (!result) return c.json({ error: 'invalid_token' }, 401);

  setSessionCookie(c, result.sessionToken);
  return c.json({
    sessionToken: result.sessionToken,
    user: {
      id: result.user.id,
      username: result.user.username,
      displayName: result.user.displayName,
    },
  });
});

/**
 * Log out: invalidate the session (whichever way it was presented — bearer
 * header or the web session cookie) and clear the cookie. Always 200, even if
 * the token was already gone.
 */
authRoutes.post('/logout', async (c) => {
  const token = sessionToken(c);
  if (token) await deleteSession(getDb(c.env.DB), token);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

/**
 * Delete the signed-in user's own account. Family memberships are kept but
 * unlinked (see `deleteUserAccount`), not removed; blocked with 409 if the
 * user is the sole admin of a family that has other members — promote another
 * admin or delete the family first.
 */
authRoutes.delete('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const result = await deleteUserAccount(getDb(c.env.DB), user.id);
  if (result === 'last_admin') return c.json({ error: 'last_admin' }, 409);
  clearSessionCookie(c);
  return c.body(null, 204);
});

/**
 * Whether the signed-in user is currently free to delete their account. Lets
 * the client warn before the delete-confirm sheet's slide control is even
 * shown, instead of letting the user slide and then surfacing the same
 * `last_admin` block as a failed-action toast.
 */
authRoutes.get('/me/deletable', authMiddleware, async (c) => {
  const user = c.get('user');
  const blocked = await accountDeletionBlocked(getDb(c.env.DB), user.id);
  return c.json({ deletable: !blocked });
});

// --- Identity linking (thread multiple login methods into one user) -------

/** The login methods threaded to the current user (Apple + magic-link emails). */
authRoutes.get('/identities', authMiddleware, async (c) => {
  const user = c.get('user');
  const identityList = await listIdentities(getDb(c.env.DB), user.id);
  return c.json({ identities: identityList });
});

/**
 * Link a magic-link email to the current user. The client requests a magic link
 * for the new email as usual, then posts that token here (instead of to
 * `/magic-link/verify`) so it attaches to the signed-in user rather than
 * starting a new account.
 */
authRoutes.post('/link/magic-link', authMiddleware, async (c) => {
  const user = c.get('user');
  const parsed = MagicLinkVerifyInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  const result = await linkMagicLinkIdentity(getDb(c.env.DB), user.id, parsed.data.token);
  if (!result.ok) {
    return c.json({ error: result.error }, result.error === 'invalid_token' ? 401 : 409);
  }
  return c.json({ ok: true, status: result.status });
});

/**
 * Link a native Sign in with Apple identity to the current user. Same token
 * verification as `/apple`, but attaches to the signed-in user. (Web links via
 * the `/apple/start?link=1` redirect.)
 */
authRoutes.post('/link/apple', authMiddleware, async (c) => {
  const audience = appleAudience(c.env);
  if (audience.length === 0) {
    return c.json({ error: 'apple_not_configured' }, 501);
  }
  const user = c.get('user');
  const parsed = AppleSignInInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  let identity;
  try {
    identity = await verifyAppleIdentityToken(parsed.data.identityToken, { audience });
  } catch (err) {
    return c.json({ error: 'invalid_apple_token', message: String(err) }, 401);
  }

  const result = await linkAppleIdentity(getDb(c.env.DB), user.id, identity.sub);
  if (!result.ok) return c.json({ error: result.error }, 409);
  return c.json({ ok: true, status: result.status });
});

/** Unlink a login method (can't remove the last one — that would orphan you). */
authRoutes.delete('/identities/:id', authMiddleware, async (c) => {
  const user = c.get('user');
  const result = await unlinkIdentity(getDb(c.env.DB), user.id, c.req.param('id'));
  if (result === 'not_found') return c.json({ error: 'identity_not_found' }, 404);
  if (result === 'last_identity') return c.json({ error: 'last_identity' }, 409);
  return c.json({ ok: true });
});
