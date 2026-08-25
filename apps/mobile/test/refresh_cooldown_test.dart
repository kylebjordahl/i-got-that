import 'dart:convert';
import 'dart:io';

import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/home_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/widgets/primitives.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Stands in for a backend that rejects the refresh as too soon.
class _CooldownApiClient extends ApiClient {
  _CooldownApiClient() : super(baseUrl: 'http://test');

  int calls = 0;

  @override
  Future<Map<String, dynamic>> refreshAllFeeds(String familyId) async {
    calls++;
    throw const FeedRefreshCooldown(retryAfter: Duration(seconds: 42));
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
  group('FeedRefreshCooldown.message', () {
    test('names the wait when the backend gave one', () {
      const cooldown = FeedRefreshCooldown(retryAfter: Duration(seconds: 42));
      expect(cooldown.message, 'Already up to date — try again in 42s.');
    });

    test('drops the wait when there is none left to report', () {
      const cooldown = FeedRefreshCooldown(retryAfter: Duration.zero);
      expect(cooldown.message, 'Already up to date.');
    });
  });

  group('refreshAllFeeds against a cooled-down backend', () {
    late HttpServer server;
    late ApiClient client;
    int status = 429;
    Object body = {'error': 'refresh_cooldown', 'retryAfterSeconds': 42};

    setUp(() async {
      // `testWidgets` elsewhere in this file installs a binding that stubs
      // every HttpClient to a canned 400, which would mask the real response.
      // These two cases are about how dio maps an actual wire response, so
      // they need the genuine client back for the duration.
      final overrides = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = overrides);

      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) async {
        req.response
          ..statusCode = status
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(body));
        await req.response.close();
      });
      client = ApiClient(baseUrl: 'http://127.0.0.1:${server.port}');
    });

    tearDown(() => server.close(force: true));

    test('turns the backend 429 into a typed cooldown', () async {
      await expectLater(
        client.refreshAllFeeds('fam-1'),
        throwsA(
          isA<FeedRefreshCooldown>().having(
            (e) => e.retryAfter,
            'retryAfter',
            const Duration(seconds: 42),
          ),
        ),
      );
    });

    test('leaves other failures alone', () async {
      status = 500;
      body = {'error': 'boom'};
      await expectLater(
        client.refreshAllFeeds('fam-1'),
        throwsA(isNot(isA<FeedRefreshCooldown>())),
      );
    });
  });

  testWidgets('a cooled-down refresh reads as up-to-date, not as a failure', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(600, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final me = _m('dad', 'Dad', caretaker: true, admin: true);
    final api = _CooldownApiClient();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          familyProvider.overrideWith((ref) async => 'fam-1'),
          membersProvider.overrideWith((ref) async => [me]),
          currentMemberProvider.overrideWith((ref) async => me),
          unownedTasksProvider.overrideWith((ref) async => const []),
          allTasksProvider.overrideWith((ref) async => const []),
          pendingDecisionsProvider.overrideWith((ref) async => const []),
          conflictsProvider.overrideWith((ref) async => const []),
          calendarEventsProvider.overrideWith((ref) async => const []),
          feedsProvider.overrideWith((ref) async => const []),
          threadingThresholdProvider.overrideWith((ref) async => 30),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: HomeScreen()),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byType(RefreshFeedsButton));
    await tester.pumpAndSettle();

    expect(api.calls, 1);
    // The cooldown is the backend debouncing a too-soon re-press, so it must
    // not surface as "Refresh failed" — the data on screen is already current.
    expect(find.text('Already up to date — try again in 42s.'), findsOneWidget);
    expect(find.textContaining('Refresh failed'), findsNothing);
  });
}
