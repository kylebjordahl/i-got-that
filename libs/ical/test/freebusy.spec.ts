import { describe, expect, it } from 'vitest';
import { busyIntervalUid, fetchGoogleFreeBusy } from '../src/index.js';

const WINDOW = {
  windowStart: new Date('2026-08-01T00:00:00Z'),
  windowEnd: new Date('2026-09-05T00:00:00Z'),
};

describe('fetchGoogleFreeBusy', () => {
  it('POSTs the window and maps busy intervals to detail-free occurrences', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          calendars: {
            'kyle@work.example': {
              busy: [
                { start: '2026-08-03T15:00:00Z', end: '2026-08-03T16:30:00Z' },
                { start: '2026-08-04T09:00:00Z', end: '2026-08-04T09:30:00Z' },
              ],
            },
          },
        }),
      };
    }) as unknown as typeof fetch;

    const { occurrences, timezone } = await fetchGoogleFreeBusy(
      'access-token',
      'kyle@work.example',
      WINDOW,
      fetchImpl,
    );

    expect(captured!.url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(captured!.init.method).toBe('POST');
    const body = JSON.parse(String(captured!.init.body));
    expect(body).toEqual({
      timeMin: '2026-08-01T00:00:00.000Z',
      timeMax: '2026-09-05T00:00:00.000Z',
      items: [{ id: 'kyle@work.example' }],
    });
    expect(
      (captured!.init.headers as Record<string, string>).Authorization,
    ).toBe('Bearer access-token');

    // Intervals only — never a summary/location, never all-day, no timezone.
    expect(timezone).toBeNull();
    expect(occurrences).toHaveLength(2);
    for (const occ of occurrences) {
      expect(occ.summary).toBeNull();
      expect(occ.location).toBeNull();
      expect(occ.allDay).toBe(false);
      expect(occ.recurrenceId).toBeNull();
    }
    expect(occurrences[0]!.uid).toBe(
      busyIntervalUid(
        new Date('2026-08-03T15:00:00Z'),
        new Date('2026-08-03T16:30:00Z'),
      ),
    );
    expect(occurrences[0]!.uid).toBe(
      'fb:2026-08-03T15:00:00.000Z/2026-08-03T16:30:00.000Z',
    );
  });

  it('returns an empty list for a calendar with no busy intervals', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ calendars: { 'kyle@work.example': { busy: [] } } }),
    })) as unknown as typeof fetch;
    const { occurrences } = await fetchGoogleFreeBusy(
      'access-token',
      'kyle@work.example',
      WINDOW,
      fetchImpl,
    );
    expect(occurrences).toEqual([]);
  });

  it('throws on a per-calendar error (unshared/nonexistent both surface as notFound)', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        calendars: {
          'kyle@work.example': {
            busy: [],
            errors: [{ domain: 'global', reason: 'notFound' }],
          },
        },
      }),
    })) as unknown as typeof fetch;
    await expect(
      fetchGoogleFreeBusy('access-token', 'kyle@work.example', WINDOW, fetchImpl),
    ).rejects.toThrow(/notFound/);
  });

  it('throws on a non-OK HTTP response', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      fetchGoogleFreeBusy('access-token', 'kyle@work.example', WINDOW, fetchImpl),
    ).rejects.toThrow(/401/);
  });

  it('falls back to the single response entry when Google canonicalizes the id', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        calendars: {
          'canonical-id@group.calendar.google.com': {
            busy: [{ start: '2026-08-03T15:00:00Z', end: '2026-08-03T16:00:00Z' }],
          },
        },
      }),
    })) as unknown as typeof fetch;
    const { occurrences } = await fetchGoogleFreeBusy(
      'access-token',
      'kyle@work.example',
      WINDOW,
      fetchImpl,
    );
    expect(occurrences).toHaveLength(1);
  });
});
