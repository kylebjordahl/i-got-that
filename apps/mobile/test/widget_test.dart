import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:caretaker_app/main.dart';

void main() {
  // AuthController's native startup path reads a persisted session from
  // secure storage (see lib/state/auth.dart); stub it so the real platform
  // channel (unavailable under `flutter test`) isn't hit.
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('shows the sign-in screen when unauthenticated', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: CaretakerApp()));
    await tester.pumpAndSettle();

    expect(find.text('I Got That'), findsOneWidget);
    expect(find.text('Continue with magic link'), findsOneWidget);
  });
}
