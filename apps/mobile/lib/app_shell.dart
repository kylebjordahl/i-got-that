import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'screens/family_screen.dart';
import 'screens/home_screen.dart';
import 'screens/me_screen.dart';
import 'screens/plan_screen.dart';
import 'state/nav.dart';

/// The persistent root shell: Home / Plan / Family / Me tabs behind the
/// floating nav pill. The pill itself lives one level up, in
/// [PersistentAppNav] — see that widget for why it isn't rendered here.
class AppShell extends ConsumerStatefulWidget {
  const AppShell({super.key});

  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell> {
  static const _pages = [HomeScreen(), PlanScreen(), FamilyScreen(), MeScreen()];

  @override
  void initState() {
    super.initState();
    // Defensive reset: guards against the depth counter drifting across a
    // logout/login cycle, which swaps `home` rather than pushing/popping.
    routeDepthNotifier.value = 0;
  }

  @override
  Widget build(BuildContext context) {
    final index = ref.watch(navIndexProvider);
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: IndexedStack(index: index, children: _pages),
      ),
    );
  }
}
