import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/absence_notice_settings.dart';
import 'package:caretaker_app/screens/home_screen.dart';
import 'package:caretaker_app/screens/task_actions_sheet.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/widgets/absence_notice.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Stands in for the phone's mail app.
class _FakeMail implements MailLauncher {
  _FakeMail({this.available = true});
  final bool available;
  final opened = <Uri>[];

  @override
  Future<bool> open(Uri uri) async {
    opened.add(uri);
    return available;
  }
}

class _RecordingApi extends ApiClient {
  _RecordingApi() : super(baseUrl: 'http://test');
  final sent = <({String eventId, String? gapStamp})>[];

  @override
  Future<void> markAbsenceNoticeSent(
    String familyId,
    String eventId, {
    String? gapStamp,
  }) async {
    sent.add((eventId: eventId, gapStamp: gapStamp));
  }
}

Member _m(
  String id,
  String name, {
  bool caretaker = false,
  bool admin = false,
  bool child = false,
}) => Member(
  id: id,
  relationName: name,
  isCaretaker: caretaker,
  isAdmin: admin,
  requiresCaretaker: child,
);

AbsenceNotice _notice({String state = 'outstanding'}) => AbsenceNotice(
  familyMemberId: 'theo',
  linkId: 'link1',
  date: '2030-03-05',
  to: const ['office@school.test'],
  cc: const ['nurse@school.test'],
  subject: 'Absence notice for Theo on Tuesday, March 5',
  body: 'Hello,\n\nTheo will be leaving at 10:00 AM & back at 11:30 AM.',
  state: state,
  gapStamp: '[["gap",1,2]]',
  child: 'Theo',
  schedule: 'leaving at 10:00 AM and returning at 11:30 AM',
  eventId: 'doc1',
  sentBy: state == 'outstanding' ? null : 'Mom',
  sentAt: state == 'outstanding' ? null : DateTime.now(),
);

CalendarEventItem _event(String id, {String provenance = 'human'}) =>
    CalendarEventItem(
      id: id,
      familyMemberId: 'theo',
      provenance: provenance,
      start: DateTime.now().add(const Duration(days: 1)),
      end: DateTime.now().add(const Duration(days: 1, hours: 1)),
      allDay: false,
      summary: 'Doctor',
    );

void main() {
  final dad = _m('dad', 'Dad', caretaker: true, admin: true);
  final theo = _m('theo', 'Theo', child: true);

  group('mailto + wording', () {
    test('absenceMailto prefills to, cc, subject and body with %20 not +', () {
      final uri = absenceMailto(_notice());
      final s = uri.toString();
      expect(s, startsWith('mailto:office@school.test?'));
      expect(s, contains('cc=nurse@school.test'));
      expect(s, contains('subject=Absence%20notice%20for%20Theo'));
      expect(s, contains('%0D%0A')); // CRLF line breaks
      expect(s, contains('%26')); // '&' in the body can't split the query
      expect(s, isNot(contains('+')));
    });

    test('the sent line says who, when, or that times changed', () {
      expect(absenceSentLine(_notice()), isNull);
      expect(
        absenceSentLine(_notice(state: 'sent')),
        startsWith('Sent by Mom'),
      );
      expect(
        absenceSentLine(_notice(state: 'needs_update')),
        startsWith('Times changed since Mom sent it'),
      );
    });
  });

  group('Home', () {
    Widget home({
      required List<AbsenceNotice> notices,
      required _FakeMail mail,
      required _RecordingApi api,
      Member? as,
    }) {
      final me = as ?? dad;
      return ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          familyProvider.overrideWith((ref) async => 'fam1'),
          mailLauncherProvider.overrideWithValue(mail),
          membersProvider.overrideWith((ref) async => [dad, theo]),
          currentMemberProvider.overrideWith((ref) async => me),
          unownedTasksProvider.overrideWith((ref) async => const []),
          allTasksProvider.overrideWith((ref) async => const []),
          pendingDecisionsProvider.overrideWith((ref) async => const []),
          conflictsProvider.overrideWith((ref) async => const []),
          absenceNoticesProvider.overrideWith((ref) async => notices),
          calendarEventsProvider.overrideWith((ref) async => const []),
          threadingThresholdProvider.overrideWith((ref) async => 30),
        ],
        child: MaterialApp(
          theme: buildAppTheme(),
          themeMode: ThemeMode.dark,
          home: const Scaffold(body: HomeScreen()),
        ),
      );
    }

    testWidgets('shows an Absence emails card with Compose', (tester) async {
      await tester.pumpWidget(
        home(notices: [_notice()], mail: _FakeMail(), api: _RecordingApi()),
      );
      await tester.pumpAndSettle();
      expect(find.text('ABSENCE EMAILS'), findsOneWidget);
      expect(find.textContaining('Theo'), findsWidgets);
      expect(
        find.textContaining('leaving at 10:00 AM and returning at 11:30 AM'),
        findsOneWidget,
      );
      expect(find.text('Compose'), findsOneWidget);
    });

    testWidgets('a changed notice offers an update and says so', (
      tester,
    ) async {
      await tester.pumpWidget(
        home(
          notices: [_notice(state: 'needs_update')],
          mail: _FakeMail(),
          api: _RecordingApi(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Compose update'), findsOneWidget);
      expect(
        find.textContaining('Times changed since Mom sent it'),
        findsOneWidget,
      );
    });

    testWidgets('no notices ⇒ no section', (tester) async {
      await tester.pumpWidget(
        home(notices: const [], mail: _FakeMail(), api: _RecordingApi()),
      );
      await tester.pumpAndSettle();
      expect(find.text('ABSENCE EMAILS'), findsNothing);
      expect(find.text('Compose'), findsNothing);
    });

    testWidgets(
      'Compose opens Mail; on return, "Yes" records it and "Not yet" does not',
      (tester) async {
        final mail = _FakeMail();
        final api = _RecordingApi();
        await tester.pumpWidget(
          home(notices: [_notice()], mail: mail, api: api),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.text('Compose'));
        await tester.pumpAndSettle();
        expect(mail.opened, hasLength(1));
        expect(
          mail.opened.single.toString(),
          startsWith('mailto:office@school.test'),
        );
        // Still in Mail: nothing asked yet, nothing recorded.
        expect(find.text('Did you send it?'), findsNothing);

        // Off to Mail, and back.
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();
        expect(find.text('Did you send it?'), findsOneWidget);

        await tester.tap(find.text('Not yet'));
        await tester.pumpAndSettle();
        expect(api.sent, isEmpty);

        // Again, this time it went out.
        await tester.tap(find.text('Compose'));
        await tester.pumpAndSettle();
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Yes, I sent it'));
        await tester.pumpAndSettle();
        expect(api.sent, [(eventId: 'doc1', gapStamp: '[["gap",1,2]]')]);
      },
    );

    testWidgets('no mail app ⇒ a message, and no dialog', (tester) async {
      final api = _RecordingApi();
      await tester.pumpWidget(
        home(notices: [_notice()], mail: _FakeMail(available: false), api: api),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Compose'));
      await tester.pumpAndSettle();
      expect(find.textContaining('No mail app'), findsOneWidget);
      expect(find.text('Did you send it?'), findsNothing);
      expect(api.sent, isEmpty);
    });
  });

  group('event detail sheets', () {
    Widget host({
      required AbsenceNotice? notice,
      required Future<void> Function(BuildContext, WidgetRef) open,
      List<Override> extra = const [],
    }) => ProviderScope(
      overrides: [
        familyProvider.overrideWith((ref) async => 'fam1'),
        membersProvider.overrideWith((ref) async => [dad, theo]),
        currentMemberProvider.overrideWith((ref) async => dad),
        absenceNoticeProvider.overrideWith((ref, id) async => notice),
        allTasksProvider.overrideWith((ref) async => const []),
        calendarEventsProvider.overrideWith((ref) async => const []),
        ...extra,
      ],
      child: MaterialApp(
        theme: buildAppTheme(),
        themeMode: ThemeMode.dark,
        home: Scaffold(
          body: Consumer(
            builder: (context, ref, _) => Center(
              child: TextButton(
                onPressed: () => open(context, ref),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );

    testWidgets('the appointment shows Email school when eligible', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          notice: _notice(),
          open: (c, r) => showEventDetails(c, r, _event('doc1'), member: theo),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Email school'), findsOneWidget);
      expect(
        find.textContaining('Theo will be leaving at 10:00 AM'),
        findsOneWidget,
      );
    });

    testWidgets('hidden when the event has no notice (no recipients, etc.)', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          notice: null,
          open: (c, r) => showEventDetails(c, r, _event('doc1'), member: theo),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Email school'), findsNothing);
    });

    testWidgets('a sent notice reads "Sent by Mom" and offers to send again', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          notice: _notice(state: 'sent'),
          open: (c, r) => showEventDetails(c, r, _event('doc1'), member: theo),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Sent by Mom'), findsOneWidget);
      expect(find.text('Email school again'), findsOneWidget);
    });

    testWidgets('a changed notice reads "times changed" and offers an update', (
      tester,
    ) async {
      await tester.pumpWidget(
        host(
          notice: _notice(state: 'needs_update'),
          open: (c, r) => showEventDetails(c, r, _event('doc1'), member: theo),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Times changed since Mom sent it'),
        findsOneWidget,
      );
      expect(find.text('Email school an update'), findsOneWidget);
    });

    testWidgets('a trimmed school-day segment (task sheet) shows it too', (
      tester,
    ) async {
      final task = TaskItem(
        id: 't1',
        familyMemberId: 'theo',
        type: 'pickup',
        start: DateTime.now().add(const Duration(days: 1)),
        status: 'unowned',
        createdVia: 'generated',
        calendarEventId: 'cf1',
      );
      await tester.pumpWidget(
        host(
          notice: _notice(),
          open: (c, r) => showTaskActions(
            c,
            r,
            task,
            sourceEvent: _event('cf1', provenance: 'synthesized'),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Email school'), findsOneWidget);
    });

    testWidgets('a trimmed segment without a notice has no button', (
      tester,
    ) async {
      final task = TaskItem(
        id: 't1',
        familyMemberId: 'theo',
        type: 'pickup',
        start: DateTime.now().add(const Duration(days: 1)),
        status: 'unowned',
        createdVia: 'generated',
        calendarEventId: 'cf1',
      );
      await tester.pumpWidget(
        host(
          notice: null,
          open: (c, r) => showTaskActions(
            c,
            r,
            task,
            sourceEvent: _event('cf1', provenance: 'synthesized'),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('Email school'), findsNothing);
    });
  });

  group('settings', () {
    testWidgets(
      'previews the wording and explains that an address enables it',
      (tester) async {
        final link = FeedLink(
          id: 'link1',
          familyMemberId: 'theo',
          active: true,
          dayStart: '08:30',
          dayEnd: '15:00',
        );
        final feed = FeedItem(
          id: 'feed1',
          kind: 'ics',
          mode: 'exception',
          status: 'active',
          sourceCalendarName: 'Lincoln',
        );
        await tester.pumpWidget(
          ProviderScope(
            overrides: [currentMemberProvider.overrideWith((ref) async => dad)],
            child: MaterialApp(
              theme: buildAppTheme(),
              themeMode: ThemeMode.dark,
              home: Scaffold(
                body: AbsenceNoticeSettingsSheet(
                  feed: feed,
                  link: link,
                  member: theo,
                  initial: AbsenceNoticeSettings(
                    to: const [],
                    cc: const [],
                    subjectTemplate: kDefaultAbsenceSubject,
                    bodyTemplate: kDefaultAbsenceBody,
                    includeReason: false,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.textContaining('Add an address to turn it on'),
          findsOneWidget,
        );
        expect(
          tester
              .widget<Text>(find.byKey(const Key('absence-preview-subject')))
              .data,
          'Absence notice for Theo on Tuesday, March 3',
        );
        expect(
          tester
              .widget<Text>(find.byKey(const Key('absence-preview-body')))
              .data,
          allOf(contains('because of an appointment'), contains('Dad')),
        );

        // Adding an address turns it on.
        await tester.enterText(
          find.byKey(const Key('absence-to-field')),
          'office@school.test',
        );
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pumpAndSettle();
        expect(find.text('office@school.test'), findsOneWidget);
        expect(find.textContaining('On for Theo'), findsOneWidget);
      },
    );

    test('preview fills every placeholder and leaves unknown ones', () {
      expect(
        previewAbsenceTemplate(
          '{child}|{leaveTime}|{returnTime}|{reason}|{parent}|{x}',
          child: 'Theo',
          parent: 'Dad',
          includeReason: true,
        ),
        'Theo|10:00 AM|11:30 AM|Dentist appointment|Dad|{x}',
      );
    });
  });
}
