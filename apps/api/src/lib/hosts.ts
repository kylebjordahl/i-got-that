import type { Bindings } from '../env.js';

/**
 * Which of the deployment's faces a request's host gets:
 *   app   — PUBLIC_ORIGIN: the API under /api, the web client at the root
 *   site  — SITE_ORIGIN: the public homepage + legal pages
 *   alias — any other host routed here (the legacy `igt.kylebjordahl.com`, the
 *           `igt.fyi` apex): /api for app builds that still point at it, and a
 *           301 to the app or the site for everything else
 * With PUBLIC_ORIGIN unset (local dev / tests) every host is the app host.
 */
export type HostRole = 'app' | 'site' | 'alias';

export function hostRole(host: string, env: Pick<Bindings, 'PUBLIC_ORIGIN' | 'SITE_ORIGIN'>): HostRole {
  if (!env.PUBLIC_ORIGIN || host === new URL(env.PUBLIC_ORIGIN).host) return 'app';
  if (env.SITE_ORIGIN && host === new URL(env.SITE_ORIGIN).host) return 'site';
  return 'alias';
}

/**
 * Where a link into the app (invite, magic link) should point, ending in `/` so
 * the caller appends `#invite=…`. Normally the web client at the root of
 * PUBLIC_ORIGIN. A request that came in on an alias host is from an app build
 * that predates the domain move, and that build only claims the alias host's
 * `/app/*` for Universal Links — a link to the new host would open in Safari
 * and spend a single-use token there. So the link stays on the alias host's
 * `/app/`; in a browser that 301s to the app host with the fragment intact.
 * Null when PUBLIC_ORIGIN is unset (local dev / tests).
 */
export function appLinkBase(
  env: Pick<Bindings, 'PUBLIC_ORIGIN' | 'SITE_ORIGIN'>,
  requestUrl: string,
): string | null {
  if (!env.PUBLIC_ORIGIN) return null;
  const url = new URL(requestUrl);
  if (hostRole(url.host, env) === 'alias') return `${url.origin}/app/`;
  return `${env.PUBLIC_ORIGIN.replace(/\/$/, '')}/`;
}
