import 'package:caretaker_app/api/client.dart';
import 'package:caretaker_app/state/auth.dart';
import 'package:dio/dio.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Records which magic-link endpoint the controller chose.
class _FakeApiClient extends ApiClient {
  _FakeApiClient({this.linkFails = false}) : super(baseUrl: 'http://test');
  final bool linkFails;
  final verified = <String>[];
  final linked = <String>[];

  @override
  Future<Map<String, dynamic>> me() async => {
    'user': {'id': 'u1'},
  };

  @override
  Future<Map<String, dynamic>> verifyMagicLink(String token) async {
    verified.add(token);
    return {
      'sessionToken': 'session-$token',
      'user': {'id': 'u1'},
    };
  }

  @override
  Future<void> linkMagicLink(String token) async {
    if (linkFails) {
      final req = RequestOptions(path: '/auth/link/magic-link');
      throw DioException(
        requestOptions: req,
        response: Response(
          requestOptions: req,
          statusCode: 401,
          data: {'error': 'invalid_token'},
        ),
      );
    }
    linked.add(token);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('plugins.it_nomads.com/flutter_secure_storage');

  /// Keychain stub: [stored] is the session a previous launch persisted.
  void keychain(String? stored) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (call) async => call.method == 'read' ? stored : null,
        );
  }

  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null),
  );

  group('magicTokenFromUri', () {
    test('reads a sign-in link and an add-a-login-method link', () {
      expect(magicTokenFromUri(Uri.parse('https://igt.test/app/#magic=abc')), (
        token: 'abc',
        linkOnly: false,
      ));
      expect(
        magicTokenFromUri(Uri.parse('https://igt.test/app/#link-email=abc')),
        (token: 'abc', linkOnly: true),
      );
    });

    test('ignores other links', () {
      expect(magicTokenFromUri(Uri.parse('https://igt.test/app/')), isNull);
      expect(
        magicTokenFromUri(Uri.parse('https://igt.test/app/?invite=x')),
        isNull,
      );
      expect(
        magicTokenFromUri(Uri.parse('https://igt.test/app/#magic=')),
        isNull,
      );
    });
  });

  group('completeMagicLink', () {
    test('signs in when signed out', () async {
      keychain(null);
      final api = _FakeApiClient();
      final auth = AuthController(api);
      await auth.completeMagicLink('t1');
      expect(api.verified, ['t1']);
      expect(auth.state.sessionToken, 'session-t1');
    });

    test('adds the address to the account when already signed in', () async {
      keychain('existing');
      final api = _FakeApiClient();
      final auth = AuthController(api);
      await auth.completeMagicLink('t1');
      expect(api.verified, isEmpty);
      expect(api.linked, ['t1']);
      expect(auth.state.sessionToken, 'existing');
      expect(auth.state.notice, contains('Email added'));
    });

    test("an add-a-login-method link signed out asks to sign in, and doesn't "
        'spend the token', () async {
      keychain(null);
      final api = _FakeApiClient();
      final auth = AuthController(api);
      await auth.completeMagicLink('t1', linkOnly: true);
      expect(api.verified, isEmpty);
      expect(api.linked, isEmpty);
      expect(auth.state.isAuthed, isFalse);
      expect(auth.state.error, contains('Sign in first'));
    });

    test('a spent or expired link says so and keeps the session', () async {
      keychain('existing');
      final api = _FakeApiClient(linkFails: true);
      final auth = AuthController(api);
      await auth.completeMagicLink('t1');
      expect(auth.state.sessionToken, 'existing');
      expect(auth.state.error, contains('expired or was already used'));
    });
  });
}
