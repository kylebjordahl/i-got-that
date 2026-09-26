import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing material, loaded from a gitignored `android/key.properties`
// (see android/.gitignore) so the upload key never enters the repo. The deploy
// workflow writes this file from repository secrets; locally it simply doesn't
// exist, and release builds fall back to the debug key below so
// `flutter build apk --release` still works for anyone who clones this.
//
//   storeFile=/absolute/path/to/igt-upload.jks   <- absolute: Gradle does not
//   storePassword=…                                 expand `~`
//   keyAlias=upload
//   keyPassword=…
val keystorePropertiesFile = rootProject.file("key.properties")
val hasUploadKeystore = keystorePropertiesFile.exists()
val keystoreProperties = Properties().apply {
    if (hasUploadKeystore) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}

// A half-filled key.properties is worse than none: the build would otherwise
// fail deep inside the signing task, or — if a property silently resolves to
// null — produce an unsigned bundle. Name the missing keys up front instead.
if (hasUploadKeystore) {
    val missing = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
        .filter { keystoreProperties.getProperty(it).isNullOrBlank() }
    if (missing.isNotEmpty()) {
        throw GradleException(
            "android/key.properties is missing: ${missing.joinToString(", ")}. " +
                "See docs/DEPLOYMENT.md § 11.",
        )
    }
}

// CI sets this for the release AAB build, so a missing or unreadable
// key.properties fails the build rather than quietly producing a
// debug-signed bundle. That matters most on a Play app's *first* upload:
// whichever certificate signs it becomes that app's upload certificate
// permanently, and a debug key there is not recoverable without Play support.
if (System.getenv("IGT_REQUIRE_RELEASE_SIGNING") == "true" && !hasUploadKeystore) {
    throw GradleException(
        "IGT_REQUIRE_RELEASE_SIGNING=true but android/key.properties is absent, " +
            "so this build would be signed with the debug key. Refusing.",
    )
}

android {
    namespace = "com.kylebjordahl.igt"

    // SDK levels are pinned as literals rather than taken from
    // `flutter.compileSdkVersion` / `flutter.targetSdkVersion` /
    // `flutter.minSdkVersion` on purpose: a Flutter upgrade would otherwise
    // move all three silently, and both ends of the range matter here.
    // `targetSdk` is a Play requirement (see below) and `minSdk` is the floor
    // the plugins were chosen against.
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Matches the iOS `prod` bundle id; the `staging` flavor below appends
        // `.staging` so the two installs coexist on one device, exactly as the
        // two iOS bundle ids do.
        applicationId = "com.kylebjordahl.igt"

        // Flutter 3.47's own template default. Above flutter_secure_storage's
        // floor of 23, and the combination the plugin ecosystem tests against.
        minSdk = 24

        // Since 31 August 2026 Google Play requires new apps *and updates* to
        // target Android 16 / API 36; an upload below that is rejected outright.
        targetSdk = 36

        // Supplied by --build-name / --build-number (see the deploy workflow),
        // falling back to pubspec.yaml's `version:` for a bare local build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // One dimension, and the flavor names match the iOS schemes exactly
    // (ios/Runner.xcodeproj/xcshareddata/xcschemes/{staging,prod}.xcscheme), so
    // `--flavor staging` means the same thing on both platforms.
    flavorDimensions += "env"

    // The launcher label comes from each flavor's own source set —
    // src/{staging,prod}/res/values/strings.xml, resolved by
    // `android:label="@string/app_name"` in the manifest — rather than from
    // `resValue(...)`. AGP 9 ships with the `resValues` build feature disabled
    // by default ("Product Flavor staging contains custom resource values, but
    // the feature is disabled"), and a flavor source set is the mechanism that
    // doesn't depend on a build-feature default staying put.
    //
    // `oauthCallbackScheme` feeds the flutter_web_auth_2 CallbackActivity in
    // the manifest — the custom scheme the connect-a-Google-Calendar wizard
    // comes back on. It must match this flavor's `googleOAuthCallbackScheme`
    // in lib/env.dart AND this env's GOOGLE_NATIVE_OAUTH_CALLBACK_SCHEME in
    // apps/api/wrangler.jsonc; the Worker's /auth/google/native-callback 302s
    // to exactly this scheme, so a mismatch strands the wizard on a blank
    // Custom Tab with no error.
    productFlavors {
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
            manifestPlaceholders["oauthCallbackScheme"] =
                "com.kylebjordahl.igt.staging.oauth"
        }
        create("prod") {
            dimension = "env"
            manifestPlaceholders["oauthCallbackScheme"] =
                "com.kylebjordahl.igt.oauth"
        }
    }

    signingConfigs {
        // Only declared when the properties file is actually present —
        // an AGP signing config with null credentials fails configuration,
        // which would break every local build rather than just release ones.
        if (hasUploadKeystore) {
            create("release") {
                // Resolved against android/ (not app/) and left as-is when
                // already absolute, so the same file works for a developer
                // pointing at ~/igt-upload.jks and for CI writing it next to
                // key.properties.
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // The upload key when it's available, the debug key otherwise, so
            // `flutter build apk --release` works for anyone who clones this
            // without the keystore. CI guards the difference with
            // IGT_REQUIRE_RELEASE_SIGNING (above) rather than trusting this
            // fallback not to reach Play.
            signingConfig = if (hasUploadKeystore) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
