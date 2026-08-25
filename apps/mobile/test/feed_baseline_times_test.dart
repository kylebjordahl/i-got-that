import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/feed_baseline_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records the baseline patch so the test can assert on the wire format the
/// picker produces.
class _RecordingApiClient extends ApiClient {
  _RecordingApiClient() : super(baseUrl: 'http://test');

  ({String? dayStart, String? dayEnd})? lastBaseline;

  @override
  Future<void> updateMemberLink(
    String familyId,
    String feedId,
    String linkId, {
    int? weekdayMask,
    String? dayStart,
    String? dayEnd,
    String? location,
    Object? locationGeo = const _Unset(),
    bool? active,
  }) async {
    lastBaseline = (dayStart: dayStart, dayEnd: dayEnd);
  }
}

/// Stands in for the client's private "argument omitted" sentinel.
class _Unset {
  const _Unset();
}

void main() {
  final feed = FeedItem(
    id: 'f1',
    kind: 'ics',
    mode: 'exception',
    sourceCalendarName: 'Lincoln Elementary',
  );
  final link = FeedLink(
    id: 'l1',
    familyMemberId: 'theo',
    active: true,
    weekdayMask: 31,
    dayStart: '08:30',
    dayEnd: '14:45',
  );
  final member = Member(
    id: 'theo',
    relationName: 'Theo',
    isCaretaker: false,
    isAdmin: false,
    requiresCaretaker: true,
  );

  testWidgets('the baseline hours are picked, and still save as "HH:MM"', (
    tester,
  ) async {
    // Tall enough that the whole form — baseline fields through Save — is on
    // screen at once.
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(420, 1400);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _RecordingApiClient();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          familyProvider.overrideWith((ref) async => 'fam-1'),
          linkRulesProvider.overrideWith((ref, key) async => const []),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          home: FeedBaselineScreen(
            member: member,
            feed: feed,
            existingLink: link,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // The stored 24-hour strings render as clock times, not as raw text.
    expect(find.text('8:30 AM'), findsOneWidget);
    expect(find.text('2:45 PM'), findsOneWidget);

    // Open the picker on the start of the day and take it as it stands.
    await tester.tap(find.text('8:30 AM'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Save linked feed'));
    await tester.pumpAndSettle();

    expect(api.lastBaseline, (dayStart: '08:30', dayEnd: '14:45'));
  });
}
