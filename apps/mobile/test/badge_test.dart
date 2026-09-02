import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/services/push.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/badge.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/state/notifications.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records what the app-icon badge was set to, with no platform channel behind
/// it (see `_FakePush` in notification_settings_test.dart for why).
class _FakePush implements PushService {
  final List<int> badges = [];

  @override
  bool get isSupported => true;

  @override
  Future<void> setBadgeCount(int count) async => badges.add(count);

  @override
  Future<PushAuthorization> authorizationStatus() async =>
      PushAuthorization.authorized;
  @override
  Future<bool> requestPermission() async => true;
  @override
  Future<String> register() async => 'a' * 64;
  @override
  Future<String> apsEnvironment() async => 'development';
  @override
  Future<String?> timezone() async => 'America/Los_Angeles';
  @override
  Future<void> openSettings() async {}
  @override
  Future<Map<String, dynamic>?> takeInitialTap() async => null;
  @override
  void onTap(void Function(Map<String, dynamic>) handler) {}
}

class _FakeApiClient extends ApiClient {
  _FakeApiClient(this.count) : super(baseUrl: 'http://test');

  /// What the server says is still outstanding. Mutated mid-test to stand in
  /// for work being claimed somewhere else.
  int count;
  int calls = 0;

  @override
  Future<int> fetchBadgeCount() async {
    calls++;
    return count;
  }
}

void main() {
  /// The scope under a stub of everything it listens to — the three real
  /// providers would otherwise drag in the family/auth chain.
  Widget scoped(ApiClient api, _FakePush push) => ProviderScope(
    overrides: [
      apiClientProvider.overrideWithValue(api),
      pushServiceProvider.overrideWithValue(push),
      // Fresh lists, not `const []`: two identical const lists are equal, and
      // an AsyncData that compares equal notifies nobody.
      allTasksProvider.overrideWith((ref) async => <TaskItem>[]),
      pendingDecisionsProvider.overrideWith((ref) async => <PendingDecision>[]),
      conflictsProvider.overrideWith((ref) async => <Conflict>[]),
    ],
    child: const BadgeSyncScope(child: SizedBox.shrink()),
  );

  /// Past the debounce and the round trip behind it. Several short pumps
  /// rather than one long one: a provider settling mid-pump only schedules its
  /// debounce timer, which needs a *later* pump to come due.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 4; i++) {
      await tester.pump(const Duration(milliseconds: 150));
    }
  }

  testWidgets('puts the badge back in step when the app starts', (
    tester,
  ) async {
    final api = _FakeApiClient(3);
    final push = _FakePush();
    await tester.pumpWidget(scoped(api, push));
    await settle(tester);

    expect(push.badges.last, 3);
  });

  testWidgets('clears the badge once the last outstanding thing is claimed', (
    tester,
  ) async {
    final api = _FakeApiClient(1);
    final push = _FakePush();
    await tester.pumpWidget(scoped(api, push));
    await settle(tester);
    expect(push.badges.last, 1);

    // A claim: the queue refetches, and by then the server has nothing left
    // that needs a human.
    api.count = 0;
    final container = ProviderScope.containerOf(
      tester.element(find.byType(SizedBox)),
    );
    container.invalidate(allTasksProvider);
    await settle(tester);

    expect(push.badges.last, 0);
  });

  testWidgets('re-syncs on resume, and coalesces a burst into one call', (
    tester,
  ) async {
    final api = _FakeApiClient(2);
    final push = _FakePush();
    await tester.pumpWidget(scoped(api, push));
    await settle(tester);
    final atStart = api.calls;

    final container = ProviderScope.containerOf(
      tester.element(find.byType(SizedBox)),
    );
    // What Home does on any refresh: several invalidations back to back, which
    // is one question about the badge, not three.
    container.invalidate(allTasksProvider);
    container.invalidate(pendingDecisionsProvider);
    container.invalidate(conflictsProvider);
    await settle(tester);
    expect(api.calls, atStart + 1);

    api.count = 5;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await settle(tester);
    expect(push.badges.last, 5);
  });

  testWidgets('a failed fetch leaves the badge alone rather than zeroing it', (
    tester,
  ) async {
    final push = _FakePush();
    await tester.pumpWidget(scoped(_ThrowingApiClient(), push));
    await settle(tester);

    expect(push.badges, isEmpty);
  });
}

class _ThrowingApiClient extends ApiClient {
  _ThrowingApiClient() : super(baseUrl: 'http://test');

  @override
  Future<int> fetchBadgeCount() async => throw Exception('offline');
}
