// Native (non-web) stubs — see web_auth.dart.

/// Navigate the whole page to [url] to begin the Apple redirect flow. No-op off
/// the web.
void startWebRedirect(String url) {}

/// Consume `session` / `auth_error` / `linked` from the URL fragment Apple's
/// callback set, clearing it so nothing lingers. Always empty off the web.
({String? session, String? error, String? linked}) consumeAppleAuthFragment() =>
    (session: null, error: null, linked: null);
