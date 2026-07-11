import 'package:flutter/material.dart';
import '../models.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';

/// The per-child position indicator on 1e/1f: the current child's avatar drawn
/// large with an accent ring, the rest dimmed, and a "Child N of M" label.
class ChildStrip extends StatelessWidget {
  const ChildStrip({super.key, required this.children, required this.currentIndex});

  final List<Member> children;
  final int currentIndex;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 0; i < children.length; i++) ...[
          _Avatar(member: children[i], active: i == currentIndex),
          const SizedBox(width: 9),
        ],
        const Spacer(),
        Text('Child ${currentIndex + 1} of ${children.length}',
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
