import 'package:caretaker_app/services/push.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

/// The real [PushService.isSupported], which every widget test that renders the
/// notifications section stubs out (see `_FakePush` in
/// notification_settings_test.dart) — so without this the gate itself is
/// untested.
void main() {
  tearDown(() => debugDefaultTargetPlatformOverride = null);

  test('push is supported on iOS, the only platform with the channel', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(const PushService().isSupported, isTrue);
  });

  // The `igt/push` MethodChannel is implemented in ios/Runner/AppDelegate.swift
  // and nowhere else. `register()` deliberately throws rather than falling back
  // — it has to surface an APNs refusal — so on Android an un-gated switch
  // would put a raw MissingPluginException in front of the user. The server
  // half is APNs-only too (`PushPlatform` is `z.enum(['ios'])`).
  test('push is unsupported on Android until an FCM sender exists', () {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(const PushService().isSupported, isFalse);
  });
}
