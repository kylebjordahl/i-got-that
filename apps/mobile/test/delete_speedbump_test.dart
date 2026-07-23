import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/models.dart';
import 'package:caretaker_app/screens/family_screen.dart';
import 'package:caretaker_app/screens/me_screen.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:caretaker_app/state/family.dart';
import 'package:caretaker_app/widgets/slide_to_confirm.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records the delete calls so the tests can assert the slide gesture (not a
/// plain tap) is what actually triggers the destructive request.
class _FakeApiClient extends ApiClient {
  _FakeApiClient() : super(baseUrl: 'http://test');
  bool deletedAccount = false;
  String? deletedFamilyId;
  String? leftFamilyId;

  /// Controls the up-front eligibility check the delete-account sheet does
  /// before showing its slide control.
  bool accountIsDeletable = true;

  @override
  Future<Map<String, dynamic>> me() async => {
        'user': {'email': 'you@example.com'},
      };

  @override
  Future<void> deleteMyAccount() async {
    deletedAccount = true;
  }

  @override
  Future<bool> accountDeletable() async => accountIsDeletable;

  @override
  Future<void> deleteFamily(String familyId) async {
    deletedFamilyId = familyId;
  }

  @override
  Future<void> leaveFamily(String familyId) async {
    leftFamilyId = familyId;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async => null);
  });

  tearDown(() {
    const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  /// Drags the confirm thumb from the start of its track to the end. A single
  /// oversized offset guarantees it clamps past the confirm threshold
  /// regardless of the test surface's width.
  ///
  /// Uses bounded `pump()`s rather than `pumpAndSettle()`: the widget shows an
  /// indeterminate spinner for the brief in-flight moment, and `pumpAndSettle`
  /// never terminates while any indeterminate animation has ever ticked.
  Future<void> slideToConfirm(WidgetTester tester) async {
    await tester.drag(find.byType(SlideToConfirm), const Offset(2000, 0));
    await tester.pump();
    // The success path flashes the checkmark for 500ms before auto-closing
    // the sheet; pump past that with bounded pumps rather than
    // pumpAndSettle (see above) while the indeterminate spinner could still
    // be in the tree. Once past it, the sheet's own close transition is a
    // bounded animation, so pumpAndSettle is safe to finish it off.
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
  }

  testWidgets(
      'deleting the account requires the full slide gesture, not just opening the sheet',
      (tester) async {
    final api = _FakeApiClient();
    final me = Member(
      id: 'me',
      relationName: 'Me',
      isCaretaker: true,
      isAdmin: false,
      requiresCaretaker: false,
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          currentMemberProvider.overrideWith((ref) async => me),
          familyInfoProvider.overrideWith((ref) async => (name: 'Test Family', count: 1)),
          accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
          loginIdentitiesProvider.overrideWith((ref) async => const <LoginIdentity>[]),
        ],
        child: const MaterialApp(home: Scaffold(body: MeScreen())),
      ),
    );
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('Delete account'), 300);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete account'));
    await tester.pumpAndSettle();

    expect(find.byType(SlideToConfirm), findsOneWidget);
    // Opening the confirmation sheet alone must not have deleted anything.
    expect(api.deletedAccount, isFalse);

    // A plain tap on the thumb (no slide) doesn't confirm either.
    await tester.tap(find.byType(SlideToConfirm));
    await tester.pumpAndSettle();
    expect(api.deletedAccount, isFalse);

    await slideToConfirm(tester);

    expect(api.deletedAccount, isTrue);
    // The sheet must close itself on success — nothing else pops it, and
    // leaving it stuck open is exactly the "dialog over a blank screen" bug
    // class this codebase already guards against elsewhere.
    expect(find.byType(SlideToConfirm), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'shows the blocking message up front instead of the slide when the account cannot be deleted yet',
      (tester) async {
    final api = _FakeApiClient()..accountIsDeletable = false;
    final me = Member(
      id: 'me',
      relationName: 'Me',
      isCaretaker: true,
      isAdmin: true,
      requiresCaretaker: false,
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          currentMemberProvider.overrideWith((ref) async => me),
          familyInfoProvider.overrideWith((ref) async => (name: 'Test Family', count: 1)),
          accountsProvider.overrideWith((ref) async => const <ExternalAccount>[]),
          loginIdentitiesProvider.overrideWith((ref) async => const <LoginIdentity>[]),
        ],
        child: const MaterialApp(home: Scaffold(body: MeScreen())),
      ),
    );
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('Delete account'), 300);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete account'));
    await tester.pumpAndSettle();

    // No slide control at all — the block is shown, not a failure toast.
    expect(find.byType(SlideToConfirm), findsNothing);
    expect(
      find.text('Before you can delete your account, you must either leave '
          'or delete all the families you are involved in.'),
      findsOneWidget,
    );

    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    expect(api.deletedAccount, isFalse);
  });

  final admin = Member(
    id: 'dad',
    relationName: 'Dad',
    isCaretaker: true,
    isAdmin: true,
    requiresCaretaker: false,
  );
  final nonAdmin = Member(
    id: 'mom',
    relationName: 'Mom',
    isCaretaker: true,
    isAdmin: false,
    requiresCaretaker: false,
  );

  Widget familyApp(_FakeApiClient api, Member currentMember) => ProviderScope(
        overrides: [
          apiClientProvider.overrideWithValue(api),
          familyProvider.overrideWith((ref) async => 'fam-1'),
          familyInfoProvider.overrideWith((ref) async => (name: 'Test Family', count: 1)),
          currentMemberProvider.overrideWith((ref) async => currentMember),
          membersProvider.overrideWith((ref) async => [admin, nonAdmin]),
        ],
        child: const MaterialApp(home: Scaffold(body: FamilyScreen())),
      );

  testWidgets('a non-admin does not see the delete-family link', (tester) async {
    await tester.pumpWidget(familyApp(_FakeApiClient(), nonAdmin));
    await tester.pumpAndSettle();

    expect(find.text('Test Family'), findsOneWidget);
    expect(find.text('Delete family'), findsNothing);
  });

  testWidgets('an admin can delete the family via the slide gesture', (tester) async {
    final api = _FakeApiClient();
    await tester.pumpWidget(familyApp(api, admin));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('Delete family'), 300);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Delete family'));
    await tester.pumpAndSettle();

    expect(find.byType(SlideToConfirm), findsOneWidget);
    expect(api.deletedFamilyId, isNull);

    await slideToConfirm(tester);

    expect(api.deletedFamilyId, 'fam-1');
    expect(find.byType(SlideToConfirm), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a non-admin can leave the family via the slide gesture', (tester) async {
    final api = _FakeApiClient();
    await tester.pumpWidget(familyApp(api, nonAdmin));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('Leave family'), 300);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Leave family'));
    await tester.pumpAndSettle();

    expect(find.byType(SlideToConfirm), findsOneWidget);
    expect(api.leftFamilyId, isNull);

    await slideToConfirm(tester);

    expect(api.leftFamilyId, 'fam-1');
    expect(find.byType(SlideToConfirm), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'the sole admin sees the blocking message instead of the slide when leaving',
      (tester) async {
    final api = _FakeApiClient();
    // `admin` is the only admin among [admin, nonAdmin] — leaving would
    // orphan the family.
    await tester.pumpWidget(familyApp(api, admin));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.text('Leave family'), 300);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Leave family'));
    await tester.pumpAndSettle();

    expect(find.byType(SlideToConfirm), findsNothing);
    expect(find.text("You're the only admin here — promote a co-admin "
        'first, or delete the family instead.'), findsOneWidget);

    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    expect(api.leftFamilyId, isNull);
  });
}
