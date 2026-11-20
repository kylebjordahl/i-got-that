import 'package:flutter/material.dart';

/// Press feedback: shrinks [child] slightly while a finger is down on it and
/// springs back on release, so a tap visibly "lands".
///
/// It listens with a raw [Listener] instead of a gesture recognizer, so it
/// never competes with the child's own `InkWell` / `GestureDetector` (or a
/// scroll view) in the gesture arena — wrap a tappable and it just works.
///
/// - Pass `enabled: false` for a non-tappable child; it renders unchanged.
/// - A tap shorter than [_minHold] still shows the full dip before releasing.
/// - Dragging past [_slop] (a scroll, a swipe) releases the press.
/// - Does nothing when the OS asks for reduced motion.
class Pressable extends StatefulWidget {
  const Pressable({
    super.key,
    required this.child,
    this.enabled = true,
    this.scale = 0.97,
  });

  final Widget child;
  final bool enabled;

  /// Scale while pressed. Smaller targets can afford a deeper dip
  /// (~0.9); full-width cards want something subtler (~0.98).
  final double scale;

  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  static const _minHold = Duration(milliseconds: 80);
  static const _slop = 18.0;

  bool _down = false;
  Offset _origin = Offset.zero;
  DateTime _downAt = DateTime.fromMillisecondsSinceEpoch(0);

  void _press(PointerDownEvent e) {
    _origin = e.position;
    _downAt = DateTime.now();
    if (!_down) setState(() => _down = true);
  }

  void _release() {
    if (!_down) return;
    final held = DateTime.now().difference(_downAt);
    if (held >= _minHold) {
      setState(() => _down = false);
      return;
    }
    final downAt = _downAt;
    Future<void>.delayed(_minHold - held, () {
      // A newer press started in the meantime — leave it alone.
      if (mounted && _down && _downAt == downAt) setState(() => _down = false);
    });
  }

  void _move(PointerMoveEvent e) {
    if (_down && (e.position - _origin).distance > _slop) _release();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.enabled || MediaQuery.disableAnimationsOf(context)) {
      return widget.child;
    }
    return Listener(
      onPointerDown: _press,
      onPointerMove: _move,
      onPointerUp: (_) => _release(),
      onPointerCancel: (_) => _release(),
      child: AnimatedScale(
        scale: _down ? widget.scale : 1,
        duration: Duration(milliseconds: _down ? 90 : 200),
        curve: _down ? Curves.easeOut : Curves.easeOutBack,
        child: widget.child,
      ),
    );
  }
}
