import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../api/client.dart';

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
  const AuthState({this.sessionToken, this.user});
  final String? sessionToken;
  final Map<String, dynamic>? user;
  bool get isAuthed => sessionToken != null;
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._api) : super(const AuthState());
  final ApiClient _api;

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
