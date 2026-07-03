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

  @override
  Widget build(BuildContext context) {
    final muted = ownedColor != null;
    return Opacity(
      opacity: muted ? 0.94 : 1,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(18),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: AppColors.card,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: AppColors.borderSubtle),
          ),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: onTap,
              child: IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SizedBox(
                      width: 3,
                      child: CustomPaint(
                        painter: _LeftBarPainter(color: ownedColor),
                      ),
                    ),
                    Expanded(
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(13, 12, 13, 12),
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
                  ],
                ),
              ),
            ),
          ),
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
    if (color != null) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
      return;
    }
    const dash = 5.0, gap = 4.0;
    var y = 0.0;
    while (y < size.height) {
      canvas.drawLine(Offset(x, y), Offset(x, (y + dash).clamp(0, size.height)), paint);
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
