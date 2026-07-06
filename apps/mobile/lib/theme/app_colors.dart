import 'package:flutter/widgets.dart';

/// Round-5 dark-theme design tokens. Values are the finals from the design
/// handoff README (§ "Color — dark theme" and the accent/person palette).
///
/// Kept as a flat set of `const Color`s so both the [ThemeData] and individual
/// widgets can reference the exact hex without going through the (lossy)
/// Material `ColorScheme` roles.
abstract final class AppColors {
  // --- Surfaces ----------------------------------------------------------
  /// Screen background.
  static const bg = Color(0xFF15121B);

  /// Card / row background.
  static const card = Color(0xFF221D2D);

  /// Hairline card border (default).
  static const border = Color(0x14FFFFFF); // rgba(255,255,255,.08)
  static const borderSubtle = Color(0x0FFFFFFF); // rgba(255,255,255,.06)

  /// Divider.
  static const divider = Color(0x0FFFFFFF);

  // --- Text --------------------------------------------------------------
  static const textPrimary = Color(0xFFF4F1F8);
  static const textSecondary = Color(0xFFA79FB5);
  static const textTertiary = Color(0xFF8B8398);
  static const textMuted = Color(0xFF6E667C);

  // --- Accents / person colors ------------------------------------------
  /// Primary UI accent ("Dad" / active nav / primary buttons).
  static const indigo = Color(0xFF8E9BFF);

  /// "Mom".
  static const blue = Color(0xFF5FA8FF);

  /// Feed / broadcast icon tint (a hair brighter than [blue]).
  static const feedBlue = Color(0xFF66B4FF);

  /// "Theo" / success / linked state.
  static const green = Color(0xFF4FD9A8);

  /// "Mia" / secondary accent.
  static const purple = Color(0xFFC08CFF);

  /// "Adeline" / warning-adjacent.
  static const coral = Color(0xFFFF7A6B);

  /// "Grandma".
  static const amber = Color(0xFFE8A44D);

  /// Hero-highlight amber (brighter than [amber]).
  static const amberHero = Color(0xFFFFC24B);

  /// Now-line / live indicator.
  static const nowLine = Color(0xFFFF5A5F);

  /// The 6-swatch member-color palette, in picker order.
  static const palette = <Color>[indigo, blue, green, purple, coral, amber];

  // --- Gradients ---------------------------------------------------------
  /// Elevated profile-header card.
  static const profileGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF241D2B), Color(0xFF1A1622)],
  );

  /// The warm amber Home hero card.
  static const heroGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF3A2F1C), Color(0xFF241D2B)],
  );

  /// Floating bottom-nav pill background (blur sits behind it).
  static const navPill = Color(0xDB2A2436); // rgba(42,36,54,.86)

  /// Tint an accent for icon-tile / chip backgrounds (~14% opacity).
  static Color tint(Color accent, [double opacity = 0.14]) =>
      accent.withValues(alpha: opacity);
}
