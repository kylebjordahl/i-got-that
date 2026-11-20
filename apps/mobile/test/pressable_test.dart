import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:caretaker_app/widgets/pressable.dart';

double _scale(WidgetTester t) =>
    t.widget<AnimatedScale>(find.byType(AnimatedScale)).scale;

Widget _host({bool enabled = true, bool reduceMotion = false}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(disableAnimations: reduceMotion),
    child: Center(
      child: Pressable(
        enabled: enabled,
        scale: 0.9,
        child: const ColoredBox(
          color: Colors.red,
          child: SizedBox(key: Key('target'), width: 100, height: 100),
        ),
      ),
    ),
  ),
);

void main() {
  testWidgets('dips while pressed and restores on release', (t) async {
    await t.pumpWidget(_host());
    expect(_scale(t), 1);
    final g = await t.startGesture(
      t.getCenter(find.byKey(const Key('target'))),
    );
    await t.pump();
    expect(_scale(t), 0.9);
    await g.up();
    await t.pump(const Duration(milliseconds: 100));
    expect(_scale(t), 1);
  });

  testWidgets('a quick tap still shows the dip before releasing', (t) async {
    await t.pumpWidget(_host());
    await t.tap(find.byKey(const Key('target')));
    await t.pump();
    expect(_scale(t), 0.9);
    await t.pump(const Duration(milliseconds: 100));
    expect(_scale(t), 1);
  });

  testWidgets('releases when the finger drags away (scrolling)', (t) async {
    await t.pumpWidget(_host());
    final g = await t.startGesture(
      t.getCenter(find.byKey(const Key('target'))),
    );
    await t.pump(const Duration(milliseconds: 100));
    await g.moveBy(const Offset(0, 40));
    await t.pump(const Duration(milliseconds: 100));
    expect(_scale(t), 1);
    await g.up();
  });

  testWidgets('disabled and reduced-motion render the child untouched', (
    t,
  ) async {
    await t.pumpWidget(_host(enabled: false));
    expect(find.byType(AnimatedScale), findsNothing);
    await t.pumpWidget(_host(reduceMotion: true));
    expect(find.byType(AnimatedScale), findsNothing);
  });
}
