import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/services.dart';

/// Where the user's notification permission currently stands.
///
/// [denied] is the one that needs UI: iOS only ever prompts once, so the app
/// can't ask again — the only way back is the system Settings app.
enum PushAuthorization {
  notDetermined,
  denied,
  authorized,
  provisional,
  ephemeral;

  bool get isGranted =>
      this == authorized || this == provisional || this == ephemeral;

  static PushAuthorization parse(String? name) => switch (name) {
    'authorized' => authorized,
    'provisional' => provisional,
    'ephemeral' => ephemeral,
    'denied' => denied,
    _ => notDetermined,
  };
}

/// Native push registration, over the `igt/push` MethodChannel implemented in
/// `ios/Runner/AppDelegate.swift` (mirroring the `igt/geocoding` channel).
///
/// Every method is a no-op returning a "not supported" answer off iOS: the same
/// codebase builds the web client the Worker serves at `/app`, where there is
/// no channel on the other end.
class PushService {
  const PushService();

  static const _channel = MethodChannel('igt/push');

  /// False on web, where the whole notifications section is hidden.
  bool get isSupported => !kIsWeb;

  /// Invoke a read-only channel method, falling back rather than throwing when
  /// there's nothing on the other end. The channel is absent on any host that
  /// isn't the iOS app — a widget test, a desktop debug run — and none of the
  /// queries below is worth failing a sign-out or a screen build over.
  Future<T?> _query<T>(String method) async {
    if (!isSupported) return null;
    try {
      return await _channel.invokeMethod<T>(method);
    } catch (_) {
      return null;
    }
  }

  Future<PushAuthorization> authorizationStatus() async =>
      PushAuthorization.parse(await _query<String>('authorizationStatus'));

  /// Show the system permission prompt. Returns whether it was granted; a
  /// second call after a denial returns false without prompting.
  Future<bool> requestPermission() async {
    if (!isSupported) return false;
    return await _channel.invokeMethod<bool>('requestPermission') ?? false;
  }

  /// Register with APNs and resolve to the device token (lowercase hex).
  /// Throws a [PlatformException] if APNs refuses — most often a build whose
  /// provisioning profile lacks the push entitlement.
  Future<String> register() async {
    final token = await _channel.invokeMethod<String>('register');
    if (token == null || token.isEmpty) {
      throw PlatformException(
        code: 'registration_failed',
        message: 'APNs returned no device token',
      );
    }
    return token;
  }

  /// `development` or `production` — which APNs host this build's tokens
  /// route through, read from the same xcconfig value that signs the
  /// entitlement.
  Future<String> apsEnvironment() async =>
      await _query<String>('apsEnvironment') ?? 'production';

  /// The device's IANA timezone identifier (e.g. `America/Los_Angeles`).
  /// Dart's own `DateTime.timeZoneName` only gives an abbreviation, which the
  /// server can't read a schedule's send time in.
  Future<String?> timezone() => _query<String>('timezone');

  /// Open the app's page in iOS Settings, the only route back from a denial.
  Future<void> openSettings() => _query<void>('openSettings');

  /// The payload of a notification tapped before Dart was listening (a cold
  /// start from the lock screen), consumed once.
  Future<Map<String, dynamic>?> takeInitialTap() async {
    if (!isSupported) return null;
    try {
      return await _channel.invokeMapMethod<String, dynamic>('takeInitialTap');
    } catch (_) {
      return null;
    }
  }

  /// Taps handled while the app is running.
  void onTap(void Function(Map<String, dynamic> payload) handler) {
    if (!isSupported) return;
    _channel.setMethodCallHandler((call) async {
      if (call.method != 'onNotificationTap') return null;
      final args = call.arguments;
      if (args is Map) {
        handler(args.map((k, v) => MapEntry(k.toString(), v)));
      }
      return null;
    });
  }
}
