import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/task_rule_matches_screen.dart';
import 'package:caretaker_app/screens/task_rules_screen.dart';
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
  Future<Map<String, dynamic>> getTaskRuleMatches(
    String familyId,
    String memberId,
    String ruleId,
  ) async => {'matches': matches};

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
  }) async {
    previews.add({
      'ruleId': ruleId,
      'linkId': linkId,
      'scope': scope,
      'matchValue': matchValue,
      'position': position,
    });
    return {'matches': preview};
  }

  @override
  Future<void> omitTaskRuleEvent(
    String familyId,
    String memberId,
    String ruleId,
    String calendarEventId,
  ) async => calls.add('omit $ruleId $calendarEventId');

  @override
  Future<void> restoreTaskRuleEvent(
    String familyId,
    String memberId,
    String ruleId,
    String calendarEventId,
  ) async => calls.add('restore $ruleId $calendarEventId');
}

final _child = Member(
  id: 'theo',
  relationName: 'Theo',
  isCaretaker: false,
  isAdmin: false,
  requiresCaretaker: true,
);
Member _viewer({required bool admin}) => Member(
  id: 'dad',
  relationName: 'Dad',
  isCaretaker: true,
  isAdmin: admin,
  requiresCaretaker: false,
);

TaskRule _rule(String id, String match, String result) => TaskRule(
  id: id,
  position: id == 'museum' ? 0 : 1,
  scope: 'this_calendar',
  linkId: 'school',
  matchField: 'summary',
  matchOp: 'regex',
  matchValue: match,
  resultType: result,
);

final _trips = _rule('trips', '/field trip/i', 'attendance');
final _museum = _rule('museum', '/museum/i', 'none');
final _ruleSet = TaskRuleSet(
  rules: [_museum, _trips],
  unifiedDefault: TaskDefault(
    resultType: 'transition',
    dropoffWindowMin: 15,
    pickupWindowMin: 15,
  ),
  linkDefaults: const {},
);

Map<String, dynamic> _match(
  String id,
  String summary,
  int days, {
  required String status,
  String? decidedBy,
  String result = 'attendance',
  List<Map<String, dynamic>>? tasks,
}) {
  final start = DateTime.now().add(Duration(days: days));
  return {
    'event': {
      'id': id,
      'summary': summary,
      'dtstart': start.toUtc().toIso8601String(),
      'dtend': start.add(const Duration(hours: 2)).toUtc().toIso8601String(),
      'allDay': false,
      'linkId': 'school',
      'provenance': 'synthesized',
    },
    'status': status,
    'decidedByRuleId': decidedBy,
    'resultType': result,
    'converted': false,
    'tasks': ?tasks,
  };
}

Map<String, dynamic> _task(
  String id,
  String type,
  String status, [
  List<String> owners = const [],
]) => {
  'id': id,
  'familyMemberId': 'theo',
  'type': type,
  'dtstart': DateTime.now().toUtc().toIso8601String(),
  'status': status,
  'createdVia': 'generated',
  'ownerMemberIds': owners,
};

Future<void> _pump(
  WidgetTester tester,
  _FakeApi api,
  Widget home, {
  bool admin = true,
}) async {
  tester.view.physicalSize = const Size(900, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final viewer = _viewer(admin: admin);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        familyProvider.overrideWith((ref) async => 'fam-1'),
        membersProvider.overrideWith((ref) async => [viewer, _child]),
        currentMemberProvider.overrideWith((ref) async => viewer),
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
      'past',
      'Field trip',
      -3,
      status: 'applies',
      decidedBy: 'trips',
      tasks: [
        _task('t1', 'attendance', 'owned', ['dad']),
      ],
    ),
    _match(
      'next',
      'Field trip',
      4,
      status: 'applies',
      decidedBy: 'trips',
      tasks: [_task('t2', 'attendance', 'unowned')],
    ),
    _match(
      'museum',
      'Museum field trip',
      6,
      status: 'shadowed',
      decidedBy: 'museum',
      result: 'none',
      tasks: const [],
    ),
    _match(
      'zoo',
      'Zoo field trip',
      8,
      status: 'omitted',
      result: 'transition',
      tasks: [
        _task('t3', 'dropoff', 'unowned'),
        _task('t4', 'pickup', 'unowned'),
      ],
    ),
  ];

  testWidgets(
    'lists what a rule catches, by window, with what each generates',
    (tester) async {
      final api = _FakeApi(matches: matches);
      await _pump(
        tester,
        api,
        TaskRuleMatchesScreen(
          member: _child,
          rule: _trips,
          ruleSet: _ruleSet,
          calendarLabels: const {'school': 'School', null: 'Unified'},
        ),
      );

      expect(find.text('What this rule catches'), findsOneWidget);
      expect(
        find.text(
          '4 events in the past and next 30 days match; this rule decides 2 of '
          'them.',
        ),
        findsOneWidget,
      );
      expect(find.text('NEXT 30 DAYS'), findsOneWidget);
      expect(find.text('PAST 30 DAYS'), findsOneWidget);
      expect(find.text('→ Attendance'), findsNWidgets(2));
      // A shadowed match names the rule that decides it instead.
      expect(
        find.text('Decided by “Title matches /museum/i” → No tasks'),
        findsOneWidget,
      );
      expect(
        find.text('Omitted · uses School default → Drop-off & pickup'),
        findsOneWidget,
      );
      // Current tasks, with who has them.
      expect(find.text('Attendance · Dad'), findsOneWidget);
      expect(find.text('Attendance · unclaimed'), findsOneWidget);
      expect(find.text('Drop-off · unclaimed'), findsOneWidget);

      // Omit / include-again on the matches this rule could decide; nothing to
      // do from here for the one an earlier rule decides.
      expect(find.text('Omit from this rule'), findsNWidgets(2));
      expect(find.text('Include again'), findsOneWidget);

      await tester.tap(find.text('Omit from this rule').first);
      await tester.pumpAndSettle();
      expect(api.calls, ['omit trips next']);
      expect(find.text('“Field trip” omitted from this rule'), findsOneWidget);

      await tester.tap(find.text('Include again'));
      await tester.pumpAndSettle();
      expect(api.calls.last, 'restore trips zoo');
    },
  );

  testWidgets('a non-admin sees the list but no omit actions', (tester) async {
    await _pump(
      tester,
      _FakeApi(matches: matches),
      TaskRuleMatchesScreen(
        member: _child,
        rule: _trips,
        ruleSet: _ruleSet,
        calendarLabels: const {'school': 'School', null: 'Unified'},
      ),
      admin: false,
    );
    expect(find.text('→ Attendance'), findsNWidgets(2));
    expect(find.text('Omit from this rule'), findsNothing);
    expect(find.text('Include again'), findsNothing);
  });

  testWidgets('the rule editor previews what the pattern would catch', (
    tester,
  ) async {
    final api = _FakeApi(
      preview: [
        _match(
          'a',
          'Museum field trip',
          2,
          status: 'applies',
          decidedBy: 'draft',
        ),
        _match(
          'b',
          'Science museum',
          5,
          status: 'shadowed',
          decidedBy: 'trips',
        ),
      ],
    );
    await _pump(
      tester,
      api,
      Consumer(
        builder: (context, ref, _) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => showTaskRuleSheet(
                context,
                member: _child,
                activeLinkId: 'school',
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    // Nothing to preview until there's a pattern.
    expect(api.previews, isEmpty);
    await tester.enterText(find.byType(TextField), '/museum/i');
    await tester.pump(const Duration(milliseconds: 200));
    expect(api.previews, isEmpty); // still debouncing
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();

    expect(api.previews.single, {
      'ruleId': null,
      'linkId': 'school',
      'scope': 'this_calendar',
      'matchValue': '/museum/i',
      'position': null,
    });
    expect(
      find.text(
        'Catches 2 events in the past and next 30 days; 1 would follow this '
        'rule.',
      ),
      findsOneWidget,
    );
    expect(
      find.textContaining('Science museum (earlier rule wins)'),
      findsOneWidget,
    );

    // Widening the scope re-runs it.
    await tester.tap(find.text('All calendars'));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpAndSettle();
    expect(api.previews.last['scope'], 'all_calendars');
    expect(api.previews.last['linkId'], isNull);
  });
}
