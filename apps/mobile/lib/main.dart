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
    final auth = ref.watch(authControllerProvider);
    return MaterialApp(
      title: 'I Got That',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      themeMode: ThemeMode.dark,
      // While restoring (the one round trip to check the web session cookie —
      // see state/auth.dart), hold on a blank scaffold instead of flashing the
      // login screen for an already-authed user.
      home: auth.restoring
          ? const Scaffold()
          : auth.isAuthed
              ? const AppShell()
              : const LoginScreen(),
    );
  }
}
