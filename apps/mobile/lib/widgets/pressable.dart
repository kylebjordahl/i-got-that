import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:material_ui/material_ui.dart';

/// Pointers already claimed by an inner [Pressable], so a `Pressable` around a
/// card doesn't also dip when the finger lands on a button inside it.
/// Pointer events reach the deepest listener first, so the inner one claims.
final _claimed = <int>{};

/// Press feedback: shrinks [child] slightly while a finger is down on it and
/// springs back on release, so a tap visibly "lands".
///
/// It listens to raw pointer events, so it never competes with the child's own
/// `InkWell` / `GestureDetector` for the tap. To behave like an `InkWell`
/// highlight anyway:
/// - the dip waits [kPressTimeout], so a scroll that starts on the item never
///   dips it (moving past [kTouchSlop] before then cancels it);
/// - a tap that ends sooner still shows the dip, for at least [_minHold];
/// - the innermost `Pressable` under the finger wins, ancestors stay put;
/// - pass `enabled: false` for a non-tappable child, and nothing ever scales
///   when the OS asks for reduced motion.
///
/// The tree is the same whether or not it is active, so toggling `enabled`
/// (a button going busy) never rebuilds the child's state.
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

  bool _down = false;
  bool _releaseWhenHeld = false;
  int? _pointer;
  Offset _origin = Offset.zero;
  Timer? _delay; // waiting out kPressTimeout before the dip starts
  Timer? _hold; // the dip's minimum on-screen time

  bool get _active =>
      widget.enabled && !MediaQuery.disableAnimationsOf(context);

  void _onDown(PointerDownEvent e) {
    // One finger at a time: a second touch on the same item is ignored.
    if (_pointer != null || !_active || !_claimed.add(e.pointer)) return;
    _pointer = e.pointer;
    _origin = e.position;
    _delay = Timer(kPressTimeout, _show);
  }

  void _show() {
    _delay = null;
    if (!mounted) return;
    setState(() => _down = true);
    _releaseWhenHeld = false;
    _hold?.cancel();
    late final Timer hold;
    hold = _hold = Timer(_minHold, () {
      if (identical(_hold, hold)) _hold = null;
      if (_releaseWhenHeld && mounted) setState(() => _down = false);
    });
  }

  void _release() {
    if (_hold != null) {
      _releaseWhenHeld = true;
    } else if (_down) {
      setState(() => _down = false);
    }
  }

  /// The finger came up: a tap that beat the press timeout still gets its dip.
  void _onUp(PointerUpEvent e) {
    if (e.pointer != _pointer) return;
    final quick = _delay != null;
    _end();
    if (quick) _show();
    _release();
  }

  /// The finger moved off (a scroll) or the gesture was cancelled.
  void _abandon() {
    if (_pointer == null) return;
    _end();
    _release();
  }

  void _end() {
    _delay?.cancel();
    _delay = null;
    _claimed.remove(_pointer);
    _pointer = null;
  }

  @override
  void didUpdateWidget(Pressable old) {
    super.didUpdateWidget(old);
    if (!widget.enabled) {
      _end();
      _hold?.cancel();
      _hold = null;
      _down = false;
    }
  }

  @override
  void dispose() {
    _end();
    _hold?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pressed = _down && _active;
    return Listener(
      onPointerDown: _onDown,
      onPointerMove: (e) {
        if (e.pointer == _pointer &&
            (e.position - _origin).distance > kTouchSlop) {
          _abandon();
        }
      },
      onPointerUp: _onUp,
      onPointerCancel: (e) {
        if (e.pointer == _pointer) _abandon();
      },
      child: AnimatedScale(
        scale: pressed ? widget.scale : 1,
        duration: Duration(milliseconds: pressed ? 90 : 200),
        curve: pressed ? Curves.easeOut : Curves.easeOutBack,
        child: widget.child,
      ),
    );
  }
}
