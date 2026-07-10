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

  testWidgets('Home shows only unclaimed tasks by default — even my own claimed ones hide',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    // Only the unowned task renders a claimable row; the two owned tasks
    // (mine and Mom's) are both hidden until opted into via Filters.
    expect(find.text('Claim'), findsOneWidget);
    expect(find.text('You'), findsNothing);
  });

  testWidgets("Filters lets a caretaker's claimed tasks back in, opt-in per person",
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    await tester.tap(find.text('Filters'));
    await tester.pumpAndSettle();
    expect(find.text('Also show claimed by'), findsOneWidget);

    // Opt into Dad's (my own) claimed tasks via the "You" chip.
    await tester.tap(find.text('You'));
    await tester.pumpAndSettle();

    final applyFinder = find.textContaining('Apply');
    await tester.scrollUntilVisible(applyFinder, 300,
        scrollable: find.byType(Scrollable).last);
    await tester.pumpAndSettle();
    expect(applyFinder, findsOneWidget);
    await tester.tap(applyFinder);
    await tester.pumpAndSettle();

    // My claimed task now shows inline as "You"; Mom's stays hidden.
    expect(find.text('You'), findsOneWidget);
    expect(find.text('Claim'), findsOneWidget); // still just the unowned row
  });
}
