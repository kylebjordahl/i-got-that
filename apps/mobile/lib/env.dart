/// Build-time environment — set with `--dart-define=APP_ENV=staging|production`
/// (see .github/workflows/deploy.yml). Empty, the default, means a local build.
const appEnv = String.fromEnvironment('APP_ENV');

/// Staging wears a corner ribbon (see [EnvRibbon]) so a staging build is never
/// mistaken for production — the two look identical otherwise.
const isStagingBuild = appEnv == 'staging';

/// `flutter_web_auth_2`'s callback scheme for the native "connect a Google
/// Calendar" wizard (`connect_account_wizard.dart`). Must match, for this
/// flavor: Info.plist's `GOOGLE_OAUTH_CALLBACK_SCHEME`
/// (`ios/Flutter/{staging,prod}*.xcconfig`), the `oauthCallbackScheme` manifest
/// placeholder (`android/app/build.gradle.kts`), and the API's
/// `GOOGLE_NATIVE_OAUTH_CALLBACK_SCHEME` (`wrangler.jsonc`). A mismatch has no
/// error path — the wizard just strands on a blank browser sheet. See
/// docs/AUTH.md's Google section.
const googleOAuthCallbackScheme = isStagingBuild
    ? 'com.kylebjordahl.igt.staging.oauth'
    : 'com.kylebjordahl.igt.oauth';
