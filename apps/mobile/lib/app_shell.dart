import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'screens/family_screen.dart';
import 'screens/home_screen.dart';
import 'screens/plan_screen.dart';
import 'screens/quick_add.dart';
import 'widgets/app_bottom_nav.dart';

/// The persistent app shell: Home / Plan / Family behind a floating nav pill with
/// a "+" quick-add action.
class AppShell extends ConsumerStatefulWidget {
  const AppShell({super.key});

  @override
  ConsumerState<AppShell> createState() => _AppShellState();
}

class _AppShellState extends ConsumerState<AppShell> {
  int _index = 0;

  static const _pages = [HomeScreen(), PlanScreen(), FamilyScreen()];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      extendBody: true,
      body: SafeArea(
        bottom: false,
        child: IndexedStack(index: _index, children: _pages),
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        child: AppBottomNav(
          currentIndex: _index,
          onSelect: (i) => setState(() => _index = i),
          onAdd: () => showQuickAddSheet(context, ref),
        ),
      ),
    );
  }
}
