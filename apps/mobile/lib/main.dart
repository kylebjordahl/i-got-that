import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'app_shell.dart';
import 'screens/login_screen.dart';
import 'state/auth.dart';
import 'theme/app_theme.dart';

void main() {
  runApp(const ProviderScope(child: CaretakerApp()));
}

class CaretakerApp extends ConsumerWidget {
  const CaretakerApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authed = ref.watch(authControllerProvider).isAuthed;
    return MaterialApp(
      title: 'I Got That',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      themeMode: ThemeMode.dark,
      home: authed ? const AppShell() : const LoginScreen(),
    );
  }
}
