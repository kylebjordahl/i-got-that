import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../api/client.dart';
import '../util/web_auth.dart';

/// API base URL — override at build time with --dart-define=API_BASE_URL=...
/// Defaults to the local `wrangler dev` address.
const apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://localhost:8787',
);

/// Native-only session persistence (iOS Keychain / Android Keystore). Web
/// deliberately never writes the token here — see docs/AUTH.md's note on
/// keeping it out of localStorage/sessionStorage — web restores via the
/// HttpOnly `igt_session` cookie instead.
const _sessionStorageKey = 'session_token';
const _storage = FlutterSecureStorage();

final apiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(baseUrl: apiBaseUrl),
);

class AuthState {
  const AuthState({this.sessionToken, this.user, this.error, this.restoring = false});
  final String? sessionToken;
  final Map<String, dynamic>? user;

  /// A login error to surface (e.g. an `auth_error` from the Apple callback).
  final String? error;

  /// True while startup restore (fragment, cookie, or Keychain) is in flight
  /// — lets the UI hold off rendering the login screen for the one round trip
  /// it takes to find out whether a previous session is still valid.
  final bool restoring;

  /// Web sessions restored from the `igt_session` cookie never populate
  /// [sessionToken] in JS (that's the point — see docs/AUTH.md); [user] is the
  /// authoritative "am I logged in" signal there, so check both.
  bool get isAuthed => sessionToken != null || user != null;
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._api) : super(const AuthState(restoring: true)) {
    _restore();
  }
  final ApiClient _api;

  /// On startup: first pick up a session (or error) the Apple callback left in
  /// the URL fragment (web only); failing that, restore per platform — web
  /// asks the server whether the `igt_session` cookie (HttpOnly so JS never
  /// touches the raw token — see docs/AUTH.md) still identifies a valid
  /// session, native reads the token it persisted to the Keychain on a
  /// previous login — so neither a page refresh nor relaunching the app
  /// forces a re-login.
  Future<void> _restore() async {
    final (:session, :error) = consumeAppleAuthFragment();
    if (session != null) {
      _api.setSession(session);
      try {
        final me = await _api.me();
        state = AuthState(
          sessionToken: session,
          user: me['user'] as Map<String, dynamic>?,
        );
      } catch (e) {
        _api.setSession(null);
        state = AuthState(error: '$e');
      }
      return;
    }
    if (error != null) {
      state = AuthState(error: error);
      return;
    }

    if (!kIsWeb) {
      String? stored;
      try {
        stored = await _storage.read(key: _sessionStorageKey);
      } catch (_) {
        // Keychain unavailable/unreadable — treat as no persisted session
        // rather than leaving the UI stuck on the restoring scaffold.
        stored = null;
      }
      if (stored == null) {
        state = const AuthState();
        return;
      }
      _api.setSession(stored);
      try {
        final me = await _api.me();
        state = AuthState(
          sessionToken: stored,
          user: me['user'] as Map<String, dynamic>?,
        );
      } catch (_) {
        // Stored token no longer valid (expired/revoked) — discard it and
        // fall through to the ordinary logged-out state.
        _api.setSession(null);
        await _storage.delete(key: _sessionStorageKey);
        state = const AuthState();
      }
      return;
    }

    try {
      final me = await _api.me();
      state = AuthState(user: me['user'] as Map<String, dynamic>?);
    } catch (_) {
      // No valid session cookie — the ordinary logged-out state, not an error
      // to surface.
      state = const AuthState();
    }
  }

  /// Web: begin Sign in with Apple by navigating to the API's redirect endpoint;
  /// Apple sends the browser back to `/app/#session=…`, picked up on reload by
  /// [_restore]. Native wiring uses `sign_in_with_apple` (TODO).
  void loginWithApple() => startWebRedirect('$apiBaseUrl/auth/apple/start');

  /// Dev flow: request a magic link and immediately verify with the returned
  /// dev token. In production the token is emailed and this would instead deep-
  /// link back into verify().
  Future<void> loginWithEmail(String email) async {
    final devToken = await _api.requestMagicLink(email);
    if (devToken == null) {
      throw Exception(
        'Magic link sent — check your email (no dev token in production).',
      );
    }
    final res = await _api.verifyMagicLink(devToken);
    final token = res['sessionToken'] as String;
    state = AuthState(
      sessionToken: token,
      user: res['user'] as Map<String, dynamic>,
    );
    if (!kIsWeb) {
      try {
        await _storage.write(key: _sessionStorageKey, value: token);
      } catch (_) {
        // Best-effort persistence; the session is still usable this launch
        // even if the Keychain write failed.
      }
    }
  }

  Future<void> logout() async {
    try {
      await _api.logout();
    } catch (_) {
      // Best-effort server-side invalidation; clear local state regardless.
    }
    if (!kIsWeb) {
      try {
        await _storage.delete(key: _sessionStorageKey);
      } catch (_) {
        // Best-effort local cleanup; state is cleared regardless below.
      }
    }
    state = const AuthState();
  }
}

final authControllerProvider =
    StateNotifierProvider<AuthController, AuthState>(
  (ref) => AuthController(ref.watch(apiClientProvider)),
);
