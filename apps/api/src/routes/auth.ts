import { getDb } from '@igt/db';
import {
  AppleSignInInput,
  MagicLinkRequestInput,
  MagicLinkVerifyInput,
} from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { verifyAppleIdentityToken } from '../lib/apple.js';
import { getMailer } from '../lib/mailer.js';
import {
  createSession,
  findOrCreateUserByApple,
  requestMagicLink,
  verifyMagicLink,
} from '../services/auth.js';

export const authRoutes = new Hono<HonoEnv>();

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

/**
 * Sign in with Apple. The client (iOS native / web Services ID) obtains an
 * identity token from Apple and posts it here; we verify it against Apple's
 * JWKS and the configured audience(s), then issue a session. Works without
 * outbound email, so it's the primary login for deployed environments.
 */
authRoutes.post('/apple', async (c) => {
  const audience = (c.env.APPLE_CLIENT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
  const sessionToken = await createSession(db, user.id);
  return c.json({
    sessionToken,
    user: { id: user.id, username: user.username, displayName: user.displayName },
  });
});

authRoutes.post('/magic-link/verify', async (c) => {
  const parsed = MagicLinkVerifyInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid' }, 400);

  const result = await verifyMagicLink(getDb(c.env.DB), parsed.data.token);
  if (!result) return c.json({ error: 'invalid_token' }, 401);

  return c.json({
    sessionToken: result.sessionToken,
    user: {
      id: result.user.id,
      username: result.user.username,
      displayName: result.user.displayName,
    },
  });
});
