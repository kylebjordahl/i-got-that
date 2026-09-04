plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
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
    productFlavors {
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
        }
        create("prod") {
            dimension = "env"
        }
    }

    buildTypes {
        release {
            // Debug keys for now, so `flutter build apk --release` works for
            // anyone without the upload keystore. Real signing — a
            // `signingConfigs.release` reading a gitignored key.properties —
            // lands with the Play upload pipeline, alongside the deploy
            // workflow's play-build/play-upload jobs.
            signingConfig = signingConfigs.getByName("debug")
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
