import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import 'caretaker_detail_screen.dart';
import 'child_detail_screen.dart';
import 'dialogs.dart';

/// People & roles — the members sub-view. Caretakers and children, each tapping
/// into their detail screen.
class PeopleScreen extends ConsumerWidget {
  const PeopleScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final isAdmin = me?.isAdmin ?? false;
    final caretakers = members.where((m) => m.isCaretaker).toList();
    final children = members.where((m) => m.requiresCaretaker).toList();

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 40),
          children: [
            Row(
              children: [
                RoundIconButton(
                  icon: Icons.chevron_left_rounded,
                  onTap: () => Navigator.of(context).maybePop(),
                ),
                const SizedBox(width: 14),
                Text('People & roles', style: AppText.subPageTitle),
                const Spacer(),
                RoundIconButton(
                  icon: Icons.vpn_key_outlined,
                  onTap: () => showRedeemInviteDialog(context, ref),
                ),
                if (isAdmin) ...[
                  const SizedBox(width: 8),
                  RoundIconButton(
                    icon: Icons.person_add_alt_1_rounded,
                    onTap: () => showAddMemberDialog(context, ref),
                  ),
                ],
              ],
            ),
            const SizedBox(height: 24),
            if (caretakers.isNotEmpty) ...[
              const SectionEyebrow('Caretakers'),
              const SizedBox(height: 12),
              AppCard(child: Column(children: _rows(context, caretakers, isChild: false))),
              const SizedBox(height: 24),
            ],
            if (children.isNotEmpty) ...[
              const SectionEyebrow('Children'),
              const SizedBox(height: 12),
              AppCard(child: Column(children: _rows(context, children, isChild: true))),
            ],
          ],
        ),
      ),
    );
  }

  List<Widget> _rows(BuildContext context, List<Member> people, {required bool isChild}) {
    final rows = <Widget>[];
    for (var i = 0; i < people.length; i++) {
      final m = people[i];
      rows.add(_PersonRow(
        member: m,
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => isChild
                ? ChildDetailScreen(memberId: m.id)
                : CaretakerDetailScreen(memberId: m.id),
          ),
        ),
      ));
      if (i < people.length - 1) rows.add(const Divider(height: 18));
    }
    return rows;
  }
}

class _PersonRow extends StatelessWidget {
  const _PersonRow({required this.member, required this.onTap});
  final Member member;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final roles = <String>[
      if (member.isAdmin) 'Admin',
      if (member.isCaretaker) 'Caretaker',
      if (member.requiresCaretaker) 'Child',
    ];
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            PersonAvatar(initial: initialFor(member.relationName), color: personColor(member), size: 40),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(member.relationName, style: AppText.sectionItemTitle),
                  const SizedBox(height: 2),
                  Text(roles.isEmpty ? 'Member' : roles.join(' · '), style: AppText.subtitle),
                ],
              ),
            ),
            if (member.hasLogin)
              const Padding(
                padding: EdgeInsets.only(right: 6),
                child: Icon(Icons.link_rounded, size: 16, color: AppColors.textMuted),
              ),
            const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
          ],
        ),
      ),
    );
  }
}
