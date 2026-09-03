import { createMiddleware } from 'hono/factory';
import type { HonoEnv } from '../env.js';
import { sha256hex } from '../lib/crypto.js';

/**
 * Gate for the cross-tenant `/ops` dashboard. Deliberately separate from
 * `authMiddleware`/`requireAdmin`: those check membership of one family,
 * this reads aggregates across every family, so it can't reuse the family
 * admin role. A single shared operator password (HTTP Basic, username
 * ignored) is the whole model — good enough for one operator, not meant to
 * grow into a real role system.
 *
 * `OPS_DASHBOARD_PASSWORD` unset ⇒ no candidate can match ⇒ always 401
 * (fails closed rather than needing its own "not configured" branch).
 */
export const opsAuthMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const unauthorized = () =>
    c.text('unauthorized', 401, { 'WWW-Authenticate': 'Basic realm="ops"' });

  const expected = c.env.OPS_DASHBOARD_PASSWORD;
  if (!expected) return unauthorized();

  const header = c.req.header('Authorization');
  if (!header?.startsWith('Basic ')) return unauthorized();

  let password: string;
  try {
    const decoded = atob(header.slice('Basic '.length));
    password = decoded.slice(decoded.indexOf(':') + 1);
  } catch {
    return unauthorized();
  }

  // Compare digests rather than the raw strings so a mismatch's timing
  // doesn't leak how many leading characters were right.
  if ((await sha256hex(password)) !== (await sha256hex(expected))) {
    return unauthorized();
  }

  await next();
});
