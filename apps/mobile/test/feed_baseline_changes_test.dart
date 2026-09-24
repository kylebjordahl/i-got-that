import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/feed_baseline_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records scheduled-change writes so the test can assert on the wire format.
class _RecordingApiClient extends ApiClient {
  _RecordingApiClient() : super(baseUrl: 'http://test');

  ({String effectiveFrom, String dayStart, String dayEnd})? created;
  String? deletedId;

  @override
  Future<void> createBaselineChange(
    String familyId,
    String feedId,
    String linkId, {
    required String effectiveFrom,
    required String dayStart,
    required String dayEnd,
  }) async {
    created = (
      effectiveFrom: effectiveFrom,
      dayStart: dayStart,
      dayEnd: dayEnd,
    );
  }

  @override
  Future<void> deleteBaselineChange(
    String familyId,
    String feedId,
    String linkId,
    String changeId,
  ) async {
    deletedId = changeId;
  }
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

  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  String dateOffset(int days) =>
      formatLocalDate(today.add(Duration(days: days)));

  Future<_RecordingApiClient> pump(
    WidgetTester tester,
    List<BaselineChange> changes,
  ) async {
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(420, 2000);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _RecordingApiClient();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          familyProvider.overrideWith((ref) async => 'fam-1'),
          linkRulesProvider.overrideWith((ref, key) async => const []),
          baselineChangesProvider.overrideWith((ref, key) async => changes),
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
    return api;
  }

  testWidgets('lists scheduled changes with their status', (tester) async {
    await pump(tester, [
      BaselineChange(
        id: 'c0',
        effectiveFrom: dateOffset(-30),
        dayStart: '09:00',
        dayEnd: '15:00',
      ),
      BaselineChange(
        id: 'c1',
        effectiveFrom: dateOffset(-3),
        dayStart: '08:30',
        dayEnd: '15:15',
      ),
      BaselineChange(
        id: 'c2',
        effectiveFrom: dateOffset(10),
        dayStart: '08:30',
        dayEnd: '17:00',
      ),
    ]);

    expect(find.text('8:30 AM – 5:00 PM'), findsOneWidget);
    expect(find.text('Ended'), findsOneWidget);
    expect(find.text('In effect'), findsOneWidget);
    expect(find.text('Upcoming'), findsOneWidget);
  });

  testWidgets('schedules a new change on the link hours by default', (
    tester,
  ) async {
    final api = await pump(tester, const []);

    await tester.tap(find.text('Schedule a change'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save change'));
    await tester.pumpAndSettle();

    // Defaults: the first of next month, on the link's current hours.
    expect(api.created, (
      effectiveFrom: formatLocalDate(DateTime(now.year, now.month + 1, 1)),
      dayStart: '08:30',
      dayEnd: '14:45',
    ));
  });

  testWidgets('deletes a change from its sheet', (tester) async {
    final api = await pump(tester, [
      BaselineChange(
        id: 'c2',
        effectiveFrom: dateOffset(10),
        dayStart: '08:30',
        dayEnd: '17:00',
      ),
    ]);

    await tester.tap(find.text('8:30 AM – 5:00 PM'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Delete change'));
    await tester.pumpAndSettle();

    expect(api.deletedId, 'c2');
  });
}
