import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/plan_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/util/format.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records the event ids a rebuild was requested for, so a sheet action can be
/// asserted on without a real network call.
class _RecordingApiClient extends ApiClient {
  _RecordingApiClient() : super(baseUrl: 'http://test');

  final List<String> rebuiltEventIds = [];

  @override
  Future<void> rebuildEventTasks(String familyId, String eventId) async {
    rebuiltEventIds.add(eventId);
  }
}

Member _m(String id, String name,
        {bool caretaker = false, bool child = false, bool generatesTasks = true}) =>
    Member(
      id: id,
      relationName: name,
      isCaretaker: caretaker,
      requiresCaretaker: child,
      isAdmin: false,
      generatesFamilyTasks: generatesTasks,
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

  testWidgets(
      'the winner of a resolved conflict is tappable between the split halves',
      (tester) async {
    tester.view.physicalSize = const Size(800, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final me = _m('dad', 'Dad', caretaker: true);
    // What a resolved conflict leaves behind: the school day split into two
    // halves with the winning appointment flush between them. The halves'
    // pick-up (10:00) and drop-off (10:30) straddle exactly the appointment's
    // two edges — and used to swallow every tap meant for it.
    final events = [
      CalendarEventItem(id: 'seg0', familyMemberId: 'theo', provenance: 'synthesized', start: at(8, 30), end: at(10, 0), allDay: false, summary: 'School day'),
      CalendarEventItem(id: 'appt', familyMemberId: 'theo', provenance: 'human', start: at(10, 0), end: at(10, 30), allDay: false, summary: 'Orthodontist'),
      CalendarEventItem(id: 'seg1', familyMemberId: 'theo', provenance: 'synthesized', start: at(10, 30), end: at(15, 0), allDay: false, summary: 'School day'),
    ];
    final tasks = [
      TaskItem(id: 'd0', familyMemberId: 'theo', type: 'dropoff', start: at(8, 30), status: 'unowned', createdVia: 'generated', calendarEventId: 'seg0'),
      TaskItem(id: 'p0', familyMemberId: 'theo', type: 'pickup', start: at(10, 0), status: 'unowned', createdVia: 'generated', calendarEventId: 'seg0'),
      TaskItem(id: 'd1', familyMemberId: 'theo', type: 'dropoff', start: at(10, 30), status: 'unowned', createdVia: 'generated', calendarEventId: 'seg1'),
      TaskItem(id: 'p1', familyMemberId: 'theo', type: 'pickup', start: at(15, 0), status: 'unowned', createdVia: 'generated', calendarEventId: 'seg1'),
      TaskItem(id: 'att', familyMemberId: 'theo', type: 'attendance', start: at(10, 0), end: at(10, 30), status: 'unowned', createdVia: 'generated', calendarEventId: 'appt'),
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

    // The appointment is only half an hour, so its block shows the time alone —
    // its title only ever appears once a sheet opens for it.
    expect(find.textContaining('Orthodontist'), findsNothing);

    // Tap just inside the appointment's top edge, in the horizontal band the
    // half's pick-up tab occupies: the 10 AM gridline is that edge.
    final top = tester.getRect(find.text('10 AM')).top;
    final tabX = tester.getRect(find.text('Pick-up · 10:00')).center.dx;
    await tester.tapAt(Offset(tabX, top + 6));
    await tester.pumpAndSettle();

    // The appointment's own sheet opened — not the neighbouring half's pick-up —
    // and it's claimable.
    expect(find.textContaining('Orthodontist'), findsWidgets);
    expect(find.text('Claim for myself'), findsOneWidget);
    // The half's pick-up would have brought its own DURATION field along; the
    // appointment's attendance-only group has none.
    expect(find.text('DURATION'), findsNothing);
  });

  testWidgets('an event with no tasks still opens its details sheet',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final me = _m('mom', 'Mom', caretaker: true);
    // A caretaker's own calendar generates no family tasks by design, so its
    // events have nothing to claim — they must still answer a tap. The API
    // stamps that as the event's ineligibility reason.
    final dad = _m('dad', 'Dad', caretaker: true, generatesTasks: false);
    final events = [
      CalendarEventItem(
        id: 'dentist',
        familyMemberId: 'dad',
        provenance: 'human',
        start: at(9, 0),
        end: at(11, 0),
        allDay: false,
        summary: 'Dentist',
        location: 'Maple Dental',
        description: 'Bring the insurance card',
        taskIneligibleReason: 'paused',
      ),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [me, dad]),
        currentMemberProvider.overrideWith((ref) async => me),
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

    await tester.tap(find.textContaining('Dentist'));
    await tester.pumpAndSettle();

    // The details sheet carries the event as the calendar holds it, and says
    // why there's nothing to claim on it.
    expect(find.text('Maple Dental'), findsOneWidget);
    expect(find.text('Bring the insurance card'), findsOneWidget);
    expect(find.textContaining("don't generate family tasks"), findsOneWidget);
    // Nothing a rebuild could do here — the block is a member setting.
    expect(find.textContaining('Rebuild'), findsNothing);
  });

  testWidgets('a free/busy block says why it can never carry a task',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final me = _m('dad', 'Dad', caretaker: true);
    // An `fb:` block from a busy-mode feed: opaque availability, never typed.
    final events = [
      CalendarEventItem(id: 'busy', familyMemberId: 'theo', provenance: 'synthesized', start: at(13, 0), end: at(15, 0), allDay: false, summary: 'Busy', taskIneligibleReason: 'busy_calendar'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [me, _m('theo', 'Theo', child: true)]),
        currentMemberProvider.overrideWith((ref) async => me),
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

    await tester.tap(find.textContaining('Busy'));
    await tester.pumpAndSettle();

    expect(find.textContaining('linked as free/busy'), findsOneWidget);
    expect(find.textContaining('Rebuild'), findsNothing);
  });

  testWidgets('an eligible event with no tasks at all offers a rebuild',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final me = _m('dad', 'Dad', caretaker: true);
    // What the reporter hit: an event that should generate an attendance task,
    // sitting on the calendar with no task row of any status behind it.
    final events = [
      CalendarEventItem(id: 'ortho', familyMemberId: 'theo', provenance: 'human', start: at(10, 0), end: at(11, 30), allDay: false, summary: 'Orthodontist'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [me, _m('theo', 'Theo', child: true)]),
        currentMemberProvider.overrideWith((ref) async => me),
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

    await tester.tap(find.textContaining('Orthodontist'));
    await tester.pumpAndSettle();

    expect(find.textContaining('should generate them'), findsOneWidget);
    expect(find.text("Rebuild this event's tasks"), findsOneWidget);
  });

  testWidgets('an event whose tasks were all dismissed offers to restore them',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final me = _m('dad', 'Dad', caretaker: true);
    final events = [
      CalendarEventItem(id: 'practice', familyMemberId: 'theo', provenance: 'synthesized', start: at(16, 0), end: at(18, 0), allDay: false, summary: 'Fiddle practice'),
    ];
    // Both of the event's tasks were marked not needed, so the block has
    // nothing live to manage — the details sheet is the way back.
    final tasks = [
      TaskItem(id: 'd', familyMemberId: 'theo', type: 'dropoff', start: at(16, 0), status: 'dismissed', createdVia: 'generated', calendarEventId: 'practice'),
      TaskItem(id: 'p', familyMemberId: 'theo', type: 'pickup', start: at(18, 0), status: 'dismissed', createdVia: 'generated', calendarEventId: 'practice'),
    ];
    final api = _RecordingApiClient();
    await tester.pumpWidget(ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        familyProvider.overrideWith((ref) async => 'fam-1'),
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

    await tester.tap(find.textContaining('Fiddle practice'));
    await tester.pumpAndSettle();

    // The sheet names the sticky dismissal and offers the way back.
    expect(find.textContaining('marked not needed'), findsOneWidget);
    expect(find.text('Restore its 2 tasks'), findsOneWidget);

    await tester.tap(find.text('Restore its 2 tasks'));
    await tester.pumpAndSettle();

    // One rebuild call for the event — it restores the dismissed rows and
    // re-runs task-gen server-side, rather than the client un-dismissing each.
    expect(api.rebuiltEventIds, ['practice']);
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

  testWidgets(
      'excluding a caretaker in "Caretakers" hides events on their own calendar',
      (tester) async {
    // Tall enough that the filter sheet's chips/Apply are on-screen without
    // needing to scroll the sheet first.
    tester.view.physicalSize = const Size(800, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final me = _m('mom', 'Mom', caretaker: true);
    final dad = _m('dad', 'Dad', caretaker: true);
    // A caretaker can have their own unified calendar too — a plain human
    // event that isn't tied to any child or task at all.
    final events = [
      CalendarEventItem(id: 'dentist', familyMemberId: 'dad', provenance: 'human', start: at(9, 0), end: at(11, 0), allDay: false, summary: 'Dentist'),
      CalendarEventItem(id: 'school', familyMemberId: 'theo', provenance: 'synthesized', start: at(8, 30), end: at(15, 0), allDay: false, summary: 'School day'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              me,
              dad,
              _m('theo', 'Theo', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => me),
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

    // Both blocks show before filtering.
    expect(find.textContaining('Dentist'), findsOneWidget);
    expect(find.textContaining('School day'), findsOneWidget);

    await tester.tap(find.text('Filters'));
    await tester.pumpAndSettle();
    // Deselect Dad's chip under "Caretakers".
    await tester.tap(find.text('Dad'));
    await tester.pump();
    await tester.tap(find.text('Apply · 1 filter'));
    await tester.pumpAndSettle();

    // Dad's own calendar event is hidden; Theo's is untouched.
    expect(find.textContaining('Dentist'), findsNothing);
    expect(find.textContaining('School day'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a double-booking flags a Conflict chip that opens the sheet (8a)',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    // Theo's school day and a manually-added orthodontist visit overlap
    // 11:00–12:00 — a double-booking on one member's calendar.
    final events = [
      CalendarEventItem(id: 'school', familyMemberId: 'theo', provenance: 'synthesized', start: at(8, 30), end: at(15, 0), allDay: false, summary: 'School day'),
      CalendarEventItem(id: 'ortho', familyMemberId: 'theo', provenance: 'human', start: at(11, 0), end: at(12, 0), allDay: false, summary: 'Orthodontist'),
    ];
    final conflict = Conflict(
      id: 'c1',
      familyMemberId: 'theo',
      loser: ConflictEventRef(summary: 'School day', allDay: false, start: at(8, 30), end: at(15, 0)),
      winner: ConflictEventRef(summary: 'Orthodontist', allDay: false, start: at(11, 0), end: at(12, 0)),
    );
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
            ]),
        currentMemberProvider.overrideWith((ref) async => _m('dad', 'Dad', caretaker: true)),
        allTasksProvider.overrideWith((ref) async => const <TaskItem>[]),
        calendarEventsProvider.overrideWith((ref) async => events),
        conflictsProvider.overrideWith((ref) async => [conflict]),
        pendingDecisionsProvider.overrideWith((ref) async => const []),
        threadingThresholdProvider.overrideWith((ref) async => 30),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: SafeArea(child: PlanScreen())),
      ),
    ));
    // The chip pulses forever, so drive frames manually rather than settling.
    for (var i = 0; i < 6; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    // The pulsing double-booked chip is on the timeline.
    expect(find.text('Conflict'), findsOneWidget);

    // Tapping it opens the shared resolution sheet.
    await tester.tap(find.text('Conflict'));
    for (var i = 0; i < 8; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(find.text('Two events, one Theo'), findsOneWidget);
    expect(find.text('Confirm split'), findsOneWidget);

    // Unmount so the chip's ticker is disposed before the test ends.
    await tester.pumpWidget(const SizedBox());
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
