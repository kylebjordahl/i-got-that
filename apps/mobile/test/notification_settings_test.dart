import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/me_screen.dart';
import 'package:caretaker_app/screens/notification_schedule_screen.dart';
import 'package:caretaker_app/services/push.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/state/notifications.dart';
import 'package:caretaker_app/theme/app_theme.dart';
import 'package:caretaker_app/util/notification_text.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:package_info_plus/package_info_plus.dart';

/// A [PushService] with no platform channel behind it. Real channel calls never
/// resolve under `pumpAndSettle` (platform messages need the real event loop),
/// so every widget test that renders the notifications section has to stub it.
class _FakePush implements PushService {
  _FakePush({
    this.supported = true,
    this.authorization = PushAuthorization.authorized,
  });

  final bool supported;
  PushAuthorization authorization;
  bool registerCalled = false;
  bool settingsOpened = false;
  int? badgeCount;

  @override
  bool get isSupported => supported;

  @override
  Future<PushAuthorization> authorizationStatus() async => authorization;

  @override
  Future<bool> requestPermission() async {
    authorization = PushAuthorization.authorized;
    return true;
  }

  @override
  Future<String> register() async {
    registerCalled = true;
    return 'a' * 64;
  }

  @override
  Future<String> apsEnvironment() async => 'development';

  @override
  Future<String?> timezone() async => 'America/Los_Angeles';

  @override
  Future<void> setBadgeCount(int count) async => badgeCount = count;

  @override
  Future<void> openSettings() async => settingsOpened = true;

  @override
  Future<Map<String, dynamic>?> takeInitialTap() async => null;

  @override
  void onTap(void Function(Map<String, dynamic>) handler) {}
}

class _FakeApiClient extends ApiClient {
  _FakeApiClient({this.devices = const [], this.schedules = const []})
    : super(baseUrl: 'http://test');

  List<dynamic> devices;
  List<dynamic> schedules;
  Map<String, dynamic>? created;
  Map<String, dynamic>? updated;
  String? unregistered;
  String? tested;

  @override
  Future<Map<String, dynamic>> me() async => {
    'user': {'email': 'you@example.com'},
  };

  @override
  Future<List<dynamic>> listPushDevices() async => devices;

  @override
  Future<void> unregisterPushDevice(String deviceToken) async {
    unregistered = deviceToken;
    devices = const [];
  }

  @override
  Future<void> registerPushDevice({
    required String deviceToken,
    required String bundleId,
    required String environment,
    String? timezone,
  }) async {
    devices = [
      {'deviceToken': deviceToken},
    ];
  }

  @override
  Future<List<dynamic>> listNotificationSchedules() async => schedules;

  @override
  Future<Map<String, dynamic>> createNotificationSchedule({
    required String label,
    required String sendAt,
    required String timezone,
    required int weekdayMask,
    required int startOffsetDays,
    required int horizonDays,
    required List<String> categories,
    required bool skipWhenEmpty,
  }) async {
    created = {
      'label': label,
      'sendAt': sendAt,
      'timezone': timezone,
      'weekdayMask': weekdayMask,
      'startOffsetDays': startOffsetDays,
      'horizonDays': horizonDays,
      'categories': categories,
      'skipWhenEmpty': skipWhenEmpty,
    };
    return {'id': 'new', ...created!};
  }

  @override
  Future<Map<String, dynamic>> updateNotificationSchedule(
    String scheduleId, {
    String? label,
    bool? enabled,
    String? sendAt,
    String? timezone,
    int? weekdayMask,
    int? startOffsetDays,
    int? horizonDays,
    List<String>? categories,
    bool? skipWhenEmpty,
  }) async {
    updated = {
      'id': scheduleId,
      if (label != null) 'label': label,
      if (weekdayMask != null) 'weekdayMask': weekdayMask,
      if (horizonDays != null) 'horizonDays': horizonDays,
      if (categories != null) 'categories': categories,
    };
    return updated!;
  }

  @override
  Future<Map<String, dynamic>> testNotificationSchedule(
    String scheduleId,
  ) async {
    tested = scheduleId;
    return {
      'digest': {'total': 2},
      'delivered': 1,
      'skipped': null,
    };
  }
}

Map<String, dynamic> scheduleJson({
  String id = 's1',
  String label = 'Evening brief',
  String sendAt = '20:00',
  int weekdayMask = 31,
  int startOffsetDays = 1,
  int horizonDays = 1,
  List<String> categories = const ['unclaimed_tasks'],
}) => {
  'id': id,
  'label': label,
  'enabled': true,
  'sendAt': sendAt,
  'timezone': 'America/Los_Angeles',
  'weekdayMask': weekdayMask,
  'startOffsetDays': startOffsetDays,
  'horizonDays': horizonDays,
  'categories': categories,
  'skipWhenEmpty': true,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // The Me screen is long and the editor longer; a tall surface keeps every
  // row laid out so the assertions are about content rather than scrolling.
  setUp(() {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    view.physicalSize = const Size(1000, 4000);
    view.devicePixelRatio = 1.0;
    // Enabling push reads the bundle id (it becomes the APNs topic).
    PackageInfo.setMockInitialValues(
      appName: 'IGT',
      packageName: 'com.kylebjordahl.igt.staging',
      version: '1.0.0',
      buildNumber: '1',
      buildSignature: '',
    );
  });

  tearDown(() {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    view.resetPhysicalSize();
    view.resetDevicePixelRatio();
  });

  final me = Member(
    id: 'me',
    relationName: 'Me',
    isCaretaker: true,
    isAdmin: false,
    requiresCaretaker: false,
  );

  Widget meScreen(_FakeApiClient api, _FakePush push) => ProviderScope(
    overrides: [
      apiClientProvider.overrideWithValue(api),
      pushServiceProvider.overrideWithValue(push),
      currentMemberProvider.overrideWith((ref) async => me),
      familyInfoProvider.overrideWith(
        (ref) async => (name: 'Test Family', count: 1),
      ),
      accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
      loginIdentitiesProvider.overrideWith(
        (ref) async => const <LoginIdentity>[],
      ),
    ],
    child: const MaterialApp(home: Scaffold(body: MeScreen())),
  );

  group('Me screen notifications section', () {
    testWidgets('lists the user\'s schedules once push is on', (tester) async {
      final api = _FakeApiClient(
        devices: [
          {'deviceToken': 'a' * 64},
        ],
        schedules: [scheduleJson()],
      );
      await tester.pumpWidget(meScreen(api, _FakePush()));
      await tester.pumpAndSettle();

      expect(find.text('NOTIFICATIONS'), findsOneWidget);
      expect(find.text('Push notifications'), findsOneWidget);
      expect(find.text('Evening brief'), findsOneWidget);
      expect(
        find.text('Weekdays · 8:00 PM · tomorrow · unclaimed tasks'),
        findsOneWidget,
      );
      expect(find.text('Add a notification'), findsOneWidget);
    });

    testWidgets('hides the schedule list until push is on', (tester) async {
      final api = _FakeApiClient(schedules: [scheduleJson()]);
      await tester.pumpWidget(
        meScreen(
          api,
          _FakePush(authorization: PushAuthorization.notDetermined),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Push notifications'), findsOneWidget);
      // Nothing to configure until there's somewhere to deliver.
      expect(find.text('Evening brief'), findsNothing);
      expect(find.text('Add a notification'), findsNothing);
    });

    testWidgets('turning the switch on registers the device', (tester) async {
      final api = _FakeApiClient();
      final push = _FakePush(authorization: PushAuthorization.notDetermined);
      await tester.pumpWidget(meScreen(api, push));
      await tester.pumpAndSettle();

      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();

      expect(push.registerCalled, isTrue);
      expect(api.devices, hasLength(1));
      expect(find.text('Add your first notification'), findsOneWidget);
    });

    testWidgets('offers the Settings escape hatch when permission was denied', (
      tester,
    ) async {
      final api = _FakeApiClient();
      final push = _FakePush(authorization: PushAuthorization.denied);
      await tester.pumpWidget(meScreen(api, push));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Enable in iOS Settings'));
      await tester.pumpAndSettle();
      expect(push.settingsOpened, isTrue);
    });

    testWidgets('is absent entirely on an unsupported platform', (
      tester,
    ) async {
      final api = _FakeApiClient();
      await tester.pumpWidget(meScreen(api, _FakePush(supported: false)));
      await tester.pumpAndSettle();
      expect(find.text('NOTIFICATIONS'), findsNothing);
      expect(find.text('Push notifications'), findsNothing);
    });
  });

  group('schedule editor', () {
    Widget editor(_FakeApiClient api, {NotificationSchedule? schedule}) =>
        ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(api),
            pushServiceProvider.overrideWithValue(_FakePush()),
          ],
          child: MaterialApp(
            theme: buildAppTheme(),
            home: NotificationScheduleScreen(
              schedule: schedule,
              timezone: 'America/Los_Angeles',
            ),
          ),
        );

    testWidgets('creates a schedule from the defaults', (tester) async {
      final api = _FakeApiClient();
      await tester.pumpWidget(editor(api));
      await tester.pumpAndSettle();

      expect(find.text('Covers tomorrow.'), findsOneWidget);
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(api.created, isNotNull);
      expect(api.created!['sendAt'], '20:00');
      expect(api.created!['timezone'], 'America/Los_Angeles');
      expect(api.created!['weekdayMask'], 127);
      expect(api.created!['startOffsetDays'], 1);
      expect(
        api.created!['categories'],
        containsAll(<String>[
          'conflicts',
          'pending_decisions',
          'unclaimed_tasks',
        ]),
      );
    });

    testWidgets('round-trips an existing schedule, editing coverage', (
      tester,
    ) async {
      final api = _FakeApiClient();
      final schedule = NotificationSchedule.fromJson(
        scheduleJson(categories: const ['conflicts']),
      );
      await tester.pumpWidget(editor(api, schedule: schedule));
      await tester.pumpAndSettle();

      // The stored weekday mask (31) drives the chips.
      expect(find.text('Covers tomorrow.'), findsOneWidget);
      await tester.tap(find.text('Today'));
      await tester.pumpAndSettle();
      expect(find.text('Covers what is left of today.'), findsOneWidget);

      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(api.updated!['id'], 's1');
      expect(api.updated!['weekdayMask'], 31);
      expect(api.updated!['categories'], ['conflicts']);
    });

    testWidgets('refuses to save with no categories selected', (tester) async {
      final api = _FakeApiClient();
      final schedule = NotificationSchedule.fromJson(
        scheduleJson(categories: const ['conflicts']),
      );
      await tester.pumpWidget(editor(api, schedule: schedule));
      await tester.pumpAndSettle();

      // The row's switch, not its label — only the switch is tappable.
      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(api.updated, isNull);
      expect(
        find.text('Pick at least one thing to be told about.'),
        findsOneWidget,
      );
    });

    testWidgets('sends a test and reports what it found', (tester) async {
      final api = _FakeApiClient();
      final schedule = NotificationSchedule.fromJson(scheduleJson());
      await tester.pumpWidget(editor(api, schedule: schedule));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Send a test now'));
      await tester.pumpAndSettle();

      expect(api.tested, 's1');
      expect(find.text('2 outstanding. Sent to 1 device(s).'), findsOneWidget);
    });

    testWidgets('a new schedule has nothing to test or delete', (tester) async {
      await tester.pumpWidget(editor(_FakeApiClient()));
      await tester.pumpAndSettle();
      expect(find.text('Send a test now'), findsNothing);
      expect(find.text('Delete notification'), findsNothing);
    });
  });

  group('describeSchedule', () {
    /// The summary formats the send time through the viewer's own clock
    /// convention, so it needs a real BuildContext under a MaterialApp.
    Future<String> describe(
      WidgetTester tester,
      Map<String, dynamic> json,
    ) async {
      late String summary;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) {
              summary = describeSchedule(
                context,
                NotificationSchedule.fromJson(json),
              );
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      return summary;
    }

    testWidgets('summarises days, time, coverage and category count', (
      tester,
    ) async {
      expect(
        await describe(tester, scheduleJson()),
        'Weekdays · 8:00 PM · tomorrow · unclaimed tasks',
      );
      expect(
        await describe(
          tester,
          scheduleJson(
            weekdayMask: 127,
            sendAt: '07:30',
            startOffsetDays: 0,
            horizonDays: 2,
            categories: const ['conflicts', 'my_tasks'],
          ),
        ),
        'Every day · 7:30 AM · 2 days from today · 2 kinds',
      );
    });

    testWidgets('renders midnight and noon as 12, not 0', (tester) async {
      expect(
        await describe(tester, scheduleJson(sendAt: '00:15')),
        startsWith('Weekdays · 12:15 AM'),
      );
      expect(
        await describe(tester, scheduleJson(sendAt: '12:00')),
        startsWith('Weekdays · 12:00 PM'),
      );
    });
  });
}
