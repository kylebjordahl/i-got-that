import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/member_detail_screen.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

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

  // Tall viewport so the whole lazily-built ListView renders in one frame.
  setUp(() {
    TestWidgetsFlutterBinding.ensureInitialized();
  });
  Future<void> pumpTall(WidgetTester tester, Widget widget) async {
    tester.view.physicalSize = const Size(800, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    await tester.pumpWidget(widget);
    await tester.pumpAndSettle();
  }

  Widget app(String memberId) => ProviderScope(
        overrides: [
          membersProvider.overrideWith((ref) async => [me, theo]),
          currentMemberProvider.overrideWith((ref) async => me),
          feedsProvider.overrideWith((ref) async => const <FeedItem>[]),
          accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
          memberCalendarProvider.overrideWith((ref, id) async => null),
          calendarEventsProvider.overrideWith((ref) async => const []),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: MemberDetailScreen(memberId: memberId),
        ),
      );

  testWidgets('one member-detail screen serves a child: all round-6 sections render',
      (tester) async {
    await pumpTall(tester, app('theo'));

    expect(find.text('Family member'), findsOneWidget);
    expect(find.textContaining('Child'), findsWidgets); // grouping tag only
    expect(find.text('SOURCE CALENDARS'), findsOneWidget);
    expect(find.text('UNIFIED CALENDAR'), findsOneWidget);
    expect(find.text('TASK CLAIMING'), findsOneWidget);
    expect(find.text('FAMILY LOGISTICS'), findsOneWidget);
    // No target designated ⇒ the DB-only hint shows.
    expect(find.text('No target calendar'), findsOneWidget);
  });

  testWidgets('the same screen serves a caretaker, with role toggles editable',
      (tester) async {
    await pumpTall(tester, app('dad'));

    expect(find.text('Family member'), findsOneWidget);
    expect(find.text('Can claim tasks'), findsOneWidget);
    expect(find.text('Admin access'), findsOneWidget);
    expect(find.text('SOURCE CALENDARS'), findsOneWidget);
  });
}
