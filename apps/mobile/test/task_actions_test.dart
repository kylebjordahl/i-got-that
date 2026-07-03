import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/home_screen.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/widgets/task_row.dart';
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

TaskItem _task = TaskItem(
  id: 't1',
  familyMemberId: 'theo',
  type: 'dropoff',
  start: DateTime(2026, 7, 2, 8),
  status: 'unowned',
  sourceEventId: 'e1',
);

void main() {
  testWidgets('long-press on a Home task opens the actions sheet and change-type modal',
      (tester) async {
    final me = _m('dad', 'Dad', caretaker: true, admin: true);
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [me, _m('theo', 'Theo', child: true)]),
        currentMemberProvider.overrideWith((ref) async => me),
        unownedTasksProvider.overrideWith((ref) async => [_task]),
        allTasksProvider.overrideWith((ref) async => [_task]),
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

    // Long-press opens the action sheet with the ported oversight actions.
    await tester.longPress(find.byType(TaskRow));
    await tester.pumpAndSettle();
    expect(find.text('Change type…'), findsOneWidget);
    expect(find.text('Mark task unneeded'), findsOneWidget);
    expect(find.text('Mark event unneeded'), findsOneWidget); // admin + feed task

    // Change type opens the multi-select modal.
    await tester.tap(find.text('Change type…'));
    await tester.pumpAndSettle();
    expect(find.text('Change type'), findsOneWidget);
    expect(find.text('Attendance'), findsOneWidget);
    expect(find.text('Pickup'), findsOneWidget);
  });
}
