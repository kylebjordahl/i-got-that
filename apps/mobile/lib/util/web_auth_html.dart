// Web implementation — see web_auth.dart. `dart:html` is the pragmatic choice
// for this tiny redirect/fragment glue; migrate to package:web + dart:js_interop
// if this grows.
// ignore_for_file: deprecated_member_use, avoid_web_libraries_in_flutter
import 'dart:html' as html;

/// Navigate the whole page to [url] to begin the Apple redirect flow.
void startWebRedirect(String url) => html.window.location.assign(url);

/// Consume `session` / `auth_error` from the URL fragment the Apple callback
/// redirected us to (`/app/#session=…`), then strip the fragment so the token
/// doesn't linger in the address bar or browser history.
({String? session, String? error}) consumeAppleAuthFragment() {
  final loc = html.window.location;
  final raw = loc.hash.startsWith('#') ? loc.hash.substring(1) : loc.hash;
  if (raw.isEmpty) return (session: null, error: null);

  final params = Uri.splitQueryString(raw);
  final session = params['session'];
  final error = params['auth_error'];
  if (session != null || error != null) {
    html.window.history.replaceState(null, '', '${loc.pathname}${loc.search}');
  }
  return (session: session, error: error);
}
