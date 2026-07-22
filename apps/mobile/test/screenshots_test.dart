import 'dart:io';
import 'dart:ui' as ui;

import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/assignment_rules_screen.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Renders the new assignment-rules UI (issue #24) to PNGs for the PR
/// description. Not a behavioural test — skipped unless SCREENSHOT_DIR is set,
/// so it never runs in CI. Run locally with:
///   SCREENSHOT_DIR=/tmp/shots fvm flutter test test/screenshots_test.dart
void main() {
  final outDir = Platform.environment['SCREENSHOT_DIR'];

  Member m(String id, String name,
          {bool caretaker = false, bool child = false, String? color}) =>
      Member(
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
    FeedItem(id: 'f1', kind: 'ics', mode: 'standard', sourceCalendarName: 'Soccer'),
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
}
