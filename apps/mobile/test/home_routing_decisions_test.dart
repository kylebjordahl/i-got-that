import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/home_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records what a routing resolution actually asked the API for.
class _RecordingApiClient extends ApiClient {
  _RecordingApiClient() : super(baseUrl: 'http://test');

  Map<String, Object?>? lastResolve;

  @override
  Future<void> resolvePendingDecision(
    String familyId,
    String decisionId, {
    String? startTime,
    String? endTime,
    List<String>? routeToLinkIds,
    String? ruleMatchOp,
    String? ruleMatchValue,
  }) async {
    lastResolve = {
      'decisionId': decisionId,
      'routeToLinkIds': routeToLinkIds,
      'ruleMatchOp': ruleMatchOp,
      'ruleMatchValue': ruleMatchValue,
    };
  }
}

Member _m(
  String id,
  String name, {
  bool caretaker = false,
  bool admin = false,
  bool child = false,
}) => Member(
  id: id,
  relationName: name,
  isCaretaker: caretaker,
  isAdmin: admin,
  requiresCaretaker: child,
);

void main() {
  final me = _m('dad', 'Dad', caretaker: true, admin: true);
  final theo = _m('theo', 'Theo', child: true);
  final bee = _m('bee', 'Bee', child: true);

  // One unrouted event on the shared calendar, asked of both kids — the API
  // returns a row per member, and Home has to show a single card.
  PendingDecision row(String id, String memberId, String linkId) =>
      PendingDecision(
        id: id,
        feedId: 'f1',
        kind: 'routing',
        sourceEventId: 'src-1',
        linkId: linkId,
        familyMemberId: memberId,
        start: DateTime.now().add(const Duration(days: 1)),
        allDay: false,
        summary: 'Swim practice',
      );
  final decisions = [
    row('pd-theo', 'theo', 'link-theo'),
    row('pd-bee', 'bee', 'link-bee'),
  ];

  Widget app(ApiClient api, {Member? asMember}) => ProviderScope(
    overrides: [
      apiClientProvider.overrideWithValue(api),
      familyProvider.overrideWith((ref) async => 'fam-1'),
      membersProvider.overrideWith((ref) async => [me, theo, bee]),
      currentMemberProvider.overrideWith((ref) async => asMember ?? me),
      unownedTasksProvider.overrideWith((ref) async => const []),
      allTasksProvider.overrideWith((ref) async => const []),
      pendingDecisionsProvider.overrideWith((ref) async => decisions),
      conflictsProvider.overrideWith((ref) async => const []),
      calendarEventsProvider.overrideWith((ref) async => const []),
      threadingThresholdProvider.overrideWith((ref) async => 30),
    ],
    child: MaterialApp(
      theme: buildAppTheme(),
      themeMode: ThemeMode.dark,
      home: const Scaffold(body: HomeScreen()),
    ),
  );

  testWidgets('the per-member routing rows show as one "whose is this?" card', (
    tester,
  ) async {
    await tester.pumpWidget(app(_RecordingApiClient()));
    await tester.pumpAndSettle();

    expect(find.text('NEEDS A DECISION'), findsOneWidget);
    // One card, not one per member — and it names the candidates.
    expect(find.text('Resolve'), findsOneWidget);
    expect(find.textContaining('Theo / Bee'), findsOneWidget);
    expect(find.textContaining('who is this for?'), findsOneWidget);
  });

  testWidgets('routing to one child sends just that link, one-off', (
    tester,
  ) async {
    final api = _RecordingApiClient();
    await tester.pumpWidget(app(api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Resolve'));
    await tester.pumpAndSettle();
    expect(find.text('Who is this for?'), findsOneWidget);

    // Nothing picked yet ⇒ nothing to route.
    final button = find.widgetWithText(InkWell, 'Route event');
    expect(tester.widget<InkWell>(button.first).onTap, isNull);

    await tester.tap(find.text('Bee').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Route event'));
    await tester.pumpAndSettle();

    expect(api.lastResolve, {
      // Any row of the group answers for all of them.
      'decisionId': 'pd-theo',
      'routeToLinkIds': ['link-bee'],
      'ruleMatchOp': null,
      'ruleMatchValue': null,
    });
  });

  testWidgets('"every time" sends a rule matching the event title', (
    tester,
  ) async {
    // Tall enough that the expanded rule fields and the footer both fit.
    tester.view.physicalSize = const Size(600, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _RecordingApiClient();
    await tester.pumpWidget(app(api));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Resolve'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Theo').last);
    await tester.tap(find.text('Every time'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Route event'));
    await tester.pumpAndSettle();

    expect(api.lastResolve, {
      'decisionId': 'pd-theo',
      'routeToLinkIds': ['link-theo'],
      'ruleMatchOp': 'contains',
      // Pre-filled from the event that raised the decision.
      'ruleMatchValue': 'Swim practice',
    });
  });

  testWidgets('a non-admin can route the event but is not offered the rule', (
    tester,
  ) async {
    final aunt = _m('aunt', 'Aunt', caretaker: true);
    await tester.pumpWidget(app(_RecordingApiClient(), asMember: aunt));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Resolve'));
    await tester.pumpAndSettle();

    expect(find.text('Who is this for?'), findsOneWidget);
    expect(find.text('Every time'), findsNothing);
  });
}
