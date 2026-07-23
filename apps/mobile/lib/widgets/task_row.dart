import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import 'primitives.dart';

/// A Home task row. The left accent bar encodes ownership: a **dashed** neutral
/// bar means "unowned / needs an owner"; a **solid** person-color bar means
/// "owned". Title reads "Type · Name" with the name in the person's color.
class TaskRow extends StatelessWidget {
  const TaskRow({
    super.key,
    required this.icon,
    required this.iconColor,
    required this.typeLabel,
    required this.personName,
    required this.personColor,
    required this.subtitle,
    this.sourceInitial,
    this.sourceColor,
    this.ownedColor,
    this.trailing,
    this.onTap,
    this.onLongPress,
  });

  final IconData icon;
  final Color iconColor;
  final String typeLabel;
  final String personName;
  final Color personColor;
  final String subtitle;

  /// A small corner badge on the icon tile naming the source person whose
  /// calendar the task came from (6b) — distinct from the claimer. Null ⇒ none.
  final String? sourceInitial;
  final Color? sourceColor;

  /// Solid left-bar color when owned; null ⇒ dashed "needs an owner" bar.
  final Color? ownedColor;
  final Widget? trailing;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final owned = ownedColor != null;
    // Uniform border (no left-only accent bar); owned rows tint it to the
    // covering person's colour so "You're covering" still reads distinctly.
    final borderColor = owned
        ? ownedColor!.withValues(alpha: 0.5)
        : AppColors.borderSubtle;
    return Opacity(
      opacity: owned ? 0.96 : 1,
      child: Material(
        color: AppColors.card,
        borderRadius: BorderRadius.circular(18),
        child: InkWell(
          onTap: onTap,
          onLongPress: onLongPress,
          borderRadius: BorderRadius.circular(18),
          child: Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: borderColor),
            ),
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            child: Row(
              children: [
                _iconTile(),
                const SizedBox(width: 12),
                Expanded(child: _titleBlock()),
                if (trailing != null) ...[
                  const SizedBox(width: 10),
                  trailing!,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// The task-type icon tile, with an optional source-person initial badge
  /// clipped to its bottom-right corner (6b).
  Widget _iconTile() {
    final tile = IconTile(icon: icon, color: iconColor, size: 42);
    if (sourceInitial == null || sourceColor == null) return tile;
    return SizedBox(
      width: 42,
      height: 42,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          tile,
          Positioned(
            right: -3,
            bottom: -3,
            child: Container(
              width: 18,
              height: 18,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: sourceColor,
                shape: BoxShape.circle,
                border: Border.all(color: AppColors.card, width: 2),
              ),
              child: Text(
                sourceInitial!,
                style: font(kBodyFont, 8.5, 800, color: const Color(0xFF17162B)),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _titleBlock() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text.rich(
          TextSpan(
            style: font(kBodyFont, 14, 600, color: AppColors.textPrimary),
            children: [
              TextSpan(text: '$typeLabel · '),
              TextSpan(
                text: personName,
                style: font(kBodyFont, 14, 600, color: personColor),
              ),
            ],
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 2),
        Text(subtitle,
            style: font(kBodyFont, 11.5, 500, color: AppColors.textTertiary),
            maxLines: 1,
            overflow: TextOverflow.ellipsis),
      ],
    );
  }
}

/// The trailing "You" chip shown on owned rows (small avatar + "You").
class YouChip extends StatelessWidget {
  const YouChip({super.key, required this.initial, required this.color});
  final String initial;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PersonAvatar(initial: initial, color: color, size: 24),
        const SizedBox(width: 6),
        Text('You', style: font(kBodyFont, 12.5, 600, color: AppColors.textSecondary)),
      ],
    );
  }
}
