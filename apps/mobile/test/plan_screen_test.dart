import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/plan_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/util/format.dart';
import 'package:caretaker_app/widgets/app_bottom_nav.dart' show kBottomNavClearance;
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

  testWidgets('an all-day event rides the pinned row, not a block down the grid',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    final today = DateTime(now.year, now.month, now.day);
    // An all-day event spans midnight to midnight, so as a block it stretched
    // the grid over the whole 24 hours and squeezed the real appointment into
    // the lane beside it.
    final events = [
      CalendarEventItem(id: 'leave', familyMemberId: 'theo', provenance: 'synthesized', start: today, end: today.add(const Duration(days: 1)), allDay: true, summary: 'Initial parental leave'),
      CalendarEventItem(id: 'dentist', familyMemberId: 'theo', provenance: 'human', start: at(10, 0), end: at(11, 0), allDay: false, summary: 'Dentist'),
    ];
    // ...and its own drop-off still belongs on the grid, at the time it happens.
    final tasks = [
      TaskItem(id: 'd', familyMemberId: 'theo', type: 'dropoff', start: at(8, 0), status: 'unowned', createdVia: 'generated', calendarEventId: 'leave'),
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

    // It's in the pinned row above the grid, not a block down it — the pill is
    // the only copy of it anywhere on the page.
    expect(find.text('all-day'), findsOneWidget);
    final pill = tester.getRect(find.textContaining('Initial parental leave'));
    final firstHour = tester.getRect(find.text('7 AM'));
    expect(pill.bottom, lessThanOrEqualTo(firstHour.top));
    expect(find.textContaining('Initial parental leave'), findsOneWidget);
    // The timed event keeps the whole lane to itself.
    expect(find.textContaining('Dentist'), findsOneWidget);
    // And the all-day event's transition still lands on the grid at 8:00.
    final tag = tester.getRect(find.text('Drop-off · 8:00'));
    expect(tag.top, greaterThan(firstHour.top));
    expect(tester.takeException(), isNull);
  });

  testWidgets('a multi-day all-day event shows on every day it covers',
      (tester) async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    // Started yesterday, runs through tomorrow: today is in the middle of it,
    // so it belongs on today's row even though it doesn't start today.
    final events = [
      CalendarEventItem(id: 'trip', familyMemberId: 'theo', provenance: 'synthesized', start: today.subtract(const Duration(days: 1)), end: today.add(const Duration(days: 2)), allDay: true, summary: 'Grandma visit'),
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
    expect(find.textContaining('Grandma visit'), findsOneWidget);

    // Swipe to tomorrow — the last day it covers — and it's still there.
    await tester.fling(find.text('7 AM'), const Offset(-400, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.textContaining('Grandma visit'), findsOneWidget);

    // One more day and it's over, so the row goes away entirely.
    await tester.fling(find.text('7 AM'), const Offset(-400, 0), 1000);
    await tester.pumpAndSettle();
    expect(find.textContaining('Grandma visit'), findsNothing);
    expect(find.text('all-day'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('tapping an all-day pill opens what tapping its block would',
      (tester) async {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final events = [
      CalendarEventItem(id: 'holiday', familyMemberId: 'theo', provenance: 'synthesized', start: today, end: today.add(const Duration(days: 1)), allDay: true, summary: 'MCH closed', location: 'Home', description: 'US holiday'),
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

    await tester.tap(find.textContaining('MCH closed'));
    await tester.pumpAndSettle();

    // The event's own details sheet, reading "All day" rather than a time.
    expect(find.text('Home'), findsOneWidget);
    expect(find.text('US holiday'), findsOneWidget);
    expect(find.text('All day'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a contained appointment cascades over its host, tags and all',
      (tester) async {
    tester.view.physicalSize = const Size(800, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    // The shape the day view used to make a mess of: a midday appointment
    // wholly inside the school day. Splitting the lane in half squeezed a
    // 6-hour block into a sliver over an appointment that only needed an hour;
    // now the appointment cascades on top of it, iOS-Calendar style.
    final events = [
      CalendarEventItem(id: 'school', familyMemberId: 'theo', provenance: 'synthesized', start: at(8, 30), end: at(15, 0), allDay: false, summary: 'School day'),
      CalendarEventItem(id: 'ortho', familyMemberId: 'theo', provenance: 'human', start: at(10, 0), end: at(11, 0), allDay: false, summary: 'Orthodontist'),
    ];
    final tasks = [
      TaskItem(id: 'sd', familyMemberId: 'theo', type: 'dropoff', start: at(8, 30), status: 'unowned', createdVia: 'generated', calendarEventId: 'school'),
      TaskItem(id: 'sp', familyMemberId: 'theo', type: 'pickup', start: at(15, 0), status: 'unowned', createdVia: 'generated', calendarEventId: 'school'),
      TaskItem(id: 'od', familyMemberId: 'theo', type: 'dropoff', start: at(10, 0), status: 'unowned', createdVia: 'generated', calendarEventId: 'ortho'),
      TaskItem(id: 'op', familyMemberId: 'theo', type: 'pickup', start: at(11, 0), status: 'unowned', createdVia: 'generated', calendarEventId: 'ortho'),
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

    final school = tester.getRect(find.textContaining('School day'));
    final ortho = tester.getRect(find.textContaining('Orthodontist'));
    // The appointment is inset from the school day's left edge and ends flush
    // with it — on top of it, not beside it (side by side, it would start past
    // the school day's right edge instead).
    expect(ortho.left, greaterThan(school.left));
    expect(ortho.right, closeTo(school.right, 1));
    // ...and the host keeps its own label strip clear above the cascade.
    expect(school.bottom, lessThanOrEqualTo(ortho.top));

    // Most important of all: every transition tag survives the cascade — both
    // the host's and the appointment's.
    expect(find.text('Drop-off · 8:30'), findsOneWidget);
    expect(find.text('Pick-up · 3:00'), findsOneWidget);
    expect(find.text('Drop-off · 10:00'), findsOneWidget);
    expect(find.text('Pick-up · 11:00'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a block widens over the columns nothing collides with it in',
      (tester) async {
    tester.view.physicalSize = const Size(800, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    // Three columns' worth of morning, but only for its first 45 minutes:
    // 'Playdate' starts once the 9 o'clock pair is over, so it takes their two
    // columns back instead of sitting in a third of a lane it has to itself.
    final events = [
      CalendarEventItem(id: 'swim', familyMemberId: 'theo', provenance: 'synthesized', start: at(9, 0), end: at(9, 45), allDay: false, summary: 'Swim'),
      CalendarEventItem(id: 'camp', familyMemberId: 'mia', provenance: 'synthesized', start: at(9, 0), end: at(9, 45), allDay: false, summary: 'Camp'),
      CalendarEventItem(id: 'recital', familyMemberId: 'theo', provenance: 'synthesized', start: at(9, 15), end: at(11, 0), allDay: false, summary: 'Recital'),
      CalendarEventItem(id: 'play', familyMemberId: 'mia', provenance: 'synthesized', start: at(10, 0), end: at(11, 30), allDay: false, summary: 'Playdate'),
    ];
    await tester.pumpWidget(ProviderScope(
      overrides: [
        membersProvider.overrideWith((ref) async => [
              _m('dad', 'Dad', caretaker: true),
              _m('theo', 'Theo', child: true),
              _m('mia', 'Mia', child: true),
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

    final swim = tester.getRect(find.textContaining('Swim'));
    final play = tester.getRect(find.textContaining('Playdate'));
    final recital = tester.getRect(find.textContaining('Recital'));
    // Playdate spreads over the two columns the 9 o'clock pair vacated...
    expect(play.left, closeTo(swim.left, 1));
    expect(play.width, greaterThan(swim.width * 1.5));
    // ...but stops at the recital, which is still going.
    expect(play.right, lessThan(recital.left));
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

    // The appointment is only half an hour: too short for its time, but its
    // description is the one line a block never gives up.
    expect(find.textContaining('Orthodontist'), findsOneWidget);
    expect(find.text('10:00 – 10:30 AM'), findsNothing);

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

  testWidgets('a short event keeps its description and drops its time',
      (tester) async {
    final now = DateTime.now();
    DateTime at(int h, int m) => DateTime(now.year, now.month, now.day, h, m);
    // A 20-minute segment (once inflated to a fixed 76px, now its true height)
    // only has room for one line — and that line is always the description.
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

    // The description shows; the time is what a compact block drops.
    expect(find.textContaining('Quick errand'), findsOneWidget);
    expect(find.text('9:00 – 9:20 AM'), findsNothing);
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

  group('pinch to zoom the time axis', () {
    /// A day with a 1-hour appointment plus something just after midnight and
    /// something late at night, so the grid runs the whole 24 hours: tall
    /// enough to pinch on, and longer than any viewport so it really scrolls.
    Future<void> pumpDay(WidgetTester tester,
        {Size size = const Size(800, 1400),
        List<CalendarEventItem> extra = const []}) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final now = DateTime.now();
      final events = [
        CalendarEventItem(id: 'e', familyMemberId: 'theo', provenance: 'human', start: DateTime(now.year, now.month, now.day, 9), end: DateTime(now.year, now.month, now.day, 10), allDay: false, summary: 'Dentist'),
        CalendarEventItem(id: 'late', familyMemberId: 'theo', provenance: 'human', start: DateTime(now.year, now.month, now.day, 22), end: DateTime(now.year, now.month, now.day, 23), allDay: false, summary: 'Late thing'),
        CalendarEventItem(id: 'early', familyMemberId: 'theo', provenance: 'human', start: DateTime(now.year, now.month, now.day, 0, 30), end: DateTime(now.year, now.month, now.day, 1), allDay: false, summary: 'Early thing'),
        ...extra,
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
    }

    /// The rule drawn beside an hour's label — the gridline itself.
    Finder ruleFor(Finder label) => find.descendant(
          of: find.ancestor(of: label, matching: find.byType(Row)).first,
          matching: find.byType(Container),
        );

    /// The rendered height of one hour: the gap between two hour gridlines.
    double hourHeight(WidgetTester tester) =>
        tester.getRect(find.text('10 AM')).top -
        tester.getRect(find.text('8 AM')).top;

    /// Pinch vertically on the grid, taking the two fingers from [from] apart
    /// to [to] apart around the same centre. Centred on the grid's own viewport
    /// so both fingers land inside it however far apart they start.
    Future<void> pinch(WidgetTester tester, double from, double to) async {
      final centre = tester.getRect(find.byType(SingleChildScrollView)).center;
      final a = await tester.startGesture(centre.translate(0, -from / 2));
      final b = await tester.startGesture(centre.translate(0, from / 2));
      // In steps, so the recognizer sees a gesture rather than a teleport.
      for (var i = 0; i < 5; i++) {
        final step = (to - from) / 10;
        await a.moveBy(Offset(0, -step));
        await b.moveBy(Offset(0, step));
        await tester.pump();
      }
      await a.up();
      await b.up();
      await tester.pumpAndSettle();
    }

    testWidgets('spreading two fingers stretches the hours apart',
        (tester) async {
      await pumpDay(tester);
      final before = hourHeight(tester);
      final block = tester.getRect(find.textContaining('Dentist'));

      await pinch(tester, 100, 200);

      // Two hours of grid take twice the room they did...
      expect(hourHeight(tester), closeTo(before * 2, 2));
      // ...the appointment's block stretched with them (it starts at 9 and ends
      // at 10, so it spans exactly that gap)...
      expect(tester.getRect(find.textContaining('Dentist')).left,
          closeTo(block.left, 1));
      // ...and it still says what it is and when.
      expect(find.textContaining('9:00 – 10:00 AM'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('pinching in compresses the day and thins the hour labels',
        (tester) async {
      // Short enough that the whole day doesn't already fit — there is room to
      // compress before the zoom hits its floor.
      await pumpDay(tester, size: const Size(800, 700));
      final before = hourHeight(tester);

      await pinch(tester, 300, 100);

      // Clamped at the minimum zoom rather than collapsing to nothing.
      final after = hourHeight(tester);
      expect(after, lessThan(before));
      expect(after, greaterThan(0));
      // Too tight for a label on every line, so the odd hours go quiet — the
      // gridlines all stay, which is what the 10 AM/8 AM measurement rides on.
      expect(find.text('9 AM'), findsNothing);
      expect(find.text('8 AM'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('pinching all the way out shows one whole day, midnight to '
        'midnight, with the grid still filling the screen', (tester) async {
      await pumpDay(tester, size: const Size(800, 700));

      await pinch(tester, 300, 100);
      // ...and again, to prove it's already at the floor.
      final atFloor = hourHeight(tester);
      await pinch(tester, 300, 100);
      expect(hourHeight(tester), closeTo(atFloor, 0.01));

      // Both midnights are drawn — the day's opening one at the top of the
      // grid, its closing one a safe margin above where the nav pill floats.
      expect(find.text('12 AM'), findsNWidgets(2));
      final grid = tester.getRect(find.byType(SingleChildScrollView));
      final opening = tester.getRect(find.text('12 AM').first);
      final closing = tester.getRect(find.text('12 AM').at(1));
      expect(opening.top, closeTo(grid.top, 8));
      expect(grid.bottom - closing.top, closeTo(kBottomNavClearance + 12, 8));
      // The whole day is on screen at once: 24 hours between the two.
      expect(closing.top - opening.top, closeTo(atFloor / 2 * 24, 1));

      // And the grid is the full height of its viewport — zooming out can't
      // lift its bottom edge off the screen, so there is nothing left to
      // scroll and the hours past midnight fill the space behind the nav.
      final position = Scrollable.of(tester.element(find.text('8 AM'))).position;
      expect(position.maxScrollExtent, closeTo(0, 1));
      // ...ruled like any other hour (2 AM shows twice: today's and the one
      // past the closing midnight, down in the space behind the nav).
      expect(find.text('2 AM'), findsNWidgets(2));
      expect(tester.takeException(), isNull);
    });

    testWidgets('both midnight lines are ruled heavier than the hours between',
        (tester) async {
      await pumpDay(tester, size: const Size(800, 700));
      // All the way out, so the day's opening *and* closing midnight are both
      // on the grid at once — both get the accent.
      await pinch(tester, 300, 100);
      expect(find.text('12 AM'), findsNWidgets(2));

      final ordinary = tester.widget<Container>(ruleFor(find.text('8 AM')));
      for (final midnight in [find.text('12 AM').first, find.text('12 AM').at(1)]) {
        final rule = tester.widget<Container>(ruleFor(midnight));
        expect(tester.getSize(ruleFor(midnight)).height,
            greaterThan(tester.getSize(ruleFor(find.text('8 AM'))).height));
        // ...and in a brighter ink than an ordinary hour, so it reads as a
        // boundary and not just a thicker hairline.
        expect(rule.color, isNot(ordinary.color));
        expect(rule.color!.a, greaterThan(ordinary.color!.a));
        // The label is accented to match.
        expect(tester.widget<Text>(midnight).style!.color,
            isNot(tester.widget<Text>(find.text('8 AM')).style!.color));
      }
      expect(tester.takeException(), isNull);
    });

    testWidgets('changing day keeps the zoom and the timeline where they were',
        (tester) async {
      await pumpDay(tester, size: const Size(800, 700));
      await pinch(tester, 100, 160); // zoom in a little
      final hour = hourHeight(tester);

      final position = Scrollable.of(tester.element(find.text('8 AM'))).position;
      position.jumpTo(position.maxScrollExtent / 2);
      await tester.pumpAndSettle();
      final offset = position.pixels;
      expect(offset, greaterThan(0));

      // A swipe to tomorrow changes the day and nothing else: the hours keep
      // the height you pinched them to, at the time you had scrolled to.
      await tester.fling(find.byType(SingleChildScrollView), const Offset(-400, 0), 1000);
      await tester.pumpAndSettle();
      expect(hourHeight(tester), closeTo(hour, 0.01));
      expect(
          Scrollable.of(tester.element(find.text('8 AM'))).position.pixels,
          closeTo(offset, 1));
      expect(tester.takeException(), isNull);
    });

    testWidgets('an event running past midnight is drawn past the closing one',
        (tester) async {
      final now = DateTime.now();
      final today = DateTime(now.year, now.month, now.day);
      await pumpDay(tester,
          size: const Size(800, 900),
          extra: [
            CalendarEventItem(
                id: 'shift',
                familyMemberId: 'theo',
                provenance: 'human',
                start: today.add(const Duration(hours: 23)),
                end: today.add(const Duration(hours: 26)), // 2 AM tomorrow
                allDay: false,
                summary: 'Night shift'),
          ]);

      final position = Scrollable.of(tester.element(find.text('8 AM'))).position;
      position.jumpTo(position.maxScrollExtent);
      await tester.pumpAndSettle();

      // The grid grew a tail past the closing midnight to hold it, and the
      // block runs its full three hours into it rather than being cut off at
      // the nav (which floats over the grid, it doesn't end it).
      final hour = hourHeight(tester) / 2;
      final closing = tester.getRect(find.text('12 AM').at(1));
      final block = tester.getRect(find
          .ancestor(
              of: find.textContaining('Night shift'),
              matching: find.byType(GestureDetector))
          .first);
      expect(block.top, closeTo(closing.top - hour, 2));
      expect(block.bottom, closeTo(closing.top + 2 * hour, 2));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a one-finger drag still scrolls the grid, not zooms it',
        (tester) async {
      // A short viewport, so the day is longer than the grid can show and there
      // is something to scroll in the first place.
      await pumpDay(tester, size: const Size(800, 700));
      final hour = hourHeight(tester);
      final before = tester.getRect(find.text('9 AM')).top;

      // (The scrollable eats the touch slop, so the grid moves a little less
      // far than the finger does.)
      await tester.drag(find.text('9 AM'), const Offset(0, -120));
      await tester.pumpAndSettle();

      // The grid scrolled under the finger, and the zoom is untouched — the
      // pinch recognizer must never claim a single-pointer gesture.
      expect(tester.getRect(find.text('9 AM')).top, lessThan(before - 80));
      expect(hourHeight(tester), closeTo(hour, 0.01));
      expect(tester.takeException(), isNull);
    });
  });
}
