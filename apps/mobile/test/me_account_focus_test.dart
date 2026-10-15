import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/me_screen.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/state/push_taps.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('Me brings the account a reauth push named into view', (
    tester,
  ) async {
    final me = Member(
      id: 'me',
      relationName: 'Me',
      isCaretaker: true,
      isAdmin: false,
      requiresCaretaker: false,
    );
    final failing = ExternalAccount.fromJson({
      'id': 'acc-broken',
      'kind': 'google',
      'name': 'work@example.com',
      'username': 'work@example.com',
      'authFailedAt': '2026-09-27T23:16:11.000Z',
    });
    final container = ProviderContainer(
      overrides: [
        currentMemberProvider.overrideWith((ref) async => me),
        familyInfoProvider.overrideWith(
          (ref) async => (name: 'Test Family', count: 1),
        ),
        accountsProvider.overrideWith((ref) async => [failing]),
        loginIdentitiesProvider.overrideWith(
          (ref) async => const <LoginIdentity>[],
        ),
      ],
    );
    addTearDown(container.dispose);
    container.read(focusedAccountIdProvider.notifier).state = 'acc-broken';

    // A short viewport, so the row has to be scrolled to.
    tester.view.physicalSize = const Size(400, 300);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: buildAppTheme(),
          home: const Scaffold(body: MeScreen()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(container.read(focusedAccountIdProvider), isNull);
    expect(find.text('Needs reconnect'), findsOneWidget);
    final row = tester.getRect(find.text('work@example.com'));
    expect(row.top, greaterThanOrEqualTo(0));
    expect(row.bottom, lessThanOrEqualTo(300));

    // The highlight is brief.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });
}
