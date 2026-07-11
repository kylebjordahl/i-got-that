import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/onboarding/onboarding_scaffold.dart';
import 'package:caretaker_app/onboarding/steps/add_members_step.dart';
import 'package:caretaker_app/onboarding/steps/connect_accounts_step.dart';
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
  Widget host(Widget child, {List<Override> overrides = const []}) => ProviderScope(
        overrides: overrides,
        child: MaterialApp(theme: buildAppTheme(), home: child),
      );

  testWidgets('OnboardingScaffold renders chrome and fires callbacks',
      (tester) async {
    var back = 0, finish = 0, go = 0;
    await tester.pumpWidget(host(OnboardingScaffold(
      progress: 0.5,
      onBack: () => back++,
      trailingLabel: 'Finish later',
      onTrailing: () => finish++,
      title: 'Create your family',
      subtitle: 'A subtitle',
      body: const [Text('body content')],
      bottom: OnboardingButton(label: 'Continue', onPressed: () => go++),
    )));
    await tester.pumpAndSettle();

    expect(find.text('Create your family'), findsOneWidget);
    expect(find.text('body content'), findsOneWidget);

    await tester.tap(find.text('Finish later'));
    expect(finish, 1);
    await tester.tap(find.byIcon(Icons.chevron_left_rounded));
    expect(back, 1);
    await tester.tap(find.text('Continue'));
    expect(go, 1);
  });

  testWidgets('1b lists connected accounts and continues', (tester) async {
    var next = 0;
    await tester.pumpWidget(host(
      ConnectAccountsStep(onNext: () => next++),
      overrides: [
        accountsProvider.overrideWith((ref) async => [
              ExternalAccount(
                  id: 'a1', kind: 'icloud', name: 'iCloud', username: 'dad@icloud.com'),
            ]),
      ],
    ));
    await tester.pumpAndSettle();

    expect(find.text('Connect your calendars'), findsOneWidget);
    expect(find.text('iCloud'), findsOneWidget);
    expect(find.text('Connected'), findsOneWidget);
    expect(find.text('Connect another account'), findsOneWidget);

    await tester.tap(find.text('Continue'));
    expect(next, 1);
  });

  testWidgets('1d groups caretakers and children with a You badge',
      (tester) async {
    final dad = _m('dad', 'Dad', caretaker: true, admin: true);
    final mom = _m('mom', 'Mom', caretaker: true);
    final theo = _m('theo', 'Theo', child: true);

    await tester.pumpWidget(host(
      AddMembersStep(onNext: () {}, onBack: () {}, onExit: () {}),
      overrides: [
        membersProvider.overrideWith((ref) async => [dad, mom, theo]),
        currentMemberProvider.overrideWith((ref) async => dad),
      ],
    ));
    await tester.pumpAndSettle();

    expect(find.text('Add your family members'), findsOneWidget);
    expect(find.text('CARETAKERS'), findsOneWidget);
    expect(find.text('CHILDREN'), findsOneWidget);
    expect(find.text('Dad'), findsOneWidget);
    expect(find.text('Mom'), findsOneWidget);
    expect(find.text('Theo'), findsOneWidget);
    expect(find.text('You'), findsOneWidget);
    expect(find.text('Add a caretaker'), findsOneWidget);
    expect(find.text('Add a child'), findsOneWidget);
  });
}
