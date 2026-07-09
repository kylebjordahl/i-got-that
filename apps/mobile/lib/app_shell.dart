import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'screens/family_screen.dart';
import 'screens/home_screen.dart';
import 'screens/me_screen.dart';
import 'screens/plan_screen.dart';
import 'state/family.dart';
import 'state/nav.dart';
import 'widgets/app_bottom_nav.dart';

/// The persistent app shell: Home / Plan / Family / Me behind a floating nav
/// pill. The "+" appears only on the Family tab (6l) — it invites a new member.
class AppShell extends ConsumerWidget {
  const AppShell({super.key});

  static const _pages = [HomeScreen(), PlanScreen(), FamilyScreen(), MeScreen()];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final index = ref.watch(navIndexProvider);
    final isAdmin = ref.watch(currentMemberProvider).valueOrNull?.isAdmin ?? false;
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
          onAdd: index == 2 && isAdmin ? () => showAddMemberSheet(context, ref) : null,
          onSelect: (i) => ref.read(navIndexProvider.notifier).state = i,
        ),
      ),
    );
  }
}
