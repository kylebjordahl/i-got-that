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
  _RecordingApiClient({this.onConvert}) : super(baseUrl: 'http://test');

  final void Function(List<String> types)? onConvert;
  List<String>? lastConvertTypes;
  ({String eventId, int? minutes})? lastTravelTime;
  ({String taskId, List<String>? memberIds, String? memberId})? lastAssign;
  String? lastUnassignedTaskId;
  final dismissedTaskIds = <String>[];
  Map<String, Object?>? lastCreatedRule;

  @override
  Future<void> dismissTask(String familyId, String taskId) async {
    dismissedTaskIds.add(taskId);
  }

  @override
  Future<Map<String, dynamic>> createTaskRule(
    String familyId,
    String memberId, {
    String? linkId,
    required String scope,
    required String resultType,
    String matchField = 'summary',
    String matchOp = 'regex',
    String? matchValue,
    int? position,
    int? dropoffWindowMin,
    int? pickupWindowMin,
  }) async {
    lastCreatedRule = {
      'memberId': memberId,
      'linkId': linkId,
      'scope': scope,
      'resultType': resultType,
      'matchValue': matchValue,
      'position': position,
      'dropoffWindowMin': dropoffWindowMin,
      'pickupWindowMin': pickupWindowMin,
    };
    return {};
  }

  @override
  Future<void> assignTask(
    String familyId,
    String taskId, {
    String? memberId,
    List<String>? memberIds,
  }) async {
    lastAssign = (taskId: taskId, memberIds: memberIds, memberId: memberId);
  }

  @override
  Future<void> unassignTask(
    String familyId,
    String taskId, {
    String? memberId,
  }) async {
    lastUnassignedTaskId = taskId;
  }

  @override
  Future<void> convertTask(
    String familyId,
    String taskId,
    List<String> types,
  ) async {
    lastConvertTypes = types;
    onConvert?.call(types);
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

  testWidgets('the sheet stays open across type switches', (tester) async {
    final me = _m('dad', 'Dad', caretaker: true, admin: true);
    TaskItem leg(String id, String type) => TaskItem(
      id: id,
      familyMemberId: 'theo',
      type: type,
      start: DateTime.now().add(const Duration(hours: 2)),
      status: 'unowned',
      createdVia: 'generated',
      calendarEventId: 'e2',
    );
    // What the server holds; converting rewrites it the way POST /convert does
    // (kept types keep their rows, new types get fresh ids).
    var live = [leg('t2', 'attendance')];
    final api = _RecordingApiClient(
      onConvert: (types) {
        live = [
          for (final type in types)
            live.where((t) => t.type == type).firstOrNull ??
                leg('new-$type', type),
        ];
      },
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          familyProvider.overrideWith((ref) async => 'fam-1'),
          membersProvider.overrideWith(
            (ref) async => [me, _m('theo', 'Theo', child: true)],
          ),
          currentMemberProvider.overrideWith((ref) async => me),
          unownedTasksProvider.overrideWith((ref) async => live),
          allTasksProvider.overrideWith((ref) async => live),
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

    bool isOn(int i) =>
        tester.widgetList<Switch>(find.byType(Switch)).toList()[i].value;

    // Drop off on: the sheet is still there, and shows it on.
    await tester.tap(find.byType(Switch).at(0));
    await tester.pumpAndSettle();
    expect(find.text('TYPE'), findsOneWidget);
    expect(isOn(0), isTrue);
    expect(isOn(1), isTrue);

    // Pick up on too: builds on the first switch rather than starting over.
    await tester.tap(find.byType(Switch).at(2));
    await tester.pumpAndSettle();
    expect(Set<String>.from(api.lastConvertTypes!), {
      'attendance',
      'dropoff',
      'pickup',
    });
    expect(find.text('TYPE'), findsOneWidget);
    expect([isOn(0), isOn(1), isOn(2)], [true, true, true]);

    // Turning off the type the sheet opened on leaves it usable (that task row
    // was deleted server-side), with the remaining types still on.
    await tester.tap(find.byType(Switch).at(1));
    await tester.pumpAndSettle();
    expect(find.text('TYPE'), findsOneWidget);
    expect([isOn(0), isOn(1), isOn(2)], [true, false, true]);
    expect(find.text('Mark as not needed'), findsOneWidget);
  });

  testWidgets(
    'tapping one leg of a multi-task event notes the toggle covers the whole event',
    (tester) async {
      final me = _m('dad', 'Dad', caretaker: true, admin: true);
      final pickup = TaskItem(
        id: 't3',
        familyMemberId: 'theo',
        type: 'pickup',
        start: DateTime.now().add(const Duration(hours: 4)),
        status: 'unowned',
        createdVia: 'generated',
        calendarEventId: 'e1',
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            membersProvider.overrideWith(
              (ref) async => [me, _m('theo', 'Theo', child: true)],
            ),
            currentMemberProvider.overrideWith((ref) async => me),
            // The dropoff row is what's tapped, but the group (allTasksProvider)
            // also holds its sibling pickup — the same event's other leg.
            unownedTasksProvider.overrideWith((ref) async => [_task]),
            allTasksProvider.overrideWith((ref) async => [_task, pickup]),
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

      await tester.tap(find.byType(TaskRow).first);
      await tester.pumpAndSettle();

      expect(
        find.text(
          'This changes the type for the whole event, not just this '
          'one leg.',
        ),
        findsOneWidget,
      );
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
        ownerMemberIds: const ['dad'],
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
      ownerMemberIds: const ['dad'],
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

  testWidgets(
    'an attendance task can be handed to several caretakers at once',
    (tester) async {
      final me = _m('dad', 'Dad', caretaker: true, admin: true);
      final mom = _m('mom', 'Mom', caretaker: true);
      // Both parents at the same recital: the sheet offers "Who's going" rather
      // than a one-of reassignment, and submits the whole set.
      final attendance = TaskItem(
        id: 't4',
        familyMemberId: 'theo',
        type: 'attendance',
        start: DateTime.now().add(const Duration(hours: 2)),
        end: DateTime.now().add(const Duration(hours: 4)),
        status: 'owned',
        ownerMemberIds: const ['dad'],
        createdVia: 'generated',
        calendarEventId: 'e4',
      );
      final api = _RecordingApiClient();

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(api),
            familyProvider.overrideWith((ref) async => 'fam-1'),
            membersProvider.overrideWith(
              (ref) async => [me, mom, _m('theo', 'Theo', child: true)],
            ),
            currentMemberProvider.overrideWith((ref) async => me),
            unownedTasksProvider.overrideWith((ref) async => const []),
            allTasksProvider.overrideWith((ref) async => [attendance]),
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

      await tester.tap(find.text('Who’s going…'));
      await tester.pumpAndSettle();

      // Dad is already going; add Mom and save.
      await tester.tap(find.text('Mom'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(api.lastAssign?.taskId, 't4');
      expect(api.lastAssign?.memberIds, ['dad', 'mom']);
    },
  );

  group('marking a whole event not needed offers a "No tasks" rule', () {
    final me = _m('dad', 'Dad', caretaker: true, admin: true);
    final event = CalendarEventItem(
      id: 'e9',
      familyMemberId: 'theo',
      provenance: 'synthesized',
      start: DateTime.now().add(const Duration(hours: 2)),
      end: DateTime.now().add(const Duration(hours: 3)),
      allDay: false,
      linkId: 'link-1',
      summary: 'Soccer (U10) practice',
    );
    TaskItem leg(String id, String type, {String status = 'unowned'}) =>
        TaskItem(
          id: id,
          familyMemberId: 'theo',
          type: type,
          start: DateTime.now().add(const Duration(hours: 2)),
          status: status,
          createdVia: 'generated',
          calendarEventId: 'e9',
        );

    Future<void> pump(
      WidgetTester tester,
      _RecordingApiClient api,
      List<TaskItem> tasks, {
      Member? as,
    }) async {
      final viewer = as ?? me;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(api),
            familyProvider.overrideWith((ref) async => 'fam-1'),
            membersProvider.overrideWith(
              (ref) async => [me, _m('theo', 'Theo', child: true)],
            ),
            currentMemberProvider.overrideWith((ref) async => viewer),
            // A dismissed task comes back dismissed, as it does server-side —
            // so the row that was tapped is gone by the time the prompt shows.
            unownedTasksProvider.overrideWith(
              (ref) async => tasks
                  .where((t) => !api.dismissedTaskIds.contains(t.id))
                  .toList(),
            ),
            allTasksProvider.overrideWith(
              (ref) async => [
                for (final t in tasks)
                  api.dismissedTaskIds.contains(t.id)
                      ? leg(t.id, t.type, status: 'dismissed')
                      : t,
              ],
            ),
            pendingDecisionsProvider.overrideWith((ref) async => const []),
            conflictsProvider.overrideWith((ref) async => const []),
            calendarEventsProvider.overrideWith((ref) async => [event]),
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
    }

    Future<void> markNotNeeded(WidgetTester tester) async {
      await tester.tap(find.byType(TaskRow).first);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Mark as not needed'));
      await tester.tap(find.text('Mark as not needed'));
      await tester.pumpAndSettle();
    }

    testWidgets('yes drafts an exact-title rule in the editor, saved first', (
      tester,
    ) async {
      final api = _RecordingApiClient();
      await pump(tester, api, [leg('t9', 'attendance')]);
      await markNotNeeded(tester);

      expect(api.dismissedTaskIds, ['t9']);
      expect(find.byType(TaskRow), findsNothing);
      expect(find.text('Make this a rule?'), findsOneWidget);
      await tester.tap(find.text('Make a rule'));
      await tester.pumpAndSettle();

      // The editor opens on the draft for refinement; nothing is saved yet.
      expect(find.text('New task rule'), findsOneWidget);
      expect(find.text('No tasks'), findsOneWidget);
      expect(find.text(r'/^Soccer \(U10\) practice$/i'), findsOneWidget);
      expect(api.lastCreatedRule, isNull);

      await tester.ensureVisible(find.text('Save rule'));
      await tester.tap(find.text('Save rule'));
      await tester.pumpAndSettle();
      expect(api.lastCreatedRule, {
        'memberId': 'theo',
        'linkId': 'link-1',
        'scope': 'this_calendar',
        'resultType': 'none',
        'matchValue': r'/^Soccer \(U10\) practice$/i',
        'position': 0,
        'dropoffWindowMin': null,
        'pickupWindowMin': null,
      });
    });

    testWidgets('not now leaves it a one-off dismissal', (tester) async {
      final api = _RecordingApiClient();
      await pump(tester, api, [leg('t9', 'attendance')]);
      await markNotNeeded(tester);

      await tester.tap(find.text('Not now'));
      await tester.pumpAndSettle();
      expect(find.text('New task rule'), findsNothing);
      expect(api.lastCreatedRule, isNull);
    });

    testWidgets('dismissing one leg of the event does not offer a rule', (
      tester,
    ) async {
      final api = _RecordingApiClient();
      await pump(tester, api, [leg('t9', 'dropoff'), leg('t10', 'pickup')]);
      await markNotNeeded(tester);

      expect(api.dismissedTaskIds, hasLength(1));
      expect(find.text('Make this a rule?'), findsNothing);
    });

    testWidgets('a non-admin is not offered a rule', (tester) async {
      final api = _RecordingApiClient();
      await pump(tester, api, [
        leg('t9', 'attendance'),
      ], as: _m('dad', 'Dad', caretaker: true));
      await markNotNeeded(tester);

      expect(api.dismissedTaskIds, ['t9']);
      expect(find.text('Make this a rule?'), findsNothing);
    });
  });
}
