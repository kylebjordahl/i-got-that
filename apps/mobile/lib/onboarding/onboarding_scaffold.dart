import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';

/// Shared chrome for every wizard step (first-run 1b–1h, join 2b–2c): the thin
/// top progress line, a header row (back + a "Finish later"/"Skip for now"
/// bail-out link), a scrollable title/subtitle/body, and a pinned bottom
/// action area. Modelled directly on the round-7 onboarding design.
class OnboardingScaffold extends StatelessWidget {
  const OnboardingScaffold({
    super.key,
    this.progress,
    this.progressColor = AppColors.indigo,
    this.onBack,
    this.trailingLabel,
    this.onTrailing,
    this.title,
    this.subtitle,
    this.header,
    required this.body,
    this.bottom,
  });

  /// 0–1 fill of the top progress line; null hides the line entirely (1a).
  final double? progress;
  final Color progressColor;

  /// Back affordance; null hides the back button (e.g. the first real step).
  final VoidCallback? onBack;

  /// The right-aligned bail-out link text ("Finish later" / "Skip for now").
  final String? trailingLabel;
  final VoidCallback? onTrailing;

  final String? title;
  final String? subtitle;

  /// Optional widget shown above the title (e.g. the per-child avatar strip).
  final Widget? header;

  /// The scrollable middle content (below the title/subtitle).
  final List<Widget> body;

  /// The pinned action area (usually one [OnboardingButton]).
  final Widget? bottom;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.bg,
      body: SafeArea(
        child: Column(
          children: [
            if (progress != null)
              _ProgressLine(value: progress!, color: progressColor),
            if (onBack != null || trailingLabel != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
                child: Row(
                  children: [
                    if (onBack != null)
                      _BackButton(onTap: onBack!)
                    else
                      const SizedBox.shrink(),
                    const Spacer(),
                    if (trailingLabel != null)
                      TextButton(
                        onPressed: onTrailing,
                        style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                          minimumSize: Size.zero,
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        ),
                        child: Text(trailingLabel!,
                            style: font(kBodyFont, 13, 600, color: AppColors.textTertiary)),
                      ),
                  ],
                ),
              ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(22, 14, 22, 8),
                children: [
                  if (header != null) ...[header!, const SizedBox(height: 16)],
                  if (title != null)
                    Text(title!, style: AppText.screenTitleAlt),
                  if (subtitle != null) ...[
                    const SizedBox(height: 8),
                    Text(subtitle!,
                        style: font(kBodyFont, 14, 500,
                            color: AppColors.textSecondary, height: 1.5)),
                  ],
                  if (title != null || subtitle != null || header != null)
                    const SizedBox(height: 22),
                  ...body,
                ],
              ),
            ),
            if (bottom != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 12, 22, 20),
                child: bottom!,
              ),
          ],
        ),
      ),
    );
  }
}

class _ProgressLine extends StatelessWidget {
  const _ProgressLine({required this.value, required this.color});
  final double value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 3,
      color: AppColors.borderSubtle,
      alignment: Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: value.clamp(0, 1),
        child: Container(
          decoration: BoxDecoration(
            color: color,
            borderRadius: const BorderRadius.only(
              topRight: Radius.circular(2),
              bottomRight: Radius.circular(2),
            ),
          ),
        ),
      ),
    );
  }
}

class _BackButton extends StatelessWidget {
  const _BackButton({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.card,
      borderRadius: BorderRadius.circular(11),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(11),
        child: Container(
          width: 34,
          height: 34,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(11),
            border: Border.all(color: AppColors.border),
          ),
          child: const Icon(Icons.chevron_left_rounded,
              size: 22, color: Color(0xFFC9C2D6)),
        ),
      ),
    );
  }
}

/// The onboarding fill button. The design uses indigo for "Continue" and green
/// for the terminal "Finish"/"Finish setup"; white/ghost are the sign-in
/// variants on the welcome & invite screens.
enum OnbButtonVariant { indigo, green, white, ghost, blue }

class OnboardingButton extends StatelessWidget {
  const OnboardingButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.variant = OnbButtonVariant.indigo,
    this.busy = false,
    this.icon,
  });

  final String label;
  final VoidCallback? onPressed;
  final OnbButtonVariant variant;
  final bool busy;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final (bg, fg, border) = switch (variant) {
      OnbButtonVariant.indigo => (AppColors.indigo, const Color(0xFF15121B), null),
      OnbButtonVariant.green => (AppColors.green, const Color(0xFF0C2A1F), null),
      OnbButtonVariant.blue => (AppColors.blue, const Color(0xFF06243F), null),
      OnbButtonVariant.white => (AppColors.textPrimary, const Color(0xFF17141C), null),
      OnbButtonVariant.ghost => (
          Colors.transparent,
          const Color(0xFFC9C2D6),
          const Color(0x1FFFFFFF),
        ),
    };
    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: busy ? null : onPressed,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          height: 50,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: border == null ? null : Border.all(color: border),
          ),
          child: busy
              ? SizedBox(
                  height: 20,
                  width: 20,
                  child: CircularProgressIndicator(strokeWidth: 2, color: fg),
                )
              : Row(
                  mainAxisSize: MainAxisSize.min,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (icon != null) ...[
                      Icon(icon, size: 18, color: fg),
                      const SizedBox(width: 9),
                    ],
                    Text(label, style: font(kBodyFont, 15, 700, color: fg)),
                  ],
                ),
        ),
      ),
    );
  }
}

/// The trailing state a [SelectRow] shows on its right edge.
enum RowTrailing { none, checkFilled, radio, radioFilled, lock, chevron, check }

/// A rounded card row (icon-tile · title/subtitle · trailing state) used across
/// the connect / source / unified-calendar screens. When [selected], the border
/// picks up the accent; otherwise it's the standard hairline.
class SelectRow extends StatelessWidget {
  const SelectRow({
    super.key,
    required this.icon,
    required this.iconColor,
    required this.title,
    this.subtitle,
    this.trailing = RowTrailing.none,
    this.trailingWidget,
    this.selected = false,
    this.accent = AppColors.indigo,
    this.dimmed = false,
    this.dashed = false,
    this.onTap,
    this.titleColor,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String? subtitle;
  final RowTrailing trailing;
  final Widget? trailingWidget;
  final bool selected;
  final Color accent;
  final bool dimmed;
  final bool dashed;
  final VoidCallback? onTap;
  final Color? titleColor;

  @override
  Widget build(BuildContext context) {
    final content = Opacity(
      opacity: dimmed ? 0.6 : 1,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        decoration: BoxDecoration(
          color: AppColors.card,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: selected ? accent : AppColors.borderSubtle,
            width: selected ? 1.5 : 1,
          ),
        ),
        child: Row(
          children: [
            _IconTile(icon: icon, color: iconColor, dashed: dashed),
            const SizedBox(width: 13),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      style: font(kBodyFont, 14.5, 600,
                          color: titleColor ?? AppColors.textPrimary)),
                  if (subtitle != null) ...[
                    const SizedBox(height: 1),
                    Text(subtitle!,
                        style: font(kBodyFont, 12, 500, color: AppColors.textTertiary)),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 10),
            trailingWidget ?? _trailing(),
          ],
        ),
      ),
    );
    if (onTap == null) return content;
    return GestureDetector(onTap: onTap, child: content);
  }

  Widget _trailing() {
    switch (trailing) {
      case RowTrailing.none:
        return const SizedBox.shrink();
      case RowTrailing.checkFilled:
      case RowTrailing.check:
        return Container(
          width: 24,
          height: 24,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
          child: const Icon(Icons.check_rounded, size: 15, color: Color(0xFF15121B)),
        );
      case RowTrailing.radioFilled:
        return Container(
          width: 26,
          height: 26,
          alignment: Alignment.center,
          decoration: const BoxDecoration(color: AppColors.green, shape: BoxShape.circle),
          child: const Icon(Icons.check_rounded, size: 16, color: Color(0xFF0F2A20)),
        );
      case RowTrailing.radio:
        return Container(
          width: 24,
          height: 24,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: const Color(0x33FFFFFF), width: 2),
          ),
        );
      case RowTrailing.lock:
        return const Icon(Icons.lock_outline_rounded, size: 18, color: AppColors.textMuted);
      case RowTrailing.chevron:
        return const Icon(Icons.chevron_right_rounded, size: 20, color: AppColors.textMuted);
    }
  }
}

/// A small rounded icon tile; [dashed] draws the dashed "+" add affordance.
class _IconTile extends StatelessWidget {
  const _IconTile({required this.icon, required this.color, this.dashed = false});
  final IconData icon;
  final Color color;
  final bool dashed;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 44,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: AppColors.tint(color, dashed ? 0.10 : 0.14),
        borderRadius: BorderRadius.circular(13),
        border: dashed ? Border.all(color: color.withValues(alpha: 0.4)) : null,
      ),
      child: Icon(icon, color: color, size: 21),
    );
  }
}

/// The dashed "add" row (e.g. "Connect another account", "Add a source"): a
/// dashed-tile leading, an accent title, optional subtitle, no trailing.
class AddRow extends StatelessWidget {
  const AddRow({
    super.key,
    required this.title,
    this.subtitle,
    this.accent = AppColors.indigo,
    this.icon = Icons.add_rounded,
    required this.onTap,
    this.boxed = false,
  });

  final String title;
  final String? subtitle;
  final Color accent;
  final IconData icon;
  final VoidCallback onTap;

  /// When true the whole row is a dashed-border card (as on 1g); otherwise it
  /// is a plain row inside a grouped card.
  final bool boxed;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
        decoration: boxed
            ? BoxDecoration(
                color: AppColors.card,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: accent.withValues(alpha: 0.4)),
              )
            : null,
        child: Row(
          children: [
            _IconTile(icon: icon, color: accent, dashed: true),
            const SizedBox(width: 13),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title, style: font(kBodyFont, 14.5, 700, color: accent)),
                  if (subtitle != null) ...[
                    const SizedBox(height: 1),
                    Text(subtitle!,
                        style: font(kBodyFont, 12, 500, color: AppColors.textTertiary)),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A grouped surface card holding [GroupRow]s / [GroupAddRow]s separated by
/// hairline dividers — the single-card list look of 1b / 1d / 1e.
class GroupedCard extends StatelessWidget {
  const GroupedCard({super.key, required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    for (var i = 0; i < children.length; i++) {
      rows.add(children[i]);
      if (i < children.length - 1) {
        rows.add(const Padding(
          padding: EdgeInsets.symmetric(horizontal: 14),
          child: Divider(height: 1, thickness: 1, color: AppColors.borderSubtle),
        ));
      }
    }
    return Container(
      decoration: BoxDecoration(
        color: AppColors.card,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(18),
        child: Column(mainAxisSize: MainAxisSize.min, children: rows),
      ),
    );
  }
}

/// One row inside a [GroupedCard]: leading (avatar or icon-tile), title +
/// subtitle, and a trailing widget (pill / chevron / check).
class GroupRow extends StatelessWidget {
  const GroupRow({
    super.key,
    required this.leading,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
  });

  final Widget leading;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final content = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: [
          leading,
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(title, style: font(kBodyFont, 14.5, 600)),
                if (subtitle != null) ...[
                  const SizedBox(height: 1),
                  Text(subtitle!,
                      style: font(kBodyFont, 11.5, 500, color: AppColors.textTertiary)),
                ],
              ],
            ),
          ),
          if (trailing != null) ...[const SizedBox(width: 10), trailing!],
        ],
      ),
    );
    if (onTap == null) return content;
    return InkWell(onTap: onTap, child: content);
  }
}

/// The dashed "add" affordance as a row inside a [GroupedCard].
class GroupAddRow extends StatelessWidget {
  const GroupAddRow({
    super.key,
    required this.title,
    this.subtitle,
    this.accent = AppColors.indigo,
    this.square = false,
    required this.onTap,
  });

  final String title;
  final String? subtitle;
  final Color accent;

  /// A dashed rounded-square "+" (member add) vs a dashed rounded-rect tile.
  final bool square;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          children: [
            Container(
              width: square ? 38 : 44,
              height: square ? 38 : 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: AppColors.tint(accent, 0.10),
                borderRadius: BorderRadius.circular(square ? 12 : 13),
                border: Border.all(color: accent.withValues(alpha: 0.4)),
              ),
              child: Icon(Icons.add_rounded, color: accent, size: 18),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title, style: font(kBodyFont, 14, 700, color: accent)),
                  if (subtitle != null) ...[
                    const SizedBox(height: 1),
                    Text(subtitle!,
                        style: font(kBodyFont, 12, 500, color: AppColors.textTertiary)),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A small pill ("Connected", "You") used as a grouped-row trailing.
class MiniPill extends StatelessWidget {
  const MiniPill(this.label, {super.key, required this.color, this.dot = false});
  final String label;
  final Color color;
  final bool dot;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.tint(color, dot ? 0.13 : 0.14),
        borderRadius: BorderRadius.circular(999),
        border: dot ? Border.all(color: color.withValues(alpha: 0.3)) : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot) ...[
            Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
            const SizedBox(width: 6),
          ],
          Text(label, style: font(kBodyFont, 11, 700, color: color)),
        ],
      ),
    );
  }
}

/// One line of a wizard summary (1h, 2d). A step the user actually completed
/// gets the green check; one they skipped gets a muted dash and says so, so the
/// summary receipts what happened rather than implying everything was done.
class ReceiptRow extends StatelessWidget {
  const ReceiptRow({super.key, required this.text, required this.done, this.note});

  final String text;
  final bool done;

  /// Optional second line — used to tell the user where to finish a skipped step.
  final String? note;

  @override
  Widget build(BuildContext context) {
    final color = done ? AppColors.green : AppColors.textMuted;
    return GroupRow(
      leading: Container(
        width: 24,
        height: 24,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: AppColors.tint(color, 0.18), shape: BoxShape.circle),
        child: Icon(done ? Icons.check_rounded : Icons.remove_rounded, size: 13, color: color),
      ),
      title: text,
      subtitle: note,
    );
  }
}

/// A small inline hint row ("ⓘ …") used beneath several step bodies.
class InfoHint extends StatelessWidget {
  const InfoHint(this.text, {super.key, this.icon = Icons.info_outline_rounded});
  final String text;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 16, 4, 0),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 15, color: AppColors.textMuted),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text,
                style: font(kBodyFont, 12, 500, color: AppColors.textTertiary, height: 1.5)),
          ),
        ],
      ),
    );
  }
}
