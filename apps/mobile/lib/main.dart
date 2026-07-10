import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'app_shell.dart';
import 'screens/login_screen.dart';
import 'state/auth.dart';
import 'state/nav.dart';
import 'theme/app_theme.dart';
import 'widgets/app_bottom_nav.dart';

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
              ? const _AuthedRoot()
              : const LoginScreen(),
    );
  }
}

/// Everything shown once signed in. [AppShell] and the screens pushed on top
/// of it (member detail, feed setup, task rules, connect-account) live in
/// their own nested Navigator here, with the floating nav stacked above it —
/// so page transitions between them never carry the nav along (see
/// PersistentAppNav). Bottom sheets/dialogs use `useRootNavigator: true` to
/// reach *past* this whole layer onto MaterialApp's own outer Navigator, so
/// they still render on top of the nav instead of being hidden behind it.
class _AuthedRoot extends StatelessWidget {
  const _AuthedRoot();

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Navigator(
          key: rootNavigatorKey,
          observers: [AppNavObserver()],
          onGenerateRoute: (settings) =>
              MaterialPageRoute(builder: (_) => const AppShell(), settings: settings),
        ),
        const PersistentAppNav(),
      ],
    );
  }
}
