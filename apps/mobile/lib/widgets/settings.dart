import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import 'primitives.dart';

/// A tappable settings row: tinted icon tile, title + optional subtitle, and a
/// trailing widget (defaults to a chevron when [onTap] is set).
class SettingRow extends StatelessWidget {
  const SettingRow({
    super.key,
    required this.icon,
    required this.iconColor,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final trailer = trailing ??
        (onTap != null
            ? const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted)
            : null);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            IconTile(icon: icon, color: iconColor),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: AppText.sectionItemTitle),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(subtitle!, style: AppText.subtitle),
                  ],
                ],
              ),
            ),
            if (trailer != null) ...[const SizedBox(width: 8), trailer],
          ],
        ),
      ),
    );
  }
}

/// A row with a leading icon tile, label, and a trailing [Switch] — used for the
/// role / delivery / feed toggles.
class SwitchRow extends StatelessWidget {
  const SwitchRow({
    super.key,
    required this.icon,
    required this.iconColor,
    required this.title,
    this.subtitle,
    required this.value,
    required this.onChanged,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String? subtitle;
  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          IconTile(icon: icon, color: iconColor),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: AppText.toggleLabel),
                if (subtitle != null) ...[
                  const SizedBox(height: 2),
                  Text(subtitle!, style: AppText.subtitle),
                ],
              ],
            ),
          ),
          Switch(value: value, onChanged: onChanged),
        ],
      ),
    );
  }
}

/// The profile header shown at the top of the detail screens.
class DetailProfileCard extends StatelessWidget {
  const DetailProfileCard({
    super.key,
    required this.avatar,
    required this.name,
    required this.subtitle,
    this.onEdit,
    this.extra,
  });

  final Widget avatar;
  final String name;
  final String subtitle;
  final VoidCallback? onEdit;

  /// Optional extra line under the subtitle (e.g. "Member of 2 families").
  final Widget? extra;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      gradient: AppColors.profileGradient,
      padding: const EdgeInsets.all(16),
      child: Row(
        children: [
          avatar,
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, style: AppText.profileName),
                const SizedBox(height: 2),
                Text(subtitle, style: AppText.subtitle),
                if (extra != null) extra!,
              ],
            ),
          ),
          if (onEdit != null)
            _RoundIconButton(icon: Icons.edit_outlined, onTap: onEdit!),
        ],
      ),
    );
  }
}

/// A 40px rounded square icon button (back chevron, edit, etc.).
class RoundIconButton extends StatelessWidget {
  const RoundIconButton({super.key, required this.icon, required this.onTap});
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => _RoundIconButton(icon: icon, onTap: onTap);
}

class _RoundIconButton extends StatelessWidget {
  const _RoundIconButton({required this.icon, required this.onTap});
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.card,
      borderRadius: BorderRadius.circular(13),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(13),
        child: Container(
          width: 40,
          height: 40,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(13),
            border: Border.all(color: AppColors.border),
          ),
          child: Icon(icon, size: 20, color: AppColors.textSecondary),
        ),
      ),
    );
  }
}

/// A sub-page header: back button + title (used by the detail screens).
class SubPageHeader extends StatelessWidget {
  const SubPageHeader({super.key, required this.title, this.subtitle, this.onBack});
  final String title;
  final String? subtitle;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        RoundIconButton(
          icon: Icons.chevron_left_rounded,
          onTap: onBack ?? () => Navigator.of(context).maybePop(),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: AppText.subPageTitle),
              if (subtitle != null)
                Text(subtitle!, style: AppText.subtitle, maxLines: 1, overflow: TextOverflow.ellipsis),
            ],
          ),
        ),
      ],
    );
  }
}
