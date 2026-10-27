import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/assignment_rule_matches_screen.dart';
import 'package:caretaker_app/screens/assignment_rules_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Serves canned match lists / previews and records omit/restore calls.
class _FakeApi extends ApiClient {
  _FakeApi({this.matches = const [], this.preview = const []})
    : super(baseUrl: 'http://test');

  final List<Map<String, dynamic>> matches;
  final List<Map<String, dynamic>> preview;
  final calls = <String>[];
  final previews = <Map<String, Object?>>[];

  @override
  Future<Map<String, dynamic>> getAssignmentRuleMatches(
    String familyId,
    String ruleId,
  ) async => {'matches': matches};

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
  }) async {
    previews.add({
      'ruleId': ruleId,
      'aboutMemberId': aboutMemberId,
      'taskType': taskType,
      'weekdayMask': weekdayMask,
    });
    return {'matches': preview};
  }

  @override
  Future<void> omitAssignmentRuleTask(
    String familyId,
    String ruleId,
    String calendarEventId,
    String taskType,
  ) async => calls.add('omit $ruleId $calendarEventId $taskType');

  @override
  Future<void> restoreAssignmentRuleTask(
    String familyId,
    String ruleId,
    String calendarEventId,
    String taskType,
  ) async => calls.add('restore $ruleId $calendarEventId $taskType');
}

Member _m(
  String id,
  String name, {
  bool caretaker = false,
  bool admin = false,
}) => Member(
  id: id,
  relationName: name,
  isCaretaker: caretaker,
  isAdmin: admin,
  requiresCaretaker: !caretaker,
);

final _mom = _m('mom', 'Mom', caretaker: true, admin: true);
final _dad = _m('dad', 'Dad', caretaker: true);
final _ada = _m('ada', 'Ada');

final _mondays = AssignmentRule(
  id: 'mondays',
  position: 1,
  ownerMemberId: 'mom',
  weekdayMask: 1,
  cadenceWeeks: 1,
);
final _dropoffs = AssignmentRule(
  id: 'dropoffs',
  position: 0,
  ownerMemberId: 'dad',
  taskType: 'dropoff',
  weekdayMask: 0,
  cadenceWeeks: 1,
);
final _ruleSet = AssignmentRuleSet(
  rules: [_dropoffs, _mondays],
  links: const [],
);

Map<String, dynamic> _match(
  String eventId,
  String type,
  int days, {
  required String status,
  String? decidedBy,
  List<String> owners = const [],
}) {
  final start = DateTime.now().add(Duration(days: days));
  return {
    'task': {
      'id': '$eventId-$type',
      'familyMemberId': 'ada',
      'type': type,
      'dtstart': start.toUtc().toIso8601String(),
      'status': owners.isEmpty ? 'unowned' : 'owned',
      'createdVia': 'generated',
      'ownerMemberIds': owners,
    },
    'event': {
      'id': eventId,
      'familyMemberId': 'ada',
      'summary': 'Practice',
      'dtstart': start.toUtc().toIso8601String(),
      'dtend': null,
      'allDay': false,
      'linkId': null,
    },
    'status': status,
    'decidedByRuleId': decidedBy,
  };
}

Future<void> _pump(
  WidgetTester tester,
  _FakeApi api,
  Widget home, {
  Member? viewer,
}) async {
  tester.view.physicalSize = const Size(900, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final me = viewer ?? _mom;
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        familyProvider.overrideWith((ref) async => 'fam-1'),
        membersProvider.overrideWith((ref) async => [_mom, _dad, _ada]),
        caretakersProvider.overrideWith((ref) async => [_mom, _dad]),
        dependentsProvider.overrideWith((ref) async => [_ada]),
        feedsProvider.overrideWith((ref) async => const []),
        currentMemberProvider.overrideWith((ref) async => me),
        allTasksProvider.overrideWith((ref) async => const []),
        unownedTasksProvider.overrideWith((ref) async => const []),
        calendarEventsProvider.overrideWith((ref) async => const []),
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: home,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  final matches = [
    _match(
      'mon',
      'pickup',
      3,
      status: 'applies',
      decidedBy: 'mondays',
      owners: ['mom'],
    ),
    _match(
      'mon',
      'dropoff',
      3,
      status: 'shadowed',
      decidedBy: 'dropoffs',
      owners: ['dad'],
    ),
    _match('mon2', 'pickup', 10, status: 'held', owners: ['dad']),
    _match('mon3', 'pickup', 17, status: 'omitted'),
    _match(
      'mon4',
      'pickup',
      24,
      status: 'owner_unavailable',
      decidedBy: 'mondays',
    ),
  ];

  testWidgets('lists what a rule claims, with who has each task', (
    tester,
  ) async {
    final api = _FakeApi(matches: matches);
    await _pump(
      tester,
      api,
      AssignmentRuleMatchesScreen(rule: _mondays, ruleSet: _ruleSet),
    );

    expect(find.text('What this rule claims'), findsOneWidget);
    expect(
      find.text(
        '5 tasks in the past and next 30 days match; this rule claims 1 of '
        'them.',
      ),
      findsOneWidget,
    );
    expect(find.text('→ claimed for Mom'), findsOneWidget);
    expect(
      find.textContaining('Claimed by an earlier rule, “Dad ·'),
      findsOneWidget,
    );
    expect(
      find.text('Handled by hand, so no rule changes who has it'),
      findsOneWidget,
    );
    expect(find.text('Omitted · back in the queue'), findsOneWidget);
    expect(
      find.text('Mom can’t take tasks any more, so this rule claims nothing'),
      findsOneWidget,
    );
    expect(find.text('Has it: Mom'), findsOneWidget);
    expect(find.text('Unclaimed'), findsNWidgets(2));

    // Omit / include-again only where this rule is (or was) the one deciding.
    expect(find.text('Omit from this rule'), findsOneWidget);
    expect(find.text('Include again'), findsOneWidget);
    await tester.tap(find.text('Omit from this rule'));
    await tester.pumpAndSettle();
    expect(api.calls, ['omit mondays mon pickup']);
    await tester.tap(find.text('Include again'));
    await tester.pumpAndSettle();
    expect(api.calls.last, 'restore mondays mon3 pickup');
  });

  testWidgets('a non-admin sees the list but no omit actions', (tester) async {
    await _pump(
      tester,
      _FakeApi(matches: matches),
      AssignmentRuleMatchesScreen(rule: _mondays, ruleSet: _ruleSet),
      viewer: _dad,
    );
    expect(find.text('→ claimed for Mom'), findsOneWidget);
    expect(find.text('Omit from this rule'), findsNothing);
  });

  testWidgets('the rule editor previews what the filters would claim', (
    tester,
  ) async {
    final api = _FakeApi(
      preview: [
        _match('mon', 'pickup', 3, status: 'applies', decidedBy: 'draft'),
        _match('mon', 'dropoff', 3, status: 'shadowed', decidedBy: 'dropoffs'),
      ],
    );
    await _pump(
      tester,
      api,
      Consumer(
        builder: (context, ref, _) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () =>
                  showAssignmentRuleSheet(context, ref, ruleSet: _ruleSet),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    // A new rule previews straight away (no filters yet: everything).
    expect(api.previews, hasLength(1));
    expect(
      find.text(
        'Matches 2 tasks in the past and next 30 days; this rule would claim '
        '1.',
      ),
      findsOneWidget,
    );
    expect(
      find.textContaining('Drop-off · Ada (earlier rule wins)'),
      findsOneWidget,
    );

    // Narrowing a filter re-runs it, once the debounce settles.
    await tester.tap(find.text('Pickup'));
    await tester.pump(const Duration(milliseconds: 200));
    expect(api.previews, hasLength(1));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
    expect(api.previews, hasLength(2));
    expect(api.previews.last['taskType'], 'pickup');
  });
}
