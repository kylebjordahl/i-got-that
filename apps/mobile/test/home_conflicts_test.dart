import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/home_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records the resolution parameters passed to resolveConflict.
class _RecordingApiClient extends ApiClient {
  _RecordingApiClient() : super(baseUrl: 'http://test');

  Map<String, Object?>? lastResolve;

  @override
  Future<void> resolveConflict(
    String familyId,
    String conflictId, {
    int travelBeforeMin = 0,
    int travelAfterMin = 0,
    bool beforeNeeded = true,
    bool afterNeeded = true,
  }) async {
    lastResolve = {
      'travelBeforeMin': travelBeforeMin,
      'travelAfterMin': travelAfterMin,
      'beforeNeeded': beforeNeeded,
      'afterNeeded': afterNeeded,
    };
  }
}

Member _m(String id, String name,
        {bool caretaker = false, bool admin = false, bool child = false}) =>
    Member(
      id: id,
      relationName: name,
      isCaretaker: caretaker,
      isAdmin: admin,
      requiresCaretaker: child,
    );

void main() {
  final me = _m('dad', 'Dad', caretaker: true, admin: true);
  final theo = _m('theo', 'Theo', child: true);

  final day = DateTime.now().add(const Duration(days: 1));
  final conflict = Conflict(
    id: 'c1',
    familyMemberId: 'theo',
    loser: ConflictEventRef(
      summary: 'School day',
      allDay: false,
      start: DateTime(day.year, day.month, day.day, 8, 30),
      end: DateTime(day.year, day.month, day.day, 15, 0),
    ),
    winner: ConflictEventRef(
      summary: 'Doctor appointment',
      allDay: false,
      start: DateTime(day.year, day.month, day.day, 10, 0),
      end: DateTime(day.year, day.month, day.day, 11, 0),
    ),
  );

  final task = TaskItem(
    id: 't1',
    familyMemberId: 'theo',
    type: 'pickup',
    start: DateTime.now().add(const Duration(hours: 3)),
    status: 'unowned',
    createdVia: 'generated',
    calendarEventId: 'e1',
  );

  Widget app() => ProviderScope(
        overrides: [
          membersProvider.overrideWith((ref) async => [me, theo]),
          currentMemberProvider.overrideWith((ref) async => me),
          unownedTasksProvider.overrideWith((ref) async => [task]),
          allTasksProvider.overrideWith((ref) async => [task]),
          pendingDecisionsProvider.overrideWith((ref) async => const []),
          conflictsProvider.overrideWith((ref) async => [conflict]),
          calendarEventsProvider.overrideWith((ref) async => const []),
          threadingThresholdProvider.overrideWith((ref) async => 30),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: HomeScreen()),
        ),
      );

  testWidgets('a double-booking ranks at the top of Home and opens the sheet',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    expect(find.text('DOUBLE-BOOKED'), findsOneWidget);
    expect(find.textContaining('School day'), findsWidgets);
    expect(find.textContaining('Doctor appointment'), findsWidgets);
    expect(find.text('Review & resolve'), findsOneWidget);

    // The conflict card sits above the claimable task queue.
    final conflictY = tester.getTopLeft(find.text('DOUBLE-BOOKED')).dy;
    final taskY = tester.getTopLeft(find.text('Claim').first).dy;
    expect(conflictY, lessThan(taskY));

    // Tapping the card opens the resolution sheet with both terminal actions
    // and a preview of the split segments the "Confirm split" would leave.
    await tester.tap(find.text('Review & resolve'));
    await tester.pumpAndSettle();

    expect(find.text('Two events, one Theo'), findsOneWidget);
    expect(find.text('Confirm split'), findsOneWidget);
    expect(find.text('Ignore conflict — keep both as-is'), findsOneWidget);
    // Loser (School day) split into two segments around the kept winner.
    expect(find.text('School day'), findsNWidgets(2));
    expect(find.text('Doctor appointment'), findsOneWidget);
    expect(find.text('Fixed'), findsOneWidget);
  });

  testWidgets('marking a half "not needed" sends that in the resolution',
      (tester) async {
    // Tall enough that the whole sheet (both halves + footer) is on-screen.
    tester.view.physicalSize = const Size(600, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _RecordingApiClient();
    await tester.pumpWidget(ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        familyProvider.overrideWith((ref) async => 'fam-1'),
        membersProvider.overrideWith((ref) async => [me, theo]),
        currentMemberProvider.overrideWith((ref) async => me),
        unownedTasksProvider.overrideWith((ref) async => [task]),
        allTasksProvider.overrideWith((ref) async => [task]),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        conflictsProvider.overrideWith((ref) async => [conflict]),
        calendarEventsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: HomeScreen()),
      ),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Review & resolve'));
    await tester.pumpAndSettle();

    // Both halves start kept; mark the morning half "not needed" (its pill
    // flips to "Undo") and confirm.
    expect(find.text('Not needed'), findsNWidgets(2));
    await tester.tap(find.text('Not needed').first);
    await tester.pumpAndSettle();
    expect(find.text('Undo'), findsOneWidget);

    await tester.tap(find.text('Confirm split'));
    await tester.pumpAndSettle();

    // The morning is dropped (and its travel zeroed); the afternoon is kept.
    expect(api.lastResolve, {
      'travelBeforeMin': 0,
      'travelAfterMin': 0,
      'beforeNeeded': false,
      'afterNeeded': true,
    });
  });
}
