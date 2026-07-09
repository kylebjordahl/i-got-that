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

  final sourceEvent = CalendarEventItem(
    id: 'e1',
    familyMemberId: 'theo',
    provenance: 'human',
    start: DateTime.now().add(const Duration(hours: 3)),
    allDay: false,
    summary: 'Soccer practice',
  );
  final attendanceTask = TaskItem(
    id: 't1',
    familyMemberId: 'theo',
    type: 'attendance',
    start: DateTime.now().add(const Duration(hours: 3)),
    status: 'unowned',
    createdVia: 'generated',
    calendarEventId: 'e1',
  );

  Widget app() => ProviderScope(
        overrides: [
          membersProvider.overrideWith((ref) async => [me, theo]),
          currentMemberProvider.overrideWith((ref) async => me),
          unownedTasksProvider.overrideWith((ref) async => [attendanceTask]),
          allTasksProvider.overrideWith((ref) async => [attendanceTask]),
          pendingDecisionsProvider.overrideWith((ref) async => const []),
          calendarEventsProvider.overrideWith((ref) async => [sourceEvent]),
          threadingThresholdProvider.overrideWith((ref) async => 30),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: HomeScreen()),
        ),
      );

  testWidgets('an attendance row reads the source event title, not "Attendance"',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    // The row title reads "Soccer practice · Theo", not "Attendance · Theo".
    expect(find.textContaining('Soccer practice · '), findsOneWidget);
    expect(find.textContaining('Attendance · Theo'), findsNothing);
  });

  testWidgets('an attendance row without a resolvable source event falls back to "Attendance"',
      (tester) async {
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [me, theo]),
        currentMemberProvider.overrideWith((ref) async => me),
        unownedTasksProvider.overrideWith((ref) async => [attendanceTask]),
        allTasksProvider.overrideWith((ref) async => [attendanceTask]),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
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

    // No matching source event ⇒ falls back to the generic "Attendance · Theo" title.
    expect(find.textContaining('Attendance · Theo'), findsOneWidget);
  });
}
