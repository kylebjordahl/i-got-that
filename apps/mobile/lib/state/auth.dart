import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../api/client.dart';
import '../util/web_auth.dart';

/// API base URL — override at build time with --dart-define=API_BASE_URL=...
/// Defaults to the local `wrangler dev` address.
const apiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://localhost:8787',
);

final apiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(baseUrl: apiBaseUrl),
);

class AuthState {
  const AuthState({this.sessionToken, this.user, this.error});
  final String? sessionToken;
  final Map<String, dynamic>? user;

  /// A login error to surface (e.g. an `auth_error` from the Apple callback).
  final String? error;
  bool get isAuthed => sessionToken != null;
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._api) : super(const AuthState()) {
    _restoreFromWebRedirect();
  }
  final ApiClient _api;

  /// On web startup, pick up a session (or error) the Apple callback left in the
  /// URL fragment. No-op on native / when there's nothing to consume.
  Future<void> _restoreFromWebRedirect() async {
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
    } else if (error != null) {
      state = AuthState(error: error);
    }
  }

  /// Web: begin Sign in with Apple by navigating to the API's redirect endpoint;
  /// Apple sends the browser back to `/app/#session=…`, picked up on reload by
  /// [_restoreFromWebRedirect]. Native wiring uses `sign_in_with_apple` (TODO).
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
    state = AuthState(
      sessionToken: res['sessionToken'] as String,
      user: res['user'] as Map<String, dynamic>,
    );
  }

  void logout() {
    _api.setSession(null);
    state = const AuthState();
  }
}

final authControllerProvider =
    StateNotifierProvider<AuthController, AuthState>(
  (ref) => AuthController(ref.watch(apiClientProvider)),
);
