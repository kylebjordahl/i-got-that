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

  final decision = PendingDecision(
    id: 'pd1',
    feedId: 'f1',
    familyMemberId: 'theo',
    start: DateTime.now().add(const Duration(days: 1)),
    allDay: false,
    summary: 'Book Fair',
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
          pendingDecisionsProvider.overrideWith((ref) async => [decision]),
          calendarEventsProvider.overrideWith((ref) async => const []),
          threadingThresholdProvider.overrideWith((ref) async => 30),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: HomeScreen()),
        ),
      );

  testWidgets('pending decisions rank above unclaimed tasks on Home', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    expect(find.text('NEEDS A DECISION'), findsOneWidget);
    expect(find.textContaining('Book Fair'), findsWidgets);
    // The decision card offers Resolve + Dismiss (no type picker now).
    expect(find.text('Resolve'), findsOneWidget);
    expect(find.text('Dismiss'), findsOneWidget);

    // The decision card sits above the claimable task row.
    final decisionY = tester.getTopLeft(find.text('NEEDS A DECISION')).dy;
    final taskY = tester.getTopLeft(find.text('Claim').first).dy;
    expect(decisionY, lessThan(taskY));
  });
}
