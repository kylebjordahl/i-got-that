import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Height of one row on a Cupertino wheel (`CupertinoTimerPicker`'s item
/// extent), which is what a drag has to cover to advance the value by one.
const double _kWheelItemExtent = 32;

/// Spins the minute wheel of an open duration picker by [notches] (positive =
/// longer) and confirms with Done. Assumes the sheet the field opened is the
/// only thing with wheels on screen — hours is wheel 0, minutes is wheel 1.
Future<void> pickDurationNotches(WidgetTester tester, int notches) async {
  await tester.drag(
    find.byType(ListWheelScrollView).at(1),
    Offset(0, -notches * _kWheelItemExtent),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text('Done'));
  await tester.pumpAndSettle();
}
