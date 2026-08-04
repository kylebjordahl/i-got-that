import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/member_detail_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/widgets/conflict_card.dart';
import 'package:caretaker_app/widgets/primitives.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Member _m(
  String id,
  String name, {
  bool caretaker = false,
  bool admin = false,
  bool child = false,
  String? userId,
}) => Member(
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
  Future<Map<String, dynamic>> issueMemberInvite(
    String familyId,
    String memberId,
  ) async => {
    'token': 'fake-invite-token',
    'expiresAt': DateTime.now().add(const Duration(days: 14)).toIso8601String(),
  };
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

  testWidgets(
    'one member-detail screen serves a child: the three 6e sections render',
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
    },
  );

  testWidgets('the same screen serves a caretaker', (tester) async {
    await pumpTall(tester, app('dad'));

    expect(find.text('Family member'), findsOneWidget);
    expect(find.text('Can claim tasks'), findsOneWidget);
    expect(find.text('SOURCE CALENDARS'), findsOneWidget);
    expect(find.text('FAMILY LOGISTICS'), findsOneWidget);
  });

  testWidgets(
    'an admin sees an "Invite link" section, just above Source calendars, '
    'for a member with no login yet',
    (tester) async {
      await pumpTall(tester, app('theo'));

      expect(find.text('INVITE LINK'), findsOneWidget);
      expect(find.text('No active invite yet'), findsOneWidget);
      expect(find.text('Generate'), findsOneWidget);

      // Ordering: below the profile card / above Source calendars.
      final invite = tester.getTopLeft(find.text('INVITE LINK'));
      final sources = tester.getTopLeft(find.text('SOURCE CALENDARS'));
      expect(invite.dy, lessThan(sources.dy));
    },
  );

  testWidgets('no invite section once the member already has a login', (
    tester,
  ) async {
    final linked = _m('theo', 'Theo', child: true, userId: 'user-theo');
    await pumpTall(
      tester,
      ProviderScope(
        overrides: [
          membersProvider.overrideWith((ref) async => [me, linked]),
          currentMemberProvider.overrideWith((ref) async => me),
          feedsProvider.overrideWith((ref) async => const <FeedItem>[]),
          accountsProvider.overrideWith(
            (ref) async => const <ExternalAccount>[],
          ),
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

    expect(find.text('INVITE LINK'), findsNothing);
  });

  testWidgets(
    'reorderable source-calendars list gets its own local Overlay so the '
    'drag proxy stays contained instead of painting over Unified calendar',
    (tester) async {
      final feedA = FeedItem(id: 'f1', kind: 'ics', mode: 'standard');
      final feedB = FeedItem(id: 'f2', kind: 'google', mode: 'standard');
      final linkA = FeedLink(
        id: 'link1',
        familyMemberId: 'theo',
        active: true,
        position: 0,
      );
      final linkB = FeedLink(
        id: 'link2',
        familyMemberId: 'theo',
        active: true,
        position: 1,
      );

      await pumpTall(
        tester,
        ProviderScope(
          overrides: [
            membersProvider.overrideWith((ref) async => [me, theo]),
            currentMemberProvider.overrideWith((ref) async => me),
            feedsProvider.overrideWith((ref) async => [feedA, feedB]),
            feedLinksProvider('f1').overrideWith((ref) async => [linkA]),
            feedLinksProvider('f2').overrideWith((ref) async => [linkB]),
            accountsProvider.overrideWith(
              (ref) async => const <ExternalAccount>[],
            ),
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

      expect(find.byType(ReorderableListView), findsOneWidget);
      expect(find.textContaining('Drag to set priority'), findsOneWidget);
      // The MaterialApp/Navigator always contributes one root Overlay. Seeing a
      // second one proves the reorderable list has its own local Overlay
      // (Overlay.wrap) to float and clip its drag proxy in, rather than
      // escaping to the app-level overlay and painting over whatever renders
      // below it (the Unified calendar section).
      expect(find.byType(Overlay), findsNWidgets(2));
    },
  );

  group('overrides in effect', () {
    Conflict conflict(String id, String loserSummary, {Duration? offset}) {
      final start = DateTime.now().add(offset ?? const Duration(hours: 2));
      return Conflict(
        id: id,
        familyMemberId: 'theo',
        loser: ConflictEventRef(
          start: start,
          end: start.add(const Duration(hours: 2)),
          allDay: false,
          summary: loserSummary,
        ),
        winner: ConflictEventRef(
          start: start,
          end: start.add(const Duration(hours: 1)),
          allDay: false,
          summary: 'Dentist',
        ),
      );
    }

    Widget appWith(List<Conflict> overrides) => ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(_FakeApiClient()),
        familyProvider.overrideWith((ref) async => 'fam-1'),
        membersProvider.overrideWith((ref) async => [me, theo]),
        currentMemberProvider.overrideWith((ref) async => me),
        feedsProvider.overrideWith((ref) async => const <FeedItem>[]),
        accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
        memberCalendarProvider.overrideWith((ref, id) async => null),
        calendarEventsProvider.overrideWith((ref) async => const []),
        memberOverridesProvider.overrideWith((ref, id) async => overrides),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const MemberDetailScreen(memberId: 'theo'),
      ),
    );

    testWidgets(
      'the list itself moved off the section — only a button remains',
      (tester) async {
        await pumpTall(
          tester,
          appWith([conflict('c1', 'Soccer'), conflict('c2', 'Piano')]),
        );

        expect(find.text('Overrides in effect'), findsOneWidget);
        expect(
          find.text('2 events split by a conflict decision'),
          findsOneWidget,
        );
        // The cards (and their revert controls) live in the sheet now.
        expect(find.text('Soccer'), findsNothing);
        expect(find.text('Revert'), findsNothing);
      },
    );

    testWidgets('no button at all when nothing is in effect', (tester) async {
      // Only a past override: already ended, so it never counted as active.
      await pumpTall(
        tester,
        appWith([conflict('c1', 'Soccer', offset: const Duration(days: -3))]),
      );

      expect(find.text('Overrides in effect'), findsNothing);
      expect(find.textContaining('split by a conflict decision'), findsNothing);
    });

    testWidgets(
      'tapping the button opens the sheet with the revertable cards',
      (tester) async {
        await pumpTall(tester, appWith([conflict('c1', 'Soccer')]));

        expect(
          find.text('1 event split by a conflict decision'),
          findsOneWidget,
        );
        await tester.tap(find.text('Overrides in effect'));
        await tester.pumpAndSettle();

        // Sheet title (the button's own title is still mounted behind it).
        expect(find.text('Overrides in effect'), findsNWidgets(2));
        expect(find.text('Revert'), findsOneWidget);
      },
    );

    testWidgets(
      'each card names both events in priority order, under the day and the '
      "member's avatar",
      (tester) async {
        await pumpTall(tester, appWith([conflict('c1', 'Soccer')]));
        await tester.tap(find.text('Overrides in effect'));
        await tester.pumpAndSettle();

        // Both events, kept one first — order is what carries the priority.
        final winner = tester.getTopLeft(find.text('Dentist'));
        final loser = tester.getTopLeft(find.text('Soccer'));
        expect(winner.dy, lessThan(loser.dy));

        // Day on the left of the top line, the member (avatar + name) opposite it.
        final header = find.byType(ConflictCardHeader);
        final day = find.descendant(
          of: header,
          matching: find.text(tester.widget<ConflictCardHeader>(header).day),
        );
        expect(day, findsOneWidget);
        final avatar = find.descendant(
          of: header,
          matching: find.byType(PersonAvatar),
        );
        expect(avatar, findsOneWidget);
        expect(tester.getTopLeft(day).dy, lessThan(winner.dy));
        expect(
          tester.getTopLeft(day).dx,
          lessThan(tester.getTopLeft(avatar).dx),
        );
      },
    );
  });

  testWidgets('generating an invite link shows the token to copy/share', (
    tester,
  ) async {
    await pumpTall(
      tester,
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(_FakeApiClient()),
          familyProvider.overrideWith((ref) async => 'fam-1'),
          membersProvider.overrideWith((ref) async => [me, theo]),
          currentMemberProvider.overrideWith((ref) async => me),
          feedsProvider.overrideWith((ref) async => const <FeedItem>[]),
          accountsProvider.overrideWith(
            (ref) async => const <ExternalAccount>[],
          ),
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
