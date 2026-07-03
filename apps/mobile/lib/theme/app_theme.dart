import 'package:flutter/material.dart';
import 'app_colors.dart';
import 'app_text.dart';

/// The single dark theme for the round-5 redesign. Maps the design tokens onto
/// a Material 3 [ThemeData] so stock widgets (dialogs, switches, snackbars) pick
/// up the palette; screens use [AppText] + the `lib/widgets/` set for the rest.
ThemeData buildAppTheme() {
  const scheme = ColorScheme.dark(
    primary: AppColors.indigo,
    onPrimary: Color(0xFF17162B),
    secondary: AppColors.purple,
    surface: AppColors.card,
    onSurface: AppColors.textPrimary,
    surfaceContainerHighest: AppColors.card,
    outline: AppColors.border,
    error: AppColors.coral,
  );

  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.bg,
    canvasColor: AppColors.bg,
    fontFamily: kBodyFont,
    splashFactory: InkRipple.splashFactory,
  );

  return base.copyWith(
    textTheme: base.textTheme.copyWith(
      titleLarge: AppText.subPageTitle,
      titleMedium: AppText.sectionItemTitle,
      bodyLarge: AppText.listItemTitle,
      bodyMedium: font(kBodyFont, 14, 500, color: AppColors.textSecondary),
      bodySmall: AppText.secondary,
      labelLarge: font(kBodyFont, 14, 700),
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.bg,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
      foregroundColor: AppColors.textPrimary,
    ),
    cardTheme: CardThemeData(
      color: AppColors.card,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: const BorderSide(color: AppColors.border),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: AppColors.card,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      titleTextStyle: AppText.subPageTitle,
      contentTextStyle: font(kBodyFont, 14, 500, color: AppColors.textSecondary),
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: AppColors.card,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.bg,
      hintStyle: font(kBodyFont, 14, 500, color: AppColors.textMuted),
      labelStyle: font(kBodyFont, 14, 500, color: AppColors.textSecondary),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: AppColors.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: AppColors.indigo, width: 1.6),
      ),
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
    ),
    switchTheme: SwitchThemeData(
      thumbColor: const WidgetStatePropertyAll(Colors.white),
      trackColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected)
            ? AppColors.indigo
            : const Color(0xFF3A3446),
      ),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
    ),
    dividerTheme: const DividerThemeData(color: AppColors.divider, thickness: 1),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: AppColors.card,
      contentTextStyle: font(kBodyFont, 13.5, 500),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: AppColors.card,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: AppColors.border),
      ),
      textStyle: font(kBodyFont, 14, 500, color: AppColors.textPrimary),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: AppColors.indigo,
        textStyle: font(kBodyFont, 14, 700),
      ),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: AppColors.indigo,
    ),
  );
}
