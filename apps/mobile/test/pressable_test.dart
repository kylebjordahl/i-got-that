import 'package:caretaker_app/widgets/pressable.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

const _target = Key('target');

double _scale(WidgetTester t) =>
    t.widget<AnimatedScale>(find.byType(AnimatedScale)).scale;

Widget _host({
  bool enabled = true,
  bool reduceMotion = false,
  VoidCallback? onTap,
  bool scrollable = false,
}) {
  final item = Pressable(
    enabled: enabled,
    scale: 0.9,
    child: GestureDetector(
      onTap: onTap,
      child: const ColoredBox(
        color: Colors.red,
        child: SizedBox(key: _target, width: 100, height: 100),
      ),
    ),
  );
  return MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: reduceMotion),
      child: scrollable
          ? ListView(children: [item, const SizedBox(height: 2000)])
          : Center(child: item),
    ),
  );
}

void main() {
  testWidgets('dips while held and restores on release', (t) async {
    await t.pumpWidget(_host());
    expect(_scale(t), 1);
    final g = await t.startGesture(t.getCenter(find.byKey(_target)));
    await t.pump(const Duration(milliseconds: 150));
    expect(_scale(t), 0.9);
    await g.up();
    await t.pump(const Duration(milliseconds: 100));
    expect(_scale(t), 1);
  });

  testWidgets('a quick tap still shows the dip, and still taps', (t) async {
    var taps = 0;
    await t.pumpWidget(_host(onTap: () => taps++));
    await t.tap(find.byKey(_target));
    await t.pump();
    expect(_scale(t), 0.9);
    await t.pump(const Duration(milliseconds: 100));
    expect(_scale(t), 1);
    expect(taps, 1);
  });

  testWidgets('a scroll starting on the item never dips it', (t) async {
    await t.pumpWidget(_host(scrollable: true));
    final g = await t.startGesture(t.getCenter(find.byKey(_target)));
    await t.pump(const Duration(milliseconds: 20));
    await g.moveBy(const Offset(0, -40));
    await t.pump(const Duration(milliseconds: 300));
    expect(_scale(t), 1);
    await g.up();
    await t.pumpAndSettle();
  });

  testWidgets('disabled and reduced-motion never scale', (t) async {
    await t.pumpWidget(_host(enabled: false));
    var g = await t.startGesture(t.getCenter(find.byKey(_target)));
    await t.pump(const Duration(milliseconds: 150));
    expect(_scale(t), 1);
    await g.up();
    await t.pumpWidget(_host(reduceMotion: true));
    g = await t.startGesture(t.getCenter(find.byKey(_target)));
    await t.pump(const Duration(milliseconds: 150));
    expect(_scale(t), 1);
    await g.up();
  });

  testWidgets('only the innermost Pressable dips', (t) async {
    await t.pumpWidget(
      const MaterialApp(
        home: Center(
          child: Pressable(
            child: Pressable(
              child: ColoredBox(
                color: Colors.red,
                child: SizedBox(key: _target, width: 100, height: 100),
              ),
            ),
          ),
        ),
      ),
    );
    final g = await t.startGesture(t.getCenter(find.byKey(_target)));
    await t.pump(const Duration(milliseconds: 150));
    final scales = t
        .widgetList<AnimatedScale>(find.byType(AnimatedScale))
        .map((w) => w.scale)
        .toList();
    expect(scales.where((s) => s < 1), hasLength(1));
    await g.up();
    await t.pump(const Duration(milliseconds: 100));
  });

  testWidgets('toggling enabled keeps the child mounted', (t) async {
    await t.pumpWidget(_host());
    final before = t.element(find.byKey(_target));
    await t.pumpWidget(_host(enabled: false));
    expect(t.element(find.byKey(_target)), same(before));
  });

  testWidgets('a second finger does not leave the item stuck pressed', (
    t,
  ) async {
    await t.pumpWidget(_host());
    final c = t.getCenter(find.byKey(_target));
    final a = await t.startGesture(c);
    await t.pump(const Duration(milliseconds: 20));
    final b = await t.startGesture(c + const Offset(10, 0));
    await b.up();
    await t.pump(const Duration(milliseconds: 150));
    await a.up();
    await t.pump(const Duration(milliseconds: 300));
    expect(_scale(t), 1);
  });

  testWidgets('a quick double tap leaves no timer behind', (t) async {
    await t.pumpWidget(_host());
    await t.tap(find.byKey(_target));
    await t.pump(const Duration(milliseconds: 20));
    await t.tap(find.byKey(_target));
    await t.pump(const Duration(milliseconds: 20));
    await t.pumpWidget(const SizedBox());
  });
}
