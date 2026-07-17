/// Build-time environment — set with `--dart-define=APP_ENV=staging|production`
/// (see .github/workflows/deploy.yml). Empty, the default, means a local build.
const appEnv = String.fromEnvironment('APP_ENV');

/// Staging wears a corner ribbon (see [EnvRibbon]) so a staging build is never
/// mistaken for production — the two look identical otherwise.
const isStagingBuild = appEnv == 'staging';
