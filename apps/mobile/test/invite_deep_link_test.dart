import 'package:caretaker_app/onboarding/onboarding_entry.dart';
import 'package:flutter_test/flutter_test.dart';

/// The invite deep-link parser is the single point where both the web launch
/// URL and native Universal Links are turned into a token — keep it lockstep.
void main() {
  group('inviteTokenFromUri', () {
    test('reads the token from the query form', () {
      final uri = Uri.parse('https://staging.igt.example/app/?invite=abc123');
      expect(inviteTokenFromUri(uri), 'abc123');
    });

    test('reads the token from a bare fragment', () {
      final uri = Uri.parse('https://staging.igt.example/app/#invite=xyz789');
      expect(inviteTokenFromUri(uri), 'xyz789');
    });

    test('reads the token from a fragment with a path + query', () {
      final uri = Uri.parse('https://staging.igt.example/app/#/join?invite=frag42');
      expect(inviteTokenFromUri(uri), 'frag42');
    });

    test('returns null for an unrelated URL', () {
      final uri = Uri.parse('https://staging.igt.example/app/?foo=bar');
      expect(inviteTokenFromUri(uri), isNull);
    });

    test('returns null for an empty invite param', () {
      final uri = Uri.parse('https://staging.igt.example/app/?invite=');
      expect(inviteTokenFromUri(uri), isNull);
    });
  });
}
