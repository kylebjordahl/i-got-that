import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/family_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/state/nav.dart';
import 'package:caretaker_app/widgets/app_bottom_nav.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Fakes the one endpoint the add-member flow calls, storing the created
/// member in [backend] so a subsequent [membersProvider] refetch sees it —
/// same as a real API round trip would.
class _FakeApiClient extends ApiClient {
  _FakeApiClient(this.backend) : super(baseUrl: 'http://test');
  final List<Member> backend;

  @override
  Future<Map<String, dynamic>> createMember(
    String familyId, {
    required String relationName,
    bool isCaretaker = false,
    bool isAdmin = false,
    bool requiresCaretaker = false,
  }) async {
    final member = Member(
      id: 'new-member',
      relationName: relationName,
      isCaretaker: isCaretaker,
      isAdmin: isAdmin,
      requiresCaretaker: requiresCaretaker,
    );
    backend.add(member);
    return {
      'member': {
        'id': member.id,
        'relationName': member.relationName,
        'isCaretaker': member.isCaretaker,
        'isAdmin': member.isAdmin,
        'requiresCaretaker': member.requiresCaretaker,
      },
    };
  }
}

void main() {
  // Mirrors `_AuthedRoot` in main.dart: [FamilyScreen] lives in its own
  // Navigator (keyed by [rootNavigatorKey]), with [PersistentAppNav] — whose
  // "+" drives the whole add-member flow — stacked above it.
  Widget authedRoot() => Stack(
        children: [
          Navigator(
            key: rootNavigatorKey,
            observers: [AppNavObserver()],
            // A bare `Scaffold` stand-in for `AppShell` — enough of a
            // Material ancestor for FamilyScreen's InkWells, without pulling
            // in the other three tabs' own provider dependencies.
            onGenerateRoute: (settings) => MaterialPageRoute(
              builder: (_) => const Scaffold(body: FamilyScreen()),
              settings: settings,
            ),
          ),
          const PersistentAppNav(),
        ],
      );

  setUp(() {
    // Shared ValueNotifier — reset between tests so depth from a previous
    // run doesn't hide the "+" button.
    routeDepthNotifier.value = 0;
  });

  testWidgets(
      'adding a member closes the naming dialog and leaves Family screen intact, '
      'instead of leaving the dialog stuck over a blank screen', (tester) async {
    final admin = Member(
      id: 'dad',
      relationName: 'Dad',
      isCaretaker: true,
      isAdmin: true,
      requiresCaretaker: false,
    );
    final backend = <Member>[admin];

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(_FakeApiClient(backend)),
          familyProvider.overrideWith((ref) async => 'fam-1'),
          familyInfoProvider.overrideWith((ref) async => (name: 'Test Family', count: 1)),
          currentMemberProvider.overrideWith((ref) async => admin),
          membersProvider.overrideWith((ref) async => List.of(backend)),
          navIndexProvider.overrideWith((ref) => 2), // Family tab: "+" only shows here
          // The pushed MemberDetailScreen's other sections — irrelevant here,
          // just need to resolve without a real network call.
          feedsProvider.overrideWith((ref) async => const <FeedItem>[]),
          accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
          memberCalendarProvider.overrideWith((ref, id) async => null),
          calendarEventsProvider.overrideWith((ref) async => const []),
        ],
        child: MaterialApp(home: authedRoot()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Test Family'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.add_rounded));
    await tester.pumpAndSettle();
    expect(find.text('Add a caretaker'), findsOneWidget);

    await tester.tap(find.text('Add a caretaker'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'Grandma');
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    // The naming dialog must actually close...
    expect(find.byType(AlertDialog), findsNothing);
    // ...and the flow must reach the pushed detail screen for the new
    // member. Both only happen if `Continue`'s pop actually dismissed the
    // dialog rather than (the bug) popping the inner content Navigator's
    // sole route out from under it, which left the dialog stuck forever
    // (the awaited `showDialog` future never completing) over a Navigator
    // with zero routes.
    expect(find.text('Grandma'), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}
