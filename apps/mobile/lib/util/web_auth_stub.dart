// Native (non-web) stubs — see web_auth.dart.

/// Navigate the whole page to [url] to begin an Apple / Google redirect flow.
/// No-op off the web.
void startWebRedirect(String url) {}

/// Consume `session` / `auth_error` / `linked` / `connected` / `magic` / `link-email` from
/// the URL fragment an auth callback set, clearing it so nothing lingers.
/// Always empty off the web.
({
  String? session,
  String? error,
  String? linked,
  String? connected,
  String? magic,
  String? linkEmail,
})
consumeWebAuthFragment() => (
  session: null,
  error: null,
  linked: null,
  connected: null,
  magic: null,
  linkEmail: null,
);
