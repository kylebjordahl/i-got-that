import 'package:url_launcher/url_launcher.dart';
import '../state/auth.dart';

/// A public legal page (`privacy` or `terms`). The API worker serves these at
/// the root `/legal/…`, not under `/api`, so the origin is [base] less its
/// `/api` suffix. Deployed, the app host 301s that to the marketing site
/// (SITE_ORIGIN), as the legacy host does for older builds. On web (`/api`) that leaves a same-origin relative path;
/// locally (`wrangler dev`, no prefix) the worker serves `/legal/…` at its
/// root, so the URL is unchanged.
String legalUrl(String doc, {String base = apiBaseUrl}) =>
    '${base.replaceFirst(RegExp(r'/api/?$'), '')}/legal/$doc';

/// Opens a legal page in the browser (a new tab on web). False when nothing
/// could open it — `launchUrl` throws rather than returning false for some
/// failures (no handler for the URL), and a tap handler has nowhere to catch.
Future<bool> openLegalPage(String doc) async {
  try {
    return await launchUrl(
      Uri.parse(legalUrl(doc)),
      mode: LaunchMode.externalApplication,
    );
  } catch (_) {
    return false;
  }
}
