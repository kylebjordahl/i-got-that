import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/home_screen.dart';
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

  Widget app(List<ExternalAccount> accounts) => ProviderScope(
    overrides: [
      membersProvider.overrideWith((ref) async => [me]),
      currentMemberProvider.overrideWith((ref) async => me),
      unownedTasksProvider.overrideWith((ref) async => const []),
      allTasksProvider.overrideWith((ref) async => const []),
      pendingDecisionsProvider.overrideWith((ref) async => const []),
      conflictsProvider.overrideWith((ref) async => const []),
      calendarEventsProvider.overrideWith((ref) async => const []),
      threadingThresholdProvider.overrideWith((ref) async => 30),
      accountsProvider.overrideWith((ref) async => accounts),
    ],
    child: MaterialApp(
      theme: buildAppTheme(),
      home: const Scaffold(body: HomeScreen()),
    ),
  );

  ExternalAccount google({DateTime? authFailedAt, String id = 'acc-1'}) =>
      ExternalAccount.fromJson({
        'id': id,
        'kind': 'google',
        'name': 'kyle@example.com',
        'username': 'kyle@example.com',
        'authFailedAt': authFailedAt?.toIso8601String(),
      });

  testWidgets('asks the owner to reconnect a Google account that stopped '
      'authenticating', (tester) async {
    await tester.pumpWidget(
      app([google(authFailedAt: DateTime(2026, 9, 27)), google(id: 'acc-2')]),
    );
    await tester.pumpAndSettle();

    expect(find.text('NEEDS RECONNECTING'), findsOneWidget);
    expect(find.text('Google · kyle@example.com'), findsOneWidget);
    expect(find.text('Reconnect'), findsOneWidget);
  });

  testWidgets('shows nothing when every account is healthy', (tester) async {
    await tester.pumpWidget(app([google()]));
    await tester.pumpAndSettle();

    expect(find.text('NEEDS RECONNECTING'), findsNothing);
    expect(find.text('Reconnect'), findsNothing);
  });
}
