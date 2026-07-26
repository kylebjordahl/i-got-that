import { env } from 'cloudflare:test';
import { feeds, getDb, sourceEvents } from '@igt/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  assertSafeOutboundUrl,
  createGuardedFetch,
  outboundPolicy,
  OutboundFetchError,
  UnsafeOutboundUrlError,
} from '../src/lib/outbound-url.js';
import { ingestFeed } from '../src/services/ingest.js';
import { authed, call, createFamily, login, put } from './helpers.js';

/** The test worker runs as `development`, so http:// is permitted there. */
const DEV = outboundPolicy({ ENVIRONMENT: 'development' });
const PROD = outboundPolicy({ ENVIRONMENT: 'production' });

/** The policy code a rejected URL produced, or null if it was allowed. */
function reasonFor(url: string, policy = DEV): string | null {
  try {
    assertSafeOutboundUrl(url, policy);
    return null;
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) return err.reason;
    throw err;
  }
}

describe('assertSafeOutboundUrl', () => {
  it('allows ordinary public https URLs', () => {
    expect(reasonFor('https://feed.example.com/cal.ics')).toBeNull();
    expect(reasonFor('https://caldav.icloud.com/123/calendars/kid/')).toBeNull();
    expect(reasonFor('https://feed.example.com:443/cal.ics')).toBeNull();
    // A public IP literal is fine — it's the *ranges* that are blocked.
    expect(reasonFor('https://93.184.216.34/cal.ics')).toBeNull();
  });

  it('requires https outside development', () => {
    expect(reasonFor('http://feed.example.com/cal.ics', PROD)).toBe('scheme_not_allowed');
    expect(reasonFor('http://feed.example.com/cal.ics', DEV)).toBeNull();
    // Non-http(s) schemes are never allowed, development included.
    expect(reasonFor('file:///etc/passwd')).toBe('scheme_not_allowed');
    expect(reasonFor('ftp://feed.example.com/cal.ics')).toBe('scheme_not_allowed');
    expect(reasonFor('data:text/calendar,BEGIN:VCALENDAR')).toBe('scheme_not_allowed');
  });

  it('rejects credentials embedded in the URL', () => {
    expect(reasonFor('https://user:pass@feed.example.com/cal.ics')).toBe('credentials_in_url');
  });

  it('never reflects an embedded credential back in the error', () => {
    try {
      assertSafeOutboundUrl('https://user:hunter2@feed.example.com/cal.ics', DEV);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeOutboundUrlError);
      expect((err as UnsafeOutboundUrlError).url).not.toContain('hunter2');
      expect((err as Error).message).not.toContain('hunter2');
    }
  });

  it('rejects loopback, private, link-local and CGNAT IPv4 literals', () => {
    expect(reasonFor('http://127.0.0.1:8787/')).toBe('ipv4_loopback');
    expect(reasonFor('http://169.254.169.254/latest/meta-data/')).toBe('ipv4_link_local');
    expect(reasonFor('https://10.0.0.5/cal.ics')).toBe('ipv4_private');
    expect(reasonFor('https://172.16.3.9/cal.ics')).toBe('ipv4_private');
    expect(reasonFor('https://172.32.3.9/cal.ics')).toBeNull(); // just outside 172.16/12
    expect(reasonFor('https://192.168.1.1/cal.ics')).toBe('ipv4_private');
    expect(reasonFor('https://100.100.100.200/')).toBe('ipv4_cgnat');
    expect(reasonFor('https://0.0.0.0/')).toBe('ipv4_this_network');
    expect(reasonFor('https://255.255.255.255/')).toBe('ipv4_reserved');
    expect(reasonFor('https://239.1.2.3/')).toBe('ipv4_reserved');
  });

  it('sees through obfuscated IPv4 spellings', () => {
    // The URL parser normalizes these to 127.0.0.1 before we ever look.
    expect(reasonFor('http://2130706433/')).toBe('ipv4_loopback');
    expect(reasonFor('http://0x7f.0x0.0x0.0x1/')).toBe('ipv4_loopback');
    expect(reasonFor('http://127.1/')).toBe('ipv4_loopback');
  });

  it('rejects loopback, unique-local and link-local IPv6 literals', () => {
    expect(reasonFor('http://[::1]:8787/')).toBe('ipv6_loopback');
    expect(reasonFor('https://[::]/')).toBe('ipv6_unspecified');
    expect(reasonFor('https://[fd00:ec2::254]/latest/meta-data/')).toBe('ipv6_unique_local');
    expect(reasonFor('https://[fe80::1]/')).toBe('ipv6_link_local');
    expect(reasonFor('https://[ff02::1]/')).toBe('ipv6_multicast');
    // A globally-routable v6 address is fine.
    expect(reasonFor('https://[2606:2800:220:1:248:1893:25c8:1946]/cal.ics')).toBeNull();
  });

  it('judges an IPv6-wrapped IPv4 destination by the address inside', () => {
    expect(reasonFor('https://[::ffff:127.0.0.1]/')).toBe('ipv4_loopback');
    expect(reasonFor('https://[::ffff:169.254.169.254]/')).toBe('ipv4_link_local');
    expect(reasonFor('https://[64:ff9b::a00:5]/')).toBe('ipv4_private'); // NAT64 of 10.0.0.5
    expect(reasonFor('https://[2002:7f00:1::]/')).toBe('ipv4_loopback'); // 6to4 of 127.0.0.1
    expect(reasonFor('https://[::ffff:93.184.216.34]/')).toBeNull();
  });

  it('rejects internal DNS names', () => {
    expect(reasonFor('http://localhost:8787/')).toBe('internal_hostname');
    expect(reasonFor('https://metadata.google.internal/computeMetadata/v1/')).toBe('internal_hostname');
    expect(reasonFor('https://nas.local/cal.ics')).toBe('internal_hostname');
    expect(reasonFor('https://router.home.arpa/')).toBe('internal_hostname');
    // Dotless names only resolve via a search domain — i.e. intranet-only.
    expect(reasonFor('https://intranet/cal.ics')).toBe('internal_hostname');
  });

  it('rejects ports outside 80/443', () => {
    expect(reasonFor('https://feed.example.com:8787/cal.ics')).toBe('port_not_allowed');
    expect(reasonFor('https://feed.example.com:5232/cal.ics')).toBe('port_not_allowed');
    expect(reasonFor('http://feed.example.com:80/cal.ics')).toBeNull();
  });

  it('honours the OUTBOUND_ALLOWED_HOSTS escape hatch', () => {
    const policy = outboundPolicy({
      ENVIRONMENT: 'development',
      OUTBOUND_ALLOWED_HOSTS: 'dav.internal.example:5232, 127.0.0.1:8080',
    });
    expect(reasonFor('https://dav.internal.example:5232/cal/', policy)).toBeNull();
    expect(reasonFor('http://127.0.0.1:8080/cal.ics', policy)).toBeNull();
    // The entry is host+port specific — a different port is still rejected.
    expect(reasonFor('http://127.0.0.1:9090/cal.ics', policy)).toBe('ipv4_loopback');
  });
});

describe('createGuardedFetch', () => {
  /** A fetch stub that answers from a url → Response map and records calls. */
  function stub(routes: Record<string, () => Response>) {
    const seen: { url: string; init?: RequestInit }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, init });
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch: ${url}`);
      return route();
    }) as unknown as typeof fetch;
    return { impl, seen };
  }

  function redirect(to: string, status = 302): Response {
    return new Response(null, { status, headers: { location: to } });
  }

  it('rejects a request to a blocked host before it reaches the network', async () => {
    const { impl, seen } = stub({});
    const guarded = createGuardedFetch(env, { fetchImpl: impl });
    await expect(guarded('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      UnsafeOutboundUrlError,
    );
    expect(seen).toHaveLength(0);
  });

  it('follows a safe redirect and re-vets each hop', async () => {
    const { impl, seen } = stub({
      'https://feed.example.com/cal.ics': () => redirect('https://cdn.example.com/cal.ics'),
      'https://cdn.example.com/cal.ics': () => new Response('BEGIN:VCALENDAR'),
    });
    const guarded = createGuardedFetch(env, { fetchImpl: impl });
    const res = await guarded('https://feed.example.com/cal.ics');
    expect(await res.text()).toBe('BEGIN:VCALENDAR');
    expect(seen.map((s) => s.url)).toEqual([
      'https://feed.example.com/cal.ics',
      'https://cdn.example.com/cal.ics',
    ]);
    // Redirects are followed by us, not by the runtime.
    expect(seen[0]!.init?.redirect).toBe('manual');
  });

  it('rejects a public host that redirects to a private address', async () => {
    const { impl, seen } = stub({
      'https://feed.example.com/cal.ics': () => redirect('http://169.254.169.254/latest/meta-data/'),
    });
    const guarded = createGuardedFetch(env, { fetchImpl: impl });
    await expect(guarded('https://feed.example.com/cal.ics')).rejects.toThrow(
      UnsafeOutboundUrlError,
    );
    expect(seen.map((s) => s.url)).toEqual(['https://feed.example.com/cal.ics']);
  });

  it('resolves a relative Location against the hop it came from', async () => {
    const { impl, seen } = stub({
      'https://feed.example.com/a/cal.ics': () => redirect('../b/cal.ics'),
      'https://feed.example.com/b/cal.ics': () => new Response('ok'),
    });
    const guarded = createGuardedFetch(env, { fetchImpl: impl });
    expect(await (await guarded('https://feed.example.com/a/cal.ics')).text()).toBe('ok');
    expect(seen[1]!.url).toBe('https://feed.example.com/b/cal.ics');
  });

  it('drops the credential when a redirect crosses origins', async () => {
    const { impl, seen } = stub({
      'https://dav.example.com/cal/': () => redirect('https://evil.example.com/cal/'),
      'https://evil.example.com/cal/': () => new Response('ok'),
    });
    const guarded = createGuardedFetch(env, { fetchImpl: impl });
    await guarded('https://dav.example.com/cal/', {
      headers: { authorization: 'Basic c2VjcmV0' },
    });
    expect(new Headers(seen[0]!.init!.headers).get('authorization')).toBe('Basic c2VjcmV0');
    expect(new Headers(seen[1]!.init!.headers).get('authorization')).toBeNull();
  });

  it('keeps the credential on a same-origin redirect', async () => {
    const { impl, seen } = stub({
      'https://dav.example.com/cal': () => redirect('https://dav.example.com/cal/'),
      'https://dav.example.com/cal/': () => new Response('ok'),
    });
    const guarded = createGuardedFetch(env, { fetchImpl: impl });
    await guarded('https://dav.example.com/cal', {
      headers: { authorization: 'Basic c2VjcmV0' },
    });
    expect(new Headers(seen[1]!.init!.headers).get('authorization')).toBe('Basic c2VjcmV0');
  });

  it('gives up on a redirect chain rather than following it forever', async () => {
    const { impl, seen } = stub({
      'https://feed.example.com/cal.ics': () => redirect('https://feed.example.com/cal.ics'),
    });
    const guarded = createGuardedFetch(env, { fetchImpl: impl });
    await expect(guarded('https://feed.example.com/cal.ics')).rejects.toThrow(OutboundFetchError);
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  it('caps an oversized response body', async () => {
    const { impl } = stub({
      'https://feed.example.com/huge.ics': () => new Response('x'.repeat(4096)),
    });
    const guarded = createGuardedFetch(env, { fetchImpl: impl, maxBytes: 1024 });
    const res = await guarded('https://feed.example.com/huge.ics');
    await expect(res.text()).rejects.toThrow();
  });

  it('passes a body-less 304 through untouched', async () => {
    const { impl } = stub({
      'https://feed.example.com/cal.ics': () =>
        new Response(null, { status: 304, headers: { etag: 'W/"v1"' } }),
    });
    const guarded = createGuardedFetch(env, { fetchImpl: impl });
    const res = await guarded('https://feed.example.com/cal.ics');
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe('W/"v1"');
  });
});

describe('feed + account creation reject unsafe URLs', () => {
  const UNSAFE = [
    'http://127.0.0.1:8787/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8787/cal.ics',
    'https://metadata.google.internal/computeMetadata/v1/',
  ];

  it('rejects an ICS feed pointed at an internal address', async () => {
    const admin = await login('ssrf-feed@example.com');
    const familyId = await createFamily(admin.token, 'SSRF Feed Fam');

    for (const url of UNSAFE) {
      const res = await call(
        `/families/${familyId}/feeds`,
        authed(admin.token, { url, mode: 'standard' }),
      );
      expect(res.status, url).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: 'unsafe_url',
        path: 'url',
      });
    }

    // Nothing was stored, so cron can't pick it up later either.
    const db = getDb(env.DB);
    expect(await db.select().from(feeds).where(eq(feeds.familyId, familyId))).toHaveLength(0);
  });

  it('rejects a CalDAV account pointed at an internal address', async () => {
    const user = await login('ssrf-account@example.com');
    for (const serverUrl of UNSAFE) {
      const res = await call(
        '/accounts',
        authed(user.token, {
          kind: 'caldav',
          name: 'Sneaky',
          serverUrl,
          username: 'u',
          password: 'p',
        }),
      );
      expect(res.status, serverUrl).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({
        error: 'unsafe_url',
        path: 'serverUrl',
      });
    }
  });

  it('rejects a CalDAV feed whose collection URL is internal', async () => {
    const user = await login('ssrf-collection@example.com');
    const familyId = await createFamily(user.token, 'SSRF Collection Fam');
    const created = await call(
      '/accounts',
      authed(user.token, {
        kind: 'caldav',
        name: 'Real CalDAV',
        serverUrl: 'https://dav.example.com',
        username: 'u',
        password: 'p',
      }),
    );
    const { account } = (await created.json()) as { account: { id: string } };

    const res = await call(
      `/families/${familyId}/feeds`,
      authed(user.token, {
        kind: 'caldav',
        externalAccountId: account.id,
        sourceCalendarId: 'http://169.254.169.254/latest/meta-data/',
        mode: 'standard',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'unsafe_url',
      path: 'sourceCalendarId',
    });

    // A non-URL collection id doesn't get to sneak past as a plain string.
    const notAUrl = await call(
      `/families/${familyId}/feeds`,
      authed(user.token, {
        kind: 'caldav',
        externalAccountId: account.id,
        sourceCalendarId: 'not-a-url',
        mode: 'standard',
      }),
    );
    expect(notAUrl.status).toBe(400);
    expect(((await notAUrl.json()) as { error: string }).error).toBe('invalid');
  });

  it("rejects a member's CalDAV mirror target pointed at an internal address", async () => {
    const user = await login('ssrf-target@example.com');
    const famRes = await call('/families', authed(user.token, { name: 'SSRF Target Fam' }));
    const { family, member } = (await famRes.json()) as {
      family: { id: string };
      member: { id: string };
    };
    const created = await call(
      '/accounts',
      authed(user.token, {
        kind: 'caldav',
        name: 'Real CalDAV',
        serverUrl: 'https://dav.example.com',
        username: 'u',
        password: 'p',
      }),
    );
    const { account } = (await created.json()) as { account: { id: string } };

    const res = await call(
      `/families/${family.id}/members/${member.id}/calendar-target`,
      put(user.token, {
        externalAccountId: account.id,
        targetCalendarId: 'http://127.0.0.1:8787/calendars/kid/',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'unsafe_url',
      path: 'targetCalendarId',
    });
  });
});

describe('ingest re-checks stored feed URLs', () => {
  /**
   * Rows written before the outbound policy existed were never validated, and
   * a URL that passed at write time can still redirect somewhere private — so
   * the guard has to run again at fetch time, and a rejection has to leave the
   * feed 'error' rather than being retried on every tick.
   */
  it('refuses a stored feed URL that now points at an internal address', async () => {
    const user = await login('ssrf-stored@example.com');
    const familyId = await createFamily(user.token, 'SSRF Stored Fam');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({ familyId, kind: 'ics', url: 'http://169.254.169.254/latest/meta-data/', mode: 'standard' })
        .returning()
    )[0]!;

    const fetchImpl = createGuardedFetch(env, {
      fetchImpl: (async () => {
        throw new Error('the guard should have refused before reaching the network');
      }) as unknown as typeof fetch,
    });
    await expect(ingestFeed(db, feed, { fetchImpl })).rejects.toThrow(UnsafeOutboundUrlError);

    const after = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    expect(after.status).toBe('error');
    expect(await db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id))).toHaveLength(0);
  });

  it('refuses a stored feed URL that 302s to an internal address', async () => {
    const user = await login('ssrf-redirect@example.com');
    const familyId = await createFamily(user.token, 'SSRF Redirect Fam');
    const db = getDb(env.DB);
    const feed = (
      await db
        .insert(feeds)
        .values({ familyId, kind: 'ics', url: 'https://feed.example.com/cal.ics', mode: 'standard' })
        .returning()
    )[0]!;

    const fetchImpl = createGuardedFetch(env, {
      fetchImpl: (async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        })) as unknown as typeof fetch,
    });
    await expect(ingestFeed(db, feed, { fetchImpl })).rejects.toThrow(UnsafeOutboundUrlError);

    const after = (await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1))[0]!;
    expect(after.status).toBe('error');
    expect(await db.select().from(sourceEvents).where(eq(sourceEvents.feedId, feed.id))).toHaveLength(0);
  });
});
