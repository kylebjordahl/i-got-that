import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:caretaker_app/main.dart';

void main() {
  // AuthController's native startup path reads a persisted session from
  // secure storage (see lib/state/auth.dart); stub it so the real platform
  // channel (unavailable under `flutter test`) isn't hit.
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  Future<void> pumpApp(WidgetTester tester) async {
    await tester.pumpWidget(const ProviderScope(child: CaretakerApp()));
    await tester.pumpAndSettle();
  }

  testWidgets('shows the welcome / sign-in screen when unauthenticated', (
    tester,
  ) async {
    await pumpApp(tester);

    expect(find.text('I Got That'), findsOneWidget);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.text('Email me a magic link'), findsOneWidget);
  });

  // Sign in with Apple has no Android implementation wired up — the package
  // needs an Apple Services ID and an `intent://` server callback there — so
  // offering the button would only ever throw. See `appleSignInAvailable`.
  // `TargetPlatformVariant` rather than assigning
  // `debugDefaultTargetPlatformOverride` directly: the test framework asserts
  // foundation debug vars are unset by the end of the body, which a plain
  // `tearDown` runs too late to satisfy.
  testWidgets('Android is offered Google and magic link, but not Apple', (
    tester,
  ) async {
    await pumpApp(tester);

    expect(find.text('Continue with Apple'), findsNothing);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.text('Email me a magic link'), findsOneWidget);
  }, variant: TargetPlatformVariant.only(TargetPlatform.android));

  testWidgets('iOS is offered Apple alongside the rest', (tester) async {
    await pumpApp(tester);

    expect(find.text('Continue with Apple'), findsOneWidget);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.text('Email me a magic link'), findsOneWidget);
  }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));
}
