import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'screens/dashboard_screen.dart';
import 'screens/login_screen.dart';
import 'state/auth.dart';

/// Phase 5 client (iOS + web). Authored without a local Flutter SDK — not yet
/// compiled/analyzed; run `flutter pub get && flutter analyze` after installing
/// the SDK (see README).
void main() {
  runApp(const ProviderScope(child: CaretakerApp()));
}

class CaretakerApp extends ConsumerWidget {
  const CaretakerApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authed = ref.watch(authControllerProvider).isAuthed;
    return MaterialApp(
      title: 'Caretaker',
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF3A7D5D),
        useMaterial3: true,
      ),
      home: authed ? const DashboardScreen() : const LoginScreen(),
    );
  }
}
