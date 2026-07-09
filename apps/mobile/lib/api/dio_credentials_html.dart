// Web implementation — see dio_credentials.dart.
import 'package:dio/browser.dart';
import 'package:dio/dio.dart';

/// Include the `igt_session` HttpOnly cookie on requests (and accept
/// `Set-Cookie` from responses) so the browser — not JS — carries the session
/// across a page refresh.
void enableSessionCookie(Dio dio) {
  final adapter = dio.httpClientAdapter;
  if (adapter is BrowserHttpClientAdapter) adapter.withCredentials = true;
}
