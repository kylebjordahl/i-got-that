import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/onboarding/join/joined_step.dart';
import 'package:caretaker_app/onboarding/onboarding_flow.dart';
import 'package:caretaker_app/onboarding/onboarding_scaffold.dart';
import 'package:caretaker_app/onboarding/steps/add_members_step.dart';
import 'package:caretaker_app/onboarding/steps/complete_step.dart';
import 'package:caretaker_app/onboarding/steps/connect_accounts_step.dart';
import 'package:caretaker_app/onboarding/steps/parent_unified_step.dart';
import 'package:caretaker_app/onboarding/wizard_outcomes.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeApiClient extends ApiClient {
  _FakeApiClient() : super(baseUrl: 'http://test');
}

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

  group('1g runs for every adult, not just the signed-in user', () {
    final dad = _m('dad', 'Dad', caretaker: true, admin: true);
    final mom = _m('mom', 'Mom', caretaker: true);
    final adults = [dad, mom];

    Future<List<Member>> adultsFor(List<Member> members, Member? self) async {
      final container = ProviderContainer(overrides: [
        membersProvider.overrideWith((ref) async => members),
        currentMemberProvider.overrideWith((ref) async => self),
      ]);
      addTearDown(container.dispose);
      return container.read(wizardAdultsProvider.future);
    }

    test('the loop covers every caretaker, signed-in user first', () async {
      final grandma = _m('gran', 'Grandma', caretaker: true);
      final theo = _m('theo', 'Theo', child: true);

      final got = await adultsFor([mom, grandma, dad, theo], dad);

      // Every caretaker gets a turn — the old flow only ever did self — and
      // children are not part of this loop.
      expect(got.map((m) => m.relationName), ['Dad', 'Mom', 'Grandma']);
    });

    test('self still gets a turn when their row is not flagged a caretaker',
        () async {
      final lurker = _m('lurker', 'Dad');
      final got = await adultsFor([mom, lurker], lurker);
      expect(got.map((m) => m.id), ['lurker', 'mom']);
    });

    List<Override> picker() => [
          apiClientProvider.overrideWithValue(_FakeApiClient()),
          accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
        ];

    testWidgets("the signed-in user's turn is first and speaks in second person",
        (tester) async {
      await tester.pumpWidget(host(
        ParentUnifiedStep(
          adult: dad,
          adults: adults,
          adultIndex: 0,
          isSelf: true,
          nextAdultName: 'Mom',
          onNext: (_) {},
          onBack: () {},
          onExit: () {},
        ),
        overrides: picker(),
      ));
      await tester.pumpAndSettle();

      expect(find.text('Your unified calendar'), findsOneWidget);
      expect(find.text('Caretaker 1 of 2'), findsOneWidget);
      // Not the last adult, so it hands off rather than finishing.
      expect(find.text('Continue · next is Mom'), findsOneWidget);
      expect(find.text('Finish setup'), findsNothing);
    });

    testWidgets("a co-parent's turn is titled for them and is skippable",
        (tester) async {
      bool? done;
      await tester.pumpWidget(host(
        ParentUnifiedStep(
          adult: mom,
          adults: adults,
          adultIndex: 1,
          isSelf: false,
          nextAdultName: null,
          onNext: (d) => done = d,
          onBack: () {},
          onExit: () {},
        ),
        overrides: picker(),
      ));
      await tester.pumpAndSettle();

      expect(find.text("Mom's unified calendar"), findsOneWidget);
      expect(find.text('Caretaker 2 of 2'), findsOneWidget);
      expect(find.text('Finish setup'), findsOneWidget);

      await tester.tap(find.text('Skip — Mom picks their own on join'));
      expect(done, false);
    });
  });

  group('summaries receipt what actually happened', () {
    final dad = _m('dad', 'Dad', caretaker: true, admin: true);
    final mom = _m('mom', 'Mom', caretaker: true);

    Future<void> pumpComplete(WidgetTester tester, WizardOutcomes outcomes) async {
      await tester.pumpWidget(host(
        CompleteStep(outcomes: outcomes, onGoHome: () {}),
        overrides: [
          apiClientProvider.overrideWithValue(_FakeApiClient()),
          accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
          familyInfoProvider.overrideWith((ref) async => (name: 'Rivera Family', count: 2)),
          membersProvider.overrideWith((ref) async => [dad, mom]),
          currentMemberProvider.overrideWith((ref) async => dad),
        ],
      ));
      await tester.pumpAndSettle();
    }

    testWidgets('1h checks off completed steps and flags skipped ones',
        (tester) async {
      await pumpComplete(
          tester,
          const WizardOutcomes(
            accountsConnected: false,
            adultCalendars: {'dad': true, 'mom': false},
          ));

      // Skipped 1b, and Mom's 1g, must not read as done.
      expect(find.text('No calendar accounts connected'), findsOneWidget);
      expect(find.text('No calendar yet for Mom'), findsOneWidget);
      expect(find.text("They'll pick their own when they join."), findsOneWidget);
      // What the user did do still gets its check.
      expect(find.text('Your calendar ready to claim onto'), findsOneWidget);
      expect(find.text('Rivera Family created · 2 members'), findsOneWidget);
    });

    testWidgets('1h says nothing was skipped when everything was done',
        (tester) async {
      await pumpComplete(
          tester,
          const WizardOutcomes(
            accountsConnected: true,
            adultCalendars: {'dad': true, 'mom': true},
          ));

      expect(find.text('Unified calendar for Mom'), findsOneWidget);
      expect(find.text('Your calendar ready to claim onto'), findsOneWidget);
      expect(find.byIcon(Icons.remove_rounded), findsNothing);
    });

    testWidgets('2d flags a join that skipped the calendar pick', (tester) async {
      await tester.pumpWidget(host(
        JoinedStep(calendarPicked: false, onGoHome: () {}),
        overrides: [
          apiClientProvider.overrideWithValue(_FakeApiClient()),
          familyInfoProvider.overrideWith((ref) async => (name: 'Rivera Family', count: 2)),
          membersProvider.overrideWith((ref) async => [dad, mom]),
          currentMemberProvider.overrideWith((ref) async => mom),
          memberCalendarProvider.overrideWith((ref, memberId) async => null),
        ],
      ));
      await tester.pumpAndSettle();

      expect(find.text('Joined Rivera Family as a caretaker'), findsOneWidget);
      expect(find.text('No unified calendar yet'), findsOneWidget);
      expect(find.text('Your unified calendar connected'), findsNothing);
    });
  });
}
