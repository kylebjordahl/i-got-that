import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/home_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records the resolution parameters passed to resolveConflict.
class _RecordingApiClient extends ApiClient {
  _RecordingApiClient() : super(baseUrl: 'http://test');

  Map<String, Object?>? lastResolve;

  @override
  Future<void> resolveConflict(
    String familyId,
    String conflictId, {
    int travelBeforeMin = 0,
    int travelAfterMin = 0,
    bool beforeNeeded = true,
    bool afterNeeded = true,
  }) async {
    lastResolve = {
      'travelBeforeMin': travelBeforeMin,
      'travelAfterMin': travelAfterMin,
      'beforeNeeded': beforeNeeded,
      'afterNeeded': afterNeeded,
    };
  }
}

Member _m(String id, String name,
        {bool caretaker = false, bool admin = false, bool child = false}) =>
    Member(
      id: id,
      relationName: name,
      isCaretaker: caretaker,
      isAdmin: admin,
      requiresCaretaker: child,
    );

void main() {
  final me = _m('dad', 'Dad', caretaker: true, admin: true);
  final theo = _m('theo', 'Theo', child: true);

  final day = DateTime.now().add(const Duration(days: 1));
  final conflict = Conflict(
    id: 'c1',
    familyMemberId: 'theo',
    loser: ConflictEventRef(
      summary: 'School day',
      allDay: false,
      start: DateTime(day.year, day.month, day.day, 8, 30),
      end: DateTime(day.year, day.month, day.day, 15, 0),
    ),
    winner: ConflictEventRef(
      summary: 'Doctor appointment',
      allDay: false,
      start: DateTime(day.year, day.month, day.day, 10, 0),
      end: DateTime(day.year, day.month, day.day, 11, 0),
    ),
  );

  final task = TaskItem(
    id: 't1',
    familyMemberId: 'theo',
    type: 'pickup',
    start: DateTime.now().add(const Duration(hours: 3)),
    status: 'unowned',
    createdVia: 'generated',
    calendarEventId: 'e1',
  );

  Widget app() => ProviderScope(
        overrides: [
          membersProvider.overrideWith((ref) async => [me, theo]),
          currentMemberProvider.overrideWith((ref) async => me),
          unownedTasksProvider.overrideWith((ref) async => [task]),
          allTasksProvider.overrideWith((ref) async => [task]),
          pendingDecisionsProvider.overrideWith((ref) async => const []),
          conflictsProvider.overrideWith((ref) async => [conflict]),
          calendarEventsProvider.overrideWith((ref) async => const []),
          threadingThresholdProvider.overrideWith((ref) async => 30),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: HomeScreen()),
        ),
      );

  testWidgets('a double-booking ranks at the top of Home and opens the sheet',
      (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    expect(find.text('DOUBLE-BOOKED'), findsOneWidget);
    expect(find.textContaining('School day'), findsWidgets);
    expect(find.textContaining('Doctor appointment'), findsWidgets);
    expect(find.text('Review & resolve'), findsOneWidget);

    // The conflict card sits above the claimable task queue.
    final conflictY = tester.getTopLeft(find.text('DOUBLE-BOOKED')).dy;
    final taskY = tester.getTopLeft(find.text('Claim').first).dy;
    expect(conflictY, lessThan(taskY));

    // Tapping the card opens the resolution sheet with both terminal actions
    // and a preview of the split segments the "Confirm split" would leave.
    await tester.tap(find.text('Review & resolve'));
    await tester.pumpAndSettle();

    expect(find.text('Two events, one Theo'), findsOneWidget);
    expect(find.text('Confirm split'), findsOneWidget);
    expect(find.text('Ignore conflict — keep both as-is'), findsOneWidget);
    // Loser (School day) split into two segments around the kept winner. Scoped
    // to the sheet — the card underneath names both events too.
    Finder inSheet(String text) =>
        find.descendant(of: find.byType(BottomSheet), matching: find.text(text));
    expect(inSheet('School day'), findsNWidgets(2));
    expect(inSheet('Doctor appointment'), findsOneWidget);
    expect(find.text('Fixed'), findsOneWidget);
  });

  testWidgets('the card lists both events as peers, winner first, under a '
      'date + member header', (tester) async {
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();

    // Both events are named outright, each with its own clock label — no prose
    // explaining the overlap.
    final winner = find.text('Doctor appointment');
    final loser = find.text('School day');
    expect(winner, findsOneWidget);
    expect(loser, findsOneWidget);
    expect(find.text('10:00 – 11:00 AM'), findsOneWidget);
    expect(find.text('8:30 AM – 3:00 PM'), findsOneWidget);
    expect(find.textContaining("can't be in two places"), findsNothing);
    expect(find.textContaining('Overlaps'), findsNothing);

    // Higher-priority event first.
    final winnerY = tester.getTopLeft(winner).dy;
    expect(winnerY, lessThan(tester.getTopLeft(loser).dy));

    // Header: the date sits on the left (beside the icon), the member on the
    // right as avatar + name. The date isn't shouted in caps.
    final date = find.text('Tomorrow');
    expect(date, findsOneWidget);
    final name = find.text('Theo');
    expect(name, findsOneWidget);
    final dateBox = tester.getTopLeft(date);
    final avatarX = tester.getTopLeft(find.text('T').first).dx;
    expect(dateBox.dy, lessThan(winnerY));
    expect(dateBox.dx, lessThan(avatarX));
    expect(avatarX, lessThan(tester.getTopLeft(name).dx));
  });

  testWidgets('trashing a half marks it not needed in the resolution',
      (tester) async {
    // Tall enough that the whole sheet (both halves + footer) is on-screen.
    tester.view.physicalSize = const Size(600, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _RecordingApiClient();
    await tester.pumpWidget(ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        familyProvider.overrideWith((ref) async => 'fam-1'),
        membersProvider.overrideWith((ref) async => [me, theo]),
        currentMemberProvider.overrideWith((ref) async => me),
        unownedTasksProvider.overrideWith((ref) async => [task]),
        allTasksProvider.overrideWith((ref) async => [task]),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        conflictsProvider.overrideWith((ref) async => [conflict]),
        calendarEventsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: HomeScreen()),
      ),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Review & resolve'));
    await tester.pumpAndSettle();

    // Both halves start kept, each with a trash button; trash the morning half
    // (its control flips to a restore icon) and confirm.
    expect(find.byIcon(Icons.delete_outline_rounded), findsNWidgets(2));
    await tester.tap(find.byIcon(Icons.delete_outline_rounded).first);
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.undo_rounded), findsOneWidget);

    await tester.tap(find.text('Confirm split'));
    await tester.pumpAndSettle();

    // The morning is dropped (and its travel zeroed); the afternoon is kept.
    expect(api.lastResolve, {
      'travelBeforeMin': 0,
      'travelAfterMin': 0,
      'beforeNeeded': false,
      'afterNeeded': true,
    });
  });

  testWidgets('dragging a travel handle steps in 5-minute increments without '
      'dragging the sheet', (tester) async {
    tester.view.physicalSize = const Size(600, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _RecordingApiClient();
    await tester.pumpWidget(ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        familyProvider.overrideWith((ref) async => 'fam-1'),
        membersProvider.overrideWith((ref) async => [me, theo]),
        currentMemberProvider.overrideWith((ref) async => me),
        unownedTasksProvider.overrideWith((ref) async => [task]),
        allTasksProvider.overrideWith((ref) async => [task]),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        conflictsProvider.overrideWith((ref) async => [conflict]),
        calendarEventsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: HomeScreen()),
      ),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Review & resolve'));
    await tester.pumpAndSettle();

    final title = find.text('Two events, one Theo');
    final sheetTop = tester.getTopLeft(title).dy;

    // The label is the only hook on the handle, and the test font stretches the
    // pill past the screen edge — so drag from just inside its label rather than
    // from the (off-screen) centre.
    Future<void> dragHandle(String label, double dy) async {
      final grip = tester.getTopLeft(find.text(label)) + const Offset(2, 4);
      await tester.dragFrom(grip, Offset(0, dy));
      await tester.pumpAndSettle();
    }

    // A small movement is a small, round adjustment: 22px ≈ 7min, snapped to 5
    // (at the old 1.4px/min it would already have been 16 minutes).
    await dragHandle('Pick-up · 10:00', -22);
    expect(find.text('Travel time · 5 min'), findsOneWidget);
    expect(find.text('Pick-up · 9:55'), findsOneWidget);

    // 60px further up is 20 more minutes, and picks up where the last drag left
    // off rather than re-snapping from the displayed 5.
    await dragHandle('Pick-up · 9:55', -60);
    expect(find.text('Travel time · 25 min'), findsOneWidget);
    expect(find.text('Pick-up · 9:35'), findsOneWidget);

    // Dragging back below zero stops at zero — no negative travel, and no dead
    // zone to unwind before the number moves again.
    await dragHandle('Pick-up · 9:35', 200);
    expect(find.textContaining('Travel time'), findsNothing);
    expect(find.text('Pick-up · 10:00'), findsOneWidget);

    // The handle owns the gesture: a long pull downwards (the direction that
    // used to drag the sheet away instead) leaves the sheet exactly where it is,
    // mid-drag and after release. Travel is already at zero, so the only thing
    // that could move the title here is the sheet itself.
    final grip = tester.getTopLeft(find.text('Pick-up · 10:00')) + const Offset(2, 4);
    final gesture = await tester.startGesture(grip);
    await gesture.moveBy(const Offset(0, 120));
    await tester.pump();
    expect(tester.getTopLeft(title).dy, sheetTop);
    await gesture.up();
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(title).dy, sheetTop);
    expect(find.textContaining('Travel time'), findsNothing);

    // What's sent is the number the preview was labelled with.
    await dragHandle('Pick-up · 10:00', -33);
    expect(find.text('Travel time · 10 min'), findsOneWidget);

    await tester.tap(find.text('Confirm split'));
    await tester.pumpAndSettle();
    expect(api.lastResolve, {
      'travelBeforeMin': 10,
      'travelAfterMin': 0,
      'beforeNeeded': true,
      'afterNeeded': true,
    });
  });

  /// Home with [c]'s conflict card — the resolution sheet opens from
  /// "Review & resolve". Keyed on the conflict so pumping a different one builds
  /// a fresh scope instead of reusing the previous conflict's providers.
  Widget appWith(Conflict c) => ProviderScope(
        key: ValueKey('${c.id}-${c.winner.end}'),
        overrides: [
          familyProvider.overrideWith((ref) async => 'fam-1'),
          membersProvider.overrideWith((ref) async => [me, theo]),
          currentMemberProvider.overrideWith((ref) async => me),
          unownedTasksProvider.overrideWith((ref) async => [task]),
          allTasksProvider.overrideWith((ref) async => [task]),
          pendingDecisionsProvider.overrideWith((ref) async => const []),
          conflictsProvider.overrideWith((ref) async => [c]),
          calendarEventsProvider.overrideWith((ref) async => const []),
          threadingThresholdProvider.overrideWith((ref) async => 30),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: HomeScreen()),
        ),
      );

  /// The same conflict with the appointment stretched to [hours] — the preview's
  /// zoom is derived from the appointment's length, so this changes the scale.
  Conflict withWinnerHours(int hours) => Conflict(
        id: conflict.id,
        familyMemberId: conflict.familyMemberId,
        loser: conflict.loser,
        winner: ConflictEventRef(
          summary: conflict.winner.summary,
          allDay: false,
          start: conflict.winner.start,
          end: conflict.winner.start.add(Duration(hours: hours)),
        ),
      );

  testWidgets('the appointment and the travel gap render to one scale, zoomed '
      'to the conflict', (tester) async {
    tester.view.physicalSize = const Size(600, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    Finder inSheet(String text) =>
        find.descendant(of: find.byType(BottomSheet), matching: find.text(text));
    // A segment's block is the nearest Container around its label.
    double blockHeight(String text) => tester
        .getSize(find
            .ancestor(of: inSheet(text), matching: find.byType(Container))
            .first)
        .height;

    /// Opens [c]'s sheet, drags the pick-up handle up [dragPx], and returns the
    /// (appointment, travel gap) block heights — then closes the sheet again.
    Future<(double, double)> heights(
        Conflict c, double dragPx, String travelLabel) async {
      await tester.pumpWidget(appWith(c));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Review & resolve'));
      await tester.pumpAndSettle();

      final grip =
          tester.getTopLeft(find.text('Pick-up · 10:00')) + const Offset(2, 4);
      await tester.dragFrom(grip, Offset(0, -dragPx));
      await tester.pumpAndSettle();
      expect(find.text(travelLabel), findsOneWidget);

      final measured = (blockHeight('Doctor appointment'), blockHeight(travelLabel));
      await tester.tapAt(const Offset(8, 8)); // dismiss the sheet
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      return measured;
    }

    // 90px of drag is 30 minutes of travel against a one-hour appointment, so
    // the gap block comes out half the appointment's height.
    final (hourH, halfHourH) = await heights(conflict, 90, 'Travel time · 30 min');
    expect(halfHourH / hourH, closeTo(0.5, 0.05));
    // Drawn to scale, the appointment is no longer the halves' fixed height.
    expect(hourH, greaterThan(60));

    // The zoom follows the conflict: a three-hour appointment draws taller than
    // a one-hour one, with its own travel gap still in proportion.
    final (threeHourH, hourGapH) =
        await heights(withWinnerHours(3), 180, 'Travel time · 60 min');
    expect(threeHourH, greaterThan(hourH));
    expect(hourGapH / threeHourH, closeTo(1 / 3, 0.05));
  });

  testWidgets('each 5-minute snap ticks a selection haptic', (tester) async {
    tester.view.physicalSize = const Size(600, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final haptics = <String?>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'HapticFeedback.vibrate') {
          haptics.add(call.arguments as String?);
        }
        return null;
      },
    );
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));

    await tester.pumpWidget(appWith(conflict));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Review & resolve'));
    await tester.pumpAndSettle();

    // Pulling down at zero travel changes nothing, so it stays silent.
    final grip = tester.getTopLeft(find.text('Pick-up · 10:00')) + const Offset(2, 4);
    await tester.dragFrom(grip, const Offset(0, 60));
    await tester.pumpAndSettle();
    expect(haptics, isEmpty);

    // Crossing into the first 5-minute step ticks.
    await tester.dragFrom(grip, const Offset(0, -22));
    await tester.pumpAndSettle();
    expect(find.text('Travel time · 5 min'), findsOneWidget);
    expect(haptics, isNotEmpty);
    expect(haptics.every((a) => a == 'HapticFeedbackType.selectionClick'), isTrue);

    // Moving within the step (a minute's worth of drag, still rounding to 5)
    // doesn't tick again.
    final ticks = haptics.length;
    await tester.dragFrom(grip, const Offset(0, 3));
    await tester.pumpAndSettle();
    expect(find.text('Travel time · 5 min'), findsOneWidget);
    expect(haptics.length, ticks);
  });
}
