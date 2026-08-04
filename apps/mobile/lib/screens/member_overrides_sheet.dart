import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../util/format.dart';
import '../widgets/app_bottom_nav.dart';
import '../widgets/conflict_card.dart';
import '../widgets/primitives.dart';

/// The overrides worth reviewing: in-progress or upcoming, i.e. the loser's
/// original span hasn't ended yet. All-day events compare by day (a bare
/// timestamp reads as "already past" for anything but the first instant of
/// today). Shared by the member-detail button (which only appears when this is
/// non-empty) and the sheet it opens, so both agree on what counts.
List<Conflict> activeOverrides(List<Conflict> overrides, {DateTime? asOf}) {
  final now = asOf ?? DateTime.now();
  return overrides.where((o) {
    final loser = o.loser;
    final end = loser.end ?? loser.start;
    if (loser.allDay) return !dayKey(end).isBefore(dayKey(now));
    return end.isAfter(now);
  }).toList();
}

/// "Overrides in effect" — resolved conflicts (split/masked events) for this
/// member's in-progress or upcoming events. Lets an admin review and undo a bad
/// "split around it" call from Home: reverting unmasks the event and puts the
/// overlap back up for a fresh decision.
///
/// Opened from the Unified calendar section of member detail. `useRootNavigator`
/// puts it on MaterialApp's outer Navigator so it layers over the floating nav
/// pill rather than behind it (see [PersistentAppNav]).
Future<void> showMemberOverridesSheet(
  BuildContext context,
  Member member, {
  required bool canEdit,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _MemberOverridesSheet(member: member, canEdit: canEdit),
  );
}

class _MemberOverridesSheet extends ConsumerWidget {
  const _MemberOverridesSheet({required this.member, required this.canEdit});
  final Member member;
  final bool canEdit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Watched (not passed in) so a revert redraws the list in place — the last
    // one reverted leaves the empty state rather than a stale card.
    final overrides = activeOverrides(
      ref.watch(memberOverridesProvider(member.id)).valueOrNull ??
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
                  child: Text(
                    'Overrides in effect',
                    style: AppText.subPageTitle,
                  ),
                ),
                if (overrides.isNotEmpty)
                  TintBadge('${overrides.length}', color: AppColors.green),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              'Events on ${member.relationName}\'s calendar split or trimmed by a '
              'conflict decision. Revert to undo the split and put the overlap '
              'back up for a decision.',
              style: AppText.subtitle,
            ),
            const SizedBox(height: 14),
            if (overrides.isEmpty)
              AppCard(
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    'No overrides in effect',
                    style: AppText.subtitle,
                  ),
                ),
              )
            else
              for (final o in overrides) ...[
                _OverrideCard(
                  conflict: o,
                  member: member,
                  onRevert: canEdit ? () => _revert(context, ref, o) : null,
                ),
                const SizedBox(height: 10),
              ],
          ],
        ),
      ),
    );
  }

  Future<void> _revert(BuildContext context, WidgetRef ref, Conflict o) async {
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).revertConflict(familyId, o.id);
      ref.invalidate(memberOverridesProvider(member.id));
      ref.invalidate(conflictsProvider);
      ref.invalidate(calendarEventsProvider);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text("Couldn't revert: $e"),
            margin: snackBarMarginAboveNav(context),
          ),
        );
      }
    }
  }
}

/// One override, laid out like Home's "Double-booked" card — the same conflict
/// one stage later. Day on the left of the top line, the member on the right,
/// then both events in priority order: the one that was kept, then the one
/// trimmed around it (marked with the scissors, since the order alone no longer
/// says which was cut).
class _OverrideCard extends StatelessWidget {
  const _OverrideCard({
    required this.conflict,
    required this.member,
    required this.onRevert,
  });
  final Conflict conflict;
  final Member member;
  final VoidCallback? onRevert;

  @override
  Widget build(BuildContext context) {
    // The higher-priority event anchors the day, as on Home.
    final day = dayHeading(dayKey(conflict.winner.start), DateTime.now());
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.tint(AppColors.green, 0.07),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.green.withValues(alpha: 0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ConflictCardHeader(day: day, member: member),
          const SizedBox(height: 10),
          ConflictEventRow(event: conflict.winner, accent: AppColors.green),
          const SizedBox(height: 6),
          ConflictEventRow(
            event: conflict.loser,
            accent: AppColors.green,
            leadingIcon: Icons.content_cut_rounded,
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              // Ghost, where Home's unresolved card is amber: this one is
              // already settled, and reverting is the escape hatch rather than
              // the thing the card is asking for.
              Expanded(
                child: PillButton(
                  label: 'Revert',
                  variant: PillVariant.ghost,
                  dense: true,
                  onPressed: onRevert,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
