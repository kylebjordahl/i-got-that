import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/member_detail_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Member _m(String id, String name,
        {bool caretaker = false, bool admin = false, bool child = false, String? userId}) =>
    Member(
      id: id,
      relationName: name,
      isCaretaker: caretaker,
      isAdmin: admin,
      requiresCaretaker: child,
      userId: userId,
    );

/// Fakes the invite-issuing endpoint so the "Invite link" section can be
/// exercised without a real network call.
class _FakeApiClient extends ApiClient {
  _FakeApiClient() : super(baseUrl: 'http://test');

  @override
  Future<Map<String, dynamic>> issueMemberInvite(String familyId, String memberId) async =>
      {'token': 'fake-invite-token', 'expiresAt': DateTime.now().add(const Duration(days: 14)).toIso8601String()};
}

void main() {
  final me = _m('dad', 'Dad', caretaker: true, admin: true);
  final theo = _m('theo', 'Theo', child: true);

  // Tall viewport so the whole lazily-built ListView renders in one frame.
  setUp(() {
    TestWidgetsFlutterBinding.ensureInitialized();
  });
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

  Widget app(String memberId) => ProviderScope(
        overrides: [
          membersProvider.overrideWith((ref) async => [me, theo]),
          currentMemberProvider.overrideWith((ref) async => me),
          feedsProvider.overrideWith((ref) async => const <FeedItem>[]),
          accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
          memberCalendarProvider.overrideWith((ref, id) async => null),
          calendarEventsProvider.overrideWith((ref) async => const []),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: MemberDetailScreen(memberId: memberId),
        ),
      );

  testWidgets('one member-detail screen serves a child: the three 6e sections render',
      (tester) async {
    await pumpTall(tester, app('theo'));

    expect(find.text('Family member'), findsOneWidget);
    expect(find.textContaining('Child'), findsWidgets); // grouping tag only
    expect(find.text('SOURCE CALENDARS'), findsOneWidget);
    expect(find.text('UNIFIED CALENDAR'), findsOneWidget);
    expect(find.text('FAMILY LOGISTICS'), findsOneWidget);
    // Task claiming is merged into Family logistics (its own section is gone).
    expect(find.text('Generate family tasks'), findsOneWidget);
    expect(find.text('Can claim tasks'), findsOneWidget);
    // Admin access moved to the editor (6h) — not on the detail screen.
    expect(find.text('Admin access'), findsNothing);
    // No connected accounts ⇒ the "no accounts" unconfigured target state (6j).
    expect(find.text('No calendar accounts'), findsOneWidget);
  });

  testWidgets('the same screen serves a caretaker', (tester) async {
    await pumpTall(tester, app('dad'));

    expect(find.text('Family member'), findsOneWidget);
    expect(find.text('Can claim tasks'), findsOneWidget);
    expect(find.text('SOURCE CALENDARS'), findsOneWidget);
    expect(find.text('FAMILY LOGISTICS'), findsOneWidget);
  });

  testWidgets(
      'an admin sees an "Invite link" section, just above Source calendars, '
      'for a member with no login yet', (tester) async {
    await pumpTall(tester, app('theo'));

    expect(find.text('INVITE LINK'), findsOneWidget);
    expect(find.text('No active invite yet'), findsOneWidget);
    expect(find.text('Generate'), findsOneWidget);

    // Ordering: below the profile card / above Source calendars.
    final invite = tester.getTopLeft(find.text('INVITE LINK'));
    final sources = tester.getTopLeft(find.text('SOURCE CALENDARS'));
    expect(invite.dy, lessThan(sources.dy));
  });

  testWidgets('no invite section once the member already has a login', (tester) async {
    final linked = _m('theo', 'Theo', child: true, userId: 'user-theo');
    await pumpTall(tester, ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [me, linked]),
        currentMemberProvider.overrideWith((ref) async => me),
        feedsProvider.overrideWith((ref) async => const <FeedItem>[]),
        accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
        memberCalendarProvider.overrideWith((ref, id) async => null),
        calendarEventsProvider.overrideWith((ref) async => const []),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const MemberDetailScreen(memberId: 'theo'),
      ),
    ));

    expect(find.text('INVITE LINK'), findsNothing);
  });

  testWidgets('generating an invite link shows the token to copy/share', (tester) async {
    await pumpTall(
      tester,
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(_FakeApiClient()),
          familyProvider.overrideWith((ref) async => 'fam-1'),
          membersProvider.overrideWith((ref) async => [me, theo]),
          currentMemberProvider.overrideWith((ref) async => me),
          feedsProvider.overrideWith((ref) async => const <FeedItem>[]),
          accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
          memberCalendarProvider.overrideWith((ref, id) async => null),
          calendarEventsProvider.overrideWith((ref) async => const []),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const MemberDetailScreen(memberId: 'theo'),
        ),
      ),
    );

    await tester.tap(find.text('Generate'));
    await tester.pumpAndSettle();

    expect(find.text('fake-invite-token'), findsOneWidget);
    expect(find.text('No active invite yet'), findsNothing);
  });
}
