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

  group('FeedLink geocoded location', () {
    test('parses a geocoded baseline location', () {
      final link = FeedLink.fromJson({
        'id': 'l1',
        'familyMemberId': 'm1',
        'active': true,
        'location': 'Lincoln Elementary',
        'locationGeo': {
          'lat': 37.331686,
          'lon': -122.030656,
          'title': 'Lincoln Elementary',
          'address': '123 Main St, Springfield',
        },
      });
      expect(link.location, 'Lincoln Elementary');
      expect(link.locationGeo, isNotNull);
      expect(link.locationGeo!.lat, 37.331686);
      expect(link.locationGeo!.lon, -122.030656);
      expect(link.locationGeo!.address, '123 Main St, Springfield');
    });

    test('locationGeo is null when the link has only free text', () {
      final link = FeedLink.fromJson({
        'id': 'l2',
        'familyMemberId': 'm1',
        'active': true,
        'location': 'the school',
      });
      expect(link.location, 'the school');
      expect(link.locationGeo, isNull);
    });

    test('GeoLocation.toJson omits absent optional fields', () {
      const geo = GeoLocation(lat: 40.7128, lon: -74.006);
      expect(geo.toJson(), {'lat': 40.7128, 'lon': -74.006});
    });
  });

  group('AssignmentRule.fromJson', () {
    test('parses filters, weekday mask and biweekly anchor', () {
      final r = AssignmentRule.fromJson({
        'id': 'ar1',
        'position': 0,
        'ownerMemberId': 'parentA',
        'aboutMemberId': 'childB',
        'linkId': null,
        'taskType': 'pickup',
        'weekdayMask': 5, // Mon (bit0) + Wed (bit2)
        'cadenceWeeks': 2,
        'anchorDate': 1783036800000, // 2026-07-03T00:00Z
      });
      expect(r.ownerMemberId, 'parentA');
      expect(r.aboutMemberId, 'childB');
      expect(r.taskType, 'pickup');
      expect(r.weekdays, {0, 2});
      expect(r.isBiweekly, isTrue);
      expect(r.anchorDate, isNotNull);
    });

    test('defaults an unfiltered weekly rule (any day)', () {
      final r = AssignmentRule.fromJson({
        'id': 'ar2',
        'position': 1,
        'ownerMemberId': 'parentA',
      });
      expect(r.weekdayMask, 0);
      expect(r.weekdays, isEmpty);
      expect(r.cadenceWeeks, 1);
      expect(r.isBiweekly, isFalse);
      expect(r.anchorDate, isNull);
    });

    test('AssignmentRuleSet parses rules and links', () {
      final set = AssignmentRuleSet.fromJson({
        'rules': [
          {'id': 'ar1', 'position': 0, 'ownerMemberId': 'p1'},
        ],
        'links': [
          {'id': 'l1', 'feedId': 'f1', 'familyMemberId': 'c1'},
        ],
      });
      expect(set.rules, hasLength(1));
      expect(set.links.single.feedId, 'f1');
    });
  });
}
