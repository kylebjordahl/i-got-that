import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/me_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/state/nav.dart';
import 'package:caretaker_app/widgets/app_bottom_nav.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records the one endpoint the sign-out flow calls so the test can assert the
/// confirmation dialog actually followed through to a logout — and returns a
/// user from [me] so `AuthController`'s startup restore lands authed.
class _FakeApiClient extends ApiClient {
  _FakeApiClient() : super(baseUrl: 'http://test');
  bool loggedOut = false;

  @override
  Future<Map<String, dynamic>> me() async => {
        'user': {'email': 'you@example.com'},
      };

  @override
  Future<void> logout() async {
    loggedOut = true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // AuthController's native restore reads/deletes the session token from the
  // Keychain; stub the plugin channel so the test drives the real controller
  // without a MissingPluginException.
  setUp(() {
    const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async => null);
    routeDepthNotifier.value = 0;
  });

  tearDown(() {
    const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  // Mirrors `_AuthedRoot` in main.dart: MeScreen lives in its own Navigator
  // (keyed by [rootNavigatorKey]) with [PersistentAppNav] stacked above — the
  // nested Navigator is what makes the outer-context pop bug reproducible.
  Widget authedRoot() => Stack(
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
      );

  testWidgets(
      'confirming the sign-out dialog closes it and logs out, instead of '
      'leaving the dialog stuck over a blank screen', (tester) async {
    final api = _FakeApiClient();
    final me = Member(
      id: 'me',
      relationName: 'Me',
      isCaretaker: true,
      isAdmin: false, // false so the admin-only threading card stays out of the way
      requiresCaretaker: false,
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          currentMemberProvider.overrideWith((ref) async => me),
          familyInfoProvider.overrideWith((ref) async => (name: 'Test Family', count: 1)),
          accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
          loginIdentitiesProvider.overrideWith((ref) async => const <LoginIdentity>[]),
        ],
        child: MaterialApp(home: authedRoot()),
      ),
    );
    await tester.pumpAndSettle();

    // The sign-out button sits at the bottom of the scrolling account screen.
    await tester.scrollUntilVisible(find.text('Sign out'), 300);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign out'));
    await tester.pumpAndSettle();

    expect(find.byType(AlertDialog), findsOneWidget);

    // Confirm from the dialog's own button (the second 'Sign out' on screen).
    await tester.tap(
      find.descendant(of: find.byType(AlertDialog), matching: find.text('Sign out')),
    );
    await tester.pumpAndSettle();

    // The dialog must actually close and the logout must fire. Both only happen
    // if the confirm button's pop dismissed the dialog rather than (the bug)
    // popping the inner content Navigator's sole route out from under it, which
    // left the dialog stuck forever (the awaited `showDialog` future never
    // completing) and the logout never running.
    expect(find.byType(AlertDialog), findsNothing);
    expect(api.loggedOut, isTrue);
    expect(tester.takeException(), isNull);
  });
}
