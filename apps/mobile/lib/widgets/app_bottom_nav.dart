import 'dart:ui' show ImageFilter;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../screens/family_screen.dart' show showAddMemberSheet;
import '../state/family.dart';
import '../state/nav.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';

/// The floating nav, mounted once above the inner content Navigator (see
/// `_AuthedRoot` in main.dart) instead of inside any pushed route's own
/// Scaffold. That keeps the pill itself stationary through every push/pop
/// transition between [AppShell] and its sub-screens (member detail, feed
/// setup, task rules, connect-account) — only that route's content slides,
/// the way a per-route `bottomNavigationBar` used to make the whole pill
/// slide along with it. Bottom sheets/dialogs still render above the pill
/// (rather than being hidden behind it) because they open with
/// `useRootNavigator: true`, landing on MaterialApp's outer Navigator, one
/// Stack layer above this whole screen-content-plus-nav unit.
class PersistentAppNav extends ConsumerWidget {
  const PersistentAppNav({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final index = ref.watch(navIndexProvider);
    final isAdmin = ref.watch(currentMemberProvider).valueOrNull?.isAdmin ?? false;
    return Positioned(
      left: 0,
      right: 0,
      bottom: MediaQuery.of(context).viewInsets.bottom,
      child: SafeArea(
        top: false,
        child: ValueListenableBuilder<int>(
          valueListenable: routeDepthNotifier,
          builder: (context, depth, _) => AppBottomNav(
            currentIndex: index,
            onAdd: depth == 0 && index == 2 && isAdmin
                ? () => showAddMemberSheet(rootNavigatorKey.currentContext!, ref)
                : null,
            onSelect: (i) {
              ref.read(navIndexProvider.notifier).state = i;
              if (depth > 0) {
                rootNavigatorKey.currentState!.popUntil((route) => route.isFirst);
              }
            },
          ),
        ),
      ),
    );
  }
}

/// The shared floating nav: a blurred pill with Home / Plan / Family / Me (active
/// tab pill-filled indigo). The circular "+" quick-add appears **only** when
/// [onAdd] is provided (the three Family list screens), not globally.
class AppBottomNav extends StatelessWidget {
  const AppBottomNav({
    super.key,
    required this.currentIndex,
    required this.onSelect,
    this.onAdd,
  });

  final int currentIndex;
  final ValueChanged<int> onSelect;
  final VoidCallback? onAdd;

  static const _items = <(IconData, String)>[
    (Icons.home_rounded, 'Home'),
    (Icons.calendar_today_rounded, 'Plan'),
    (Icons.people_alt_rounded, 'Family'),
    (Icons.person_rounded, 'Me'),
  ];

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        bottom: 14 + MediaQuery.of(context).padding.bottom * 0.4,
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Flexible(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(999),
              child: BackdropFilter(
                filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
                child: Container(
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: AppColors.navPill,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (var i = 0; i < _items.length; i++)
                        _NavTab(
                          icon: _items[i].$1,
                          label: _items[i].$2,
                          active: i == currentIndex,
                          onTap: () => onSelect(i),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (onAdd != null) ...[
            const SizedBox(width: 10),
            _AddButton(onTap: onAdd!),
          ],
        ],
      ),
    );
  }
}

class _NavTab extends StatelessWidget {
  const _NavTab({
    required this.icon,
    required this.label,
    required this.active,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: active ? AppColors.indigo : Colors.transparent,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(999),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: EdgeInsets.symmetric(horizontal: active ? 15 : 12, vertical: 11),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon,
                  size: 20,
                  color: active ? const Color(0xFF17162B) : AppColors.textTertiary),
              if (active) ...[
                const SizedBox(width: 7),
                Text(label,
                    style: font(kBodyFont, 13, 700, color: const Color(0xFF17162B))),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _AddButton extends StatelessWidget {
  const _AddButton({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.indigo,
      shape: const CircleBorder(),
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        child: DecoratedBox(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            boxShadow: [
              BoxShadow(
                color: AppColors.indigo.withValues(alpha: 0.4),
                blurRadius: 16,
                spreadRadius: 1,
              ),
            ],
          ),
          child: const SizedBox(
            width: 54,
            height: 54,
            child: Icon(Icons.add_rounded, color: Color(0xFF17162B), size: 26),
          ),
        ),
      ),
    );
  }
}
