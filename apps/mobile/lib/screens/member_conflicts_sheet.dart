import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../util/format.dart';
import '../widgets/conflict_card.dart';
import '../widgets/primitives.dart';
import 'conflict_resolution_sheet.dart';

/// The conflicts worth revisiting: in-progress or upcoming, i.e. the loser's
/// original span hasn't ended yet. All-day events compare by day (a bare
/// timestamp reads as "already past" for anything but the first instant of
/// today). Shared by the member-detail button (which only appears when this is
/// non-empty) and the sheet it opens, so both agree on what counts. Ordered by
/// when the overlap happens.
List<Conflict> upcomingConflicts(List<Conflict> all, {DateTime? asOf}) {
  final now = asOf ?? DateTime.now();
  return all.where((o) {
    final loser = o.loser;
    final end = loser.end ?? loser.start;
    if (loser.allDay) return !dayKey(end).isBefore(dayKey(now));
    return end.isAfter(now);
  }).toList()..sort((a, b) => a.winner.start.compareTo(b.winner.start));
}

/// How a conflict has been handled, as shown on its badge.
({String label, Color color}) conflictStatusBadge(String status) =>
    switch (status) {
      'resolved' => (label: 'Split', color: AppColors.green),
      'dismissed' => (label: 'Ignored', color: AppColors.textTertiary),
      _ => (label: 'Needs a decision', color: AppColors.amber),
    };

/// "Double-bookings" — every upcoming conflict on this member's calendar, with
/// a badge for how it was handled: still waiting on a decision, split around
/// the winner, or ignored (both events kept). Any decided one can be revisited,
/// which undoes it (unmasks the event, drops the split) and puts the overlap
/// back up for a fresh decision.
///
/// Opened from the Unified calendar section of member detail. `useRootNavigator`
/// puts it on MaterialApp's outer Navigator so it layers over the floating nav
/// pill rather than behind it (see [PersistentAppNav]).
Future<void> showMemberConflictsSheet(
  BuildContext context,
  Member member, {
  required bool canEdit,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _MemberConflictsSheet(member: member, canEdit: canEdit),
  );
}

class _MemberConflictsSheet extends ConsumerWidget {
  const _MemberConflictsSheet({required this.member, required this.canEdit});
  final Member member;
  final bool canEdit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Watched (not passed in) so a decision redraws the list in place.
    final conflicts = upcomingConflicts(
      ref.watch(memberConflictsProvider(member.id)).valueOrNull ??
          const <Conflict>[],
    );

    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          22,
          4,
          22,
          28 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('Double-bookings', style: AppText.subPageTitle),
                ),
                if (conflicts.isNotEmpty)
                  TintBadge('${conflicts.length}', color: AppColors.green),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              'Overlaps on ${member.relationName}\'s calendar and how each was '
              'handled. Revisit a decided one to undo it and put the overlap '
              'back up for a decision.',
              style: AppText.subtitle,
            ),
            const SizedBox(height: 14),
            if (conflicts.isEmpty)
              AppCard(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    'No upcoming double-bookings',
                    style: AppText.subtitle,
                  ),
                ),
              )
            else
              for (final o in conflicts) ...[
                _ConflictStatusCard(
                  conflict: o,
                  member: member,
                  onAct: !canEdit
                      ? null
                      : o.status == 'pending'
                      ? () => showConflictResolution(
                          context,
                          ref,
                          o,
                          member: member,
                        )
                      : () => _revisit(context, ref, o),
                ),
                const SizedBox(height: 10),
              ],
          ],
        ),
      ),
    );
  }

  Future<void> _revisit(BuildContext context, WidgetRef ref, Conflict o) async {
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).revertConflict(familyId, o.id);
      ref.invalidate(memberConflictsProvider(member.id));
      ref.invalidate(conflictsProvider);
      ref.invalidate(calendarEventsProvider);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text("Couldn't revisit: $e")));
      }
    }
  }
}

/// One conflict, laid out like Home's "Double-booked" card, tinted and badged
/// by how it was handled. Day on the left of the top line, the member on the
/// right, then both events in priority order: the one that wins, then the one
/// that would be (or was) trimmed around it. A split one marks the trimmed
/// event with the scissors, since the order alone no longer says which was cut.
class _ConflictStatusCard extends StatelessWidget {
  const _ConflictStatusCard({
    required this.conflict,
    required this.member,
    required this.onAct,
  });
  final Conflict conflict;
  final Member member;
  final VoidCallback? onAct;

  @override
  Widget build(BuildContext context) {
    // The higher-priority event anchors the day, as on Home.
    final day = dayHeading(dayKey(conflict.winner.start), DateTime.now());
    final badge = conflictStatusBadge(conflict.status);
    final pending = conflict.status == 'pending';
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.tint(badge.color, 0.07),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: badge.color.withValues(alpha: 0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [TintBadge(badge.label, color: badge.color)]),
          const SizedBox(height: 8),
          ConflictCardHeader(day: day, member: member),
          const SizedBox(height: 10),
          ConflictEventRow(event: conflict.winner, accent: badge.color),
          const SizedBox(height: 6),
          ConflictEventRow(
            event: conflict.loser,
            accent: badge.color,
            leadingIcon: conflict.status == 'resolved'
                ? Icons.content_cut_rounded
                : null,
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              // Ghost for a settled one — revisiting is the escape hatch, not
              // what the card is asking for. Pending is asking.
              Expanded(
                child: PillButton(
                  label: pending ? 'Decide' : 'Revisit',
                  variant: pending ? PillVariant.amber : PillVariant.ghost,
                  dense: true,
                  onPressed: onAct,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
