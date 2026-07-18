import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import 'app_bottom_nav.dart';

/// The shared confirm-sheet chrome for a [SlideToConfirm]-gated destructive
/// action: title, description, the slide control, and a Cancel fallback.
/// Shared by the Me screen's "Delete account" and the Family screen's "Delete
/// family"/"Leave family" flows so the destructive confirmations read as one
/// system.
///
/// When [blocked] is true, the slide control is omitted entirely — just the
/// (caller-supplied, blocked-specific) description and an "OK" dismissal.
/// Callers precompute [blocked] from state they already have (or a cheap
/// server check) so a guard the server would otherwise 409 on shows up front,
/// not as a toast surfaced after a failed slide.
Future<void> showSlideToConfirmSheet(
  BuildContext context, {
  required String title,
  required String description,
  required String slideLabel,
  required Future<void> Function() onConfirmed,
  required String Function(Object error) errorMessage,
  IconData icon = Icons.delete_forever_rounded,
  bool blocked = false,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => Padding(
      padding: EdgeInsets.fromLTRB(
          22, 4, 22, 28 + MediaQuery.of(sheetContext).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: AppText.subPageTitle),
          const SizedBox(height: 8),
          Text(description, style: AppText.subtitle),
          const SizedBox(height: 24),
          if (!blocked) ...[
            SlideToConfirm(
              label: slideLabel,
              icon: icon,
              onConfirmed: () async {
                await onConfirmed();
                // Let the checkmark flash briefly before closing — nothing else
                // pops this sheet, and a reactive state swap elsewhere in the
                // app isn't guaranteed to dismiss it.
                await Future<void>.delayed(const Duration(milliseconds: 500));
                if (sheetContext.mounted) Navigator.of(sheetContext).pop();
              },
              onError: (e) {
                if (!sheetContext.mounted) return;
                ScaffoldMessenger.of(sheetContext).showSnackBar(SnackBar(
                  content: Text(errorMessage(e)),
                  margin: snackBarMarginAboveNav(sheetContext),
                ));
              },
            ),
            const SizedBox(height: 12),
          ],
          Center(
            child: TextButton(
              onPressed: () => Navigator.of(sheetContext).pop(),
              child: Text(blocked ? 'OK' : 'Cancel'),
            ),
          ),
        ],
      ),
    ),
  );
}

/// A left-to-right slide gesture — the speedbump for an irreversible
/// destructive action (delete account, delete family). Harder to trigger by
/// accident than a tap + dialog, and reads unambiguously as "you meant to do
/// this."
class SlideToConfirm extends StatefulWidget {
  const SlideToConfirm({
    super.key,
    required this.label,
    required this.onConfirmed,
    this.onError,
    this.icon = Icons.chevron_right_rounded,
    this.color = AppColors.coral,
  });

  final String label;

  /// Invoked once the thumb reaches the end of the track.
  final Future<void> Function() onConfirmed;

  /// Called (instead of throwing) when [onConfirmed] fails; the thumb snaps
  /// back so the user can retry.
  final void Function(Object error)? onError;

  final IconData icon;
  final Color color;

  @override
  State<SlideToConfirm> createState() => _SlideToConfirmState();
}

class _SlideToConfirmState extends State<SlideToConfirm>
    with SingleTickerProviderStateMixin {
  static const _thumbSize = 44.0;
  static const _trackHeight = 52.0;
  static const _pad = 4.0;
  static const _confirmThreshold = 0.9;

  late final AnimationController _controller;
  Animation<double>? _snap;
  double _dragX = 0;
  bool _busy = false;
  bool _done = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 220),
    )..addListener(() {
        final snap = _snap;
        if (snap != null) setState(() => _dragX = snap.value);
      });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  double _maxDrag(double trackWidth) =>
      (trackWidth - _thumbSize - _pad * 2).clamp(0, double.infinity);

  void _animateTo(double target) {
    _snap = Tween<double>(begin: _dragX, end: target).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic),
    );
    _controller.forward(from: 0);
  }

  Future<void> _onDragEnd(double max) async {
    if (_busy || _done || max <= 0) return;
    if (_dragX < max * _confirmThreshold) {
      _animateTo(0);
      return;
    }
    setState(() {
      _busy = true;
      _dragX = max;
    });
    try {
      await widget.onConfirmed();
      if (mounted) setState(() => _done = true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      _animateTo(0);
      widget.onError?.call(e);
    }
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, constraints) {
      final max = _maxDrag(constraints.maxWidth);
      final progress = max == 0 ? 0.0 : (_dragX / max).clamp(0.0, 1.0);
      return GestureDetector(
        onHorizontalDragUpdate: (d) {
          if (_busy || _done) return;
          setState(() => _dragX = (_dragX + d.delta.dx).clamp(0, max));
        },
        onHorizontalDragEnd: (_) => _onDragEnd(max),
        child: Container(
          height: _trackHeight,
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: AppColors.tint(widget.color, 0.10),
            borderRadius: BorderRadius.circular(_trackHeight / 2),
            border: Border.all(color: widget.color.withValues(alpha: 0.5)),
          ),
          child: Stack(
            alignment: Alignment.centerLeft,
            children: [
              Positioned.fill(
                child: Center(
                  child: Opacity(
                    opacity: (1 - progress * 1.4).clamp(0.0, 1.0),
                    child: Text(
                      widget.label,
                      style: font(kBodyFont, 13.5, 700, color: widget.color),
                    ),
                  ),
                ),
              ),
              Positioned(
                left: _pad + _dragX,
                child: Container(
                  width: _thumbSize,
                  height: _thumbSize,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle),
                  child: _busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Color(0xFF2A1205),
                          ),
                        )
                      : Icon(
                          _done ? Icons.check_rounded : widget.icon,
                          color: const Color(0xFF2A1205),
                        ),
                ),
              ),
            ],
          ),
        ),
      );
    });
  }
}
