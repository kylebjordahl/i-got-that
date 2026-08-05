import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';

/// A pill toggle for one weekday. Shared by the assignment-rule editor and the
/// notification-schedule editor, which both drive a Mon=bit0 weekday mask.
class DayChip extends StatelessWidget {
  const DayChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? AppColors.amber : AppColors.bg,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: selected ? AppColors.amber : AppColors.border,
          ),
        ),
        child: Text(
          label,
          style: font(
            kBodyFont,
            13,
            600,
            color: selected ? const Color(0xFF2A1E05) : AppColors.textSecondary,
          ),
        ),
      ),
    );
  }
}

/// The "Every day" / "Weekdays" shortcut above a [DayChip] row.
class DayPreset extends StatelessWidget {
  const DayPreset({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
    onTap: onTap,
    child: Text(
      label,
      style: font(kBodyFont, 12, 700, color: AppColors.indigo),
    ),
  );
}
