import 'package:url_launcher/url_launcher.dart';
import '../state/auth.dart';

/// A public legal page (`privacy` or `terms`). The API worker serves these at
/// the apex `/legal/…`, not under `/api`, so the origin is [base] less its
/// `/api` suffix. On web (`/api`) that leaves a same-origin relative path;
/// locally (`wrangler dev`, no prefix) the worker serves `/legal/…` at its
/// root, so the URL is unchanged.
String legalUrl(String doc, {String base = apiBaseUrl}) =>
    '${base.replaceFirst(RegExp(r'/api/?$'), '')}/legal/$doc';

/// Opens a legal page in the browser (a new tab on web).
Future<bool> openLegalPage(String doc) =>
    launchUrl(Uri.parse(legalUrl(doc)), mode: LaunchMode.externalApplication);
