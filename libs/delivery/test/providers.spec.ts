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

describe('EmailImipProvider', () => {
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
    expect(sent[0]!.mime).toContain('To: parent@example.com');
    expect(sent[0]!.mime).toContain('Content-Type: text/calendar; method=REQUEST');
    expect(sent[0]!.mime).toContain('METHOD:REQUEST');
    expect(sent[0]!.mime).toContain('UID:igt-task-1-target-1');
    // RFC 5322 headers required by strict senders (Cloudflare Email Service).
    expect(sent[0]!.mime).toMatch(/^Date: /m);
    expect(sent[0]!.mime).toMatch(/^Message-ID: <.+@igt\.test>/m);
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
