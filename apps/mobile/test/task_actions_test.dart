import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/home_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/widgets/task_row.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records the `types` passed to convertTask so tests can assert on it
/// without a real network call.
class _RecordingApiClient extends ApiClient {
  _RecordingApiClient() : super(baseUrl: 'http://test');

  List<String>? lastConvertTypes;

  @override
  Future<void> convertTask(String familyId, String taskId, List<String> types) async {
    lastConvertTypes = types;
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

// A couple of hours in the future so it survives Home's "hide past tasks" filter.
final TaskItem _task = TaskItem(
  id: 't1',
  familyMemberId: 'theo',
  type: 'dropoff',
  start: DateTime.now().add(const Duration(hours: 2)),
  status: 'unowned',
  createdVia: 'generated',
  calendarEventId: 'e1',
);

void main() {
  testWidgets('tapping a Home task opens the quick-actions sheet', (tester) async {
    final me = _m('dad', 'Dad', caretaker: true, admin: true);
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [me, _m('theo', 'Theo', child: true)]),
        currentMemberProvider.overrideWith((ref) async => me),
        unownedTasksProvider.overrideWith((ref) async => [_task]),
        allTasksProvider.overrideWith((ref) async => [_task]),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        conflictsProvider.overrideWith((ref) async => const []),
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

    // The unowned row is rendered.
    expect(find.byType(TaskRow), findsOneWidget);

    // Tapping opens the quick-actions sheet: change-type segments + actions.
    await tester.tap(find.byType(TaskRow));
    await tester.pumpAndSettle();
    expect(find.text('CHANGE TYPE'), findsOneWidget);
    expect(find.text('Transition'), findsOneWidget); // segment tile
    expect(find.text('Attendance'), findsOneWidget);
    expect(find.text('Both'), findsOneWidget);
    expect(find.text('Claim for myself'), findsOneWidget); // unowned + caretaker
    expect(find.text('Mark as not needed'), findsOneWidget);
  });

  testWidgets(
      'converting an attendance task to Transition requests both drop-off and pick-up',
      (tester) async {
    final me = _m('dad', 'Dad', caretaker: true, admin: true);
    final attendanceTask = TaskItem(
      id: 't2',
      familyMemberId: 'theo',
      type: 'attendance',
      start: DateTime.now().add(const Duration(hours: 2)),
      status: 'unowned',
      createdVia: 'generated',
      calendarEventId: 'e2',
    );
    final api = _RecordingApiClient();

    await tester.pumpWidget(ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        familyProvider.overrideWith((ref) async => 'fam-1'),
        membersProvider.overrideWith((ref) async => [me, _m('theo', 'Theo', child: true)]),
        currentMemberProvider.overrideWith((ref) async => me),
        unownedTasksProvider.overrideWith((ref) async => [attendanceTask]),
        allTasksProvider.overrideWith((ref) async => [attendanceTask]),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        conflictsProvider.overrideWith((ref) async => const []),
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

    await tester.tap(find.byType(TaskRow));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Transition'));
    await tester.pumpAndSettle();

    expect(api.lastConvertTypes, ['dropoff', 'pickup']);
  });
}
