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

  void _confirmSplit() => _act(
        (familyId) =>
            ref.read(apiClientProvider).resolveConflict(familyId, _conflict.id),
        'Split applied — new pick-up / drop-off tasks to claim',
      );

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
          Text(splittable ? 'AFTER THE SPLIT' : 'THE OVERLAP',
              style: AppText.eyebrow()),
          const SizedBox(height: 10),
          if (splittable) ...[
            if (hasBefore) ...[
              _SegmentBlock(
                title: _titleOf(loser),
                timeLabel: friendlyRange(lStart, wStart),
                accent: _memberColor,
              ),
              const SizedBox(height: 7),
            ],
            _SegmentBlock(
              title: _titleOf(winner),
              timeLabel: _rangeLabel(winner),
              accent: AppColors.indigo,
              badge: 'Kept',
            ),
            if (hasAfter) ...[
              const SizedBox(height: 7),
              _SegmentBlock(
                title: _titleOf(loser),
                timeLabel: friendlyRange(wEnd, lEnd),
                accent: _memberColor,
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
/// and its (post-split) time range, with an optional status badge.
class _SegmentBlock extends StatelessWidget {
  const _SegmentBlock({
    required this.title,
    required this.timeLabel,
    required this.accent,
    this.badge,
  });

  final String title;
  final String timeLabel;
  final Color accent;
  final String? badge;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [AppColors.tint(accent, 0.18), AppColors.tint(accent, 0.08)],
        ),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: accent.withValues(alpha: 0.55)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: font(kBodyFont, 13, 600, color: AppColors.textPrimary),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis),
                const SizedBox(height: 2),
                Text(timeLabel,
                    style: font(kBodyFont, 11, 500, color: AppColors.textTertiary)),
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
