// Native (non-web) stubs — see web_auth.dart.

/// Navigate the whole page to [url] to begin the Apple redirect flow. No-op off
/// the web.
void startWebRedirect(String url) {}

/// Consume `session` / `auth_error` from the URL fragment Apple's callback set,
/// clearing it so the token doesn't linger. Always empty off the web.
({String? session, String? error}) consumeAppleAuthFragment() =>
    (session: null, error: null);
