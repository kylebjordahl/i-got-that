import { getDb } from '@igt/db';
import { MagicLinkRequestInput, MagicLinkVerifyInput } from '@igt/domain';
import { Hono } from 'hono';
import type { HonoEnv } from '../env.js';
import { getMailer } from '../lib/mailer.js';
import { requestMagicLink, verifyMagicLink } from '../services/auth.js';

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
