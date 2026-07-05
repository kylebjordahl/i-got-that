import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/plan_screen.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Member _m(String id, String name, {bool caretaker = false, bool child = false}) => Member(
      id: id,
      relationName: name,
      isCaretaker: caretaker,
      requiresCaretaker: child,
      isAdmin: false,
    );

void main() {
  testWidgets('Plan renders the day scroller + grid without overflow', (tester) async {
    final now = DateTime.now();
    final tasks = [
      TaskItem(
        id: 't1',
        familyMemberId: 'theo',
        type: 'dropoff',
        start: DateTime(now.year, now.month, now.day, 8),
        status: 'unowned',
        sourceEventId: 'e1',
      ),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        allTasksProvider.overrideWith((ref) async => tasks),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // Header + controls render (and no RenderFlex overflow was thrown above).
    expect(find.text('Plan'), findsOneWidget);
    expect(find.text('Today'), findsOneWidget);
    expect(find.text('Filters'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('grid expands past the default window to fit an evening event',
      (tester) async {
    final now = DateTime.now();
    // A 9 PM event is well past the 7 PM default end — the grid must grow to show
    // it (rather than clipping it at the bottom of a fixed window).
    final tasks = [
      TaskItem(
        id: 't1',
        familyMemberId: 'theo',
        type: 'dropoff',
        start: DateTime(now.year, now.month, now.day, 21, 0),
        status: 'unowned',
        sourceEventId: 'e1',
      ),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        allTasksProvider.overrideWith((ref) async => tasks),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // Hour labels now extend to the evening (default window stopped at 7 PM).
    expect(find.text('9 PM'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
