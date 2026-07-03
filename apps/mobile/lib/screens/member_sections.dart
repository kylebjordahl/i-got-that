import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/color_swatch_picker.dart';
import '../widgets/primitives.dart';

/// The shared "Member color" section used by both detail screens — a helper card
/// with the 6-swatch picker. Persists the choice to the member (`color` PATCH);
/// colors already taken by other members are disabled so no two people clash.
class MemberColorSection extends ConsumerWidget {
  const MemberColorSection({
    super.key,
    required this.member,
    required this.others,
    this.enabled = true,
  });

  final Member member;
  final List<Member> others;
  final bool enabled;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final taken = <String>{
      for (final m in others)
        if (m.id != member.id && m.color != null && m.color!.isNotEmpty)
          hexFromColor(colorFromHex(m.color!)),
    };

    Future<void> pick(Color c) async {
      final familyId = await ref.read(familyProvider.future);
      await ref
          .read(apiClientProvider)
          .updateMember(familyId, member.id, color: hexFromColor(c));
      ref.invalidate(membersProvider);
      ref.invalidate(currentMemberProvider);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionEyebrow('Member color'),
        const SizedBox(height: 12),
        AppCard(
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Used everywhere ${member.relationName} appears — Plan blocks, avatars, chips.',
                style: AppText.subtitle,
              ),
              const SizedBox(height: 18),
              IgnorePointer(
                ignoring: !enabled,
                child: Opacity(
                  opacity: enabled ? 1 : 0.5,
                  child: ColorSwatchPicker(
                    selected: personColor(member),
                    takenHex: taken,
                    onSelected: pick,
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
