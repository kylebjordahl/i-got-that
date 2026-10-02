import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { routePath } from 'hono/route';
import type { HonoEnv } from '../env.js';
import { bearerToken, SESSION_COOKIE } from '../lib/session-cookie.js';

export type ClientKind = 'web' | 'native' | 'other';

/**
 * Which client made the request. The bearer header can't be the discriminator:
 * the Flutter web client holds the session token too and sends it alongside
 * its cookie, so "has a bearer" is true on both. Browsers, though, always
 * attach `Sec-Fetch-*` (forbidden headers — page JS can't set them) and the
 * web session cookie, while the native app has neither and identifies itself
 * with dart:io's default `Dart/<ver>` user-agent (or a bearer, once signed in).
 * That also classifies the signed-out login requests correctly.
 */
export function clientKind(c: Context<HonoEnv>): ClientKind {
  if (
    c.req.header('Sec-Fetch-Site') ||
    c.req.header('Sec-Fetch-Mode') ||
    getCookie(c, SESSION_COOKIE)
  ) {
    return 'web';
  }
  if (bearerToken(c) || c.req.header('User-Agent')?.startsWith('Dart/')) {
    return 'native';
  }
  return 'other';
}

// Probes and the operator dashboard itself would only add noise to the traffic charts.
const UNTRACKED = /^\/(health|ops)(\/|$)/;

// Analytics Engine caps an index at 96 bytes; route patterns are far shorter.
const MAX_INDEX_LENGTH = 96;

/**
 * Records one Analytics Engine data point per API request, for the `/ops`
 * traffic charts. Column layout (the queries in routes/ops.ts depend on it):
 *   index1  route pattern            blob1  route pattern
 *   blob2   HTTP method              blob3  client kind (web/native/other)
 *   blob4   status class (2xx…5xx)   double1 status   double2 duration ms
 *
 * The route is the matched *pattern* (`/families/:familyId/feeds`), never the
 * concrete path, so ids stay out of the dataset and cardinality stays bounded.
 * Unbound `ANALYTICS` (local dev, tests) ⇒ no-op; a telemetry failure must
 * never fail the request it describes.
 */
export const requestTelemetry = createMiddleware<HonoEnv>(async (c, next) => {
  const dataset = c.env.ANALYTICS;
  if (!dataset || UNTRACKED.test(c.req.path)) return next();

  const started = Date.now();
  await next();

  try {
    const status = c.res.status;
    const matched = routePath(c);
    // No handler claimed the request: only the catch-all middleware ran.
    const route = matched === '/*' || matched === '' ? 'unmatched' : matched;
    dataset.writeDataPoint({
      indexes: [route.slice(0, MAX_INDEX_LENGTH)],
      blobs: [route, c.req.method, clientKind(c), `${Math.floor(status / 100)}xx`],
      // Workers only advances its clock on I/O, so this is I/O wait, not CPU time.
      doubles: [status, Date.now() - started],
    });
  } catch (err) {
    console.error('request telemetry failed', err);
  }
});
