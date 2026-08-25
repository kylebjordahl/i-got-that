import type { Bindings } from '../env.js';

/**
 * SSRF guard for the one class of outbound request this Worker makes on a
 * user's behalf: fetching a URL the user supplied (an ICS feed, a CalDAV
 * server/collection URL). Those strings reach `fetch()` verbatim, and the
 * fetched bytes come back to the caller — parsed into `source_events`, or
 * returned as a discovered-collection list — so an unvalidated URL is a
 * readable proxy into whatever the Worker's egress can reach.
 *
 * The policy is default-deny by host: only public destinations over https are
 * allowed. `assertSafeOutboundUrl` runs twice — once at write time in the
 * create/update handlers (so a bad URL never lands in a row) and again inside
 * `createGuardedFetch` immediately before every request, because rows written
 * before this existed still have to be re-checked, and because DNS can change
 * (or a redirect can point) between the two.
 */

/** Rejection from the outbound-URL policy. `reason` is a short stable code. */
export class UnsafeOutboundUrlError extends Error {
  constructor(
    readonly reason: string,
    /** The offending URL, with any embedded credentials already stripped. */
    readonly url: string,
  ) {
    super(`unsafe outbound url (${reason}): ${url}`);
    this.name = 'UnsafeOutboundUrlError';
  }
}

/** Non-policy failure of a guarded fetch (redirect loop, oversized body). */
export class OutboundFetchError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'OutboundFetchError';
  }
}

export interface OutboundUrlPolicy {
  /** `http:` is only ever allowed in local development. */
  allowHttp: boolean;
  /**
   * Explicit escape hatch (`OUTBOUND_ALLOWED_HOSTS`), as lowercase `host` or
   * `host:port` entries. A match bypasses the host-range and port checks —
   * that's how a self-hosted CalDAV server on an odd port, or a local ICS
   * fixture during development, stays reachable without widening the default.
   */
  allowedHosts: ReadonlySet<string>;
}

/** Ports a user-supplied URL may target without being explicitly allowlisted. */
const DEFAULT_ALLOWED_PORTS = new Set(['', '80', '443']);

/** Hostname suffixes that only ever resolve inside a private network. */
const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];
const BLOCKED_HOSTNAMES = new Set(['localhost', 'local', 'internal']);

export function outboundPolicy(env: Pick<Bindings, 'ENVIRONMENT' | 'OUTBOUND_ALLOWED_HOSTS'>): OutboundUrlPolicy {
  return {
    allowHttp: env.ENVIRONMENT === 'development',
    allowedHosts: new Set(
      (env.OUTBOUND_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0),
    ),
  };
}

/**
 * Parse + vet a user-supplied URL. Returns the parsed `URL` (callers should
 * fetch *that*, not the raw string, so what was vetted is what gets sent).
 * Throws `UnsafeOutboundUrlError` otherwise.
 */
export function assertSafeOutboundUrl(raw: string, policy: OutboundUrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeOutboundUrlError('unparseable', raw);
  }

  // Credentials in the URL would be sent to whatever host we end up at, and
  // they'd also survive into logs — there's no legitimate use here.
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
    throw new UnsafeOutboundUrlError('credentials_in_url', url.href);
  }

  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new UnsafeOutboundUrlError('scheme_not_allowed', url.href);
  }

  const hostname = url.hostname.toLowerCase();
  // `host` carries the port when there is one, which is exactly the
  // granularity the allowlist wants; also accept a bare-host entry.
  if (policy.allowedHosts.has(url.host.toLowerCase()) || policy.allowedHosts.has(hostname)) {
    return url;
  }

  // Host before port: for a blocked destination, *which* range it fell in is
  // the useful signal, and "wrong port" would mask it.
  const reason = blockedHostReason(hostname);
  if (reason) throw new UnsafeOutboundUrlError(reason, url.href);

  if (!DEFAULT_ALLOWED_PORTS.has(url.port)) {
    throw new UnsafeOutboundUrlError('port_not_allowed', url.href);
  }

  return url;
}

/**
 * Why this hostname may not be fetched, or null if it looks public. The URL
 * parser has already normalized IP literals for us (`http://2130706433/` and
 * `http://0x7f.1/` both arrive here as `127.0.0.1`), so the dotted-quad and
 * bracketed-IPv6 forms are the only shapes that need range checks.
 */
function blockedHostReason(hostname: string): string | null {
  if (hostname.length === 0) return 'empty_host';

  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const words = parseIpv6(hostname.slice(1, -1));
    if (!words) return 'unparseable_ipv6';
    return blockedIpv6Reason(words);
  }

  const v4 = parseIpv4(hostname);
  if (v4) return blockedIpv4Reason(v4);

  if (BLOCKED_HOSTNAMES.has(hostname)) return 'internal_hostname';
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return 'internal_hostname';
  }
  // A dotless name can only resolve through a search domain — i.e. it is by
  // construction an intranet name (`http://admin/`), never a public host.
  if (!hostname.includes('.')) return 'internal_hostname';

  return null;
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** Everything outside globally-routable unicast space. */
function blockedIpv4Reason([a, b, c]: number[]): string | null {
  if (a === 0) return 'ipv4_this_network'; // 0.0.0.0/8
  if (a === 127) return 'ipv4_loopback';
  if (a === 10) return 'ipv4_private';
  if (a === 172 && b! >= 16 && b! <= 31) return 'ipv4_private';
  if (a === 192 && b === 168) return 'ipv4_private';
  if (a === 169 && b === 254) return 'ipv4_link_local'; // incl. 169.254.169.254
  if (a === 100 && b! >= 64 && b! <= 127) return 'ipv4_cgnat'; // incl. 100.100.100.200
  if (a === 192 && b === 0 && c === 0) return 'ipv4_reserved'; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'ipv4_reserved'; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return 'ipv4_reserved'; // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'ipv4_reserved'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'ipv4_reserved'; // TEST-NET-3
  if (a! >= 224) return 'ipv4_reserved'; // multicast, reserved, broadcast
  return null;
}

/** Expand an IPv6 literal (`::` compression + trailing dotted-quad) to 8 words. */
function parseIpv6(literal: string): number[] | null {
  // A zone id (`fe80::1%eth0`) is never routable off-box anyway.
  if (literal.includes('%')) return null;
  const halves = literal.split('::');
  if (halves.length > 2) return null;

  const expand = (chunk: string): number[] | null => {
    if (chunk.length === 0) return [];
    const words: number[] = [];
    const parts = chunk.split(':');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      // A trailing dotted-quad (`::ffff:127.0.0.1`) occupies the last two words.
      if (part.includes('.')) {
        if (i !== parts.length - 1) return null;
        const v4 = parseIpv4(part);
        if (!v4) return null;
        words.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      words.push(Number.parseInt(part, 16));
    }
    return words;
  };

  const head = expand(halves[0]!);
  const tail = halves.length === 2 ? expand(halves[1]!) : [];
  if (!head || !tail) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

function blockedIpv6Reason(w: number[]): string | null {
  const isZeroPrefix = (n: number) => w.slice(0, n).every((x) => x === 0);

  if (w.every((x) => x === 0)) return 'ipv6_unspecified';
  if (isZeroPrefix(7) && w[7] === 1) return 'ipv6_loopback';
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d):
  // the reachable address is the embedded v4 one, so judge it as such.
  if (isZeroPrefix(5) && w[5] === 0xffff) return embeddedIpv4Reason(w[6]!, w[7]!) ?? null;
  if (isZeroPrefix(6)) return embeddedIpv4Reason(w[6]!, w[7]!) ?? 'ipv6_reserved';
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) both wrap a v4 destination.
  if (w[0] === 0x0064 && w[1] === 0xff9b) return embeddedIpv4Reason(w[6]!, w[7]!) ?? null;
  if (w[0] === 0x2002) return embeddedIpv4Reason(w[1]!, w[2]!) ?? null;
  if ((w[0]! & 0xfe00) === 0xfc00) return 'ipv6_unique_local'; // fc00::/7, incl. fd00:ec2::254
  if ((w[0]! & 0xffc0) === 0xfe80) return 'ipv6_link_local';
  if ((w[0]! & 0xff00) === 0xff00) return 'ipv6_multicast';
  if (w[0] === 0x0100 && isZeroPrefix(1)) return 'ipv6_reserved'; // 100::/64 discard-only
  return null;
}

function embeddedIpv4Reason(hi: number, lo: number): string | null {
  return blockedIpv4Reason([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
}

// --- Guarded fetch -------------------------------------------------------

/** Wall-clock budget for one user-URL fetch, redirects included. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Hard ceiling on a fetched body — an ICS feed or CalDAV REPORT is orders below this. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Redirect hops followed before giving up (each one is re-vetted). */
const MAX_REDIRECTS = 3;

/**
 * Keep every outbound hop out of Cloudflare's cache.
 *
 * A Worker's `fetch()` is not a bare socket: a cacheable GET is served from
 * Cloudflare's cache, honouring whatever `Cache-Control` the origin sent. Calendar
 * publishers routinely send hours of `max-age` on their `.ics`, and the entry
 * even answers our conditional `If-None-Match` — so an event added to the source
 * calendar last night could stay invisible all morning no matter how many times
 * someone pressed "Refresh feeds". Everything the guard fronts is live user data
 * being read or written (ICS feeds, CalDAV REPORT/PUT/DELETE, calendar APIs);
 * none of it is ever correct to serve from a cache, so the bypass is unconditional
 * rather than a per-caller flag. Freshness on the *feed's* side is still the
 * stored ETag's job — see `ingest.ts` — this only stops our own layer from
 * answering before the request gets out.
 */
const NO_STORE = { cache: 'no-store' } as const;

/**
 * `RequestInit` plus the standard `cache` member: workerd implements it
 * (`no-store` / `no-cache`), but `@cloudflare/workers-types` doesn't declare it
 * on its own `RequestInit`.
 */
interface CacheableRequestInit extends RequestInit {
  cache?: 'no-store' | 'no-cache';
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Statuses whose `Response` may not carry a body (constructing one throws). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export interface GuardedFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** The underlying fetch; injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * A `fetch` that enforces the outbound policy on every hop. Injected as the
 * `fetchImpl` of ingest / read-back / CalDAV delivery, so the libs keep making
 * ordinary `fetch` calls and the guard lives in one place:
 *
 * - the target is re-vetted before each request (stored rows predate the check,
 *   and DNS can be rebound after a write-time validation);
 * - redirects are followed manually (`redirect: 'manual'`), so a public host
 *   can't 302 us onto `169.254.169.254`;
 * - `authorization` is dropped when a redirect crosses origins, so the CalDAV
 *   basic credential doesn't follow the user's URL to a third party;
 * - the request is time-bounded and the response body is size-capped, so a
 *   hostile-but-permitted target can't hang or OOM the Worker;
 * - every hop is `cache: 'no-store'` (see `NO_STORE` below).
 */
export function createGuardedFetch(
  env: Pick<Bindings, 'ENVIRONMENT' | 'OUTBOUND_ALLOWED_HOSTS'>,
  opts: GuardedFetchOptions = {},
): typeof fetch {
  const policy = outboundPolicy(env);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const baseFetch = opts.fetchImpl ?? fetch.bind(globalThis);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let { url, init: current } = await normalizeRequest(input, init);
    // One deadline for the whole chain — a redirect loop can't extend it.
    const signal = current.signal ?? AbortSignal.timeout(timeoutMs);

    for (let hop = 0; ; hop++) {
      const target = assertSafeOutboundUrl(url, policy);
      const init: CacheableRequestInit = {
        ...current,
        ...NO_STORE,
        signal,
        redirect: 'manual',
      };
      const res = await baseFetch(target.href, init);

      const location = res.headers.get('location');
      if (!REDIRECT_STATUSES.has(res.status) || !location) {
        return capBody(res, maxBytes);
      }
      if (hop >= MAX_REDIRECTS) {
        throw new OutboundFetchError(
          'too_many_redirects',
          `outbound fetch exceeded ${MAX_REDIRECTS} redirects: ${target.href}`,
        );
      }

      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new UnsafeOutboundUrlError('unparseable_redirect', location);
      }
      current = followRedirect(current, res.status, target, next);
      url = next.href;
    }
  };
}

/**
 * Flatten the fetch arguments into a re-issuable (url, init) pair. A `Request`
 * body has to be buffered up front because a redirect means sending it twice.
 */
async function normalizeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ url: string; init: RequestInit }> {
  if (typeof input === 'string') return { url: input, init: { ...init } };
  if (input instanceof URL) return { url: input.href, init: { ...init } };

  const hasBody = input.method !== 'GET' && input.method !== 'HEAD' && input.body !== null;
  return {
    url: input.url,
    init: {
      method: input.method,
      headers: new Headers(input.headers),
      ...(hasBody ? { body: await input.arrayBuffer() } : {}),
      ...init,
    },
  };
}

/**
 * The next hop's init: browser redirect semantics (303, and 301/302 on POST,
 * degrade to a bodyless GET; 307/308 replay as-is) plus a credential guard —
 * `authorization` is scoped to the origin it was minted for.
 */
function followRedirect(
  current: RequestInit,
  status: number,
  from: URL,
  to: URL,
): RequestInit {
  const next: RequestInit = { ...current };
  const method = (current.method ?? 'GET').toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    next.method = 'GET';
    next.body = undefined;
  }
  if (to.origin !== from.origin) {
    const headers = new Headers(current.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    next.headers = headers;
  }
  return next;
}

/**
 * Re-wrap the response so reading its body can't exceed `maxBytes` — the
 * callers hand it straight to `parseAndExpand`, which means an unbounded
 * `res.text()` on a hostile target would buffer the whole thing first.
 */
function capBody(res: Response, maxBytes: number): Response {
  if (!res.body || NULL_BODY_STATUSES.has(res.status)) return res;

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OutboundFetchError(
      'response_too_large',
      `outbound response declared ${declared} bytes (max ${maxBytes})`,
    );
  }

  let seen = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(
          new OutboundFetchError(
            'response_too_large',
            `outbound response exceeded ${maxBytes} bytes`,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  return new Response(res.body.pipeThrough(limiter), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}
