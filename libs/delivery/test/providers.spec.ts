import { describe, expect, it } from 'vitest';
import {
  CalDavProvider,
  EmailImipProvider,
  GoogleCalendarProvider,
  type DeliveryEvent,
  type DeliveryTarget,
} from '../src/index.js';

/**
 * In-memory CalDAV server facade — records every request and stores objects by
 * URL, so we can assert the exact outbound PUT/DELETE the provider makes without
 * a live iCloud account. Its `fetch` is injected into the provider.
 */
class FakeCalDavServer {
  readonly store = new Map<string, string>();
  readonly requests: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }[] = [];

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    this.requests.push({
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    if (method === 'PUT') {
      const existed = this.store.has(url);
      this.store.set(url, (init?.body as string) ?? '');
      return existed
        ? new Response(null, { status: 204 })
        : new Response('', { status: 201 });
    }
    if (method === 'DELETE') {
      if (!this.store.has(url)) return new Response('', { status: 404 });
      this.store.delete(url);
      return new Response(null, { status: 204 });
    }
    return new Response(this.store.get(url) ?? '', {
      status: this.store.has(url) ? 200 : 404,
    });
  };

  get last() {
    return this.requests[this.requests.length - 1]!;
  }
}

const event: DeliveryEvent = {
  uid: 'igt-task-1-target-1',
  sequence: 0,
  start: new Date('2026-03-10T17:00:00Z'),
  end: new Date('2026-03-10T17:30:00Z'),
  summary: 'Pickup — child',
  location: "Children's House",
};

/** Decode the base64 body of the MIME part whose Content-Type starts with `type`. */
function mimePart(mime: string, type: string): string {
  const at = mime.indexOf(`Content-Type: ${type}`);
  if (at < 0) throw new Error(`no ${type} part`);
  const body = mime.slice(mime.indexOf('\r\n\r\n', at) + 4).split('\r\n--')[0]!;
  const bin = atob(body.replace(/\r\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

/** The decoded Subject header of a captured mail. */
function subjectOf(mime: string): string {
  const raw = /^Subject: (.*)$/m.exec(mime)![1]!;
  const encoded = /^=\?UTF-8\?B\?(.*)\?=$/.exec(raw);
  if (!encoded) return raw;
  return new TextDecoder().decode(Uint8Array.from(atob(encoded[1]!), (ch) => ch.charCodeAt(0)));
}

describe('EmailImipProvider', () => {
  it('says what, when (in the event zone) and where, so duplicates are easy to spot', async () => {
    const sent: string[] = [];
    const provider = new EmailImipProvider(async (mime) => void sent.push(mime), 'noreply@igt.test');
    const detailed = {
      ...event,
      description: 'Bring the permission slip.',
      timezone: 'America/Denver',
    };
    await provider.upsert(detailed, { method: 'email', addressOrUrl: 'p@example.com' });
    await provider.cancel(detailed, { method: 'email', addressOrUrl: 'p@example.com' });

    // 17:00Z is 11:00 AM in Denver (MDT) on 2026-03-10.
    expect(subjectOf(sent[0]!)).toBe('Pickup — child — Tue, Mar 10, 11:00 AM');
    const text = mimePart(sent[0]!, 'text/plain');
    expect(text).toContain('When: Tue, Mar 10, 11:00 AM – 11:30 AM MDT');
    expect(text).toContain("Where: Children's House");
    expect(text).toContain('Bring the permission slip.');
    expect(subjectOf(sent[1]!)).toBe('Cancelled: Pickup — child — Tue, Mar 10, 11:00 AM');
    expect(mimePart(sent[1]!, 'text/plain')).toContain('When: Tue, Mar 10, 11:00 AM');
  });

  it('sends a METHOD:REQUEST iMIP message to the attendee', async () => {
    const sent: { mime: string; to: string }[] = [];
    const provider = new EmailImipProvider(
      async (mime, to) => void sent.push({ mime, to }),
      'noreply@igt.test',
    );

    const res = await provider.upsert(event, {
      method: 'email',
      addressOrUrl: 'parent@example.com',
    });

    expect(res.externalRef).toBe(event.uid);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('parent@example.com');
    const mime = sent[0]!.mime;
    expect(mime).toContain('To: parent@example.com');
    expect(mime).toContain('Content-Type: multipart/alternative;');
    expect(mime).toContain('Content-Type: text/calendar; method=REQUEST');
    const ics = mimePart(mime, 'text/calendar');
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('UID:igt-task-1-target-1');
    // The em dash survives: UTF-8 in a base64 body, RFC 2047 in the subject.
    expect(ics).toContain('SUMMARY:Pickup — child');
    expect(mime).toMatch(/^Subject: =\?UTF-8\?B\?.+\?=$/m);
    // RFC 5322 headers required by strict senders (Cloudflare Email Service).
    expect(mime).toMatch(/^Date: /m);
    expect(mime).toMatch(/^Message-ID: <.+@igt\.test>/m);
  });

  it("can't be made to inject headers by a feed-controlled summary", async () => {
    const sent: string[] = [];
    const provider = new EmailImipProvider(async (mime) => void sent.push(mime), 'noreply@igt.test');
    await provider.upsert(
      { ...event, summary: 'Soccer\r\nBcc: victim@example.com' },
      { method: 'email', addressOrUrl: 'parent@example.com' },
    );
    expect(sent[0]).not.toMatch(/^Bcc:/m);
    // The subject (now with an em-dashed date, so RFC 2047-encoded) is one line.
    expect(subjectOf(sent[0]!)).toMatch(/^Soccer Bcc: victim@example\.com — /);
  });

  it('refuses a recipient that is not a bare address', async () => {
    const provider = new EmailImipProvider(async () => {}, 'noreply@igt.test');
    await expect(
      provider.upsert(event, {
        method: 'email',
        addressOrUrl: 'a@example.com\r\nBcc: b@example.com',
      }),
    ).rejects.toThrow(/malformed address/);
  });
});

describe('GoogleCalendarProvider', () => {
  it('POSTs an event with a bearer token to the chosen calendar', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const provider = new GoogleCalendarProvider(async (url, init) => {
      captured = { url: String(url), init: init! };
      return new Response(JSON.stringify({ id: 'google-evt-1' }), { status: 200 });
    });

    const res = await provider.upsert(event, {
      method: 'google',
      addressOrUrl: '',
      externalCalendarId: 'fam@group.calendar.google.com',
      credential: { kind: 'oauth', accessToken: 'tok-123' },
    });

    expect(res.externalRef).toBe('google-evt-1');
    expect(captured!.url).toContain(
      'fam%40group.calendar.google.com/events',
    );
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
  });

  it('rejects a google target without an oauth credential', async () => {
    const provider = new GoogleCalendarProvider();
    await expect(
      provider.upsert(event, { method: 'google', addressOrUrl: '' }),
    ).rejects.toThrow();
  });

  it('refreshes a refresh-token credential into an access token', async () => {
    let captured: { headers: Record<string, string> } | null = null;
    const provider = new GoogleCalendarProvider(
      async (_url, init) => {
        captured = { headers: init!.headers as Record<string, string> };
        return new Response(JSON.stringify({ id: 'g-evt-1' }), { status: 200 });
      },
      async (refreshToken) => (refreshToken === 'rt-1' ? 'fresh-access' : 'wrong'),
    );
    const res = await provider.upsert(event, {
      method: 'google',
      addressOrUrl: '',
      externalCalendarId: 'cal',
      credential: { kind: 'oauth', refreshToken: 'rt-1' },
    });
    expect(res.externalRef).toBe('g-evt-1');
    expect(captured!.headers.Authorization).toBe('Bearer fresh-access');
  });

  it('rejects a refresh-token credential with no refresher available', async () => {
    const provider = new GoogleCalendarProvider(); // no refresher
    await expect(
      provider.upsert(event, {
        method: 'google',
        addressOrUrl: '',
        credential: { kind: 'oauth', refreshToken: 'rt-1' },
      }),
    ).rejects.toThrow();
  });
});

/**
 * In-memory Google Calendar events collection with the API's real addressing:
 * events live under Google's own opaque `id` (base32hex — `igt-…` can never be
 * one), `iCalUID` is a separate unique field, inserting an existing iCalUID is
 * a 409, and `events/{eventId}` 404s for anything that isn't an id.
 */
class FakeGoogleCalendar {
  readonly events = new Map<
    string,
    { id: string; iCalUID: string; status: string; updated: string; body: Record<string, unknown> }
  >();
  readonly requests: { method: string; url: string }[] = [];
  private seq = 0;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.requests.push({ method, url: url.toString() });
    const m = url.pathname.match(/\/events(?:\/([^/]+))?$/);
    if (!m) return new Response('', { status: 400 });
    const eventId = m[1] ? decodeURIComponent(m[1]) : undefined;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    const now = new Date().toISOString();

    if (method === 'GET' && !eventId) {
      const uid = url.searchParams.get('iCalUID');
      const showDeleted = url.searchParams.get('showDeleted') === 'true';
      const items = [...this.events.values()]
        .filter((e) => (uid ? e.iCalUID === uid : true))
        .filter((e) => showDeleted || e.status !== 'cancelled')
        .map((e) => ({ ...e.body, id: e.id, iCalUID: e.iCalUID, status: e.status, updated: e.updated }));
      return json({ items });
    }
    if (method === 'POST' && !eventId) {
      const body = JSON.parse(String(init!.body));
      if ([...this.events.values()].some((e) => e.iCalUID === body.iCalUID)) {
        return json({ error: { code: 409, message: 'The requested identifier already exists.' } }, 409);
      }
      const id = `ev${(this.seq++).toString(32).padStart(4, '0')}`;
      this.events.set(id, { id, iCalUID: body.iCalUID, status: 'confirmed', updated: now, body });
      return json({ id, iCalUID: body.iCalUID });
    }
    const existing = eventId ? this.events.get(eventId) : undefined;
    if (!existing) return json({ error: { code: 404 } }, 404);
    if (method === 'PUT') {
      const body = JSON.parse(String(init!.body));
      this.events.set(existing.id, { ...existing, status: body.status ?? 'confirmed', updated: now, body });
      return json({ id: existing.id });
    }
    if (method === 'DELETE') {
      if (existing.status === 'cancelled') return json({ error: { code: 410 } }, 410);
      existing.status = 'cancelled';
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 405 });
  };

  live() {
    return [...this.events.values()].filter((e) => e.status !== 'cancelled');
  }
}

describe('GoogleCalendarProvider (against a fake Google Calendar)', () => {
  const target: DeliveryTarget = {
    method: 'google',
    addressOrUrl: '',
    externalCalendarId: 'me@example.com',
    credential: { kind: 'oauth', accessToken: 'tok' },
  };

  it('deletes by the Google event id it was handed back, not the iCalUID', async () => {
    const cal = new FakeGoogleCalendar();
    const provider = new GoogleCalendarProvider(cal.fetch);
    const { externalRef } = await provider.upsert(event, target);
    expect(externalRef).not.toBe(event.uid);

    await provider.cancel({ ...event, externalRef }, target);
    expect(cal.live()).toHaveLength(0);
    const del = cal.requests.find((r) => r.method === 'DELETE')!;
    expect(del.url).toContain(`/events/${externalRef}`);
  });

  it('finds the id by iCalUID when no ref was recorded', async () => {
    const cal = new FakeGoogleCalendar();
    const provider = new GoogleCalendarProvider(cal.fetch);
    await provider.upsert(event, target);

    await provider.cancel(event, target);
    expect(cal.live()).toHaveLength(0);
  });

  it('treats an already-deleted event as cancelled, and throws on a real failure', async () => {
    const cal = new FakeGoogleCalendar();
    const provider = new GoogleCalendarProvider(cal.fetch);
    const { externalRef } = await provider.upsert(event, target);
    await provider.cancel({ ...event, externalRef }, target);
    await expect(provider.cancel({ ...event, externalRef }, target)).resolves.toBeUndefined();

    const failing = new GoogleCalendarProvider(async () => new Response('', { status: 500 }));
    await expect(failing.cancel({ ...event, externalRef: 'abc12' }, target)).rejects.toThrow(/500/);
  });

  it('updates an event in place instead of re-inserting it (which Google 409s)', async () => {
    const cal = new FakeGoogleCalendar();
    const provider = new GoogleCalendarProvider(cal.fetch);
    const first = await provider.upsert(event, target);
    const moved = { ...event, sequence: 1, externalRef: first.externalRef, summary: 'Moved' };
    const second = await provider.upsert(moved, target);

    expect(second.externalRef).toBe(first.externalRef);
    expect(cal.live()).toHaveLength(1);
    expect(cal.live()[0]!.body.summary).toBe('Moved');
  });

  it('recovers from a lost ref: the 409 on insert turns into an update', async () => {
    const cal = new FakeGoogleCalendar();
    const provider = new GoogleCalendarProvider(cal.fetch);
    const first = await provider.upsert(event, target);
    const second = await provider.upsert({ ...event, summary: 'Again' }, target);
    expect(second.externalRef).toBe(first.externalRef);
    expect(cal.live()).toHaveLength(1);
    expect(cal.live()[0]!.body.summary).toBe('Again');
  });

  it('revives a UID whose event was deleted, rather than failing on its tombstone', async () => {
    const cal = new FakeGoogleCalendar();
    const provider = new GoogleCalendarProvider(cal.fetch);
    const { externalRef } = await provider.upsert(event, target);
    await provider.cancel({ ...event, externalRef }, target);
    await provider.upsert(event, target);
    expect(cal.live()).toHaveLength(1);
  });

  it('re-inserts when the user deleted the event out from under its ref', async () => {
    const cal = new FakeGoogleCalendar();
    const provider = new GoogleCalendarProvider(cal.fetch);
    await provider.upsert({ ...event, externalRef: 'gone1' }, target);
    expect(cal.live()).toHaveLength(1);
  });

  it('lists only our own events, skipping ones another deployment stamped', async () => {
    const cal = new FakeGoogleCalendar();
    const prod = new GoogleCalendarProvider(cal.fetch, undefined, 'production');
    const staging = new GoogleCalendarProvider(cal.fetch, undefined, 'staging');
    await prod.upsert({ ...event, uid: 'igt-a' }, target);
    await staging.upsert({ ...event, uid: 'igt-b' }, target);
    await new GoogleCalendarProvider(cal.fetch).upsert({ ...event, uid: 'igt-legacy' }, target);
    await prod.upsert({ ...event, uid: 'someone-elses' }, target);

    const owned = await prod.listOwned(target, {
      uidPrefix: 'igt-',
      start: new Date('2026-03-01T00:00:00Z'),
      end: new Date('2026-04-01T00:00:00Z'),
    });
    expect(owned.map((o) => o.uid).sort()).toEqual(['igt-a', 'igt-legacy']);
    expect(owned.every((o) => o.externalRef && o.updatedAt)).toBe(true);
  });
});

describe('CalDavProvider (against a fake CalDAV server)', () => {
  const collection = 'https://p01-caldav.icloud.com/123/calendars/home/';
  const target: DeliveryTarget = {
    method: 'caldav',
    addressOrUrl: collection,
    credential: { kind: 'basic', username: 'me@icloud.com', password: 'app-pw-1234' },
  };
  const alarmEvent: DeliveryEvent = { ...event, alertMinutes: [30, 10] };
  const objectUrl = `${collection}${alarmEvent.uid}.ics`;

  it('PUTs a full-detail event to the collection with Basic auth + alarms', async () => {
    const server = new FakeCalDavServer();
    const provider = new CalDavProvider(server.fetch);

    const res = await provider.upsert(alarmEvent, target);
    expect(res.externalRef).toBe(alarmEvent.uid);

    expect(server.last.method).toBe('PUT');
    expect(server.last.url).toBe(objectUrl);
    expect(server.last.headers['content-type']).toContain('text/calendar');
    // Basic auth decodes to username:password.
    const basic = server.last.headers.authorization.replace('Basic ', '');
    expect(atob(basic)).toBe('me@icloud.com:app-pw-1234');
    // Body is a real VEVENT with summary, location, and the two alarms.
    expect(server.last.body).toContain('BEGIN:VEVENT');
    expect(server.last.body).toContain('SUMMARY:Pickup — child');
    expect(server.last.body).toContain("LOCATION:Children's House");
    expect(server.last.body!.match(/BEGIN:VALARM/g)).toHaveLength(2);
    expect(server.store.has(objectUrl)).toBe(true);
  });

  it('upserts: a second write overwrites the same object (no 412)', async () => {
    const server = new FakeCalDavServer();
    const provider = new CalDavProvider(server.fetch);

    await provider.upsert(alarmEvent, target);
    await provider.upsert(
      { ...alarmEvent, sequence: 1, summary: 'Pickup — updated' },
      target,
    );

    const puts = server.requests.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts.every((p) => p.url === objectUrl)).toBe(true);
    expect(server.store.get(objectUrl)).toContain('SUMMARY:Pickup — updated');
  });

  it('renders DTSTART in the event timezone + Apple travel-time opt-in', async () => {
    const server = new FakeCalDavServer();
    const provider = new CalDavProvider(server.fetch);
    // 17:00 UTC == 10:00 in Los Angeles (PDT).
    await provider.upsert(
      { ...alarmEvent, timezone: 'America/Los_Angeles' },
      target,
    );
    expect(server.last.body).toContain(
      'DTSTART;TZID=America/Los_Angeles:20260310T100000',
    );
    expect(server.last.body).toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC');
  });

  it('cancel DELETEs the same object URL', async () => {
    const server = new FakeCalDavServer();
    const provider = new CalDavProvider(server.fetch);

    await provider.upsert(alarmEvent, target);
    await provider.cancel(alarmEvent, target);

    expect(server.last.method).toBe('DELETE');
    expect(server.last.url).toBe(objectUrl);
    expect(server.store.has(objectUrl)).toBe(false);
  });

  it('enforces a trailing slash so the object lands inside the collection', async () => {
    const server = new FakeCalDavServer();
    const provider = new CalDavProvider(server.fetch);
    // Collection URL WITHOUT a trailing slash (the historical bug source).
    await provider.upsert(alarmEvent, {
      ...target,
      addressOrUrl: 'https://host/dav/home',
    });
    expect(server.last.url).toBe(`https://host/dav/home/${alarmEvent.uid}.ics`);
  });

  it('cancel tolerates an already-deleted object (404)', async () => {
    const server = new FakeCalDavServer();
    const provider = new CalDavProvider(server.fetch);
    await expect(provider.cancel(alarmEvent, target)).resolves.toBeUndefined();
  });

  it('throws on a non-2xx PUT so the reconcile surfaces the failure', async () => {
    const provider = new CalDavProvider(
      async () => new Response('forbidden', { status: 403 }),
    );
    await expect(provider.upsert(alarmEvent, target)).rejects.toThrow(/403/);
  });

  it('requires a basic credential', async () => {
    const provider = new CalDavProvider();
    await expect(
      provider.upsert(alarmEvent, { method: 'caldav', addressOrUrl: collection }),
    ).rejects.toThrow();
  });
});
