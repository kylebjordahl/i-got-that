import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../state/nav.dart';
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
    final name = info?.name ?? 'Family';
    final multipleFamilies = (info?.count ?? 1) > 1;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              multipleFamilies
                  ? _FamilySelect(name: name, onTap: () => _openSwitcher(context, ref))
                  : Text(name, style: AppText.screenTitleAlt),
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
      useRootNavigator: true,
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
    useRootNavigator: true,
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
    // Wait for the refetch to land (not a fire-and-forget invalidate) so the
    // detail screen finds the new member on its very first build.
    ref.invalidate(membersProvider);
    await ref.read(membersProvider.future);
    final id = (res['member'] as Map<String, dynamic>)['id'] as String;
    // Push via the key rather than `Navigator.of(context)` so this doesn't
    // depend on `context` still happening to be the inner Navigator's own
    // element (see the note on `_promptName` above for why that's fragile).
    rootNavigatorKey.currentState!.push(
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
    // `dialogContext`, not the outer `context`: `context` here is
    // `rootNavigatorKey.currentContext` (the inner content Navigator's own
    // element), and `Navigator.of` special-cases that to resolve to the
    // Navigator itself rather than an ancestor. Popping through it removes
    // AppShell — the inner Navigator's only route — leaving it empty, while
    // this dialog (opened on the outer Navigator, showDialog's default)
    // never actually closes.
    builder: (dialogContext) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: controller,
        autofocus: true,
        decoration: const InputDecoration(labelText: 'Name / relation'),
        onSubmitted: (v) => Navigator.of(dialogContext).pop(v),
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(), child: const Text('Cancel')),
        PillButton(
          label: 'Continue',
          variant: PillVariant.amber,
          onPressed: () => Navigator.of(dialogContext).pop(controller.text),
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

/// The Family-screen title, styled as an explicit select control (name +
/// unfold-chevron, both tappable) — shown in place of a plain title once the
/// account belongs to more than one family.
class _FamilySelect extends StatelessWidget {
  const _FamilySelect({required this.name, required this.onTap});
  final String name;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: Text(name,
                    style: AppText.screenTitleAlt,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis),
              ),
              const SizedBox(width: 6),
              const Icon(Icons.unfold_more_rounded, size: 22, color: AppColors.textMuted),
            ],
          ),
        ),
      ),
    );
  }
}
