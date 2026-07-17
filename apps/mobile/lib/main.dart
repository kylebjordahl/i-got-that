import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'app_shell.dart';
import 'onboarding/join/join_flow.dart';
import 'onboarding/onboarding_entry.dart';
import 'onboarding/steps/welcome_step.dart';
import 'state/auth.dart';
import 'state/nav.dart';
import 'theme/app_theme.dart';
import 'widgets/app_bottom_nav.dart';
import 'widgets/env_ribbon.dart';

void main() {
  runApp(const ProviderScope(child: CaretakerApp()));
}

class CaretakerApp extends ConsumerStatefulWidget {
  const CaretakerApp({super.key});

  @override
  ConsumerState<CaretakerApp> createState() => _CaretakerAppState();
}

class _CaretakerAppState extends ConsumerState<CaretakerApp> {
  StreamSubscription<Uri>? _linkSub;

  @override
  void initState() {
    super.initState();
    // Native invite links (iOS Universal Links) arrive asynchronously — the web
    // launch URL is already read synchronously by activeInviteTokenProvider.
    if (!kIsWeb) _initDeepLinks();
  }

  Future<void> _initDeepLinks() async {
    final appLinks = AppLinks();
    // Cold start: the link that launched the app.
    try {
      final initial = await appLinks.getInitialLink();
      if (initial != null) _onLink(initial);
    } catch (_) {
      // No launch link (normal start) — nothing to route.
    }
    // Warm: links delivered while the app is already running.
    _linkSub = appLinks.uriLinkStream.listen(_onLink, onError: (_) {});
  }

  /// Route an incoming deep link into the join flow by seeding the invite token
  /// provider (main.dart's build watches it). Non-invite links are ignored.
  void _onLink(Uri uri) {
    final token = inviteTokenFromUri(uri);
    if (token != null && mounted) {
      ref.read(activeInviteTokenProvider.notifier).state = token;
    }
  }

  @override
  void dispose() {
    _linkSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);
    // On sign-out, forget any latched onboarding decision so the next session
    // re-determines whether the first-run wizard is needed.
    ref.listen(authControllerProvider, (prev, next) {
      if (!next.isAuthed) {
        ref.read(onboardingActiveProvider.notifier).state = null;
      }
    });
    final inviteToken = ref.watch(activeInviteTokenProvider);
    return MaterialApp(
      title: 'I Got That',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      themeMode: ThemeMode.dark,
      // Staging-only corner ribbon, above every route/sheet/dialog.
      builder: (context, child) => EnvRibbon(child: child ?? const SizedBox()),
      // While restoring (the one round trip to check the web session cookie —
      // see state/auth.dart), hold on a blank scaffold instead of flashing the
      // welcome screen for an already-authed user.
      home: auth.restoring
          ? const Scaffold()
          // An invite link (web URL or iOS Universal Link) drives the
          // second-parent join flow, whether or not the recipient is already
          // signed in — it owns the screen until it finishes and clears the token.
          : inviteToken != null
              ? JoinFlow(token: inviteToken)
              : auth.isAuthed
                  // First-run wizard vs. the app, latched once (see OnboardingGate).
                  ? OnboardingGate(appBuilder: (_) => const _AuthedRoot())
                  : const WelcomeStep(),
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
