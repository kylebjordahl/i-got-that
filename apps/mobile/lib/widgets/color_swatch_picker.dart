import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/person_colors.dart';

/// The 6-swatch member-color picker. The current selection is drawn larger with
/// a ring; colors already taken by *other* members are dimmed and unselectable
/// (so two people never share a color).
class ColorSwatchPicker extends StatelessWidget {
  const ColorSwatchPicker({
    super.key,
    required this.selected,
    required this.onSelected,
    this.takenHex = const {},
  });

  /// The currently selected color (may be off-palette; still matched by hex).
  final Color? selected;
  final ValueChanged<Color> onSelected;

  /// Uppercase `#RRGGBB` hexes taken by other members — disabled in the picker.
  final Set<String> takenHex;

  @override
  Widget build(BuildContext context) {
    final selectedHex = selected == null ? null : hexFromColor(selected!);
    return Wrap(
      spacing: 14,
      runSpacing: 12,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        for (final color in AppColors.palette)
          _Swatch(
            color: color,
            selected: hexFromColor(color) == selectedHex,
            disabled: takenHex.contains(hexFromColor(color)),
            onTap: () => onSelected(color),
          ),
      ],
    );
  }
}

class _Swatch extends StatelessWidget {
  const _Swatch({
    required this.color,
    required this.selected,
    required this.disabled,
    required this.onTap,
  });

  final Color color;
  final bool selected;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    if (selected) {
      return Container(
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: AppColors.card,
          border: Border.all(color: color, width: 2),
        ),
        child: Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
      );
    }
    return Opacity(
      opacity: disabled ? 0.28 : 1,
      child: GestureDetector(
        onTap: disabled ? null : onTap,
        child: Container(
          width: 34,
          height: 34,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          child: disabled
              ? const Icon(Icons.lock, size: 14, color: Color(0xFF17162B))
              : null,
        ),
      ),
    );
  }
}
