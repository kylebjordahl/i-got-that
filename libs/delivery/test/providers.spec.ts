import { describe, expect, it } from 'vitest';
import {
  EmailImipProvider,
  GoogleCalendarProvider,
  type DeliveryEvent,
} from '../src/index.js';

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
});
