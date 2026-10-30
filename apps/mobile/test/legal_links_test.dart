import 'package:flutter_test/flutter_test.dart';
import 'package:caretaker_app/util/legal_links.dart';

void main() {
  test('legal pages live at the apex, not under the /api prefix', () {
    expect(
      legalUrl('privacy', base: 'https://igt.kylebjordahl.com/api'),
      'https://igt.kylebjordahl.com/legal/privacy',
    );
    expect(legalUrl('terms', base: '/api'), '/legal/terms');
    expect(
      legalUrl('terms', base: 'http://localhost:8787'),
      'http://localhost:8787/legal/terms',
    );
  });
}
