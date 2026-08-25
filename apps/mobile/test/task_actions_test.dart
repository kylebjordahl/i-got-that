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

import 'support/duration_wheel.dart';

/// Records the `types` passed to convertTask so tests can assert on it
/// without a real network call.
class _RecordingApiClient extends ApiClient {
  _RecordingApiClient() : super(baseUrl: 'http://test');

  List<String>? lastConvertTypes;
  ({String eventId, int? minutes})? lastTravelTime;

  @override
  Future<void> convertTask(
    String familyId,
    String taskId,
    List<String> types,
  ) async {
    lastConvertTypes = types;
  }

  @override
  Future<void> setEventTravelTime(
    String familyId,
    String eventId,
    int? travelMinutes,
  ) async {
    lastTravelTime = (eventId: eventId, minutes: travelMinutes);
  }
}

Member _m(
  String id,
  String name, {
  bool caretaker = false,
  bool admin = false,
  bool child = false,
}) => Member(
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
  testWidgets('tapping a Home task opens the quick-actions sheet', (
    tester,
  ) async {
    final me = _m('dad', 'Dad', caretaker: true, admin: true);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          membersProvider.overrideWith(
            (ref) async => [me, _m('theo', 'Theo', child: true)],
          ),
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
      ),
    );
    await tester.pumpAndSettle();

    // The unowned row is rendered.
    expect(find.byType(TaskRow), findsOneWidget);

    // Tapping opens the quick-actions sheet: type toggles + actions.
    await tester.tap(find.byType(TaskRow));
    await tester.pumpAndSettle();
    expect(find.text('TYPE'), findsOneWidget);
    expect(find.text('Drop off'), findsOneWidget);
    expect(find.text('Attend'), findsOneWidget);
    expect(find.text('Pick up'), findsOneWidget);
    expect(
      find.text('Claim for myself'),
      findsOneWidget,
    ); // unowned + caretaker
    expect(find.text('Mark as not needed'), findsOneWidget);

    // The task's only type is drop-off, so its switch can't be turned off.
    final switches = tester.widgetList<Switch>(find.byType(Switch)).toList();
    expect(switches[0].onChanged, isNull); // Drop off
    expect(switches[1].onChanged, isNotNull); // Attend
    expect(switches[2].onChanged, isNotNull); // Pick up
  });

  testWidgets(
    'switching on drop off for an attendance task adds it alongside attendance',
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

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(api),
            familyProvider.overrideWith((ref) async => 'fam-1'),
            membersProvider.overrideWith(
              (ref) async => [me, _m('theo', 'Theo', child: true)],
            ),
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
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byType(TaskRow));
      await tester.pumpAndSettle();

      // Drop off, Attend, Pick up — turn on the first (off) switch.
      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();

      expect(Set<String>.from(api.lastConvertTypes!), {
        'attendance',
        'dropoff',
      });
    },
  );

  testWidgets(
    'an auto-assigned task is marked on the row and names its rule in the sheet',
    (tester) async {
      final me = _m('dad', 'Dad', caretaker: true, admin: true);
      final autoTask = TaskItem(
        id: 't3',
        familyMemberId: 'theo',
        type: 'pickup',
        start: DateTime.now().add(const Duration(hours: 2)),
        status: 'owned',
        createdVia: 'generated',
        calendarEventId: 'e3',
        ownerMemberId: 'dad',
        autoAssignedRuleId: 'ar1',
      );
      final ruleSet = AssignmentRuleSet(
        links: const [],
        rules: [
          AssignmentRule(
            id: 'ar1',
            position: 0,
            ownerMemberId: 'dad',
            aboutMemberId: 'theo',
            taskType: 'pickup',
            weekdayMask: 1 << 0, // Mon
            cadenceWeeks: 2,
          ),
        ],
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            familyProvider.overrideWith((ref) async => 'fam-1'),
            membersProvider.overrideWith(
              (ref) async => [me, _m('theo', 'Theo', child: true)],
            ),
            currentMemberProvider.overrideWith((ref) async => me),
            unownedTasksProvider.overrideWith((ref) async => const []),
            allTasksProvider.overrideWith((ref) async => [autoTask]),
            pendingDecisionsProvider.overrideWith((ref) async => const []),
            conflictsProvider.overrideWith((ref) async => const []),
            calendarEventsProvider.overrideWith((ref) async => const []),
            threadingThresholdProvider.overrideWith((ref) async => 30),
            assignmentRulesProvider.overrideWith((ref) async => ruleSet),
            feedsProvider.overrideWith((ref) async => const []),
          ],
          child: MaterialApp(
            theme: buildAppTheme(),
            themeMode: ThemeMode.dark,
            home: const Scaffold(body: HomeScreen()),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The row carries the auto-assigned bolt.
      final row = tester.widget<TaskRow>(find.byType(TaskRow));
      expect(row.autoAssigned, isTrue);

      await tester.tap(find.byType(TaskRow));
      await tester.pumpAndSettle();

      // The sheet says a rule did it, and describes which one.
      expect(find.text('Assigned automatically'), findsOneWidget);
      expect(
        find.text('By “Pickup · for Theo · Mon · every other week”'),
        findsOneWidget,
      );
    },
  );

  testWidgets("a claimed drop-off's sheet edits the travel time on its claim", (
    tester,
  ) async {
    // Plan draws drop-offs and pickups as tabs on their source event and never
    // as claim blocks, so this sheet — not the event-details one — is where a
    // transition's travel time has to be reachable.
    final me = _m('dad', 'Dad', caretaker: true, admin: true);
    final claimed = TaskItem(
      id: 't3',
      familyMemberId: 'theo',
      type: 'dropoff',
      start: DateTime.now().add(const Duration(hours: 2)),
      status: 'owned',
      ownerMemberId: 'dad',
      createdVia: 'generated',
      calendarEventId: 'e3',
    );
    // The claim: the copy of that task on Dad's own calendar, which is what
    // mirrors out and carries the travel block.
    final claimEvent = CalendarEventItem(
      id: 'claim-3',
      familyMemberId: 'dad',
      provenance: 'claimed_task',
      start: claimed.start,
      allDay: false,
      summary: 'Drop-off — Theo',
      location: 'Lincoln Elementary',
      taskId: 't3',
    );
    final api = _RecordingApiClient();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          familyProvider.overrideWith((ref) async => 'fam-1'),
          membersProvider.overrideWith(
            (ref) async => [me, _m('theo', 'Theo', child: true)],
          ),
          currentMemberProvider.overrideWith((ref) async => me),
          unownedTasksProvider.overrideWith((ref) async => const []),
          allTasksProvider.overrideWith((ref) async => [claimed]),
          pendingDecisionsProvider.overrideWith((ref) async => const []),
          conflictsProvider.overrideWith((ref) async => const []),
          calendarEventsProvider.overrideWith((ref) async => [claimEvent]),
          threadingThresholdProvider.overrideWith((ref) async => 30),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: HomeScreen()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byType(TaskRow));
    await tester.pumpAndSettle();

    expect(find.text('TRAVEL TIME'), findsOneWidget);
    // No override yet, so the field reads as the server's estimate; tapping it
    // opens the duration wheel (starting at the 15-minute fallback).
    await tester.tap(find.text('Estimated'));
    await tester.pumpAndSettle();
    // Ten notches down the minute wheel: 15 -> 25.
    await pickDurationNotches(tester, 10);

    // Written to the claim, not to the source event the task came from.
    expect(api.lastTravelTime, (eventId: 'claim-3', minutes: 25));
  });
}
