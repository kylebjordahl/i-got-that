import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/member_detail_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/state/nav.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records the unlink call so the test can assert the confirmation actually
/// reached the API, and drops the link from the backing list so a refetch of
/// [feedLinksProvider] sees it gone — same as a real round trip would.
class _FakeApiClient extends ApiClient {
  _FakeApiClient(this.links) : super(baseUrl: 'http://test');
  final List<FeedLink> links;
  String? deletedLinkId;

  @override
  Future<void> deleteMemberLink(
    String familyId,
    String feedId,
    String linkId,
  ) async {
    deletedLinkId = linkId;
    links.removeWhere((l) => l.id == linkId);
  }
}

void main() {
  final admin = Member(
    id: 'dad',
    relationName: 'Dad',
    isCaretaker: true,
    isAdmin: true,
    requiresCaretaker: false,
  );
  final theo = Member(
    id: 'theo',
    relationName: 'Theo',
    isCaretaker: false,
    isAdmin: false,
    requiresCaretaker: true,
  );

  setUp(() {
    routeDepthNotifier.value = 0;
  });

  testWidgets(
    'unlinking a feed closes the confirmation dialog, calls the API, and '
    'returns to the member detail screen',
    (tester) async {
      tester.view.physicalSize = const Size(800, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final feed = FeedItem(
        id: 'f1',
        kind: 'ics',
        mode: 'standard',
        sourceCalendarName: 'School calendar',
      );
      final links = <FeedLink>[
        FeedLink(
          id: 'link1',
          familyMemberId: 'theo',
          active: true,
          position: 0,
        ),
      ];
      final api = _FakeApiClient(links);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(api),
            familyProvider.overrideWith((ref) async => 'fam-1'),
            membersProvider.overrideWith((ref) async => [admin, theo]),
            currentMemberProvider.overrideWith((ref) async => admin),
            feedsProvider.overrideWith((ref) async => [feed]),
            feedLinksProvider('f1').overrideWith((ref) async => List.of(links)),
            accountsProvider.overrideWith(
              (ref) async => const <ExternalAccount>[],
            ),
            memberCalendarProvider.overrideWith((ref, id) async => null),
            calendarEventsProvider.overrideWith((ref) async => const []),
          ],
          child: MaterialApp(
            theme: buildAppTheme(),
            themeMode: ThemeMode.dark,
            // Mirrors `_AuthedRoot` in main.dart: the member detail screen (and
            // the feed setup screen pushed on top of it) live in their own inner
            // Navigator, while dialogs are raised on MaterialApp's outer one.
            // Without that split the pop-through bug this guards can't reproduce.
            home: Stack(
              children: [
                Navigator(
                  key: rootNavigatorKey,
                  observers: [AppNavObserver()],
                  onGenerateRoute: (settings) => MaterialPageRoute(
                    builder: (_) => const MemberDetailScreen(memberId: 'theo'),
                    settings: settings,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Open the feed's setup screen from Source calendars.
      await tester.tap(find.text('School calendar'));
      await tester.pumpAndSettle();
      expect(find.text('Feed setup'), findsOneWidget);

      await tester.tap(find.text('Unlink feed'));
      await tester.pumpAndSettle();
      expect(find.text('Unlink feed?'), findsOneWidget);
      expect(api.deletedLinkId, isNull);

      // Exact match — the screen's own 'Unlink feed' button behind the barrier
      // doesn't collide with the dialog's 'Unlink'.
      await tester.tap(find.text('Unlink'));
      await tester.pumpAndSettle();

      // The dialog must actually close and the request must have gone out. The
      // bug: the dialog's buttons popped through the screen's own context, i.e.
      // the *inner* Navigator, which dismissed the feed setup screen instead —
      // leaving the dialog stranded over the member detail screen with the
      // awaited future never completing, so the unlink never ran.
      expect(find.text('Unlink feed?'), findsNothing);
      expect(api.deletedLinkId, 'link1');
      // ...and the feed setup screen pops itself, back to the member detail.
      expect(find.text('Feed setup'), findsNothing);
      expect(find.text('Family member'), findsOneWidget);
      expect(find.text('No source calendars yet'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
