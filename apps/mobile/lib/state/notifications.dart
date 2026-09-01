import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../models.dart';
import '../services/push.dart';
import 'auth.dart';

final pushServiceProvider = Provider<PushService>((_) => const PushService());

/// This device's push state: whether the OS has granted permission, and whether
/// we currently hold a token registered with the backend.
///
/// The pair matters because they can disagree — permission survives a reinstall
/// in some cases, and a registered token can be revoked from Settings — and the
/// UI has to say which is wrong. [PushAuthorization.denied] in particular can
/// only be fixed in the system Settings app; iOS never prompts twice.
class PushState {
  const PushState({
    required this.authorization,
    required this.registered,
    this.supported = true,
    this.error,
  });

  const PushState.unsupported()
    : authorization = PushAuthorization.denied,
      registered = false,
      supported = false,
      error = null;

  final PushAuthorization authorization;
  final bool registered;

  /// False on web, where there's no APNs on the other end.
  final bool supported;
  final String? error;

  /// Whether the master switch should read as on.
  bool get isOn => supported && authorization.isGranted && registered;

  /// Permission was refused and can't be asked for again in-app.
  bool get needsSettings =>
      supported && authorization == PushAuthorization.denied;

  PushState copyWith({
    PushAuthorization? authorization,
    bool? registered,
    String? error,
    bool clearError = false,
  }) => PushState(
    authorization: authorization ?? this.authorization,
    registered: registered ?? this.registered,
    supported: supported,
    error: clearError ? null : (error ?? this.error),
  );
}

class PushController extends StateNotifier<AsyncValue<PushState>> {
  PushController(this._ref) : super(const AsyncValue.loading()) {
    refresh();
  }

  final Ref _ref;
  String? _deviceToken;

  PushService get _push => _ref.read(pushServiceProvider);

  Future<void> refresh() async {
    if (!_push.isSupported) {
      state = const AsyncValue.data(PushState.unsupported());
      return;
    }
    final authorization = await _push.authorizationStatus();
    if (!authorization.isGranted) {
      state = AsyncValue.data(
        PushState(authorization: authorization, registered: false),
      );
      return;
    }
    // Once authorized, APNs hands back the same token without prompting, so
    // this is how a relaunch learns which device row is *this* one — needed to
    // unregister cleanly on sign-out.
    try {
      _deviceToken = await _push.register();
    } catch (_) {
      _deviceToken = null;
    }
    try {
      final devices = await _ref.read(apiClientProvider).listPushDevices();
      state = AsyncValue.data(
        PushState(authorization: authorization, registered: devices.isNotEmpty),
      );
    } catch (err, stack) {
      state = AsyncValue.error(err, stack);
    }
  }

  /// Turn push on: prompt if we haven't yet, then register with APNs and hand
  /// the token to the backend. Returns whether it ended up on.
  Future<bool> enable() async {
    if (!_push.isSupported) return false;
    final current = state.valueOrNull;
    state = const AsyncValue.loading();
    try {
      var authorization = await _push.authorizationStatus();
      if (authorization == PushAuthorization.notDetermined) {
        await _push.requestPermission();
        authorization = await _push.authorizationStatus();
      }
      if (!authorization.isGranted) {
        state = AsyncValue.data(
          PushState(authorization: authorization, registered: false),
        );
        return false;
      }

      final token = await _push.register();
      _deviceToken = token;
      // The bundle id becomes the APNs topic, so staging and production
      // installs of the same account register distinct devices.
      final packageInfo = await PackageInfo.fromPlatform();
      await _ref
          .read(apiClientProvider)
          .registerPushDevice(
            deviceToken: token,
            bundleId: packageInfo.packageName,
            environment: await _push.apsEnvironment(),
            timezone: await _push.timezone(),
          );
      state = AsyncValue.data(
        PushState(authorization: authorization, registered: true),
      );
      return true;
    } catch (err) {
      state = AsyncValue.data(
        (current ??
                const PushState(
                  authorization: PushAuthorization.notDetermined,
                  registered: false,
                ))
            .copyWith(registered: false, error: err.toString()),
      );
      return false;
    }
  }

  /// Drop this device's server-side registration.
  ///
  /// API only — no platform-channel calls, deliberately: this runs as part of
  /// sign-out, and a channel round trip would block it. Never throws.
  ///
  /// Only a token we actually hold is unregistered. Without one (a relaunch
  /// where APNs didn't answer) the row is left behind rather than guessed at:
  /// a stale row costs one undeliverable push, which APNs reports back and the
  /// server then disables.
  Future<void> unregisterDevice() async {
    final token = _deviceToken;
    _deviceToken = null;
    if (token == null) return;
    try {
      await _ref.read(apiClientProvider).unregisterPushDevice(token);
    } catch (_) {
      // Best-effort; the next enable re-registers the same token.
    }
  }

  /// Turn push off for this device. The schedules are left alone — they're the
  /// account's, and another device may still want them.
  Future<void> disable() async {
    await unregisterDevice();
    // With no registration left, nothing can ever take a leftover badge back
    // down again — so it goes now, with the last push that could set it.
    await _push.setBadgeCount(0);
    final authorization = await _push.authorizationStatus();
    state = AsyncValue.data(
      PushState(authorization: authorization, registered: false),
    );
  }

  Future<void> openSettings() => _push.openSettings();
}

final pushControllerProvider =
    StateNotifierProvider<PushController, AsyncValue<PushState>>(
      PushController.new,
    );

/// The user's configured digests, newest send time first.
final notificationSchedulesProvider =
    FutureProvider<List<NotificationSchedule>>((ref) async {
      final api = ref.watch(apiClientProvider);
      final rows = await api.listNotificationSchedules();
      return rows
          .map((e) => NotificationSchedule.fromJson(e as Map<String, dynamic>))
          .toList();
    });
