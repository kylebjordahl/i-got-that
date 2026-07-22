import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/home_screen.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

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

  testWidgets('a double-booking ranks at the top of Home with Split / Dismiss',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    expect(find.text('DOUBLE-BOOKED'), findsOneWidget);
    expect(find.textContaining('School day'), findsWidgets);
    expect(find.textContaining('Doctor appointment'), findsWidgets);
    expect(find.text('Split around it'), findsOneWidget);
    expect(find.text('Dismiss'), findsOneWidget);

    // The conflict card sits above the claimable task queue.
    final conflictY = tester.getTopLeft(find.text('DOUBLE-BOOKED')).dy;
    final taskY = tester.getTopLeft(find.text('Claim').first).dy;
    expect(conflictY, lessThan(taskY));
  });
}
