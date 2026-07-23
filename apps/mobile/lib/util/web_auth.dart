// Web-only helpers for the browser Sign in with Apple / Google redirect flows.
// On native builds the stub no-ops (native Apple uses the `sign_in_with_apple`
// package instead — see docs/AUTH.md). Conditional import keeps `dart:html` out
// of the iOS build.
export 'web_auth_stub.dart' if (dart.library.html) 'web_auth_html.dart';
