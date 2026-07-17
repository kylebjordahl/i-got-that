import 'package:flutter/material.dart';
import '../models.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';

/// The position indicator for the wizard's per-member loops (1e/1f per child,
/// 1g per caretaker): the current member's avatar drawn large with an accent
/// ring, the rest dimmed, and a "{noun} N of M" label.
class MemberStrip extends StatelessWidget {
  const MemberStrip({
    super.key,
    required this.members,
    required this.currentIndex,
    required this.noun,
  });

  final List<Member> members;
  final int currentIndex;

  /// Singular label for the thing being iterated — "Child" or "Caretaker".
  final String noun;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 0; i < members.length; i++) ...[
          _Avatar(member: members[i], active: i == currentIndex),
          const SizedBox(width: 9),
        ],
        const Spacer(),
        Text('$noun ${currentIndex + 1} of ${members.length}',
            style: font(kBodyFont, 12, 600, color: AppColors.textMuted)),
      ],
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.member, required this.active});
  final Member member;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final color = personColor(member);
    if (active) {
      return Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: color, width: 2),
        ),
        padding: const EdgeInsets.all(2),
        child: PersonAvatar(
            initial: initialFor(member.relationName), color: color, size: 32),
      );
    }
    return Opacity(
      opacity: 0.4,
      child: PersonAvatar(
          initial: initialFor(member.relationName), color: color, size: 30),
    );
  }
}
