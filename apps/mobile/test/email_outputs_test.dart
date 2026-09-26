import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/email_outputs_section.dart';
import 'package:caretaker_app/screens/member_detail_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records what the sheet sends instead of calling the network.
class _FakeApiClient extends ApiClient {
  _FakeApiClient() : super(baseUrl: 'http://test');

  Map<String, dynamic>? created;
  Map<String, dynamic>? updated;

  @override
  Future<Map<String, dynamic>> createEmailOutput(
    String familyId,
    String memberId, {
    required String email,
    String? label,
    required Map<String, dynamic> filters,
  }) async {
    created = {'email': email, 'label': label, 'filters': filters};
    return {'verificationSent': true};
  }

  @override
  Future<Map<String, dynamic>> updateEmailOutput(
    String familyId,
    String memberId,
    String outputId, {
    String? label,
    bool clearLabel = false,
    Map<String, dynamic>? filters,
    bool? active,
  }) async {
    updated = {'filters': filters, 'active': active};
    return {};
  }
}

void main() {
  final me = Member(
    id: 'dad',
    relationName: 'Dad',
    isCaretaker: true,
    isAdmin: true,
    requiresCaretaker: false,
    userId: 'user-dad',
  );
  final partner = Member(
    id: 'mom',
    relationName: 'Mom',
    isCaretaker: true,
    isAdmin: false,
    requiresCaretaker: false,
    userId: 'user-mom',
  );
  final work = FeedItem(
    id: 'f-work',
    kind: 'google',
    mode: 'busy',
    sourceCalendarName: 'Work',
  );
  final club = FeedItem(
    id: 'f-club',
    kind: 'ics',
    mode: 'standard',
    sourceCalendarName: 'Book club',
  );

  Future<void> pumpTall(WidgetTester tester, Widget widget) async {
    tester.view.physicalSize = const Size(800, 3000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(widget);
    await tester.pumpAndSettle();
  }

  Widget app({
    required String memberId,
    required List<EmailOutput> outputs,
    bool emailEnabled = true,
    ApiClient? api,
  }) => ProviderScope(
    overrides: [
      if (api != null) apiClientProvider.overrideWithValue(api),
      familyProvider.overrideWith((ref) async => 'fam'),
      membersProvider.overrideWith((ref) async => [me, partner]),
      currentMemberProvider.overrideWith((ref) async => me),
      feedsProvider.overrideWith((ref) async => [work, club]),
      feedLinksProvider.overrideWith(
        (ref, feedId) async => [
          FeedLink(
            id: feedId == 'f-work' ? 'link-work' : 'link-club',
            familyMemberId: 'dad',
            active: true,
          ),
        ],
      ),
      accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
      memberCalendarProvider.overrideWith((ref, id) async => null),
      calendarEventsProvider.overrideWith((ref) async => const []),
      emailOutputsProvider.overrideWith(
        (ref, id) async =>
            EmailOutputList(outputs: outputs, emailEnabled: emailEnabled),
      ),
    ],
    child: MaterialApp(
      theme: buildAppTheme(),
      themeMode: ThemeMode.dark,
      home: MemberDetailScreen(memberId: memberId),
    ),
  );

  testWidgets('lists each address with what it sends and its state', (
    tester,
  ) async {
    await pumpTall(
      tester,
      app(
        memberId: 'dad',
        emailEnabled: false,
        outputs: [
          EmailOutput(
            id: 'o1',
            email: 'grandma@example.com',
            label: 'Grandma',
            filters: const EmailOutputFilters(
              include: {'claimed_task'},
              taskTypes: {'pickup'},
            ),
            active: true,
            verified: false,
          ),
          EmailOutput(
            id: 'o2',
            email: 'me@work.example',
            filters: const EmailOutputFilters(include: {'schedule'}),
            active: false,
            verified: true,
          ),
          EmailOutput(
            id: 'o3',
            email: 'nanny@example.com',
            filters: EmailOutputFilters.claimedOnly,
            active: true,
            verified: true,
            unsubscribed: true,
          ),
        ],
      ),
    );

    expect(find.text('EMAIL INVITES'), findsOneWidget);
    expect(find.text('Grandma'), findsOneWidget);
    expect(find.text('grandma@example.com\nClaimed pickups'), findsOneWidget);
    expect(find.text('Unconfirmed'), findsOneWidget);
    expect(find.text('Paused'), findsOneWidget);
    expect(find.text('Unsubscribed'), findsOneWidget);
    expect(find.textContaining("isn't switched on"), findsOneWidget);
  });

  testWidgets("hidden on someone else's own member page", (tester) async {
    await pumpTall(tester, app(memberId: 'mom', outputs: const []));
    expect(find.text('EMAIL INVITES'), findsNothing);
  });

  testWidgets('adding one sends the address and the picked filters', (
    tester,
  ) async {
    final api = _FakeApiClient();
    await pumpTall(tester, app(memberId: 'dad', outputs: const [], api: api));

    await tester.tap(find.text('Add email invites'));
    await tester.pumpAndSettle();
    expect(find.byType(EmailOutputSheet), findsOneWidget);

    await tester.enterText(
      find.widgetWithText(TextField, 'Email address'),
      'nanny@example.com',
    );
    // Claimed tasks are on by default; narrow them to pickups, and add the
    // schedule from one calendar only.
    await tester.tap(find.text('Pickups'));
    await tester.tap(
      find
          .descendant(
            of: find.ancestor(
              of: find.text('Schedule'),
              matching: find.byType(Row),
            ),
            matching: find.byType(Switch),
          )
          .first,
    );
    await tester.pumpAndSettle();
    final inSheet = find.descendant(
      of: find.byType(EmailOutputSheet),
      matching: find.text('Book club'),
    );
    await tester.ensureVisible(inSheet);
    await tester.tap(inSheet);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Send confirmation'));
    await tester.tap(find.text('Send confirmation'));
    await tester.pumpAndSettle();

    expect(api.created, {
      'email': 'nanny@example.com',
      'label': '',
      'filters': {
        'include': ['claimed_task', 'schedule'],
        'taskTypes': ['pickup'],
        'sourceLinkIds': ['link-club'],
      },
    });
    expect(find.textContaining('Confirmation sent to nanny@'), findsOneWidget);
  });

  testWidgets('refuses to save with nothing selected', (tester) async {
    final api = _FakeApiClient();
    await pumpTall(tester, app(memberId: 'dad', outputs: const [], api: api));

    await tester.tap(find.text('Add email invites'));
    await tester.pumpAndSettle();
    await tester.tap(
      find
          .descendant(
            of: find.ancestor(
              of: find.text('Claimed tasks'),
              matching: find.byType(Row),
            ),
            matching: find.byType(Switch),
          )
          .first,
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('Send confirmation'));
    await tester.tap(find.text('Send confirmation'));
    await tester.pumpAndSettle();

    expect(api.created, isNull);
    expect(
      find.text('Pick at least one kind of event to send.'),
      findsOneWidget,
    );
  });

  testWidgets('an unsubscribed address explains itself and offers no resend', (
    tester,
  ) async {
    await pumpTall(
      tester,
      app(
        memberId: 'dad',
        outputs: [
          EmailOutput(
            id: 'o1',
            email: 'nanny@example.com',
            filters: EmailOutputFilters.claimedOnly,
            active: true,
            verified: false,
            unsubscribed: true,
          ),
        ],
      ),
    );
    await tester.tap(find.text('nanny@example.com').first);
    await tester.pumpAndSettle();

    expect(
      find.textContaining('unsubscribed from calendar invites'),
      findsOneWidget,
    );
    expect(find.text('Resend confirmation'), findsNothing);
    expect(find.text('Remove'), findsOneWidget);
  });
}
