import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
  // double (the raw drag accumulator) and resolved through [_resolveTravel] when
  // displayed / sent.
  bool _beforeNeeded = true;
  bool _afterNeeded = true;
  // Seeded with the backend's estimate of the trip between the two places
  // (null when either end isn't geocoded — then the handles start at zero, as
  // they always did). Getting there and coming back is the same trip, so both
  // start at the same number; dragging either handle takes over from there.
  late double _travelBefore =
      (widget.conflict.suggestedTravelMin ?? 0).toDouble();
  late double _travelAfter =
      (widget.conflict.suggestedTravelMin ?? 0).toDouble();

  /// Vertical drag sensitivity — logical px per minute. Deliberately coarse: at
  /// the original 1.4px/min a thumb-sized twitch swung travel by 15+ minutes,
  /// which made a specific number nearly unhittable.
  static const _pxPerMin = 3.0;

  /// Travel resolves to whole 5-minute steps, so a drag lands on a round number
  /// (15px of movement per step) instead of an arbitrary minute.
  static const _travelStepMin = 5;

  /// Travel is capped so the child never leaves school more than 2h early / late
  /// (and never past the half's own length).
  static const _travelMax = 120;

  /// The preview is a zoomed window on the conflict: the appointment and the
  /// travel buffers are drawn to one scale, so 30 minutes of travel reads as half
  /// of a one-hour appointment. This caps that scale, so a 10-minute conflict
  /// doesn't balloon into a screenful.
  static const _maxZoom = 2.2;

  /// The travel minutes a raw drag accumulator resolves to: snapped to
  /// [_travelStepMin] and held within the half's own slack. A [max] that isn't a
  /// multiple of the step is still reachable — it's what the very end of the
  /// drag range gives.
  double _resolveTravel(double raw, double max) {
    final clamped = raw.clamp(0.0, max);
    if (clamped >= max) return max;
    final stepped = (clamped / _travelStepMin).round() * _travelStepMin.toDouble();
    return math.min(stepped, max);
  }

  /// Logical px per minute for the to-scale part of the preview (the appointment
  /// and the travel gaps). Derived from the conflict's own dimensions — the
  /// appointment's length plus the most travel it could ever take — so even a
  /// fully dragged-out split fits the sheet's timeline budget, and so the zoom
  /// never shifts under the finger while a handle is being dragged.
  double _zoom(int winnerMin, double maxTravel) {
    final budget = (MediaQuery.of(context).size.height * 0.34).clamp(180.0, 320.0);
    final span = winnerMin + maxTravel;
    if (span <= 0) return _maxZoom;
    return math.min(_maxZoom, budget / span);
  }

  /// Applies a drag delta to one half's travel buffer, ticking a selection haptic
  /// each time the resolved 5-minute step changes — the same feedback a picker
  /// gives, so the steps are felt rather than watched.
  void _dragTravel({required bool before, required double dy, required double max}) {
    final raw = before ? _travelBefore : _travelAfter;
    // Up shortens the morning half (an earlier pick-up); down lengthens the
    // afternoon's lead-in (a later drop-off).
    final next = (before ? raw - dy / _pxPerMin : raw + dy / _pxPerMin)
        .clamp(0.0, max);
    final stepped = _resolveTravel(next, max) != _resolveTravel(raw, max);
    setState(() {
      if (before) {
        _travelBefore = next;
      } else {
        _travelAfter = next;
      }
    });
    if (stepped) HapticFeedback.selectionClick();
  }

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

  /// Sends the split. The travel minutes come from the build that drew the
  /// preview, so what's sent is exactly the snapped, slack-clamped number the
  /// halves were labelled with.
  void _confirmSplit(int travelBeforeMin, int travelAfterMin) {
    final bothGone = !_beforeNeeded && !_afterNeeded;
    _act(
      (familyId) => ref.read(apiClientProvider).resolveConflict(
            familyId,
            _conflict.id,
            travelBeforeMin: _beforeNeeded ? travelBeforeMin : 0,
            travelAfterMin: _afterNeeded ? travelAfterMin : 0,
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
    final travelBefore = _resolveTravel(_travelBefore, maxBefore);
    final travelAfter = _resolveTravel(_travelAfter, maxAfter);
    final beforeEnd = wStart.subtract(Duration(minutes: travelBefore.round()));
    final afterStart = wEnd?.add(Duration(minutes: travelAfter.round()));

    // The to-scale part of the window: one zoom shared by the appointment and
    // both travel gaps, so their heights read as their durations. The two halves
    // stay a fixed height — they're the clipped context either side of the window
    // (often hours of school day), not segments being measured. Heights are
    // minimums: a segment the zoom would draw thinner than its own label keeps
    // the label's height instead of clipping it.
    final winnerMin = splittable ? wEnd!.difference(wStart).inMinutes : 0;
    final zoom = _zoom(winnerMin, maxBefore + maxAfter);
    final winnerH = winnerMin * zoom;

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
                onDragMinutes: (dy) =>
                    _dragTravel(before: true, dy: dy, max: maxBefore),
              ),
              if (_beforeNeeded && travelBefore.round() > 0) ...[
                const SizedBox(height: 7),
                _TravelGapBlock(
                  minutes: travelBefore.round(),
                  height: travelBefore * zoom,
                ),
              ],
              const SizedBox(height: 7),
            ],
            _FixedBlock(
              title: _titleOf(winner),
              timeLabel: _rangeLabel(winner),
              height: winnerH,
            ),
            if (hasAfter) ...[
              if (_afterNeeded && travelAfter.round() > 0) ...[
                const SizedBox(height: 7),
                _TravelGapBlock(
                  minutes: travelAfter.round(),
                  height: travelAfter * zoom,
                ),
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
                onDragMinutes: (dy) =>
                    _dragTravel(before: false, dy: dy, max: maxAfter),
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
            onTap: _busy
                ? null
                : () => _confirmSplit(travelBefore.round(), travelAfter.round()),
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
    this.trailing,
    this.dimmed = false,
    this.compact = false,
  });

  final String title;
  final String timeLabel;
  final Color accent;
  final String? badge;

  /// An arbitrary top-right control (the editable half's trash / restore
  /// button). Takes precedence over [badge].
  final Widget? trailing;
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
        crossAxisAlignment: CrossAxisAlignment.start,
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
          if (trailing != null) ...[
            const SizedBox(width: 8),
            trailing!,
          ] else if (badge != null) ...[
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

/// The rail reserved on the right of each editable half for its drag handle,
/// matching the design's 108px rail.
const double _railWidth = 108;
const double _connectorWidth = 14;

/// One editable half of the split (design §8b): a narrower event block on the
/// left — with a trash / restore button in its top-right to drop or keep the
/// half — and a green drag handle in the right-hand rail, pinned to the block's
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

  /// Called with the vertical drag delta since the previous update (logical px,
  /// down-positive).
  final ValueChanged<double> onDragMinutes;

  static const double _blockH = 58;

  @override
  Widget build(BuildContext context) {
    // The block fills the row; the drag handle straddles the appointment-facing
    // edge, painting into the rail beside the neighbouring segment (Stack clip is
    // off), so the visible block-to-segment gaps stay tight and even.
    final handleY = handleAtBottom ? _blockH : 0.0;

    return LayoutBuilder(builder: (context, c) {
      final blockW = c.maxWidth - _railWidth;
      final controlLeft = blockW + _connectorWidth;
      return SizedBox(
        height: _blockH,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            // The (narrower) event block, with the trash / restore control.
            Positioned(
              left: 0,
              top: 0,
              width: blockW,
              height: _blockH,
              child: _SegmentBlock(
                title: title,
                timeLabel: needed ? timeLabel : notNeededLabel,
                accent: accent,
                dimmed: !needed,
                compact: true,
                trailing: _RemoveButton(needed: needed, onTap: onToggle),
              ),
            ),
            // The green drag handle, pinned to the appointment-facing edge.
            if (needed) ...[
              Positioned(
                left: blockW,
                top: handleY - 0.75,
                child: Container(
                    width: _connectorWidth,
                    height: 1.5,
                    color: AppColors.green.withValues(alpha: 0.6)),
              ),
              Positioned(
                // Centred on the edge: back off half the pill plus the
                // transparent grab margin the handle pads itself with.
                left: controlLeft - 4,
                top: handleY -
                    _DragHandle.height / 2 -
                    _DragHandle.touchPadding,
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
}

/// The trash (drop the half) / restore (keep it) button in a half's top-right.
class _RemoveButton extends StatelessWidget {
  const _RemoveButton({required this.needed, required this.onTap});
  final bool needed;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.only(left: 6),
        child: Icon(
          needed ? Icons.delete_outline_rounded : Icons.undo_rounded,
          size: 18,
          color: needed ? AppColors.textMuted : AppColors.indigo,
        ),
      ),
    );
  }
}

/// The higher-priority winner ("Fixed") block — indigo, at the same reduced
/// width as the editable halves so the split reads as one stack. Inside the
/// timeline window it's drawn [height] tall, which is its duration at the
/// preview's zoom.
class _FixedBlock extends StatelessWidget {
  const _FixedBlock({
    required this.title,
    required this.timeLabel,
    this.height,
    this.fullWidth = false,
  });

  final String title;
  final String timeLabel;

  /// The block's to-scale height — a minimum, so a short appointment still shows
  /// its title and time. Null outside the timeline window (the all-day /
  /// open-ended case, where there's no duration to draw).
  final double? height;
  final bool fullWidth;

  @override
  Widget build(BuildContext context) {
    Widget block = _SegmentBlock(
      title: title,
      timeLabel: timeLabel,
      accent: AppColors.indigo,
      badge: 'Fixed',
    );
    if (height != null) {
      block = ConstrainedBox(
        constraints: BoxConstraints(minHeight: height!),
        child: block,
      );
    }
    if (fullWidth) return block;
    return Padding(
      padding: const EdgeInsets.only(right: _railWidth),
      child: block,
    );
  }
}

/// The green, grip-dotted drag handle ("Pick-up · 10:30" / "Drop-off · 12:30").
/// Dragging it vertically adds or removes travel time.
class _DragHandle extends StatefulWidget {
  const _DragHandle({required this.label, required this.onDragMinutes});
  final String label;

  /// Called with the vertical pointer movement since the previous update
  /// (logical px, down-positive).
  final ValueChanged<double> onDragMinutes;

  /// The visible pill's height, and the transparent margin around it that's
  /// still draggable — the pill alone is a small target, and a near-miss used to
  /// land on the sheet and scroll it instead.
  static const double height = 26;
  static const double touchPadding = 10;

  @override
  State<_DragHandle> createState() => _DragHandleState();
}

class _DragHandleState extends State<_DragHandle> {
  /// Where the pointer was at the last update, in *global* coordinates. The
  /// handle moves around while you drag it (a travel-gap block appearing above
  /// the afternoon half shifts the handle down, and the sheet itself grows), and
  /// local deltas would fold that movement into the value.
  double _lastGlobalY = 0;

  void _onStart(DragStartDetails d) => _lastGlobalY = d.globalPosition.dy;

  void _onUpdate(DragUpdateDetails d) {
    final dy = d.globalPosition.dy - _lastGlobalY;
    _lastGlobalY = d.globalPosition.dy;
    widget.onDragMinutes(dy);
  }

  @override
  Widget build(BuildContext context) {
    return RawGestureDetector(
      behavior: HitTestBehavior.opaque,
      gestures: <Type, GestureRecognizerFactory>{
        _HandleDragRecognizer:
            GestureRecognizerFactoryWithHandlers<_HandleDragRecognizer>(
          () => _HandleDragRecognizer(debugOwner: this),
          (r) => r
            ..onStart = _onStart
            ..onUpdate = _onUpdate,
        ),
      },
      child: MouseRegion(
        cursor: SystemMouseCursors.resizeUpDown,
        child: Padding(
          padding: const EdgeInsets.symmetric(
              vertical: _DragHandle.touchPadding, horizontal: 4),
          child: Container(
            height: _DragHandle.height,
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
                Text(widget.label,
                    style: font(kBodyFont, 10, 700, color: const Color(0xFFEAFFF5))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The handle's vertical-drag recognizer. It claims the pointer the moment it
/// lands on the handle instead of waiting out the drag slop, so the enclosing
/// scroll view / bottom sheet never wins the gesture — that's what made the
/// sheet slide under the finger and the minutes jump when it sprang back.
class _HandleDragRecognizer extends VerticalDragGestureRecognizer {
  _HandleDragRecognizer({super.debugOwner});

  @override
  void addAllowedPointer(PointerDownEvent event) {
    super.addAllowedPointer(event);
    resolve(GestureDisposition.accepted);
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
/// the appointment, at the halves' reduced width. [height] is the gap's own
/// duration at the preview's zoom — a minimum, so a five-minute buffer still fits
/// its label, and a longer one visibly takes longer.
class _TravelGapBlock extends StatelessWidget {
  const _TravelGapBlock({required this.minutes, required this.height});
  final int minutes;
  final double height;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: _railWidth),
      child: Container(
        width: double.infinity,
        constraints: BoxConstraints(minHeight: height),
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
