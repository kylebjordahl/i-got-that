import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/me_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/state/nav.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/widgets/app_bottom_nav.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeApiClient extends ApiClient {
  _FakeApiClient() : super(baseUrl: 'http://test');
}

/// Keeps the "Default family" flow off the real Keychain plugin, which isn't
/// available in the widget-test environment.
class _FakeDefaultFamilyController extends DefaultFamilyController {
  @override
  Future<void> set(String? familyId) async {
    state = AsyncValue.data(familyId);
  }
}

void main() {
  final me = Member(
    id: 'dad',
    relationName: 'Dad',
    isCaretaker: true,
    isAdmin: true,
    requiresCaretaker: false,
  );

  Future<void> pumpTall(WidgetTester tester, Widget widget) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(widget);
    await tester.pumpAndSettle();
  }

  List<Override> baseOverrides() => [
        apiClientProvider.overrideWithValue(_FakeApiClient()),
        currentMemberProvider.overrideWith((ref) async => me),
        accountsProvider.overrideWith((ref) async => const []),
        loginIdentitiesProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
        defaultFamilyIdProvider.overrideWith((ref) => _FakeDefaultFamilyController()),
      ];

  testWidgets('no "Default family" setting shows when the account has only one family',
      (tester) async {
    await pumpTall(
      tester,
      ProviderScope(
        overrides: [
          ...baseOverrides(),
          familyInfoProvider.overrideWith((ref) async => (name: 'The Smiths', count: 1)),
          familiesListProvider.overrideWith((ref) async => [(id: 'fam-1', name: 'The Smiths')]),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: MeScreen()),
        ),
      ),
    );

    expect(find.text('Default family'), findsNothing);
  });

  testWidgets(
      'picking a "Default family" updates the setting and its subtitle notes it is '
      'device-only', (tester) async {
    final container = ProviderContainer(overrides: [
      ...baseOverrides(),
      familyInfoProvider.overrideWith((ref) async => (name: 'The Smiths', count: 2)),
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
          home: const Scaffold(body: MeScreen()),
        ),
      ),
    );

    expect(find.text('Default family'), findsOneWidget);
    expect(find.textContaining('Account default · only affects this device'), findsOneWidget);

    await tester.tap(find.text('Default family'));
    await tester.pumpAndSettle();

    expect(find.textContaining('only affects this device'), findsWidgets);

    await tester.tap(find.text('The Joneses'));
    await tester.pumpAndSettle();

    expect(container.read(defaultFamilyIdProvider).value, 'fam-2');
    expect(find.textContaining('The Joneses · only affects this device'), findsOneWidget);
  });

  // Mirrors `_AuthedRoot` in main.dart: MeScreen lives in its own Navigator
  // (keyed by [rootNavigatorKey]) with [PersistentAppNav] stacked above — the
  // two tests above use a bare `MaterialApp(home: ...)` with a single implicit
  // Navigator, which can't reproduce the outer-context pop bug (there's only
  // one Navigator for `Navigator.of(context)` to resolve to either way). This
  // nested structure is what actually makes it reproducible.
  testWidgets(
      'picking a "Default family" closes the sheet and keeps the Me screen '
      'intact, instead of leaving a blank screen', (tester) async {
    routeDepthNotifier.value = 0;
    final container = ProviderContainer(overrides: [
      ...baseOverrides(),
      familyInfoProvider.overrideWith((ref) async => (name: 'The Smiths', count: 2)),
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
          home: Stack(
            children: [
              Navigator(
                key: rootNavigatorKey,
                observers: [AppNavObserver()],
                onGenerateRoute: (settings) => MaterialPageRoute(
                  builder: (_) => const Scaffold(body: MeScreen()),
                  settings: settings,
                ),
              ),
              const PersistentAppNav(),
            ],
          ),
        ),
      ),
    );

    await tester.tap(find.text('Default family'));
    await tester.pumpAndSettle();

    expect(find.textContaining('only affects this device'), findsWidgets);
    await tester.tap(find.text('The Joneses'));
    await tester.pumpAndSettle();

    // The sheet must actually close, and MeScreen must still be mounted — both
    // only hold if the row's pop dismissed the sheet (on MaterialApp's outer
    // Navigator) rather than (the bug) popping the inner content Navigator's
    // sole route out from under it and leaving a blank screen.
    expect(find.byType(MeScreen), findsOneWidget);
    expect(container.read(defaultFamilyIdProvider).value, 'fam-2');
    expect(tester.takeException(), isNull);
  });
}
