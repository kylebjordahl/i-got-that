import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/family_screen.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final me = Member(
    id: 'dad',
    relationName: 'Dad',
    isCaretaker: true,
    isAdmin: true,
    requiresCaretaker: false,
  );

  Future<void> pumpTall(WidgetTester tester, Widget widget) async {
    tester.view.physicalSize = const Size(800, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(widget);
    await tester.pumpAndSettle();
  }

  Widget screen(List<Override> overrides) => ProviderScope(
        overrides: overrides,
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: FamilyScreen()),
        ),
      );

  testWidgets('the header is a plain title when the account has only one family',
      (tester) async {
    await pumpTall(
      tester,
      screen([
        membersProvider.overrideWith((ref) async => [me]),
        currentMemberProvider.overrideWith((ref) async => me),
        familyProvider.overrideWith((ref) async => 'fam-1'),
        familiesListProvider.overrideWith((ref) async => [(id: 'fam-1', name: 'The Smiths')]),
      ]),
    );

    expect(find.text('The Smiths'), findsOneWidget);
    expect(find.byIcon(Icons.unfold_more_rounded), findsNothing);
  });

  testWidgets(
      'the header becomes a select control once there is more than one family, '
      'and switching updates the selected family', (tester) async {
    final container = ProviderContainer(overrides: [
      membersProvider.overrideWith((ref) async => [me]),
      currentMemberProvider.overrideWith((ref) async => me),
      familyProvider.overrideWith((ref) async => 'fam-1'),
      familiesListProvider.overrideWith((ref) async => [
        (id: 'fam-1', name: 'The Smiths'),
        (id: 'fam-2', name: 'The Joneses'),
      ]),
    ]);
    addTearDown(container.dispose);

    await pumpTall(
      tester,
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: FamilyScreen()),
        ),
      ),
    );

    // The select affordance only shows up once there's something to switch to.
    expect(find.byIcon(Icons.unfold_more_rounded), findsOneWidget);
    expect(container.read(selectedFamilyIdProvider), isNull);

    await tester.tap(find.byIcon(Icons.unfold_more_rounded));
    await tester.pumpAndSettle();

    expect(find.text('Switch family'), findsOneWidget);
    expect(find.text('The Joneses'), findsOneWidget);

    await tester.tap(find.text('The Joneses'));
    await tester.pumpAndSettle();

    expect(container.read(selectedFamilyIdProvider), 'fam-2');
  });
}
