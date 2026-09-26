import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/widgets/app_bottom_nav.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Toasts under the signed-in shell must clear the floating nav pill without
/// each call site passing `margin:` — the thing new code kept forgetting.
void main() {
  Future<Rect> toastRect(WidgetTester tester, {required bool fromSheet}) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: SnackBarsAboveNav(
          child: Scaffold(
            body: Builder(
              builder: (context) => Center(
                child: TextButton(
                  onPressed: () {
                    void toast(BuildContext c) => ScaffoldMessenger.of(
                      c,
                    ).showSnackBar(const SnackBar(content: Text('Saved')));
                    if (!fromSheet) return toast(context);
                    // Like the app's sheets: on the root navigator, no
                    // Scaffold of their own, toast then pop.
                    showModalBottomSheet<void>(
                      context: context,
                      useRootNavigator: true,
                      builder: (sheet) => TextButton(
                        onPressed: () {
                          Navigator.of(sheet).pop();
                          toast(sheet);
                        },
                        child: const Text('Save'),
                      ),
                    );
                  },
                  child: const Text('Go'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Go'));
    await tester.pumpAndSettle();
    if (fromSheet) {
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
    }
    // The SnackBar's own box spans its margin; measure what's visible.
    return tester.getRect(find.text('Saved'));
  }

  for (final fromSheet in [false, true]) {
    testWidgets('a plain SnackBar floats above the nav pill'
        '${fromSheet ? ' when raised from a bottom sheet' : ''}', (
      tester,
    ) async {
      final screenHeight =
          tester.view.physicalSize.height / tester.view.devicePixelRatio;
      final rect = await toastRect(tester, fromSheet: fromSheet);
      expect(screenHeight - rect.bottom, greaterThan(kBottomNavClearance));
    });
  }
}
