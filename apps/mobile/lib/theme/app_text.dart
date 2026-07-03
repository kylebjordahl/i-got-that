import 'package:flutter/material.dart';
import 'app_colors.dart';

/// Font families (declared in pubspec as variable TTFs).
const kDisplayFont = 'Schibsted Grotesk'; // screen titles, hero headline
const kBodyFont = 'Hanken Grotesk'; // everything else
const kAccentFont = 'Caveat'; // handwritten annotation accents

FontWeight _weightOf(int w) => switch (w) {
      <= 400 => FontWeight.w400,
      500 => FontWeight.w500,
      600 => FontWeight.w600,
      700 => FontWeight.w700,
      _ => FontWeight.w800,
    };

/// Build a [TextStyle] for one of the bundled variable fonts, pinning the
/// weight through the `wght` axis (variable fonts don't respond to plain
/// [FontWeight] on every platform, so we set the variation explicitly).
TextStyle font(
  String family,
  double size,
  int weight, {
  Color color = AppColors.textPrimary,
  double? height,
  double? letterSpacing,
}) =>
    TextStyle(
      fontFamily: family,
      fontSize: size,
      height: height,
      letterSpacing: letterSpacing,
      color: color,
      fontWeight: _weightOf(weight),
      fontVariations: [FontVariation('wght', weight.toDouble())],
    );

/// Named styles from the design's type scale (README § Typography).
abstract final class AppText {
  static TextStyle get screenTitle =>
      font(kDisplayFont, 28, 600, letterSpacing: -0.3);
  static TextStyle get screenTitleAlt =>
      font(kDisplayFont, 26, 600, letterSpacing: -0.2);
  static TextStyle get subPageTitle => font(kDisplayFont, 22, 600);
  static TextStyle get heroHeadline =>
      font(kDisplayFont, 25, 600, height: 1.12);

  static TextStyle get profileName => font(kBodyFont, 17, 700);
  static TextStyle get sectionItemTitle => font(kBodyFont, 16, 600);
  static TextStyle get listItemTitle => font(kBodyFont, 14, 600);
  static TextStyle get toggleLabel => font(kBodyFont, 14.5, 600);

  static TextStyle get subtitle =>
      font(kBodyFont, 13, 500, color: AppColors.textSecondary);
  static TextStyle get secondary =>
      font(kBodyFont, 12, 500, color: AppColors.textTertiary);

  /// Uppercase eyebrow label; `.13em` tracking at 11px ≈ 1.4px.
  static TextStyle eyebrow([Color color = AppColors.textMuted]) =>
      font(kBodyFont, 11, 700, color: color, letterSpacing: 1.4);

  static TextStyle micro([Color color = AppColors.textTertiary]) =>
      font(kBodyFont, 10.5, 700, color: color, letterSpacing: 0.4);

  /// Handwritten annotation accent.
  static TextStyle get caveat =>
      font(kAccentFont, 15, 500, color: AppColors.textTertiary, height: 1.4);
}
