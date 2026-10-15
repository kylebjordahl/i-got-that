import 'package:caretaker_app/services/push.dart';
import 'package:caretaker_app/state/nav.dart';
import 'package:caretaker_app/state/notifications.dart';
import 'package:caretaker_app/state/push_taps.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Captures the tap handler and serves an optional cold-start tap.
class _TapPush extends PushService {
  _TapPush({this.initial});

  final Map<String, dynamic>? initial;
  void Function(Map<String, dynamic>)? handler;

  @override
  void onTap(void Function(Map<String, dynamic> payload) handler) {
    this.handler = handler;
  }

  @override
  Future<Map<String, dynamic>?> takeInitialTap() async => initial;
}

void main() {
  late ProviderContainer container;

  Future<void> pump(WidgetTester tester, _TapPush push) async {
    container = ProviderContainer(
      overrides: [pushServiceProvider.overrideWithValue(push)],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: PushTapScope(child: SizedBox())),
      ),
    );
    await tester.pumpAndSettle();
  }

  const reauth = {'type': 'reauth', 'accountId': 'acc-1'};

  testWidgets('a reauth tap opens Me focused on the account', (tester) async {
    final push = _TapPush();
    await pump(tester, push);
    expect(container.read(navIndexProvider), 0);

    push.handler!(reauth);
    expect(container.read(navIndexProvider), 3);
    expect(container.read(focusedAccountIdProvider), 'acc-1');
  });

  testWidgets('the tap that cold-started the app is routed too', (
    tester,
  ) async {
    await pump(tester, _TapPush(initial: reauth));
    expect(container.read(navIndexProvider), 3);
    expect(container.read(focusedAccountIdProvider), 'acc-1');
  });

  testWidgets('other pushes leave navigation alone', (tester) async {
    final push = _TapPush();
    await pump(tester, push);
    push.handler!({'type': 'digest', 'scheduleId': 's1'});
    expect(container.read(navIndexProvider), 0);
    expect(container.read(focusedAccountIdProvider), isNull);
  });
}
