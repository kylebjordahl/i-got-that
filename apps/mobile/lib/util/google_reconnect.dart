import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import '../env.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';

/// Renew one Google account's grant — the fix for calendars that stopped
/// syncing because the refresh token expired, was revoked, or is missing a
/// permission. Shared by the Me screen's account sheet and Home's reconnect
/// card. The row keeps its id, so every feed on it picks up the new token.
Future<void> reconnectGoogleAccount(
  BuildContext context,
  WidgetRef ref,
  ExternalAccount a,
) async {
  // Web navigates away and comes back to `#connected=google`.
  if (kIsWeb) {
    ref.read(authControllerProvider.notifier).reconnectGoogleCalendar(a.id);
    return;
  }
  final api = ref.read(apiClientProvider);
  String message;
  try {
    // Same system-browser consent as the connect wizard (see
    // ConnectAccountWizard._connectGoogleNative).
    const redirectUri = '$apiBaseUrl/auth/google/native-callback';
    final authorizeUrl = await api.accountGoogleAuthorizeUrl(redirectUri);
    final callback = await FlutterWebAuth2.authenticate(
      url: authorizeUrl,
      callbackUrlScheme: googleOAuthCallbackScheme,
    );
    final code = Uri.parse(callback).queryParameters['code'];
    if (code == null) {
      message = 'Google did not return an authorization code.';
    } else {
      await api.reconnectGoogleAccount(
        a.id,
        authCode: code,
        redirectUri: redirectUri,
      );
      ref.invalidate(accountsProvider);
      message = 'Reconnected. Its calendars will catch up on the next sync.';
    }
  } on DioException catch (e) {
    final data = e.response?.data;
    final code = data is Map ? data['error'] : null;
    message = switch (code) {
      'google_account_mismatch' =>
        'That was a different Google account. Sign in as '
            '${a.username ?? 'the account you connected'} to reconnect it.',
      'google_scopes_missing' =>
        "Google didn't grant all the calendar access I Got That needs. "
            'Try again and leave every calendar permission ticked on '
            "Google's consent screen.",
      'google_no_refresh_token' =>
        'Google did not grant offline access. Remove I Got That from your '
            'Google account permissions, then try again.',
      _ => 'Could not reconnect (HTTP ${e.response?.statusCode ?? '?'}).',
    };
  } on PlatformException catch (e) {
    // FlutterWebAuth2 reports a closed browser sheet as CANCELED.
    if (e.code == 'CANCELED') return;
    message = 'Could not reconnect: ${e.message ?? e.code}';
  }
  if (context.mounted) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }
}
