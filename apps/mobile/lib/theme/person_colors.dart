import 'package:flutter/widgets.dart';
import '../models.dart';
import 'app_colors.dart';

/// Per-person accent color resolution. Every caretaker/child gets one persistent
/// color used everywhere they appear (avatars, calendar blocks, chips). A member
/// may pin one explicitly (`Member.color`); otherwise we derive a stable color
/// from their id so it never shifts between sessions.

/// Parse a `#RRGGBB` (or `#AARRGGBB`) hex string into a [Color].
Color colorFromHex(String hex) {
  var h = hex.replaceFirst('#', '').trim();
  if (h.length == 6) h = 'FF$h';
  return Color(int.parse(h, radix: 16));
}

/// Format a [Color] as an uppercase `#RRGGBB` hex string.
String hexFromColor(Color color) {
  int c(double v) => (v * 255).round() & 0xff;
  final r = c(color.r).toRadixString(16).padLeft(2, '0');
  final g = c(color.g).toRadixString(16).padLeft(2, '0');
  final b = c(color.b).toRadixString(16).padLeft(2, '0');
  return '#${(r + g + b).toUpperCase()}';
}

/// A stable palette index for an id (used when no explicit color is set).
int _paletteIndexForId(String id) {
  var hash = 0;
  for (final unit in id.codeUnits) {
    hash = (hash * 31 + unit) & 0x7fffffff;
  }
  return hash % AppColors.palette.length;
}

/// The resolved accent color for a member.
Color personColor(Member m) {
  final c = m.color;
  if (c != null && c.isNotEmpty) return colorFromHex(c);
  return AppColors.palette[_paletteIndexForId(m.id)];
}

/// Resolve a color from an id + optional explicit hex (for callers that only
/// have loose fields rather than a full [Member]).
Color personColorFor(String id, {String? hex}) {
  if (hex != null && hex.isNotEmpty) return colorFromHex(hex);
  return AppColors.palette[_paletteIndexForId(id)];
}

/// The uppercase avatar initial for a name (first letter, `?` when empty).
String initialFor(String name) {
  final t = name.trim();
  return t.isEmpty ? '?' : t.substring(0, 1).toUpperCase();
}
