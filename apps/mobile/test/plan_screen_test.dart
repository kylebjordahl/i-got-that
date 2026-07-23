import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/plan_screen.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/util/format.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Member _m(String id, String name, {bool caretaker = false, bool child = false}) => Member(
      id: id,
      relationName: name,
      isCaretaker: caretaker,
      requiresCaretaker: child,
      isAdmin: false,
    );

void main() {
  testWidgets('Plan renders the day scroller + grid without overflow', (tester) async {
    final now = DateTime.now();
    final tasks = [
      TaskItem(
        id: 't1',
        familyMemberId: 'theo',
        type: 'dropoff',
        start: DateTime(now.year, now.month, now.day, 8),
        status: 'unowned',
        createdVia: 'generated',
        calendarEventId: 'e1',
      ),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => const []),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // Header + controls render (and no RenderFlex overflow was thrown above).
    expect(find.text('Plan'), findsOneWidget);
    expect(find.text('Today'), findsOneWidget);
    expect(find.text('Filters'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('attendance blocks (owned + unowned) render without overflow',
      (tester) async {
    final now = DateTime.now();
    final tasks = [
      TaskItem(id: 'a', familyMemberId: 'mia', type: 'attendance', start: DateTime(now.year, now.month, now.day, 10), status: 'unowned', createdVia: 'generated', calendarEventId: 'e1'),
      TaskItem(id: 'b', familyMemberId: 'theo', type: 'attendance', start: DateTime(now.year, now.month, now.day, 14), status: 'owned', ownerMemberId: 'dad', createdVia: 'generated', calendarEventId: 'e2'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
              _m('mia', 'Mia', child: true),
            ]),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => const []),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('grid expands past the default window to fit an evening event',
      (tester) async {
    final now = DateTime.now();
    // A 9 PM event is well past the 7 PM default end — the grid must grow to show
    // it (rather than clipping it at the bottom of a fixed window).
    final tasks = [
      TaskItem(
        id: 't1',
        familyMemberId: 'theo',
        type: 'dropoff',
        start: DateTime(now.year, now.month, now.day, 21, 0),
        status: 'unowned',
        createdVia: 'generated',
        calendarEventId: 'e1',
      ),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => const []),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // Hour labels now extend to the evening (default window stopped at 7 PM).
    expect(find.text('9 PM'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('grid defaults its scroll to 7 AM when an early event expands the window',
      (tester) async {
    // Wide (so the header's test-font pills fit) but short, so the grid content
    // is taller than its viewport and actually scrolls.
    tester.view.physicalSize = const Size(800, 480);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final now = DateTime.now();
    final tasks = [
      // A midnight event pins the window's start to hour 0 deterministically —
      // regardless of the current time (the now-line can only pull the start
      // *earlier* than an event, and nothing is earlier than 0).
      TaskItem(id: 'a', familyMemberId: 'theo', type: 'dropoff', start: DateTime(now.year, now.month, now.day), status: 'unowned', createdVia: 'generated', calendarEventId: 'e1'),
      // ...and a late event makes the grid taller than the viewport so it scrolls.
      TaskItem(id: 'b', familyMemberId: 'theo', type: 'pickup', start: DateTime(now.year, now.month, now.day, 20), status: 'unowned', createdVia: 'generated', calendarEventId: 'e2'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => const []),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // The grid opens scrolled so 7 AM (seven hours = 7 * 42 = 294px past the
    // midnight start) is at the top, rather than showing the expanded early hours.
    final position = Scrollable.of(tester.element(find.text('9 AM'))).position;
    expect(position.pixels, closeTo(294.0, 2.0));
  });

  testWidgets('many overlapping calendars pack into narrow columns without overflow',
      (tester) async {
    // "Everyone" shows the same activity from several calendars at once (a
    // synthesized copy, a manual copy, and a claimed copy) plus a pickup — four
    // items overlapping at 3:15 pack into narrow columns. Their contents must
    // clip / adapt, not overflow into the neighbouring column.
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final events = [
      CalendarEventItem(id: 'mch', familyMemberId: 'delbert', provenance: 'synthesized', start: at(8, 31), end: at(14, 47), allDay: false, summary: 'MCH'),
      CalendarEventItem(id: 'fs', familyMemberId: 'delbert', provenance: 'synthesized', start: at(15, 15), end: at(16, 15), allDay: false, summary: 'fiddle practice'),
      CalendarEventItem(id: 'fm', familyMemberId: 'delbert', provenance: 'human', start: at(15, 15), end: at(16, 15), allDay: false, summary: 'fiddle practice'),
      CalendarEventItem(id: 'fc', familyMemberId: 'kyle', provenance: 'claimed_task', start: at(15, 15), end: at(16, 15), allDay: false, summary: 'fiddle practice', taskId: 'tf'),
    ];
    final tasks = [
      TaskItem(id: 'd', familyMemberId: 'delbert', type: 'dropoff', start: at(9, 0), status: 'unowned', createdVia: 'generated'),
      TaskItem(id: 'p', familyMemberId: 'delbert', type: 'pickup', start: at(15, 15), status: 'unowned', createdVia: 'generated'),
      TaskItem(id: 'tf', familyMemberId: 'delbert', type: 'attendance', start: at(15, 15), end: at(16, 15), status: 'owned', ownerMemberId: 'kyle', createdVia: 'generated', calendarEventId: 'fc'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('kyle', 'Kyle', caretaker: true),
              _m('delbert', 'delbert', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => _m('kyle', 'Kyle', caretaker: true)),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();
    // No RenderFlex overflow was thrown while laying out the crowded 3:15 column.
    expect(tester.takeException(), isNull);
  });

  testWidgets('drop-off / pick-up render as edge tabs on their event (6c)',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final events = [
      CalendarEventItem(id: 'school', familyMemberId: 'theo', provenance: 'synthesized', start: at(8, 30), end: at(15, 0), allDay: false, summary: 'School day'),
    ];
    final tasks = [
      // A claimed drop-off (top tab, owner avatar) and an unowned pick-up
      // (bottom tab, no button) — both attached to the school event, not blocks.
      TaskItem(id: 'drop', familyMemberId: 'theo', type: 'dropoff', start: at(8, 0), status: 'owned', ownerMemberId: 'dad', createdVia: 'generated', calendarEventId: 'school'),
      TaskItem(id: 'pick', familyMemberId: 'theo', type: 'pickup', start: at(15, 0), status: 'unowned', createdVia: 'generated', calendarEventId: 'school'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => _m('dad', 'Dad', caretaker: true)),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // Both transitions render as edge tabs; neither carries a Claim button.
    expect(find.text('Drop-off · 8:00'), findsOneWidget);
    expect(find.text('Pick-up · 3:00'), findsOneWidget);
    expect(find.text('Claim'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'a claimed drop-off does not add the claimant as an attendee avatar on the block',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final events = [
      CalendarEventItem(id: 'school', familyMemberId: 'theo', provenance: 'synthesized', start: at(8, 30), end: at(15, 0), allDay: false, summary: 'School day'),
    ];
    // The drop-off is claimed by Dad, but the only real attendee of the
    // school event is Theo — Dad's avatar should show up on the edge tab
    // only, not as a second attendee badge on the event block itself.
    final tasks = [
      TaskItem(id: 'drop', familyMemberId: 'theo', type: 'dropoff', start: at(8, 0), status: 'owned', ownerMemberId: 'dad', createdVia: 'generated', calendarEventId: 'school'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => _m('dad', 'Dad', caretaker: true)),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // Dad's "D" avatar renders exactly once — on the claimed edge tab — not a
    // second time as an attendee badge on the block.
    expect(find.text('D'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a claimed attendance dedupes to one block carrying both attendees',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    // The child's synthesized practice and the mirrored copy on the caretaker's
    // calendar after they claim it — the same practice, twice on the grid before
    // the dedup.
    final events = [
      CalendarEventItem(id: 'fs', familyMemberId: 'delbert', provenance: 'synthesized', start: at(15, 15), end: at(16, 15), allDay: false, summary: 'Fiddle practice'),
      CalendarEventItem(id: 'fc', familyMemberId: 'kyle', provenance: 'claimed_task', start: at(15, 15), end: at(16, 15), allDay: false, summary: 'Fiddle practice', taskId: 'tf'),
    ];
    final tasks = [
      TaskItem(id: 'tf', familyMemberId: 'delbert', type: 'attendance', start: at(15, 15), end: at(16, 15), status: 'owned', ownerMemberId: 'kyle', createdVia: 'generated', calendarEventId: 'fs'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('kyle', 'Kyle', caretaker: true),
              _m('delbert', 'delbert', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => _m('kyle', 'Kyle', caretaker: true)),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // Only the source-event block survives (its subtitle appears once, not
    // twice), and it carries the claimer as a second attendee avatar.
    expect(find.text('3:15 – 4:15 PM'), findsOneWidget);
    expect(find.text('K'), findsOneWidget); // the claimer's attendee avatar
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'an unclaimed attendance task dedupes to one block titled with the source event',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    // The child's synthesized practice, still unclaimed — before the dedup fix
    // this rendered twice: the real event block, plus a second, generic
    // "Attendance" block for the still-unowned task pointing at the same event.
    // Give it a couple of hours so the block is tall enough to show its title
    // (a compact block would collapse to just its time).
    final events = [
      CalendarEventItem(id: 'fs', familyMemberId: 'delbert', provenance: 'synthesized', start: at(14, 0), end: at(16, 15), allDay: false, summary: 'Fiddle practice'),
    ];
    final tasks = [
      TaskItem(id: 'tf', familyMemberId: 'delbert', type: 'attendance', start: at(14, 0), end: at(16, 15), status: 'unowned', createdVia: 'generated', calendarEventId: 'fs'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('kyle', 'Kyle', caretaker: true),
              _m('delbert', 'delbert', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => _m('kyle', 'Kyle', caretaker: true)),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // One block, titled with the real event summary (never the generic
    // "Attendance" fallback), with no inline Claim button.
    expect(find.textContaining('Fiddle practice'), findsOneWidget);
    expect(find.text('Attendance'), findsNothing);
    expect(find.text('Claim'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('tapping an event block manages its whole task group', (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final me = _m('dad', 'Dad', caretaker: true);
    final events = [
      CalendarEventItem(id: 'school', familyMemberId: 'theo', provenance: 'synthesized', start: at(8, 30), end: at(15, 0), allDay: false, summary: 'School day'),
    ];
    // The block's event generates an (unowned) drop-off and pick-up.
    final tasks = [
      TaskItem(id: 'drop', familyMemberId: 'theo', type: 'dropoff', start: at(8, 0), status: 'unowned', createdVia: 'generated', calendarEventId: 'school'),
      TaskItem(id: 'pick', familyMemberId: 'theo', type: 'pickup', start: at(15, 0), status: 'unowned', createdVia: 'generated', calendarEventId: 'school'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [me, _m('theo', 'Theo', child: true)]),
        currentMemberProvider.overrideWith((ref) async => me),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // Tap the block body (its subtitle, clear of the edge tabs) — previously a
    // plain event block had no task and tapping did nothing.
    await tester.tap(find.text('8:30 AM – 3:00 PM'));
    await tester.pumpAndSettle();

    // The management sheet opens: change the event's type, and claim both the
    // drop-off and pick-up at once.
    expect(find.text('CHANGE TYPE'), findsOneWidget);
    expect(find.text('Claim for myself'), findsOneWidget);
    expect(find.text('Mark as not needed'), findsOneWidget);
  });

  testWidgets('tapping an event block shows the event\'s own details', (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final me = _m('dad', 'Dad', caretaker: true);
    final events = [
      CalendarEventItem(
        id: 'school',
        familyMemberId: 'theo',
        provenance: 'synthesized',
        start: at(8, 30),
        end: at(15, 0),
        allDay: false,
        summary: 'School day',
        description: 'Bring the permission slip',
        location: 'Lincoln Elementary',
      ),
    ];
    final tasks = [
      TaskItem(id: 'att', familyMemberId: 'theo', type: 'attendance', start: at(8, 30), end: at(15, 0), status: 'unowned', createdVia: 'generated', calendarEventId: 'school'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [me, _m('theo', 'Theo', child: true)]),
        currentMemberProvider.overrideWith((ref) async => me),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.textContaining('School day'));
    await tester.pumpAndSettle();

    // The sheet's header carries the event's real title, and a details block
    // surfaces its location and description alongside the full time range.
    expect(find.textContaining('School day'), findsWidgets);
    expect(find.text('Lincoln Elementary'), findsOneWidget);
    expect(find.text('Bring the permission slip'), findsOneWidget);
    expect(find.textContaining('8:30 AM – 3:00 PM'), findsWidgets);
  });

  testWidgets('a wide manual block keeps the "· manual" tag beside its time',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final events = [
      CalendarEventItem(id: 'appt', familyMemberId: 'theo', provenance: 'human', start: at(15, 15), end: at(16, 15), allDay: false, summary: 'Dentist'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => _m('dad', 'Dad', caretaker: true)),
        allTasksProvider.overrideWith((ref) async => const <TaskItem>[]),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // A full-width block has room for the whole subtitle: time + the tag.
    expect(find.text('3:15 – 4:15 PM · manual'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a compact block drops the tag but never truncates the time',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    // Four manual events overlapping at 3:15 pack into columns too narrow to fit
    // "· manual" beside the time — the tag is dropped, and each block still
    // shows the whole start–end range rather than an ellipsised "3:15 – 4:1…".
    final events = [
      for (var i = 0; i < 4; i++)
        CalendarEventItem(id: 'e$i', familyMemberId: 'theo', provenance: 'human', start: at(15, 15), end: at(16, 15), allDay: false, summary: 'Overlap $i'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => _m('dad', 'Dad', caretaker: true)),
        allTasksProvider.overrideWith((ref) async => const <TaskItem>[]),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // The exact time renders once per block, tag-free; the tagged variant is gone.
    expect(find.text('3:15 – 4:15 PM'), findsNWidgets(4));
    expect(find.textContaining('manual'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a short event collapses to just its time, without overflow',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    // A 20-minute segment (once inflated to a fixed 76px, now its true height)
    // is too short for the title line — it shows the start–end time alone.
    final events = [
      CalendarEventItem(id: 'q', familyMemberId: 'theo', provenance: 'synthesized', start: at(9, 0), end: at(9, 20), allDay: false, summary: 'Quick errand'),
    ];
    final tasks = [
      TaskItem(id: 'att', familyMemberId: 'theo', type: 'attendance', start: at(9, 0), end: at(9, 20), status: 'unowned', createdVia: 'generated', calendarEventId: 'q'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => _m('dad', 'Dad', caretaker: true)),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // The time shows; the summary is dropped for the compact block.
    expect(find.text('9:00 – 9:20 AM'), findsOneWidget);
    expect(find.textContaining('Quick errand'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('"Only my kids" hides a plain calendar event for a child I don\'t cover',
      (tester) async {
    // Tall enough that the filter sheet's "Only my kids" switch and Apply
    // button are on-screen without needing to scroll the sheet first.
    tester.view.physicalSize = const Size(800, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final me = _m('dad', 'Dad', caretaker: true);
    // Two plain (non-task) calendar-event blocks: one for a kid Dad covers
    // (owns a task for), one for a kid he doesn't.
    final events = [
      CalendarEventItem(id: 'school', familyMemberId: 'theo', provenance: 'synthesized', start: at(8, 30), end: at(15, 0), allDay: false, summary: 'School day'),
      CalendarEventItem(id: 'practice', familyMemberId: 'mia', provenance: 'synthesized', start: at(16, 0), end: at(18, 0), allDay: false, summary: 'Practice'),
    ];
    // Dad owns a task for Mia only, so she's the only kid he "covers".
    final tasks = [
      TaskItem(id: 'mia-att', familyMemberId: 'mia', type: 'attendance', start: at(16, 0), end: at(18, 0), status: 'owned', ownerMemberId: 'dad', createdVia: 'generated', calendarEventId: 'practice'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              me,
              _m('theo', 'Theo', child: true),
              _m('mia', 'Mia', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => me),
        allTasksProvider.overrideWith((ref) async => tasks),
        calendarEventsProvider.overrideWith((ref) async => events),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();

    // Both blocks show before filtering.
    expect(find.textContaining('School day'), findsOneWidget);
    expect(find.textContaining('Practice'), findsOneWidget);

    await tester.tap(find.text('Filters'));
    await tester.pumpAndSettle();
    // Two SwitchRows in the sheet: "Show completed" then "Only my kids".
    await tester.tap(find.byType(Switch).at(1));
    await tester.pump();
    await tester.tap(find.text('Apply · 1 filter'));
    await tester.pumpAndSettle();

    // Theo's event (a kid Dad doesn't cover) is hidden; Mia's remains.
    expect(find.textContaining('School day'), findsNothing);
    expect(find.textContaining('Practice'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('swiping the grid left/right steps the selected day', (tester) async {
    final today = DateTime.now();
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        allTasksProvider.overrideWith((ref) async => const []),
        calendarEventsProvider.overrideWith((ref) async => const []),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text(longDateComma(today)), findsOneWidget);

    // A leftward fling over the time grid steps to tomorrow.
    await tester.fling(find.text('7 AM'), const Offset(-400, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.text(longDateComma(today.add(const Duration(days: 1)))), findsOneWidget);

    // A rightward fling steps back — past today to yesterday.
    await tester.fling(find.text('7 AM'), const Offset(400, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.text(longDateComma(today)), findsOneWidget);

    await tester.fling(find.text('7 AM'), const Offset(400, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.text(longDateComma(today.subtract(const Duration(days: 1)))), findsOneWidget);

    // The grid's own vertical scroll still works — a swipe doesn't swallow it.
    expect(tester.takeException(), isNull);
  });
}
