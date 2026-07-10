import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';

/// A colored circle with a single initial — the app-wide person avatar.
class PersonAvatar extends StatelessWidget {
  const PersonAvatar({
    super.key,
    required this.initial,
    required this.color,
    this.size = 40,
  });

  final String initial;
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      child: Text(
        initial,
        style: font(kBodyFont, size * 0.4, 700, color: const Color(0xFF17162B)),
      ),
    );
  }
}

/// Overlapping avatar cluster with an optional "+N" overflow chip.
class AvatarCluster extends StatelessWidget {
  const AvatarCluster({
    super.key,
    required this.avatars,
    this.overflow,
    this.size = 34,
    this.overlap = 12,
  });

  /// (initial, color) pairs, front-to-back left-to-right.
  final List<(String, Color)> avatars;
  final int? overflow;
  final double size;
  final double overlap;

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    var left = 0.0;
    for (final (initial, color) in avatars) {
      children.add(Positioned(
        left: left,
        child: Container(
          padding: const EdgeInsets.all(2),
          decoration: const BoxDecoration(
            color: AppColors.card,
            shape: BoxShape.circle,
          ),
          child: PersonAvatar(initial: initial, color: color, size: size),
        ),
      ));
      left += size - overlap + 4;
    }
    if (overflow != null && overflow! > 0) {
      children.add(Positioned(
        left: left,
        child: Container(
          width: size + 4,
          height: size + 4,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: const Color(0xFF322B40),
            shape: BoxShape.circle,
            border: Border.all(color: AppColors.card, width: 2),
          ),
          child: Text('+$overflow',
              style: font(kBodyFont, 11, 700, color: AppColors.textSecondary)),
        ),
      ));
      left += size + 4;
    }
    return SizedBox(
      width: left + overlap,
      height: size + 4,
      child: Stack(children: children),
    );
  }
}

/// A rounded, tinted icon tile (accent bg at ~14% opacity + accent-colored icon).
class IconTile extends StatelessWidget {
  const IconTile({
    super.key,
    required this.icon,
    required this.color,
    this.size = 44,
    this.radius = 13,
  });

  final IconData icon;
  final Color color;
  final double size;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: AppColors.tint(color),
        borderRadius: BorderRadius.circular(radius),
      ),
      child: Icon(icon, color: color, size: size * 0.5),
    );
  }
}

/// The standard rounded surface card. Optional gradient (profile/hero variants),
/// border, padding, and tap handling.
class AppCard extends StatelessWidget {
  const AppCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.radius = 20,
    this.gradient,
    this.color,
    this.border,
    this.onTap,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;
  final Gradient? gradient;
  final Color? color;
  final BoxBorder? border;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final decoration = BoxDecoration(
      color: gradient == null ? (color ?? AppColors.card) : null,
      gradient: gradient,
      borderRadius: BorderRadius.circular(radius),
      border: border ?? Border.all(color: AppColors.border),
    );
    final content = Padding(padding: padding, child: child);
    return DecoratedBox(
      decoration: decoration,
      child: onTap == null
          ? content
          : Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: onTap,
                borderRadius: BorderRadius.circular(radius),
                child: content,
              ),
            ),
    );
  }
}

/// An uppercase eyebrow section label with an optional trailing widget
/// (count text or a [TintBadge]).
class SectionEyebrow extends StatelessWidget {
  const SectionEyebrow(this.label, {super.key, this.color, this.trailing});

  final String label;
  final Color? color;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Text(label.toUpperCase(),
                style: AppText.eyebrow(color ?? AppColors.textMuted)),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

/// A small tinted pill used for counts / status ("2 active", "Linked").
class TintBadge extends StatelessWidget {
  const TintBadge(this.label, {super.key, required this.color, this.filled = false});

  final String label;
  final Color color;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: filled ? color : AppColors.tint(color, 0.16),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: font(kBodyFont, 11, 700,
            color: filled ? const Color(0xFF17162B) : color),
      ),
    );
  }
}

/// A refresh-all-feeds trigger: a bare circular icon button. Used in place of
/// the user badge on Home, and as a compact toolbar icon next to Filters on
/// Plan. Spins the icon while [busy].
class RefreshFeedsButton extends StatelessWidget {
  const RefreshFeedsButton({
    super.key,
    required this.busy,
    required this.onTap,
    this.size = 40,
  });

  final bool busy;
  final VoidCallback? onTap;
  final double size;

  @override
  Widget build(BuildContext context) {
    final iconOrSpinner = busy
        ? SizedBox(
            width: size * 0.45,
            height: size * 0.45,
            child: const CircularProgressIndicator(
                strokeWidth: 2, color: AppColors.textSecondary),
          )
        : Icon(Icons.refresh_rounded, size: size * 0.5, color: AppColors.textSecondary);

    return Material(
      color: AppColors.card,
      shape: const CircleBorder(side: BorderSide(color: AppColors.border)),
      child: InkWell(
        onTap: busy ? null : onTap,
        customBorder: const CircleBorder(),
        child: SizedBox(width: size, height: size, child: Center(child: iconOrSpinner)),
      ),
    );
  }
}

/// A filter chip. Person chips (with a [dotColor]) tint to that color when
/// selected and show a colored dot; type chips fill solid indigo. Shared by
/// the Home and Plan filter sheets so both read as one filtering system.
class TaskFilterChip extends StatelessWidget {
  const TaskFilterChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
    this.dotColor,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final Color? dotColor;

  @override
  Widget build(BuildContext context) {
    final person = dotColor != null;
    final accent = dotColor ?? AppColors.indigo;
    final Color bg, fg, border;
    if (selected) {
      bg = person ? AppColors.tint(accent, 0.18) : AppColors.indigo;
      fg = person ? AppColors.textPrimary : const Color(0xFF17162B);
      border = accent;
    } else {
      bg = Colors.transparent;
      fg = AppColors.textSecondary;
      border = AppColors.border;
    }
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (person && selected) ...[
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
              ),
              const SizedBox(width: 7),
            ],
            Text(label, style: font(kBodyFont, 13, 600, color: fg)),
          ],
        ),
      ),
    );
  }
}

/// The toolbar "Filters" pill with a count badge — opens a screen's filter
/// sheet. Shared by Home and Plan.
class FiltersButton extends StatelessWidget {
  const FiltersButton({super.key, required this.count, required this.onTap});
  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.card,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(999),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.tune_rounded, size: 17, color: AppColors.textSecondary),
              const SizedBox(width: 7),
              Text('Filters', style: font(kBodyFont, 13.5, 600, color: AppColors.textSecondary)),
              if (count > 0) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(color: AppColors.indigo, borderRadius: BorderRadius.circular(999)),
                  child: Text('$count', style: font(kBodyFont, 11, 700, color: const Color(0xFF17162B))),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Pill buttons in the three design variants.
enum PillVariant { amber, white, ghost, indigo }

class PillButton extends StatelessWidget {
  const PillButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = PillVariant.white,
    this.icon,
    this.dense = false,
    this.compact = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final PillVariant variant;
  final IconData? icon;
  final bool dense;

  /// Extra-small pill for the slim Plan transition rows.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final (bg, fg, border) = switch (variant) {
      PillVariant.amber => (AppColors.amberHero, const Color(0xFF2A1E05), null),
      PillVariant.white => (AppColors.textPrimary, const Color(0xFF17141C), null),
      PillVariant.ghost => (Colors.transparent, AppColors.textPrimary, AppColors.border),
      PillVariant.indigo => (AppColors.indigo, const Color(0xFF17162B), null),
    };
    return Material(
      color: bg,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(999),
        side: border == null ? BorderSide.none : BorderSide(color: border),
      ),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(999),
        child: Padding(
          padding: EdgeInsets.symmetric(
            horizontal: compact ? 11 : (dense ? 14 : 16),
            vertical: compact ? 5 : (dense ? 8 : 9),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 16, color: fg),
                const SizedBox(width: 6),
              ],
              Text(label, style: font(kBodyFont, compact ? 11.5 : 13, 700, color: fg)),
            ],
          ),
        ),
      ),
    );
  }
}
