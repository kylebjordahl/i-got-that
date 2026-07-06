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

  /// Solid left-bar color when owned; null ⇒ dashed "needs an owner" bar.
  final Color? ownedColor;
  final Widget? trailing;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final muted = ownedColor != null;
    return Opacity(
      opacity: muted ? 0.94 : 1,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppColors.card,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: AppColors.borderSubtle),
        ),
        child: Stack(
          children: [
            // Content sizes the stack; the accent bar is overlaid, inset from the
            // corners so its rounded ends aren't clipped by the card radius.
            Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: onTap,
                onLongPress: onLongPress,
                borderRadius: BorderRadius.circular(18),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(19, 12, 14, 12),
                  child: Row(
                    children: [
                      IconTile(icon: icon, color: iconColor, size: 42),
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
            Positioned(
              left: 8,
              top: 12,
              bottom: 12,
              width: 3,
              child: IgnorePointer(
                child: CustomPaint(painter: _LeftBarPainter(color: ownedColor)),
              ),
            ),
          ],
        ),
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

/// Paints the row's left bar: a solid fill when [color] is set, otherwise a
/// dashed neutral bar (the "needs an owner" treatment).
class _LeftBarPainter extends CustomPainter {
  _LeftBarPainter({this.color});
  final Color? color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color ?? const Color(0x52FFFFFF) // rgba(255,255,255,.32)
      ..strokeWidth = size.width
      ..strokeCap = StrokeCap.round;
    final x = size.width / 2;
    // Keep the round caps inside the box so the bar reads as rounded top/bottom.
    final r = size.width / 2;
    final top = r, bottom = size.height - r;
    if (bottom <= top) return;
    if (color != null) {
      canvas.drawLine(Offset(x, top), Offset(x, bottom), paint);
      return;
    }
    const dash = 4.0, gap = 7.0; // wider-spaced dashes
    var y = top;
    while (y <= bottom) {
      canvas.drawLine(Offset(x, y), Offset(x, (y + dash).clamp(top, bottom)), paint);
      y += dash + gap;
    }
  }

  @override
  bool shouldRepaint(_LeftBarPainter old) => old.color != color;
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
