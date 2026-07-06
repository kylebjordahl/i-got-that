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

  testWidgets('attendance blocks (owned + unowned) render without overflow',
      (tester) async {
    final now = DateTime.now();
    final tasks = [
      TaskItem(id: 'a', familyMemberId: 'mia', type: 'attendance', start: DateTime(now.year, now.month, now.day, 10), status: 'unowned', sourceEventId: 'e1'),
      TaskItem(id: 'b', familyMemberId: 'theo', type: 'attendance', start: DateTime(now.year, now.month, now.day, 14), status: 'owned', ownerMemberId: 'dad', sourceEventId: 'e2'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
              _m('mia', 'Mia', child: true),
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

  testWidgets('grid defaults its scroll to 7 AM when an early event expands the window',
      (tester) async {
    // Wide (so the header's test-font pills fit) but short, so the grid content
    // is taller than its viewport and actually scrolls.
    tester.view.physicalSize = const Size(800, 480);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final now = DateTime.now();
    final tasks = [
      // A 6 AM event pushes the window's start to 6 AM...
      TaskItem(id: 'a', familyMemberId: 'theo', type: 'dropoff', start: DateTime(now.year, now.month, now.day, 6), status: 'unowned', sourceEventId: 'e1'),
      // ...and a late event makes the grid taller than the viewport so it scrolls.
      TaskItem(id: 'b', familyMemberId: 'theo', type: 'pickup', start: DateTime(now.year, now.month, now.day, 20), status: 'unowned', sourceEventId: 'e2'),
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

    // The grid opens scrolled so 7 AM (one hour = 42px past the 6 AM start) is at
    // the top, rather than showing the expanded 6 AM row.
    final position = Scrollable.of(tester.element(find.text('9 AM'))).position;
    expect(position.pixels, closeTo(42.0, 2.0));
  });
}
