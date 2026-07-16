// Web implementation — see web_auth.dart. `dart:html` is the pragmatic choice
// for this tiny redirect/fragment glue; migrate to package:web + dart:js_interop
// if this grows.
// ignore_for_file: deprecated_member_use, avoid_web_libraries_in_flutter
import 'dart:html' as html;

/// Navigate the whole page to [url] to begin an Apple / Google redirect flow.
void startWebRedirect(String url) => html.window.location.assign(url);

/// Consume `session` / `auth_error` / `linked` / `connected` from the URL
/// fragment an auth callback redirected us to (`/app/#session=…`, or
/// `#linked=apple` / `#connected=google` for the link-a-method / connect-a-
/// calendar flows), then strip the fragment so nothing lingers in the address
/// bar or browser history.
({String? session, String? error, String? linked, String? connected})
    consumeWebAuthFragment() {
  final loc = html.window.location;
  final raw = loc.hash.startsWith('#') ? loc.hash.substring(1) : loc.hash;
  if (raw.isEmpty) {
    return (session: null, error: null, linked: null, connected: null);
  }

  final params = Uri.splitQueryString(raw);
  final session = params['session'];
  final error = params['auth_error'];
  final linked = params['linked'];
  final connected = params['connected'];
  if (session != null || error != null || linked != null || connected != null) {
    html.window.history.replaceState(null, '', '${loc.pathname}${loc.search}');
  }
  return (session: session, error: error, linked: linked, connected: connected);
}
