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
  final mom = _m('mom', 'Mom', caretaker: true);
  final theo = _m('theo', 'Theo', child: true);

  final unowned = TaskItem(
    id: 'unowned1',
    familyMemberId: 'theo',
    type: 'pickup',
    start: DateTime.now().add(const Duration(hours: 2)),
    status: 'unowned',
    createdVia: 'generated',
  );
  final claimedByMe = TaskItem(
    id: 'mine1',
    familyMemberId: 'theo',
    type: 'dropoff',
    start: DateTime.now().add(const Duration(hours: 3)),
    status: 'owned',
    ownerMemberId: 'dad',
    createdVia: 'generated',
  );
  final claimedByMom = TaskItem(
    id: 'moms1',
    familyMemberId: 'theo',
    type: 'dropoff',
    start: DateTime.now().add(const Duration(hours: 4)),
    status: 'owned',
    ownerMemberId: 'mom',
    createdVia: 'generated',
  );

  Widget app() => ProviderScope(
        overrides: [
          membersProvider.overrideWith((ref) async => [me, mom, theo]),
          currentMemberProvider.overrideWith((ref) async => me),
          unownedTasksProvider.overrideWith((ref) async => [unowned]),
          allTasksProvider
              .overrideWith((ref) async => [unowned, claimedByMe, claimedByMom]),
          pendingDecisionsProvider.overrideWith((ref) async => const []),
          calendarEventsProvider.overrideWith((ref) async => const []),
          threadingThresholdProvider.overrideWith((ref) async => 30),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: HomeScreen()),
        ),
      );

  testWidgets('Home splits unclaimed work from what I am covering (6b)',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    // The unowned task is a claimable "Needs an owner" row; my own claimed
    // task always shows under "You're covering" (trailing "You"). Mom's claimed
    // task stays hidden until opted into via Filters.
    expect(find.text('NEEDS AN OWNER'), findsOneWidget);
    expect(find.text("YOU'RE COVERING"), findsOneWidget);
    expect(find.text('Claim'), findsOneWidget);
    expect(find.text('You'), findsOneWidget);
    expect(find.text('Mom'), findsNothing);
  });

  testWidgets("Filters opts another caretaker's claimed tasks into You're covering",
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Filters'));
    await tester.pumpAndSettle();
    expect(find.text('Also show claimed by'), findsOneWidget);

    // Opt into Mom's claimed tasks (my own are always shown, so the opt-in list
    // only contains other caretakers).
    await tester.tap(find.text('Mom'));
    await tester.pumpAndSettle();

    final applyFinder = find.textContaining('Apply');
    await tester.scrollUntilVisible(applyFinder, 300,
        scrollable: find.byType(Scrollable).last);
    await tester.pumpAndSettle();
    expect(applyFinder, findsOneWidget);
    await tester.tap(applyFinder);
    await tester.pumpAndSettle();

    // Mom's claimed task now shows as a covering row; mine still shows as "You".
    expect(find.text('Mom'), findsOneWidget);
    expect(find.text('You'), findsOneWidget);
    expect(find.text('Claim'), findsOneWidget); // still just the unowned row
  });
}
