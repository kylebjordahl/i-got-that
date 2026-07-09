import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import 'member_detail_screen.dart';

/// Family — the hub (6l): Caretakers and Children render inline as two lists;
/// tapping a person opens their unified member-detail screen. The nav "+"
/// invites a new member. "Family settings" (input feeds / family rules) is
/// gone — feeds are linked per-person, and task rules live per-person too.
class FamilyScreen extends ConsumerWidget {
  const FamilyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final info = ref.watch(familyInfoProvider).valueOrNull;
    final caretakers = members.where((m) => m.isCaretaker).toList();
    final children = members.where((m) => m.requiresCaretaker).toList();

    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 14, 22, 130),
      children: [
        _header(context, ref, info, me?.isAdmin ?? false),
        const SizedBox(height: 24),
        if (caretakers.isNotEmpty) ...[
          SectionEyebrow('Caretakers',
              color: AppColors.indigo,
              trailing: Text('${caretakers.length}', style: AppText.secondary)),
          const SizedBox(height: 12),
          AppCard(child: Column(children: _rows(context, caretakers))),
          const SizedBox(height: 24),
        ],
        if (children.isNotEmpty) ...[
          SectionEyebrow('Children',
              trailing: Text('${children.length}', style: AppText.secondary)),
          const SizedBox(height: 12),
          AppCard(child: Column(children: _rows(context, children))),
        ],
        if (members.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 40),
            child: Center(child: Text('No members yet — tap + to add one', style: AppText.subtitle)),
          ),
      ],
    );
  }

  List<Widget> _rows(BuildContext context, List<Member> people) {
    final rows = <Widget>[];
    for (var i = 0; i < people.length; i++) {
      rows.add(_PersonRow(
        member: people[i],
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => MemberDetailScreen(memberId: people[i].id)),
        ),
      ));
      if (i < people.length - 1) rows.add(const Divider(height: 18));
    }
    return rows;
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

/// The add-member sheet (raised by the Family tab's nav "+"): choose caretaker
/// or child, name them, and open their detail screen to finish setup.
Future<void> showAddMemberSheet(BuildContext context, WidgetRef ref) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheetCtx) => Padding(
      padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Add a person', style: AppText.subPageTitle),
          const SizedBox(height: 12),
          SettingRow(
            icon: Icons.person_add_alt_1_rounded,
            iconColor: AppColors.indigo,
            title: 'Add a caretaker',
            subtitle: 'Someone who can claim tasks',
            onTap: () {
              Navigator.of(sheetCtx).pop();
              _createAndOpen(context, ref, isChild: false);
            },
          ),
          const Divider(height: 22),
          SettingRow(
            icon: Icons.child_care_rounded,
            iconColor: AppColors.green,
            title: 'Add a child',
            subtitle: 'A child whose events need a caretaker',
            onTap: () {
              Navigator.of(sheetCtx).pop();
              _createAndOpen(context, ref, isChild: true);
            },
          ),
        ],
      ),
    ),
  );
}

Future<void> _createAndOpen(BuildContext context, WidgetRef ref, {required bool isChild}) async {
  final name = await _promptName(context, isChild ? 'Add a child' : 'Add a caretaker');
  if (name == null || name.trim().isEmpty) return;
  try {
    final familyId = await ref.read(familyProvider.future);
    final res = await ref.read(apiClientProvider).createMember(
          familyId,
          relationName: name.trim(),
          isCaretaker: !isChild,
          requiresCaretaker: isChild,
        );
    ref.invalidate(membersProvider);
    final id = (res['member'] as Map<String, dynamic>)['id'] as String;
    if (!context.mounted) return;
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => MemberDetailScreen(memberId: id)),
    );
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
    }
  }
}

Future<String?> _promptName(BuildContext context, String title) {
  final controller = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (_) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: controller,
        autofocus: true,
        decoration: const InputDecoration(labelText: 'Name / relation'),
        onSubmitted: (v) => Navigator.of(context).pop(v),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        PillButton(
          label: 'Continue',
          variant: PillVariant.amber,
          onPressed: () => Navigator.of(context).pop(controller.text),
        ),
      ],
    ),
  );
}

class _PersonRow extends StatelessWidget {
  const _PersonRow({required this.member, required this.onTap});
  final Member member;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final subtitle = member.requiresCaretaker
        ? 'Child'
        : '${member.isAdmin ? 'Admin' : 'Caretaker'} · can claim tasks';
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
                  Text(subtitle, style: AppText.subtitle),
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
