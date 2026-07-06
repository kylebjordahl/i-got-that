import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:caretaker_app/main.dart';

void main() {
  testWidgets('shows the sign-in screen when unauthenticated', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: CaretakerApp()));
    await tester.pumpAndSettle();

    expect(find.text('I Got That'), findsOneWidget);
    expect(find.text('Continue with magic link'), findsOneWidget);
  });
}
