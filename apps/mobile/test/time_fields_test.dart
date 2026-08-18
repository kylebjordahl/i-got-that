import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/widgets/time_fields.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/duration_wheel.dart';

Widget _host(Widget child, {TargetPlatform? platform}) => MaterialApp(
  theme: platform == null
      ? buildAppTheme()
      : buildAppTheme().copyWith(platform: platform),
  home: Scaffold(body: Center(child: child)),
);

void main() {
  group('wire formats', () {
    test('a clock time round-trips through the API string', () {
      expect(parseClockTime('08:30'), const TimeOfDay(hour: 8, minute: 30));
      expect(parseClockTime('8:05'), const TimeOfDay(hour: 8, minute: 5));
      expect(formatClockTime(const TimeOfDay(hour: 8, minute: 5)), '08:05');
      expect(formatClockTime(const TimeOfDay(hour: 14, minute: 45)), '14:45');
    });

    test('a malformed or absent clock time parses to null', () {
      for (final raw in [null, '', 'noon', '8', '08:5', '24:00', '08:60']) {
        expect(parseClockTime(raw), isNull, reason: 'parsed "$raw"');
      }
    });

    test('a length reads in words, by magnitude', () {
      expect(formatMinutes(0), '0 min');
      expect(formatMinutes(45), '45 min');
      expect(formatMinutes(60), '1 hr');
      expect(formatMinutes(95), '1 hr 35 min');
      expect(formatMinutes(-20), '20 min');
    });
  });

  testWidgets('a clock field opens the platform picker and reports the pick', (
    tester,
  ) async {
    TimeOfDay? picked;
    await tester.pumpWidget(
      _host(
        ClockTimePickerField(
          label: 'Day starts',
          value: const TimeOfDay(hour: 8, minute: 30),
          onChanged: (t) => picked = t,
        ),
        // Cupertino platforms get the wheel; this is the Material half.
        platform: TargetPlatform.android,
      ),
    );

    expect(find.text('8:30 AM'), findsOneWidget);
    await tester.tap(find.text('8:30 AM'));
    await tester.pumpAndSettle();

    // Material's picker, titled after the field it came from.
    expect(find.text('DAY STARTS'), findsOneWidget);
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    expect(picked, const TimeOfDay(hour: 8, minute: 30));
  });

  testWidgets('on iOS the clock field opens the Cupertino wheel', (
    tester,
  ) async {
    TimeOfDay? picked;
    await tester.pumpWidget(
      _host(
        ClockTimePickerField(
          label: 'Day ends',
          value: const TimeOfDay(hour: 14, minute: 45),
          onChanged: (t) => picked = t,
        ),
        platform: TargetPlatform.iOS,
      ),
    );

    await tester.tap(find.text('2:45 PM'));
    await tester.pumpAndSettle();
    expect(find.byType(CupertinoDatePicker), findsOneWidget);

    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(picked, const TimeOfDay(hour: 14, minute: 45));
  });

  testWidgets('dismissing the clock picker leaves the value alone', (
    tester,
  ) async {
    var changes = 0;
    await tester.pumpWidget(
      _host(
        ClockTimePickerField(
          label: 'Day starts',
          value: const TimeOfDay(hour: 8, minute: 30),
          onChanged: (_) => changes++,
        ),
        platform: TargetPlatform.iOS,
      ),
    );

    await tester.tap(find.text('8:30 AM'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(changes, 0);
  });

  testWidgets('an optional clock time shows its stand-in and can be cleared', (
    tester,
  ) async {
    var cleared = false;
    await tester.pumpWidget(
      _host(
        ClockTimePickerField(
          label: 'New day starts',
          value: const TimeOfDay(hour: 10, minute: 0),
          emptyLabel: 'Unchanged',
          onChanged: (_) {},
          onCleared: () => cleared = true,
        ),
      ),
    );

    await tester.tap(find.byIcon(Icons.close_rounded));
    await tester.pumpAndSettle();
    expect(cleared, isTrue);

    await tester.pumpWidget(
      _host(
        ClockTimePickerField(
          label: 'New day starts',
          value: null,
          emptyLabel: 'Unchanged',
          onChanged: (_) {},
          onCleared: () {},
        ),
      ),
    );
    expect(find.text('Unchanged'), findsOneWidget);
    // Nothing to clear while it's already unset.
    expect(find.byIcon(Icons.close_rounded), findsNothing);
  });

  testWidgets('a duration field picks a length off the wheel', (tester) async {
    int? picked;
    await tester.pumpWidget(
      _host(
        DurationPickerField(
          label: 'Drop-off',
          minutes: 15,
          onChanged: (m) => picked = m,
        ),
      ),
    );

    expect(find.text('15 min'), findsOneWidget);
    await tester.tap(find.text('15 min'));
    await tester.pumpAndSettle();
    await pickDurationNotches(tester, 5);
    expect(picked, 20);
  });

  testWidgets('a signed window picks its direction rather than a minus sign', (
    tester,
  ) async {
    int? picked;
    await tester.pumpWidget(
      _host(
        DurationPickerField(
          label: 'Task window',
          minutes: 20,
          directions: (forward: 'after start', backward: 'before start'),
          onChanged: (m) => picked = m,
        ),
      ),
    );

    expect(find.text('20 min after start'), findsOneWidget);
    await tester.tap(find.text('20 min after start'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('before start'));
    await tester.pumpAndSettle();
    await pickDurationNotches(tester, 0);
    expect(picked, -20);
  });

  testWidgets('an unset duration opens at its fallback and clears back', (
    tester,
  ) async {
    int? picked;
    var cleared = false;
    await tester.pumpWidget(
      _host(
        DurationPickerField(
          label: 'Travel time',
          minutes: null,
          emptyLabel: 'Estimated',
          onChanged: (m) => picked = m,
          onCleared: () => cleared = true,
        ),
      ),
    );

    // Unset reads as the stand-in, with nothing to clear yet.
    expect(find.text('Estimated'), findsOneWidget);
    expect(find.byIcon(Icons.close_rounded), findsNothing);

    await tester.tap(find.text('Estimated'));
    await tester.pumpAndSettle();
    await pickDurationNotches(tester, 0);
    expect(picked, 15);

    await tester.pumpWidget(
      _host(
        DurationPickerField(
          label: 'Travel time',
          minutes: 25,
          emptyLabel: 'Estimated',
          onChanged: (_) {},
          onCleared: () => cleared = true,
        ),
      ),
    );
    await tester.tap(find.byIcon(Icons.close_rounded));
    await tester.pumpAndSettle();
    expect(cleared, isTrue);
  });
}
