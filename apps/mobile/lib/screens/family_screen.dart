import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import 'accounts_screen.dart';
import 'feeds_screen.dart';
import 'people_screen.dart';
import 'rules_screen.dart';

/// Family — the settings-first hub. People & roles, input feeds, family rules,
/// and connected accounts. (Delivery methods moved to each caretaker's detail.)
class FamilyScreen extends ConsumerWidget {
  const FamilyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final info = ref.watch(familyInfoProvider).valueOrNull;
    final caretakers = members.where((m) => m.isCaretaker).length;
    final children = members.where((m) => m.requiresCaretaker).length;

    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 14, 22, 130),
      children: [
        _header(context, ref, info, me?.isAdmin ?? false),
        const SizedBox(height: 22),
        AppCard(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => const PeopleScreen()),
          ),
          child: Row(
            children: [
              AvatarCluster(
                avatars: [
                  for (final m in members.take(3))
                    (initialFor(m.relationName), personColor(m)),
                ],
                overflow: members.length > 3 ? members.length - 3 : null,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('People & roles', style: AppText.sectionItemTitle),
                    const SizedBox(height: 2),
                    Text('$caretakers caretaker${caretakers == 1 ? '' : 's'} · '
                        '$children child${children == 1 ? '' : 'ren'}',
                        style: AppText.subtitle),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
            ],
          ),
        ),
        const SizedBox(height: 26),
        const SectionEyebrow('Family settings'),
        const SizedBox(height: 12),
        AppCard(
          child: Column(
            children: [
              SettingRow(
                icon: Icons.rss_feed_rounded,
                iconColor: AppColors.feedBlue,
                title: 'Input feeds',
                subtitle: 'Calendars that generate tasks',
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const FeedsScreen()),
                ),
              ),
              const Divider(height: 22),
              SettingRow(
                icon: Icons.rule_rounded,
                iconColor: AppColors.purple,
                title: 'Family rules',
                subtitle: 'How events become tasks',
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const RulesScreen()),
                ),
              ),
              const Divider(height: 22),
              SettingRow(
                icon: Icons.link_rounded,
                iconColor: AppColors.blue,
                title: 'Connected accounts',
                subtitle: 'Google / iCloud / CalDAV',
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const AccountsScreen()),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Text(
            'Delivery calendars live on each caretaker now — set them in their '
            'detail. Feed→child links live on the child.',
            style: AppText.caveat,
          ),
        ),
      ],
    );
  }

  Widget _header(BuildContext context, WidgetRef ref, ({String name, int count})? info, bool isAdmin) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(child: Text(info?.name ?? 'Family', style: AppText.screenTitleAlt)),
                  if ((info?.count ?? 1) > 1) ...[
                    const SizedBox(width: 8),
                    _SwitcherButton(onTap: () => _openSwitcher(context, ref)),
                  ],
                ],
              ),
              const SizedBox(height: 3),
              Text.rich(TextSpan(
                style: AppText.subtitle,
                children: [
                  TextSpan(text: isAdmin ? "You're admin · " : 'Member · '),
                  TextSpan(
                    text: '${info?.count ?? 1} famil${(info?.count ?? 1) == 1 ? 'y' : 'ies'}',
                    style: font(kBodyFont, 13, 600, color: AppColors.indigo),
                  ),
                ],
              )),
            ],
          ),
        ),
      ],
    );
  }

  void _openSwitcher(BuildContext context, WidgetRef ref) async {
    final families = ref.read(familiesListProvider).valueOrNull ?? const [];
    final current = ref.read(familyProvider).valueOrNull;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => Padding(
        padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Switch family', style: AppText.subPageTitle),
            const SizedBox(height: 12),
            for (final f in families)
              SettingRow(
                icon: Icons.home_rounded,
                iconColor: f.id == current ? AppColors.indigo : AppColors.textMuted,
                title: f.name,
                trailing: f.id == current
                    ? const Icon(Icons.check_rounded, color: AppColors.indigo)
                    : null,
                onTap: () {
                  ref.read(selectedFamilyIdProvider.notifier).state = f.id;
                  Navigator.of(context).pop();
                },
              ),
          ],
        ),
      ),
    );
  }
}

class _SwitcherButton extends StatelessWidget {
  const _SwitcherButton({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.card,
      shape: const CircleBorder(),
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        child: Container(
          width: 30,
          height: 30,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: AppColors.border),
          ),
          child: const Icon(Icons.expand_more_rounded, size: 20, color: AppColors.textSecondary),
        ),
      ),
    );
  }
}
