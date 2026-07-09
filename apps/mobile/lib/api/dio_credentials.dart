// Web needs the session cookie (see docs/AUTH.md) sent on same-site requests
// so a page refresh can restore auth via GET /me instead of forcing a re-login.
// Native keeps using the Authorization header + its own secure storage, where
// this is a no-op. Conditional import mirrors util/web_auth.dart.
export 'dio_credentials_stub.dart' if (dart.library.html) 'dio_credentials_html.dart';
