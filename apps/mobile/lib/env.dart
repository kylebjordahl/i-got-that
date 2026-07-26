/// Build-time environment — set with `--dart-define=APP_ENV=staging|production`
/// (see .github/workflows/deploy.yml). Empty, the default, means a local build.
const appEnv = String.fromEnvironment('APP_ENV');

/// Staging wears a corner ribbon (see [EnvRibbon]) so a staging build is never
/// mistaken for production — the two look identical otherwise.
const isStagingBuild = appEnv == 'staging';

/// `flutter_web_auth_2`'s callback scheme for the native "connect a Google
/// Calendar" wizard (`connect_account_wizard.dart`) — must match Info.plist's
/// `GOOGLE_OAUTH_CALLBACK_SCHEME` (`ios/Flutter/{staging,prod}*.xcconfig`) and
/// the API's `GOOGLE_IOS_OAUTH_CALLBACK_SCHEME` (`wrangler.jsonc`) for this
/// flavor. See docs/AUTH.md's Google section.
const googleOAuthCallbackScheme =
    isStagingBuild ? 'com.kylebjordahl.igt.staging.oauth' : 'com.kylebjordahl.igt.oauth';
