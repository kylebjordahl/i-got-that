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

  // Resolution parameters (design §8b), sent with "Confirm split".
  bool _beforeNeeded = true;
  bool _afterNeeded = true;
  int _travelBeforeMin = 0;
  int _travelAfterMin = 0;

  /// Travel is stepped in 5-minute increments, up to 2 hours.
  static const _travelStep = 5;
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
            travelBeforeMin: _beforeNeeded ? _travelBeforeMin : 0,
            travelAfterMin: _afterNeeded ? _travelAfterMin : 0,
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
    final travelBefore =
        _travelBeforeMin.clamp(0, math.min(_travelMax, beforeAvail)).toInt();
    final travelAfter =
        _travelAfterMin.clamp(0, math.min(_travelMax, afterAvail)).toInt();
    final beforeEnd = wStart.subtract(Duration(minutes: travelBefore));
    final afterStart = wEnd?.add(Duration(minutes: travelAfter));

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
          Row(
            children: [
              Text(splittable ? 'ADJUST THE SPLIT' : 'THE OVERLAP',
                  style: AppText.eyebrow()),
              if (splittable && (hasBefore || hasAfter)) ...[
                const SizedBox(width: 10),
                Expanded(
                  child: Text('mark a half not needed, or add travel time',
                      textAlign: TextAlign.right,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: font(kBodyFont, 10.5, 500, color: AppColors.textMuted)),
                ),
              ],
            ],
          ),
          const SizedBox(height: 10),
          if (splittable) ...[
            if (hasBefore) ...[
              _SegmentBlock(
                title: _titleOf(loser),
                timeLabel: _beforeNeeded
                    ? friendlyRange(lStart, beforeEnd)
                    : '$memberName skips this half',
                accent: _memberColor,
                dimmed: !_beforeNeeded,
              ),
              const SizedBox(height: 6),
              _HalfControls(
                needed: _beforeNeeded,
                travelLabel: 'Travel',
                travelMin: travelBefore,
                travelMax: math.min(_travelMax, beforeAvail),
                step: _travelStep,
                onToggle: () => setState(() => _beforeNeeded = !_beforeNeeded),
                onTravel: (v) => setState(() => _travelBeforeMin = v),
              ),
              if (_beforeNeeded && travelBefore > 0) ...[
                const SizedBox(height: 6),
                _TravelGap(minutes: travelBefore),
              ],
              const SizedBox(height: 8),
            ],
            _SegmentBlock(
              title: _titleOf(winner),
              timeLabel: _rangeLabel(winner),
              accent: AppColors.indigo,
              badge: 'Kept',
            ),
            if (hasAfter) ...[
              if (_afterNeeded && travelAfter > 0) ...[
                const SizedBox(height: 6),
                _TravelGap(minutes: travelAfter),
              ],
              const SizedBox(height: 8),
              _SegmentBlock(
                title: _titleOf(loser),
                timeLabel: _afterNeeded
                    ? friendlyRange(afterStart!, lEnd)
                    : '$memberName skips this half',
                accent: _memberColor,
                dimmed: !_afterNeeded,
              ),
              const SizedBox(height: 6),
              _HalfControls(
                needed: _afterNeeded,
                travelLabel: 'Travel',
                travelMin: travelAfter,
                travelMax: math.min(_travelMax, afterAvail),
                step: _travelStep,
                onToggle: () => setState(() => _afterNeeded = !_afterNeeded),
                onTravel: (v) => setState(() => _travelAfterMin = v),
              ),
            ],
            if (!hasBefore && !hasAfter) ...[
              const SizedBox(height: 7),
              _NoteRow(
                'The visit covers the whole event, so confirming removes '
                '${_titleOf(loser)} for the day.',
              ),
            ],
          ] else ...[
            // Can't cut cleanly on the timeline (all-day / open-ended): just name
            // the two colliding events.
            _SegmentBlock(
              title: _titleOf(winner),
              timeLabel: _rangeLabel(winner),
              accent: AppColors.indigo,
              badge: 'Kept',
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
  });

  final String title;
  final String timeLabel;
  final Color accent;
  final String? badge;
  final bool dimmed;

  @override
  Widget build(BuildContext context) {
    final borderColor = dimmed
        ? AppColors.textMuted.withValues(alpha: 0.35)
        : accent.withValues(alpha: 0.55);
    final titleColor = dimmed ? AppColors.textSecondary : AppColors.textPrimary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
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

/// The control rail for one splittable half: a "Not needed" / "Undo" toggle and,
/// while the half is kept, a travel-time stepper (adds a buffer between the half
/// and the appointment). Sits directly under the half's [_SegmentBlock].
class _HalfControls extends StatelessWidget {
  const _HalfControls({
    required this.needed,
    required this.travelLabel,
    required this.travelMin,
    required this.travelMax,
    required this.step,
    required this.onToggle,
    required this.onTravel,
  });

  final bool needed;
  final String travelLabel;
  final int travelMin;
  final int travelMax;
  final int step;
  final VoidCallback onToggle;
  final ValueChanged<int> onTravel;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        _ToggleChip(
          label: needed ? 'Not needed' : 'Undo — keep it',
          active: !needed,
          onTap: onToggle,
        ),
        const Spacer(),
        if (needed && travelMax > 0)
          _Stepper(
            label: travelLabel,
            value: travelMin,
            unit: 'min',
            onDec: travelMin > 0
                ? () => onTravel(math.max(0, travelMin - step))
                : null,
            onInc: travelMin < travelMax
                ? () => onTravel(math.min(travelMax, travelMin + step))
                : null,
          ),
      ],
    );
  }
}

/// A small outlined toggle chip (the per-half "Not needed").
class _ToggleChip extends StatelessWidget {
  const _ToggleChip({required this.label, required this.active, required this.onTap});
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = active ? AppColors.indigo : AppColors.textSecondary;
    return Material(
      color: active ? AppColors.tint(AppColors.indigo, 0.12) : Colors.transparent,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(999),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(999),
            border: Border.all(
              color: active ? AppColors.indigo.withValues(alpha: 0.6) : AppColors.border,
            ),
          ),
          child: Text(label, style: font(kBodyFont, 11.5, 600, color: color)),
        ),
      ),
    );
  }
}

/// A compact "− value unit +" stepper (the travel-time buffer). A null callback
/// disables that end (at the min/max bound).
class _Stepper extends StatelessWidget {
  const _Stepper({
    required this.label,
    required this.value,
    required this.unit,
    required this.onDec,
    required this.onInc,
  });
  final String label;
  final int value;
  final String unit;
  final VoidCallback? onDec;
  final VoidCallback? onInc;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: font(kBodyFont, 10.5, 600, color: AppColors.textMuted)),
        const SizedBox(width: 8),
        _StepBtn(icon: Icons.remove_rounded, onTap: onDec),
        SizedBox(
          width: 44,
          child: Text('$value $unit',
              textAlign: TextAlign.center,
              style: font(kBodyFont, 12, 700,
                  color: value > 0 ? AppColors.amber : AppColors.textSecondary)),
        ),
        _StepBtn(icon: Icons.add_rounded, onTap: onInc),
      ],
    );
  }
}

class _StepBtn extends StatelessWidget {
  const _StepBtn({required this.icon, required this.onTap});
  final IconData icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Material(
      color: AppColors.card,
      shape: const CircleBorder(),
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        child: Container(
          width: 28,
          height: 28,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: AppColors.border),
          ),
          child: Icon(icon,
              size: 16,
              color: enabled ? AppColors.textPrimary : AppColors.textMuted),
        ),
      ),
    );
  }
}

/// The amber travel-time gap chip shown between a kept half and the appointment.
class _TravelGap extends StatelessWidget {
  const _TravelGap({required this.minutes});
  final int minutes;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: AppColors.tint(AppColors.amber, 0.06),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: AppColors.amber.withValues(alpha: 0.5)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.directions_walk_rounded, size: 13, color: AppColors.amber),
          const SizedBox(width: 6),
          Text('Travel time · $minutes min',
              style: font(kBodyFont, 10.5, 700, color: AppColors.amber)),
        ],
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
