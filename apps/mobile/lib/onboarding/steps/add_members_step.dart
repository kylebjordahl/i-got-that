import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../models.dart';
import '../../state/family.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../../theme/person_colors.dart';
import '../../widgets/primitives.dart';
import '../add_member_sheet.dart';
import '../onboarding_scaffold.dart';

/// 1d — add family members. Any number of children and caretakers up front (not
/// limited to 1+1), establishing the structure the per-child steps iterate over.
class AddMembersStep extends ConsumerWidget {
  const AddMembersStep({
    super.key,
    required this.onNext,
    required this.onBack,
    required this.onExit,
  });

  final VoidCallback onNext;
  final VoidCallback onBack;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final selfId = ref.watch(currentMemberProvider).valueOrNull?.id;
    final caretakers = members.where((m) => m.isCaretaker).toList();
    final children = members.where((m) => m.requiresCaretaker).toList();

    return OnboardingScaffold(
      progress: 0.50,
      onBack: onBack,
      trailingLabel: 'Finish later',
      onTrailing: onExit,
      title: 'Add your family members',
      subtitle: 'Add everyone now, or just yourself for now — you can add more '
          'anytime.',
      body: [
        SectionEyebrow('Caretakers',
            color: AppColors.indigo, trailing: _count(caretakers.length)),
        const SizedBox(height: 10),
        GroupedCard(children: [
          for (final m in caretakers)
            _memberRow(m, isSelf: m.id == selfId, roleLine: _caretakerRole(m)),
          GroupAddRow(
            title: 'Add a caretaker',
            square: true,
            onTap: () => showOnboardingAddMemberSheet(context, ref, isChild: false),
          ),
        ]),
        const SizedBox(height: 20),
        SectionEyebrow('Children',
            color: AppColors.textTertiary, trailing: _count(children.length)),
        const SizedBox(height: 10),
        GroupedCard(children: [
          for (final m in children)
            _memberRow(m, isSelf: false, roleLine: 'Child'),
          GroupAddRow(
            title: 'Add a child',
            accent: AppColors.green,
            square: true,
            onTap: () => showOnboardingAddMemberSheet(context, ref, isChild: true),
          ),
        ]),
      ],
      bottom: OnboardingButton(label: 'Continue', onPressed: onNext),
    );
  }

  Widget _count(int n) =>
      Text('$n', style: font(kBodyFont, 12, 600, color: AppColors.textMuted));

  String _caretakerRole(Member m) {
    final role = m.isAdmin ? 'Admin' : 'Caretaker';
    return '$role · can claim tasks';
  }

  Widget _memberRow(Member m, {required bool isSelf, required String roleLine}) {
    return GroupRow(
      leading: PersonAvatar(
          initial: initialFor(m.relationName), color: personColor(m), size: 38),
      title: m.relationName,
      subtitle: roleLine,
      trailing: isSelf
          ? const MiniPill('You', color: AppColors.indigo)
          : const Icon(Icons.chevron_right_rounded, size: 18, color: AppColors.textMuted),
    );
  }
}
