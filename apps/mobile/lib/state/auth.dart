import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';
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
  const AuthState({this.sessionToken, this.user, this.error, this.restoring = false});
  final String? sessionToken;
  final Map<String, dynamic>? user;

  /// A login error to surface (e.g. an `auth_error` from the Apple callback).
  final String? error;

  /// True while startup restore (fragment or cookie) is in flight — lets the
  /// UI hold off rendering the login screen for the one round trip it takes to
  /// find out whether the web session cookie is still valid.
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

  /// On web startup: first pick up a session (or error) the Apple callback
  /// left in the URL fragment; failing that, ask the server whether the
  /// `igt_session` cookie (set on login, HttpOnly so JS never touches the raw
  /// token — see docs/AUTH.md) still identifies a valid session, so a plain
  /// page refresh doesn't force a re-login. No-op on native / when neither
  /// yields anything.
  Future<void> _restore() async {
    // The third field (`linked`) is the web link-a-method redirect
    // (`#linked=apple`); it leaves the existing session cookie in place, so we
    // just let it strip the fragment and fall through to the cookie restore
    // below — the freshly linked identity is picked up on the reload.
    final (:session, :error, linked: _) = consumeAppleAuthFragment();
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

    // Native has no cookie to restore from (and no persisted token yet — see
    // docs/AUTH.md's native TODO), so skip the round trip and go straight to
    // the login screen.
    if (!kIsWeb) {
      state = const AuthState();
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
  /// [_restore].
  void loginWithApple() => startWebRedirect('$apiBaseUrl/auth/apple/start');

  /// Web: link Sign in with Apple to the *current* user (rather than logging in
  /// afresh). The session cookie rides along on the redirect, so the callback
  /// threads Apple onto this account and sends the browser back to
  /// `/app/#linked=apple`. Native uses [linkWithAppleNative].
  void linkWithApple() => startWebRedirect('$apiBaseUrl/auth/apple/start?link=1');

  /// Native (iOS): request an Apple ID credential from the OS sheet and post
  /// its identity token to `/auth/apple` to obtain a session.
  Future<void> loginWithAppleNative() async {
    final identityToken = await _requestAppleIdentityToken();
    if (identityToken == null) return; // user dismissed the sheet
    final res = await _api.signInWithApple(identityToken);
    state = AuthState(
      sessionToken: res['sessionToken'] as String,
      user: res['user'] as Map<String, dynamic>,
    );
  }

  /// Native (iOS): link Sign in with Apple to the *current* user by posting a
  /// fresh identity token to `/auth/link/apple`. The session is unchanged; the
  /// caller refreshes the identity list.
  Future<void> linkWithAppleNative() async {
    final identityToken = await _requestAppleIdentityToken();
    if (identityToken == null) return; // user dismissed the sheet
    await _api.linkApple(identityToken);
  }

  /// Drive the native Apple OS sheet and return the identity token, or null if
  /// the user dismissed it.
  Future<String?> _requestAppleIdentityToken() async {
    AuthorizationCredentialAppleID cred;
    try {
      cred = await SignInWithApple.getAppleIDCredential(
        scopes: [
          AppleIDAuthorizationScopes.email,
          AppleIDAuthorizationScopes.fullName,
        ],
      );
    } on SignInWithAppleAuthorizationException catch (e) {
      // User dismissed the OS sheet — not an error worth surfacing.
      if (e.code == AuthorizationErrorCode.canceled) return null;
      rethrow;
    }
    final identityToken = cred.identityToken;
    if (identityToken == null) {
      throw Exception('Apple did not return an identity token.');
    }
    return identityToken;
  }

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

  Future<void> logout() async {
    try {
      await _api.logout();
    } catch (_) {
      // Best-effort server-side invalidation; clear local state regardless.
    }
    state = const AuthState();
  }
}

final authControllerProvider =
    StateNotifierProvider<AuthController, AuthState>(
  (ref) => AuthController(ref.watch(apiClientProvider)),
);
