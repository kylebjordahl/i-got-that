import 'package:caretaker_app/env.dart';
import 'package:caretaker_app/widgets/env_ribbon.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget host({required bool show}) => MaterialApp(
        home: EnvRibbon(show: show, child: const Text('app body')),
      );

  testWidgets('staging builds show the beta ribbon over the app', (t) async {
    await t.pumpWidget(host(show: true));
    expect(find.text('app body'), findsOneWidget);
    expect(find.text('BETA'), findsOneWidget);
  });

  testWidgets('other builds add nothing at all', (t) async {
    await t.pumpWidget(host(show: false));
    expect(find.text('BETA'), findsNothing);
    expect(find.byType(Stack), findsNothing);
  });

  test('the ribbon is gated on APP_ENV=staging', () {
    // The default (no --dart-define) is a local build: no ribbon.
    expect(appEnv, '');
    expect(isStagingBuild, isFalse);
  });
}
