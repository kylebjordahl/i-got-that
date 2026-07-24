import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../util/format.dart';
import '../widgets/app_bottom_nav.dart';
import '../widgets/primitives.dart';

/// The richer conflict-resolution bottom sheet (design §8b), shared by the Plan
/// timeline's double-booked indicator and Home's "Double-booked" card.
///
/// A conflict is one member's unified calendar overlapping itself — they can't
/// be in two places at once. The higher-priority [Conflict.winner] (a manually
/// added event outranks a source-feed one) is kept as-is; the lower-priority
/// [Conflict.loser] is split/trimmed around it. The sheet names both events,
/// previews the exact segments the split would leave behind, and offers the two
/// terminal actions:
///
///  * **Confirm split** → `POST /conflicts/:id/resolve` — trims the loser around
///    the winner; task-gen then spawns a drop-off + pick-up at each new segment
///    boundary (they land as claimable edge tabs on Plan).
///  * **Ignore conflict** → `POST /conflicts/:id/dismiss` — acknowledge the
///    double-book and leave both events exactly as scheduled.
Future<void> showConflictResolution(
  BuildContext context,
  WidgetRef ref,
  Conflict conflict, {
  Member? member,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _ConflictResolutionSheet(conflict: conflict, member: member),
  );
}

class _ConflictResolutionSheet extends ConsumerStatefulWidget {
  const _ConflictResolutionSheet({required this.conflict, this.member});

  final Conflict conflict;
  final Member? member;

  @override
  ConsumerState<_ConflictResolutionSheet> createState() =>
      _ConflictResolutionSheetState();
}

class _ConflictResolutionSheetState
    extends ConsumerState<_ConflictResolutionSheet> {
  bool _busy = false;

  // Resolution parameters (design §8b), sent with "Confirm split". Travel is set
  // by dragging the pick-up / drop-off handles, so it's held as a continuous
  // double and rounded when displayed / sent.
  bool _beforeNeeded = true;
  bool _afterNeeded = true;
  double _travelBefore = 0;
  double _travelAfter = 0;

  /// Vertical drag sensitivity — logical px per minute (matches the design).
  static const _pxPerMin = 1.4;

  /// Travel is capped so the child never leaves school more than 2h early / late
  /// (and never past the half's own length).
  static const _travelMax = 120;

  Conflict get _conflict => widget.conflict;

  Color get _memberColor =>
      widget.member != null ? personColor(widget.member!) : AppColors.textSecondary;

  /// Refresh everything a resolve/dismiss touches: the conflict queue, the
  /// unified-calendar events (loser gets split), and the task lists (a split
  /// spawns a drop-off + pick-up).
  void _invalidate() {
    ref.invalidate(conflictsProvider);
    ref.invalidate(calendarEventsProvider);
    ref.invalidate(allTasksProvider);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(pendingDecisionsProvider);
  }

  Future<void> _act(
    Future<void> Function(String familyId) call,
    String successMessage,
  ) async {
    setState(() => _busy = true);
    try {
      final familyId = await ref.read(familyProvider.future);
      await call(familyId);
      _invalidate();
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(successMessage),
        margin: snackBarMarginAboveNav(context),
      ));
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('Couldn\'t update: $e'),
        margin: snackBarMarginAboveNav(context),
      ));
    }
  }

  void _confirmSplit() {
    final bothGone = !_beforeNeeded && !_afterNeeded;
    _act(
      (familyId) => ref.read(apiClientProvider).resolveConflict(
            familyId,
            _conflict.id,
            travelBeforeMin: _beforeNeeded ? _travelBefore.round() : 0,
            travelAfterMin: _afterNeeded ? _travelAfter.round() : 0,
            beforeNeeded: _beforeNeeded,
            afterNeeded: _afterNeeded,
          ),
      bothGone
          ? 'Both halves marked not needed — the day was cleared'
          : 'Split applied — new pick-up / drop-off tasks to claim',
    );
  }

  void _ignore() => _act(
        (familyId) =>
            ref.read(apiClientProvider).dismissConflict(familyId, _conflict.id),
        'Conflict ignored — both events kept as scheduled',
      );

  @override
  Widget build(BuildContext context) {
    final loser = _conflict.loser;
    final winner = _conflict.winner;
    final memberName = widget.member?.relationName ?? 'this member';

    // The winner anchors the day shown in the header chip.
    final day = dayKey(winner.start);

    // The three segments a split would leave: the loser trimmed to before the
    // winner, the winner itself (kept), and the loser trimmed to after. A
    // segment only renders when it has real positive duration — a loser that
    // starts at the winner (or an all-day / open-ended event that can't be cut
    // on the timeline) collapses to just the two overlapping events.
    final splittable = !loser.allDay &&
        !winner.allDay &&
        loser.end != null &&
        winner.end != null;
    final lStart = loser.start.toLocal();
    final lEnd = loser.end?.toLocal();
    final wStart = winner.start.toLocal();
    final wEnd = winner.end?.toLocal();

    final hasBefore = splittable && wStart.isAfter(lStart);
    final hasAfter = splittable && lEnd!.isAfter(wEnd!);

    // How much slack each half has for a travel buffer (can't eat past its own
    // length), and the resulting live-adjusted half boundaries.
    final beforeAvail = hasBefore ? wStart.difference(lStart).inMinutes : 0;
    final afterAvail = hasAfter ? lEnd.difference(wEnd).inMinutes : 0;
    final maxBefore = math.min(_travelMax, beforeAvail).toDouble();
    final maxAfter = math.min(_travelMax, afterAvail).toDouble();
    final travelBefore = _travelBefore.clamp(0.0, maxBefore);
    final travelAfter = _travelAfter.clamp(0.0, maxAfter);
    final beforeEnd = wStart.subtract(Duration(minutes: travelBefore.round()));
    final afterStart = wEnd?.add(Duration(minutes: travelAfter.round()));

    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(
          22, 4, 22, 24 + MediaQuery.of(context).viewInsets.bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Eyebrow: CONFLICT + member/day chip.
          Row(
            children: [
              Text('CONFLICT', style: AppText.eyebrow(AppColors.coral)),
              const Spacer(),
              _MemberDayChip(
                member: widget.member,
                label: '${widget.member?.relationName ?? 'Member'} · '
                    '${_shortDate(day)}',
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text('Two events, one $memberName', style: AppText.subPageTitle),
          const SizedBox(height: 10),
          // Why one wins: manual events outrank feed events.
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.info_outline_rounded,
                  size: 15, color: AppColors.textMuted),
              const SizedBox(width: 7),
              Expanded(
                child: Text(
                  'A manually added event always outranks a source-feed one, so '
                  '${_titleOf(winner)} stays put and ${_titleOf(loser)} is split '
                  'around it.',
                  style: font(kBodyFont, 12, 500,
                      color: AppColors.textTertiary, height: 1.45),
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
                splittable && (hasBefore || hasAfter)
                    ? 'DRAG TO ADJUST TIMING'
                    : (splittable ? 'AFTER THE SPLIT' : 'THE OVERLAP'),
                style: AppText.eyebrow()),
          ),
          const SizedBox(height: 12),
          if (splittable) ...[
            if (hasBefore) ...[
              _EditableHalf(
                title: _titleOf(loser),
                timeLabel: friendlyRange(lStart, beforeEnd),
                notNeededLabel: '$memberName skips the first half',
                accent: _memberColor,
                needed: _beforeNeeded,
                handleAtBottom: true,
                handleLabel: 'Pick-up · ${clockShort(beforeEnd)}',
                onToggle: () => setState(() => _beforeNeeded = !_beforeNeeded),
                onDragMinutes: (dy) => setState(() => _travelBefore =
                    (_travelBefore - dy / _pxPerMin).clamp(0.0, maxBefore)),
              ),
              if (_beforeNeeded && travelBefore.round() > 0) ...[
                const SizedBox(height: 7),
                _TravelGapBlock(minutes: travelBefore.round()),
              ],
              const SizedBox(height: 7),
            ],
            _FixedBlock(
              title: _titleOf(winner),
              timeLabel: _rangeLabel(winner),
            ),
            if (hasAfter) ...[
              if (_afterNeeded && travelAfter.round() > 0) ...[
                const SizedBox(height: 7),
                _TravelGapBlock(minutes: travelAfter.round()),
              ],
              const SizedBox(height: 7),
              _EditableHalf(
                title: _titleOf(loser),
                timeLabel: friendlyRange(afterStart!, lEnd),
                notNeededLabel: '$memberName skips the second half',
                accent: _memberColor,
                needed: _afterNeeded,
                handleAtBottom: false,
                handleLabel: 'Drop-off · ${clockShort(afterStart)}',
                onToggle: () => setState(() => _afterNeeded = !_afterNeeded),
                onDragMinutes: (dy) => setState(() => _travelAfter =
                    (_travelAfter + dy / _pxPerMin).clamp(0.0, maxAfter)),
              ),
            ],
            if (!hasBefore && !hasAfter) ...[
              const SizedBox(height: 3),
              _NoteRow(
                'The visit covers the whole event, so confirming removes '
                '${_titleOf(loser)} for the day.',
              ),
            ],
          ] else ...[
            // Can't cut cleanly on the timeline (all-day / open-ended): just name
            // the two colliding events.
            _FixedBlock(
              title: _titleOf(winner),
              timeLabel: _rangeLabel(winner),
              fullWidth: true,
            ),
            const SizedBox(height: 7),
            _SegmentBlock(
              title: _titleOf(loser),
              timeLabel: _rangeLabel(loser),
              accent: _memberColor,
              badge: 'Split',
            ),
          ],
          const SizedBox(height: 22),
          // Terminal actions.
          _WideButton(
            label: 'Confirm split',
            icon: Icons.check_rounded,
            variant: _WideVariant.amber,
            busy: _busy,
            onTap: _busy ? null : _confirmSplit,
          ),
          const SizedBox(height: 9),
          _WideButton(
            label: 'Ignore conflict — keep both as-is',
            variant: _WideVariant.ghost,
            onTap: _busy ? null : _ignore,
          ),
        ],
      ),
    );
  }

  String _titleOf(ConflictEventRef e) => e.summary ?? 'An event';

  String _rangeLabel(ConflictEventRef e) {
    if (e.allDay) return 'All day';
    final end = e.end;
    if (end != null && end.isAfter(e.start)) return friendlyRange(e.start, end);
    return friendlyTime(e.start);
  }
}

/// "Thu, Jul 9" — compact date for the header chip.
String _shortDate(DateTime day) {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', //
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];
  return '${weekdayShort(day)}, ${months[day.month - 1]} ${day.day}';
}

/// The member + day chip in the sheet eyebrow (avatar dot + "Theo · Thu Jul 9").
class _MemberDayChip extends StatelessWidget {
  const _MemberDayChip({required this.label, this.member});

  final Member? member;
  final String label;

  @override
  Widget build(BuildContext context) {
    final color = member != null ? personColor(member!) : AppColors.textSecondary;
    return Container(
      padding: const EdgeInsets.fromLTRB(5, 4, 10, 4),
      decoration: BoxDecoration(
        color: AppColors.tint(color, 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (member != null)
            PersonAvatar(
                initial: initialFor(member!.relationName),
                color: color,
                size: 16)
          else
            const Icon(Icons.event_busy_rounded,
                size: 16, color: AppColors.textSecondary),
          const SizedBox(width: 6),
          Text(label, style: font(kBodyFont, 12, 600, color: AppColors.textPrimary)),
        ],
      ),
    );
  }
}

/// One segment in the split preview: a tinted, bordered block naming the event
/// and its (post-split) time range, with an optional status badge. A [dimmed]
/// block (a half marked "not needed") drops to a muted, dashed-looking treatment.
class _SegmentBlock extends StatelessWidget {
  const _SegmentBlock({
    required this.title,
    required this.timeLabel,
    required this.accent,
    this.badge,
    this.dimmed = false,
    this.compact = false,
  });

  final String title;
  final String timeLabel;
  final Color accent;
  final String? badge;
  final bool dimmed;

  /// Tighter padding + a clip, for a fixed-height block inside [_EditableHalf].
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final borderColor = dimmed
        ? AppColors.textMuted.withValues(alpha: 0.35)
        : accent.withValues(alpha: 0.55);
    final titleColor = dimmed ? AppColors.textSecondary : AppColors.textPrimary;
    return Container(
      clipBehavior: compact ? Clip.antiAlias : Clip.none,
      padding: EdgeInsets.symmetric(horizontal: 13, vertical: compact ? 6 : 11),
      decoration: BoxDecoration(
        gradient: dimmed
            ? null
            : LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [AppColors.tint(accent, 0.18), AppColors.tint(accent, 0.08)],
              ),
        color: dimmed ? AppColors.bg.withValues(alpha: 0.4) : null,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: borderColor),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: font(kBodyFont, 13, 600, color: titleColor),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis),
                const SizedBox(height: 2),
                Text(timeLabel,
                    style: font(kBodyFont, 11, 500,
                        color: dimmed ? AppColors.textMuted : AppColors.textTertiary)),
              ],
            ),
          ),
          if (badge != null) ...[
            const SizedBox(width: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: AppColors.tint(accent, 0.16),
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(badge!,
                  style: font(kBodyFont, 9.5, 700, color: accent, letterSpacing: 0.3)),
            ),
          ],
        ],
      ),
    );
  }
}

/// The rail reserved on the right of each editable half for its controls (the
/// "Not needed" pill and the drag handle), matching the design's 108px rail.
const double _railWidth = 108;
const double _connectorWidth = 14;

/// One editable half of the split (design §8b): a narrower event block on the
/// left, with a right-hand rail holding a "Not needed" toggle (vertically
/// centred) and a green drag handle pinned to the block's inner edge — the
/// appointment-facing edge (bottom for the morning half, top for the afternoon).
/// Dragging the handle vertically adds/removes travel time.
class _EditableHalf extends StatelessWidget {
  const _EditableHalf({
    required this.title,
    required this.timeLabel,
    required this.notNeededLabel,
    required this.accent,
    required this.needed,
    required this.handleAtBottom,
    required this.handleLabel,
    required this.onToggle,
    required this.onDragMinutes,
  });

  final String title;
  final String timeLabel;
  final String notNeededLabel;
  final Color accent;
  final bool needed;

  /// Which edge the drag handle straddles — the one facing the appointment.
  final bool handleAtBottom;
  final String handleLabel;
  final VoidCallback onToggle;

  /// Called with the vertical drag delta (logical px, down-positive).
  final ValueChanged<double> onDragMinutes;

  // The block is fixed-height with room reserved on the handle side so the
  // straddling handle stays inside the widget's own bounds (no sibling overlap).
  static const double _blockH = 58;
  static const double _slack = 13; // half the handle height
  static const double _totalH = _blockH + _slack;

  @override
  Widget build(BuildContext context) {
    final blockTop = handleAtBottom ? 0.0 : _slack;
    final blockCenter = blockTop + _blockH / 2;
    final handleY = handleAtBottom ? blockTop + _blockH : blockTop;

    return LayoutBuilder(builder: (context, c) {
      final blockW = c.maxWidth - _railWidth;
      final controlLeft = blockW + _connectorWidth;
      return SizedBox(
        height: _totalH,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            // The (narrower) event block.
            Positioned(
              left: 0,
              top: blockTop,
              width: blockW,
              height: _blockH,
              child: _SegmentBlock(
                title: title,
                timeLabel: needed ? timeLabel : notNeededLabel,
                accent: accent,
                dimmed: !needed,
                compact: true,
              ),
            ),
            // "Not needed" / "Undo" pill in the rail, vertically centred.
            _connector(top: blockCenter, left: blockW, active: !needed),
            Positioned(
              left: controlLeft,
              top: blockCenter - 12,
              child: _NotNeededPill(needed: needed, onTap: onToggle),
            ),
            // The green drag handle, pinned to the appointment-facing edge.
            if (needed) ...[
              _connector(top: handleY, left: blockW, green: true),
              Positioned(
                left: controlLeft,
                top: handleY - 13,
                child: _DragHandle(
                  label: handleLabel,
                  onDragMinutes: onDragMinutes,
                ),
              ),
            ],
          ],
        ),
      );
    });
  }

  /// A short horizontal tick joining the block's right edge to a rail control.
  Widget _connector({
    required double top,
    required double left,
    bool green = false,
    bool active = false,
  }) {
    final color = green
        ? AppColors.green.withValues(alpha: 0.6)
        : active
            ? AppColors.indigo.withValues(alpha: 0.4)
            : Colors.white.withValues(alpha: 0.22);
    return Positioned(
      left: left,
      top: top - 0.75,
      child: Container(width: _connectorWidth, height: 1.5, color: color),
    );
  }
}

/// The higher-priority winner ("Fixed") block — indigo, at the same reduced
/// width as the editable halves so the split reads as one stack.
class _FixedBlock extends StatelessWidget {
  const _FixedBlock({
    required this.title,
    required this.timeLabel,
    this.fullWidth = false,
  });

  final String title;
  final String timeLabel;
  final bool fullWidth;

  @override
  Widget build(BuildContext context) {
    final block = _SegmentBlock(
      title: title,
      timeLabel: timeLabel,
      accent: AppColors.indigo,
      badge: 'Fixed',
    );
    if (fullWidth) return block;
    return Padding(
      padding: const EdgeInsets.only(right: _railWidth),
      child: block,
    );
  }
}

/// The per-half "Not needed" → "Undo" toggle pill (dashed when kept, solid
/// indigo when the half is dropped).
class _NotNeededPill extends StatelessWidget {
  const _NotNeededPill({required this.needed, required this.onTap});
  final bool needed;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final dropped = !needed;
    final color = dropped ? AppColors.indigo : AppColors.textSecondary;
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        constraints: const BoxConstraints(minHeight: 24),
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
        decoration: BoxDecoration(
          color: dropped ? AppColors.tint(AppColors.indigo, 0.12) : AppColors.bg,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: dropped
                ? AppColors.indigo.withValues(alpha: 0.6)
                : Colors.white.withValues(alpha: 0.3),
          ),
        ),
        child: Text(dropped ? 'Undo' : 'Not needed',
            style: font(kBodyFont, 10, 600, color: color)),
      ),
    );
  }
}

/// The green, grip-dotted drag handle ("Pick-up · 10:30" / "Drop-off · 12:30").
/// Dragging it vertically adds or removes travel time.
class _DragHandle extends StatelessWidget {
  const _DragHandle({required this.label, required this.onDragMinutes});
  final String label;
  final ValueChanged<double> onDragMinutes;

  @override
  Widget build(BuildContext context) {
    // Raw pointer events (like the design's onPointerDown/Move/Up) so the drag
    // isn't swallowed by the enclosing scroll view's gesture arena.
    return Listener(
      behavior: HitTestBehavior.opaque,
      onPointerMove: (e) => onDragMinutes(e.delta.dy),
      child: MouseRegion(
        cursor: SystemMouseCursors.resizeUpDown,
        child: Container(
          height: 26,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          decoration: BoxDecoration(
            color: const Color(0xFF172B23),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.green.withValues(alpha: 0.65)),
            boxShadow: const [
              BoxShadow(color: Color(0x59000000), blurRadius: 6, offset: Offset(0, 2)),
            ],
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const _GripDots(),
              const SizedBox(width: 6),
              Text(label, style: font(kBodyFont, 10, 700, color: const Color(0xFFEAFFF5))),
            ],
          ),
        ),
      ),
    );
  }
}

/// The 2×3 grip-dot glyph on a drag handle.
class _GripDots extends StatelessWidget {
  const _GripDots();

  @override
  Widget build(BuildContext context) {
    Widget dot() => Container(
          width: 2.6,
          height: 2.6,
          decoration: const BoxDecoration(color: AppColors.green, shape: BoxShape.circle),
        );
    Widget col() => Column(
          mainAxisSize: MainAxisSize.min,
          children: [dot(), const SizedBox(height: 2.5), dot(), const SizedBox(height: 2.5), dot()],
        );
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [col(), const SizedBox(width: 2.5), col()],
    );
  }
}

/// The amber, dashed-outline travel-time gap block shown between a kept half and
/// the appointment, at the halves' reduced width.
class _TravelGapBlock extends StatelessWidget {
  const _TravelGapBlock({required this.minutes});
  final int minutes;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: _railWidth),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: AppColors.tint(AppColors.amber, 0.06),
          borderRadius: BorderRadius.circular(9),
          border: Border.all(color: AppColors.amber.withValues(alpha: 0.6)),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.directions_walk_rounded, size: 13, color: AppColors.amber),
            const SizedBox(width: 6),
            Text('Travel time · $minutes min',
                style: font(kBodyFont, 10, 700, color: AppColors.amber)),
          ],
        ),
      ),
    );
  }
}

/// A muted explanatory row inside the preview (e.g. the loser is fully covered).
class _NoteRow extends StatelessWidget {
  const _NoteRow(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        color: AppColors.tint(AppColors.amber, 0.06),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.amber.withValues(alpha: 0.4)),
      ),
      child: Text(text,
          style: font(kBodyFont, 11.5, 500, color: AppColors.textTertiary, height: 1.4)),
    );
  }
}

enum _WideVariant { amber, ghost }

/// Full-width sheet action button (48px), matching the design's footer CTAs.
class _WideButton extends StatelessWidget {
  const _WideButton({
    required this.label,
    required this.variant,
    required this.onTap,
    this.icon,
    this.busy = false,
  });

  final String label;
  final _WideVariant variant;
  final VoidCallback? onTap;
  final IconData? icon;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final amber = variant == _WideVariant.amber;
    final fg = amber ? const Color(0xFF2A1A06) : AppColors.textPrimary;
    return Material(
      color: amber ? AppColors.amber : Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(15),
        side: amber
            ? BorderSide.none
            : const BorderSide(color: Color(0x24FFFFFF)),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(15),
        child: SizedBox(
          height: 48,
          child: Center(
            child: busy
                ? SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2.4, color: fg),
                  )
                : Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (icon != null) ...[
                        Icon(icon, size: 17, color: fg),
                        const SizedBox(width: 8),
                      ],
                      Text(label, style: font(kBodyFont, 14.5, 700, color: fg)),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}
