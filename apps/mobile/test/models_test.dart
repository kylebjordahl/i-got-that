import 'package:flutter_test/flutter_test.dart';

import 'package:caretaker_app/models.dart';

void main() {
  group('SourceEventItem.fromJson', () {
    test('all-day event keeps its calendar date regardless of local tz', () {
      // Backend anchors all-day events to UTC midnight. 2026-07-03T00:00Z is a
      // Friday; naive local parsing in a -offset zone would slip it to Thursday.
      const utcMidnight = 1783036800000; // 2026-07-03T00:00:00Z
      final e = SourceEventItem.fromJson({
        'id': 'e1',
        'feedId': 'f1',
        'dtstart': utcMidnight,
        'allDay': true,
        'summary': 'MCH Closed - US Holiday',
      });

      expect(e.allDay, isTrue);
      // The rendered date is July 3 (built from the UTC parts), never July 2.
      expect(e.start.year, 2026);
      expect(e.start.month, 7);
      expect(e.start.day, 3);
    });

    test('timed event parses as a normal instant', () {
      final e = SourceEventItem.fromJson({
        'id': 'e2',
        'feedId': 'f1',
        'dtstart': 1783036800000,
        'allDay': false,
        'summary': 'Open House',
      });
      expect(e.allDay, isFalse);
      // Local instant (may differ by tz) — but flagged as timed, not all-day.
      expect(e.start.isUtc, isFalse);
    });

    test('defaults allDay to false when the field is absent', () {
      final e = SourceEventItem.fromJson({
        'id': 'e3',
        'feedId': 'f1',
        'dtstart': 1783036800000,
      });
      expect(e.allDay, isFalse);
    });
  });

  group('parseTimestamp', () {
    test('normalises a UTC ISO string to a local instant', () {
      // The API serialises `dtstart` (a timestamp_ms column) as a UTC ISO string.
      final dt = parseTimestamp('2026-07-07T02:00:00.000Z');
      // Same instant as the UTC time...
      expect(dt.millisecondsSinceEpoch,
          DateTime.utc(2026, 7, 7, 2).millisecondsSinceEpoch);
      // ...but a *local* DateTime, so `.hour` reflects the clock the user sees
      // (this is what the Plan grid positions against).
      expect(dt.isUtc, isFalse);
    });

    test('epoch-int values are treated as local instants', () {
      final dt = parseTimestamp(1783043200000);
      expect(dt.isUtc, isFalse);
      expect(dt.millisecondsSinceEpoch, 1783043200000);
    });
  });

  group('LoginIdentity.fromJson', () {
    test('a magic-link identity labels with its email', () {
      final id = LoginIdentity.fromJson({
        'id': 'i1',
        'provider': 'magic_link',
        'providerRef': 'me@example.com',
      });
      expect(id.kindLabel, 'Magic link');
      expect(id.label, 'me@example.com');
    });

    test('an Apple identity labels generically, not by its opaque subject', () {
      final id = LoginIdentity.fromJson({
        'id': 'i2',
        'provider': 'apple',
        'providerRef': 'apple-sub-abc',
      });
      expect(id.kindLabel, 'Apple');
      expect(id.label, 'Sign in with Apple');
    });
  });
}
