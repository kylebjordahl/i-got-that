import 'dart:math' as math;

import 'package:flutter/material.dart';
import '../env.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';

/// A diagonal "BETA" ribbon across the top-right corner, shown only on staging
/// builds ([isStagingBuild]). Wraps the whole app via `MaterialApp.builder`, so
/// it rides above every screen, sheet and dialog.
///
/// On a non-staging build this is a pass-through: it adds no widget at all.
class EnvRibbon extends StatelessWidget {
  const EnvRibbon({
    super.key,
    required this.child,
    this.label = 'BETA',
    this.show = isStagingBuild,
  });

  final Widget child;
  final String label;

  /// Defaults to the build-time environment; injectable for tests.
  final bool show;

  @override
  Widget build(BuildContext context) {
    if (!show) return child;
    return Stack(
      textDirection: TextDirection.ltr,
      children: [
        child,
        // Hangs off the top of the safe area rather than the physical corner,
        // so it never fights the status bar / notch.
        Positioned(
          top: MediaQuery.paddingOf(context).top,
          right: 0,
          child: IgnorePointer(child: _CornerRibbon(label: label)),
        ),
      ],
    );
  }
}

class _CornerRibbon extends StatelessWidget {
  const _CornerRibbon({required this.label});

  final String label;

  /// Side of the square the ribbon is clipped to — its ends are cut flush with
  /// the top and right edges.
  static const _box = 86.0;

  @override
  Widget build(BuildContext context) {
    return ClipRect(
      child: SizedBox(
        width: _box,
        height: _box,
        child: Stack(
          children: [
            Positioned(
              top: 16,
              right: -34,
              child: Transform.rotate(
                angle: math.pi / 4,
                child: Container(
                  width: 128,
                  height: 20,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: [
                        AppColors.tint(AppColors.amber, 0.34),
                        AppColors.tint(AppColors.amber, 0.2),
                      ],
                    ),
                    border: Border.symmetric(
                      horizontal: BorderSide(
                        color: AppColors.amber.withValues(alpha: 0.4),
                      ),
                    ),
                  ),
                  child: Text(
                    label,
                    style: font(kBodyFont, 9.5, 700,
                        color: AppColors.amberHero, letterSpacing: 1.6),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
