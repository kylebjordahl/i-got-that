import 'dart:io';
import 'dart:ui' as ui;

import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/assignment_rule_matches_screen.dart';
import 'package:caretaker_app/screens/assignment_rules_screen.dart';
import 'package:caretaker_app/screens/email_outputs_section.dart';
import 'package:caretaker_app/screens/member_detail_screen.dart';
import 'package:caretaker_app/screens/me_screen.dart';
import 'package:caretaker_app/screens/notification_schedule_screen.dart';
import 'package:caretaker_app/screens/task_rule_matches_screen.dart';
import 'package:caretaker_app/screens/task_rules_screen.dart';
import 'package:caretaker_app/services/push.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/state/notifications.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Renders UI to PNGs for PR descriptions — the assignment-rules screens
/// (issue #24), the notification settings and the email invite outputs. Not a behavioural test — skipped
/// unless SCREENSHOT_DIR is set, so it never runs in CI. Run locally with:
///   SCREENSHOT_DIR=/tmp/shots fvm flutter test test/screenshots_test.dart
void main() {
  final outDir = Platform.environment['SCREENSHOT_DIR'];

  Member m(
    String id,
    String name, {
    bool caretaker = false,
    bool child = false,
    String? color,
  }) => Member(
    id: id,
    relationName: name,
    isCaretaker: caretaker,
    isAdmin: caretaker,
    requiresCaretaker: child,
    color: color,
  );

  final members = [
    m('mom', 'Mom', caretaker: true, color: '#7C6CF0'),
    m('dad', 'Dad', caretaker: true, color: '#E8845B'),
    m('ada', 'Ada', child: true, color: '#4FB6A6'),
    m('ben', 'Ben', child: true, color: '#D06C9A'),
  ];
  final caretakers = members.where((x) => x.isCaretaker).toList();
  final children = members.where((x) => x.requiresCaretaker).toList();
  final feeds = [
    FeedItem(
      id: 'f1',
      kind: 'ics',
      mode: 'standard',
      sourceCalendarName: 'Soccer',
    ),
  ];
  final ruleSet = AssignmentRuleSet(
    rules: [
      AssignmentRule(
        id: 'r1',
        position: 0,
        ownerMemberId: 'mom',
        weekdayMask: 127, // every day
        cadenceWeeks: 1,
        taskType: 'pickup',
      ),
      AssignmentRule(
        id: 'r2',
        position: 1,
        ownerMemberId: 'dad',
        aboutMemberId: 'ada',
        weekdayMask: 7, // Mon, Tue, Wed
        cadenceWeeks: 2,
        anchorDate: DateTime(2026, 7, 20),
      ),
    ],
    links: [AssignmentLink(id: 'l1', feedId: 'f1', familyMemberId: 'ada')],
  );

  List<Override> overrides() => [
    membersProvider.overrideWith((ref) async => members),
    caretakersProvider.overrideWith((ref) async => caretakers),
    dependentsProvider.overrideWith((ref) async => children),
    feedsProvider.overrideWith((ref) async => feeds),
    assignmentRulesProvider.overrideWith((ref) async => ruleSet),
  ];

  Future<void> loadFonts() async {
    for (final family in const ['Hanken Grotesk', 'Schibsted Grotesk']) {
      final asset = family == 'Hanken Grotesk'
          ? 'assets/fonts/HankenGrotesk.ttf'
          : 'assets/fonts/SchibstedGrotesk.ttf';
      final loader = FontLoader(family);
      loader.addFont(rootBundle.load(asset));
      await loader.load();
    }
  }

  Future<void> capture(WidgetTester tester, GlobalKey key, String name) async {
    final boundary =
        key.currentContext!.findRenderObject() as RenderRepaintBoundary;
    await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: 2.5);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      File('$outDir/$name.png').writeAsBytesSync(bytes!.buffer.asUint8List());
    });
    // ignore: avoid_print
    print('wrote $outDir/$name.png');
  }

  testWidgets('render assignment-rules screens', (tester) async {
    if (outDir == null) return; // no-op unless explicitly requested
    await loadFonts();
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(400, 860);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final key = GlobalKey();
    Widget app() => ProviderScope(
      overrides: overrides(),
      child: RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: ThemeData.dark(useMaterial3: true).copyWith(
            scaffoldBackgroundColor: const Color(0xFF15121B),
            canvasColor: const Color(0xFF15121B),
            bottomSheetTheme: const BottomSheetThemeData(
              backgroundColor: Color(0xFF15121B),
            ),
          ),
          home: const AssignmentRulesScreen(),
        ),
      ),
    );

    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await capture(tester, key, '01-assignment-rules-list');

    // Open the create/edit sheet and capture it.
    await tester.tap(find.text('Add rule'));
    await tester.pumpAndSettle();
    await capture(tester, key, '02-assignment-rule-sheet');
  });

  testWidgets('render notification settings screens', (tester) async {
    if (outDir == null) return; // no-op unless explicitly requested
    await loadFonts();
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(400, 900);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final api = _ShotApiClient();
    final key = GlobalKey();
    Widget app(Widget home) => ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        pushServiceProvider.overrideWithValue(_ShotPush()),
        currentMemberProvider.overrideWith(
          (ref) async => m('me', 'Mom', caretaker: true, color: '#7C6CF0'),
        ),
        familyInfoProvider.overrideWith(
          (ref) async => (name: 'Jordahl', count: 2),
        ),
        accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
        loginIdentitiesProvider.overrideWith(
          (ref) async => const <LoginIdentity>[],
        ),
      ],
      child: RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: ThemeData.dark(useMaterial3: true).copyWith(
            scaffoldBackgroundColor: const Color(0xFF15121B),
            canvasColor: const Color(0xFF15121B),
          ),
          home: home,
        ),
      ),
    );

    await tester.pumpWidget(app(const Scaffold(body: MeScreen())));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Push notifications'), 200);
    await tester.pumpAndSettle();
    await capture(tester, key, '03-me-notifications');

    await tester.pumpWidget(
      app(
        NotificationScheduleScreen(
          schedule: NotificationSchedule.fromJson(_shotSchedule),
          timezone: 'America/Los_Angeles',
        ),
      ),
    );
    await tester.pumpAndSettle();
    await capture(tester, key, '04-notification-editor');
  });

  testWidgets('render email invite outputs', (tester) async {
    if (outDir == null) return; // no-op unless explicitly requested
    await loadFonts();
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(400, 1900);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final mom = members.first;
    final key = GlobalKey();
    final work = FeedItem(
      id: 'f-work',
      kind: 'google',
      mode: 'busy',
      sourceCalendarName: 'Busy (work)',
    );
    final club = FeedItem(
      id: 'f-club',
      kind: 'ics',
      mode: 'standard',
      sourceCalendarName: 'Book club',
    );
    final outputs = [
      EmailOutput(
        id: 'o1',
        email: 'grandma@example.com',
        label: 'Grandma',
        filters: const EmailOutputFilters(
          include: {'claimed_task'},
          taskTypes: {'pickup', 'attendance'},
        ),
        active: true,
        verified: true,
      ),
      EmailOutput(
        id: 'o2',
        email: 'mom@work.example',
        label: 'Work inbox',
        filters: const EmailOutputFilters(
          include: {'claimed_task', 'schedule'},
          sourceLinkIds: {'link-club'},
        ),
        active: true,
        verified: false,
      ),
      EmailOutput(
        id: 'o3',
        email: 'nanny@example.com',
        label: 'Nanny',
        filters: EmailOutputFilters.claimedOnly,
        active: true,
        verified: true,
        unsubscribed: true,
      ),
    ];
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          familyProvider.overrideWith((ref) async => 'fam'),
          membersProvider.overrideWith((ref) async => members),
          currentMemberProvider.overrideWith((ref) async => mom),
          feedsProvider.overrideWith((ref) async => [work, club]),
          feedLinksProvider.overrideWith(
            (ref, feedId) async => [
              FeedLink(
                id: feedId == 'f-work' ? 'link-work' : 'link-club',
                familyMemberId: 'mom',
                active: true,
              ),
            ],
          ),
          accountsProvider.overrideWith(
            (ref) async => const <ExternalAccount>[],
          ),
          memberCalendarProvider.overrideWith((ref, id) async => null),
          calendarEventsProvider.overrideWith((ref) async => const []),
          emailOutputsProvider.overrideWith(
            (ref, id) async =>
                EmailOutputList(outputs: outputs, emailEnabled: true),
          ),
        ],
        child: RepaintBoundary(
          key: key,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(),
            themeMode: ThemeMode.dark,
            home: const MemberDetailScreen(memberId: 'mom'),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.pumpAndSettle();
    await capture(tester, key, '05-email-invites-section');

    await tester.tap(find.text('Work inbox'));
    await tester.pumpAndSettle();
    expect(find.byType(EmailOutputSheet), findsOneWidget);
    await capture(tester, key, '06-email-invites-sheet');
  });

  testWidgets('render a task rule\'s match list and editor preview', (
    tester,
  ) async {
    if (outDir == null) return; // no-op unless explicitly requested
    await loadFonts();
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(400, 1100);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final ada = members[2];
    TaskRule rule(String id, int position, String match, String result) =>
        TaskRule(
          id: id,
          position: position,
          scope: 'this_calendar',
          linkId: 'l1',
          matchField: 'summary',
          matchOp: 'regex',
          matchValue: match,
          resultType: result,
        );
    final trips = rule('trips', 1, '/field trip/i', 'attendance');
    final taskRules = TaskRuleSet(
      rules: [rule('museum', 0, '/museum/i', 'none'), trips],
      unifiedDefault: TaskDefault(
        resultType: 'transition',
        dropoffWindowMin: 15,
        pickupWindowMin: 15,
      ),
      linkDefaults: {
        'l1': TaskDefault(
          resultType: 'transition',
          dropoffWindowMin: 15,
          pickupWindowMin: 15,
        ),
      },
    );

    final key = GlobalKey();
    Widget app(Widget home) => ProviderScope(
      overrides: [
        ...overrides(),
        apiClientProvider.overrideWithValue(_ShotApiClient()),
        familyProvider.overrideWith((ref) async => 'fam-1'),
        currentMemberProvider.overrideWith((ref) async => members.first),
        feedLinksProvider.overrideWith(
          (ref, feedId) async => [
            FeedLink(id: 'l1', familyMemberId: 'ada', active: true),
          ],
        ),
        taskRulesProvider.overrideWith((ref, memberId) async => taskRules),
      ],
      child: RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: home,
        ),
      ),
    );

    await tester.pumpWidget(
      app(
        TaskRuleMatchesScreen(
          member: ada,
          rule: trips,
          ruleSet: taskRules,
          calendarLabels: const {'l1': 'Soccer', null: 'Unified'},
        ),
      ),
    );
    await tester.pumpAndSettle();
    await capture(tester, key, '06-task-rule-matches');

    // The calendar chips fill in once the feeds load, so pump it twice.
    await tester.pumpWidget(app(TaskRulesScreen(member: ada)));
    await tester.pumpAndSettle();
    await tester.pumpWidget(app(TaskRulesScreen(member: ada)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Soccer'));
    await tester.pumpAndSettle();
    await capture(tester, key, '05-task-rules-see-what-it-catches');
    await tester.tap(find.text('Add rule'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '/museum/i');
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpAndSettle();
    await capture(tester, key, '07-task-rule-editor-preview');
  });

  testWidgets('render an assignment rule\'s match list and editor preview', (
    tester,
  ) async {
    if (outDir == null) return; // no-op unless explicitly requested
    await loadFonts();
    tester.view.devicePixelRatio = 1.0;
    tester.view.physicalSize = const Size(400, 1100);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final key = GlobalKey();
    Widget app(Widget home) => ProviderScope(
      overrides: [
        ...overrides(),
        apiClientProvider.overrideWithValue(_ShotApiClient()),
        familyProvider.overrideWith((ref) async => 'fam-1'),
        currentMemberProvider.overrideWith((ref) async => members.first),
      ],
      child: RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: home,
        ),
      ),
    );

    await tester.pumpWidget(app(const AssignmentRulesScreen()));
    await tester.pumpAndSettle();
    await capture(tester, key, '08-assignment-rules-see-what-it-claims');

    await tester.pumpWidget(
      app(
        AssignmentRuleMatchesScreen(
          rule: ruleSet.rules.first,
          ruleSet: ruleSet,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await capture(tester, key, '09-assignment-rule-matches');

    await tester.pumpWidget(app(const AssignmentRulesScreen()));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Add rule'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Pickup'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpAndSettle();
    await tester.drag(
      find.byType(SingleChildScrollView).last,
      const Offset(0, -600),
    );
    await tester.pumpAndSettle();
    await capture(tester, key, '10-assignment-rule-editor-preview');
  });
}

const _shotSchedule = {
  'id': 's1',
  'label': 'Evening brief',
  'enabled': true,
  'sendAt': '20:00',
  'timezone': 'America/Los_Angeles',
  'weekdayMask': 31,
  'startOffsetDays': 1,
  'horizonDays': 1,
  'categories': ['conflicts', 'pending_decisions', 'unclaimed_tasks'],
  'skipWhenEmpty': true,
};

/// Push is "on" for the shots, with no platform channel behind it.
class _ShotPush implements PushService {
  @override
  bool get isSupported => true;
  @override
  Future<PushAuthorization> authorizationStatus() async =>
      PushAuthorization.authorized;
  @override
  Future<bool> requestPermission() async => true;
  @override
  Future<String> register() async => 'a' * 64;
  @override
  Future<String> apsEnvironment() async => 'development';
  @override
  Future<String?> timezone() async => 'America/Los_Angeles';
  @override
  Future<void> setBadgeCount(int count) async {}
  @override
  Future<void> openSettings() async {}
  @override
  Future<Map<String, dynamic>?> takeInitialTap() async => null;
  @override
  void onTap(void Function(Map<String, dynamic>) handler) {}
}

class _ShotApiClient extends ApiClient {
  _ShotApiClient() : super(baseUrl: 'http://shots');

  static Map<String, dynamic> _match(
    String id,
    String summary,
    int days,
    String status,
    String? decidedBy,
    String result,
    List<Map<String, dynamic>> tasks,
  ) {
    final start = DateTime.now()
        .add(Duration(days: days))
        .copyWith(hour: 9, minute: 30);
    return {
      'event': {
        'id': id,
        'summary': summary,
        'dtstart': start.toUtc().toIso8601String(),
        'dtend': start.add(const Duration(hours: 5)).toUtc().toIso8601String(),
        'allDay': false,
        'linkId': 'l1',
        'provenance': 'synthesized',
      },
      'status': status,
      'decidedByRuleId': decidedBy,
      'resultType': result,
      'converted': false,
      'tasks': tasks,
    };
  }

  static Map<String, dynamic> _task(
    String type,
    String status, [
    List<String> owners = const [],
  ]) => {
    'id': '$type-$status',
    'familyMemberId': 'ada',
    'type': type,
    'dtstart': DateTime.now().toUtc().toIso8601String(),
    'status': status,
    'createdVia': 'generated',
    'ownerMemberIds': owners,
  };

  @override
  Future<Map<String, dynamic>> getTaskRuleMatches(
    String familyId,
    String memberId,
    String ruleId,
  ) async => {
    'matches': [
      _match(
        'a',
        'Field trip: aquarium',
        -12,
        'applies',
        'trips',
        'attendance',
        [
          _task('attendance', 'owned', ['mom']),
        ],
      ),
      _match(
        'b',
        'Field trip: fire station',
        3,
        'applies',
        'trips',
        'attendance',
        [_task('attendance', 'unowned')],
      ),
      _match('c', 'Museum field trip', 9, 'shadowed', 'museum', 'none', []),
      _match(
        'd',
        'Field trip: zoo (parents not needed)',
        16,
        'omitted',
        null,
        'transition',
        [
          _task('dropoff', 'owned', ['dad']),
          _task('pickup', 'unowned'),
        ],
      ),
    ],
  };

  static Map<String, dynamic> _assignMatch(
    String eventId,
    String type,
    int days,
    String status,
    String? decidedBy,
    List<String> owners,
  ) {
    final m = _match(
      eventId,
      'Practice',
      days,
      status,
      decidedBy,
      'transition',
      [],
    );
    return {
      'task': {
        ..._task(type, owners.isEmpty ? 'unowned' : 'owned', owners),
        'id': '$eventId-$type',
      },
      'event': {
        ...(m['event'] as Map<String, dynamic>),
        'familyMemberId': 'ada',
      },
      'status': status,
      'decidedByRuleId': decidedBy,
    };
  }

  @override
  Future<Map<String, dynamic>> getAssignmentRuleMatches(
    String familyId,
    String ruleId,
  ) async => {
    'matches': [
      _assignMatch('a', 'pickup', -5, 'applies', 'r1', ['mom']),
      _assignMatch('b', 'pickup', 2, 'applies', 'r1', ['mom']),
      _assignMatch('c', 'pickup', 4, 'held', null, ['dad']),
      _assignMatch('d', 'pickup', 9, 'omitted', 'r2', ['dad']),
      _assignMatch('e', 'pickup', 11, 'omitted', null, []),
    ],
  };

  @override
  Future<Map<String, dynamic>> previewAssignmentRule(
    String familyId, {
    String? ruleId,
    required String ownerMemberId,
    String? aboutMemberId,
    String? linkId,
    String? taskType,
    int weekdayMask = 0,
    int cadenceWeeks = 1,
    int? anchorDate,
  }) async => {
    'matches': [
      _assignMatch('b', 'pickup', 2, 'shadowed', 'r1', ['mom']),
      _assignMatch('c', 'pickup', 4, 'held', null, ['dad']),
      _assignMatch('f', 'pickup', 6, 'applies', 'draft', []),
    ],
  };

  @override
  Future<Map<String, dynamic>> previewTaskRule(
    String familyId,
    String memberId, {
    String? ruleId,
    String? linkId,
    required String scope,
    required String resultType,
    required String matchValue,
    String matchField = 'summary',
    String matchOp = 'regex',
    int? position,
  }) async => {
    'matches': [
      _match(
        'c',
        'Museum field trip',
        9,
        'shadowed',
        'trips',
        'transition',
        [],
      ),
      _match(
        'e',
        'Science museum day',
        20,
        'applies',
        'draft',
        'transition',
        [],
      ),
    ],
  };

  @override
  Future<Map<String, dynamic>> me() async => {
    'user': {'email': 'mom@example.com'},
  };

  @override
  Future<List<dynamic>> listPushDevices() async => [
    {'deviceToken': 'a' * 64},
  ];

  @override
  Future<List<dynamic>> listNotificationSchedules() async => [
    _shotSchedule,
    {
      ..._shotSchedule,
      'id': 's2',
      'label': 'Morning check',
      'sendAt': '07:00',
      'weekdayMask': 127,
      'startOffsetDays': 0,
      'categories': ['my_tasks'],
    },
  ];
}
