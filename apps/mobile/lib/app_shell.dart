import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'screens/family_screen.dart';
import 'screens/home_screen.dart';
import 'screens/me_screen.dart';
import 'screens/plan_screen.dart';
import 'state/nav.dart';
import 'widgets/app_bottom_nav.dart';

/// The persistent app shell: Home / Plan / Family / Me behind a floating nav pill.
/// The "+" is not global — it lives only on the Family list screens.
class AppShell extends ConsumerWidget {
  const AppShell({super.key});

  static const _pages = [HomeScreen(), PlanScreen(), FamilyScreen(), MeScreen()];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final index = ref.watch(navIndexProvider);
    return Scaffold(
      extendBody: true,
      body: SafeArea(
        bottom: false,
        child: IndexedStack(index: index, children: _pages),
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        child: AppBottomNav(
          currentIndex: index,
          onSelect: (i) => ref.read(navIndexProvider.notifier).state = i,
        ),
      ),
    );
  }
}

/// The bottom nav for a pushed Family list screen (People / Feeds / Rules): the
/// Family tab reads active, switching tabs pops back to the shell, and [onAdd]
/// renders the collection "+".
Widget familyListNav(BuildContext context, WidgetRef ref, {VoidCallback? onAdd}) {
  return SafeArea(
    top: false,
    child: AppBottomNav(
      currentIndex: 2,
      onAdd: onAdd,
      onSelect: (i) {
        ref.read(navIndexProvider.notifier).state = i;
        Navigator.of(context).popUntil((r) => r.isFirst);
      },
    ),
  );
}
