import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../app_shell.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import 'caretaker_detail_screen.dart';
import 'child_detail_screen.dart';

/// People & roles — the members list off the Family hub. Caretakers and children
/// in their own sections; the nav "+" opens the add-member menu.
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
      extendBody: true,
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 130),
          children: [
            const SubPageHeader(title: 'People & roles'),
            const SizedBox(height: 22),
            if (caretakers.isNotEmpty) ...[
              SectionEyebrow('Caretakers',
                  color: AppColors.indigo,
                  trailing: Text('${caretakers.length}', style: AppText.secondary)),
              const SizedBox(height: 12),
              AppCard(child: Column(children: _rows(context, caretakers, isChild: false))),
              const SizedBox(height: 24),
            ],
            if (children.isNotEmpty) ...[
              SectionEyebrow('Children',
                  trailing: Text('${children.length}', style: AppText.secondary)),
              const SizedBox(height: 12),
              AppCard(child: Column(children: _rows(context, children, isChild: true))),
            ],
          ],
        ),
      ),
      bottomNavigationBar: familyListNav(
        context,
        ref,
        onAdd: isAdmin ? () => _openAddMenu(context, ref) : null,
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

  void _openAddMenu(BuildContext context, WidgetRef ref) {
    showModalBottomSheet<void>(
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

  Future<void> _createAndOpen(BuildContext context, WidgetRef ref,
      {required bool isChild}) async {
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
      Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => isChild ? ChildDetailScreen(memberId: id) : CaretakerDetailScreen(memberId: id),
      ));
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
          decoration: const InputDecoration(
            labelText: 'Name / relation',
            hintText: 'e.g. Adeline, Grandma',
          ),
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
