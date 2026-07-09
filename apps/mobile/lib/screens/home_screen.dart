import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../util/format.dart';
import '../util/task_visuals.dart';
import '../widgets/primitives.dart';
import '../widgets/task_row.dart';
import 'task_actions_sheet.dart';

/// Home — the claim hub. A multi-day list grouped under sticky day headers;
/// unowned tasks read as dashed "needs an owner" rows any caretaker can claim,
/// and the caller's own claimed tasks sit inline (solid bar + "You").
class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  bool _refreshingFeeds = false;

  void _refresh() {
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
    ref.invalidate(pendingDecisionsProvider);
    ref.invalidate(calendarEventsProvider);
  }

  Future<void> _refreshFeeds() async {
    setState(() => _refreshingFeeds = true);
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).refreshAllFeeds(familyId);
      ref.invalidate(feedsProvider);
      _refresh();
      await ref.read(allTasksProvider.future);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Refresh failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _refreshingFeeds = false);
    }
  }

  Future<void> _claim(String taskId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).assignTask(familyId, taskId);
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final allAsync = ref.watch(allTasksProvider);
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final decisions =
        ref.watch(pendingDecisionsProvider).valueOrNull ?? const <PendingDecision>[];
    final threshold = ref.watch(threadingThresholdProvider).valueOrNull ?? 30;
    final events =
        ref.watch(calendarEventsProvider).valueOrNull ?? const <CalendarEventItem>[];
    final eventsById = {for (final e in events) e.id: e};
    final byId = {for (final m in members) m.id: m};
    final now = DateTime.now();

    // Unowned tasks + my own claimed tasks, upcoming only (no past tasks,
    // regardless of claim state), grouped by day.
    final visible = [
      for (final t in allAsync.valueOrNull ?? const <TaskItem>[])
        if (!t.isDismissed &&
            !t.start.isBefore(now) &&
            (t.status == 'unowned' || t.ownerMemberId == me?.id))
          t
    ];
    final byDay = <DateTime, List<TaskItem>>{};
    for (final t in visible) {
      (byDay[dayKey(t.start)] ??= []).add(t);
    }
    for (final list in byDay.values) {
      list.sort((a, b) => a.start.compareTo(b.start));
    }
    final days = byDay.keys.toList()..sort();

    return RefreshIndicator(
      onRefresh: () async {
        _refresh();
        await ref.read(allTasksProvider.future);
      },
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(22, 14, 22, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _header(now),
                  const SizedBox(height: 18),
                  // Pending decisions rank ABOVE unclaimed tasks — they block
                  // the pipeline until a human decides.
                  if (decisions.isNotEmpty) ...[
                    SectionEyebrow(
                      'Needs a decision',
                      color: AppColors.amber,
                      trailing: TintBadge('${decisions.length}', color: AppColors.amber),
                    ),
                    const SizedBox(height: 10),
                    for (final d in decisions) ...[
                      _DecisionCard(
                        decision: d,
                        member: byId[d.familyMemberId],
                        onResolve: () => _resolveDecision(d),
                        onDismiss: () => _dismissDecision(d),
                      ),
                      const SizedBox(height: 10),
                    ],
                    const SizedBox(height: 8),
                  ],
                  const _HintChip(),
                  const SizedBox(height: 8),
                ],
              ),
            ),
          ),
          if (allAsync.hasError)
            SliverToBoxAdapter(child: _pad(_error('${allAsync.error}')))
          else if (days.isEmpty)
            SliverToBoxAdapter(
              child: _pad(_empty(allAsync.isLoading
                  ? 'Loading…'
                  : 'Nothing to cover — all clear 🎉')))
          else
            // Each day is its own SliverMainAxisGroup so its header stays pinned
            // only within that day — the next day's header pushes it out instead
            // of the headers stacking at the top.
            for (final day in days)
              SliverMainAxisGroup(
                slivers: [
                  SliverPersistentHeader(
                    pinned: true,
                    delegate: _DayHeaderDelegate(
                      label: homeDayHeader(day, now),
                      openCount: byDay[day]!.where((t) => t.status == 'unowned').length,
                    ),
                  ),
                  SliverPadding(
                    padding: const EdgeInsets.fromLTRB(22, 0, 22, 8),
                    sliver: _daySliver(byDay[day]!, byId, eventsById, me, threshold),
                  ),
                ],
              ),
          const SliverToBoxAdapter(child: SizedBox(height: 120)),
        ],
      ),
    );
  }

  /// Stitch a day's tasks into threaded chains: consecutive tasks whose gap is
  /// within the family threshold render joined by a dotted spine ("same trip")
  /// while staying independently claimable. Presentation only — nothing stored.
  List<List<TaskItem>> _chains(List<TaskItem> tasks, int thresholdMinutes) {
    final chains = <List<TaskItem>>[];
    for (final t in tasks) {
      if (chains.isEmpty) {
        chains.add([t]);
        continue;
      }
      final prev = chains.last.last;
      final anchor = prev.end ?? prev.start;
      final gap = t.start.difference(anchor).inMinutes;
      if (gap >= 0 && gap <= thresholdMinutes) {
        chains.last.add(t);
      } else {
        chains.add([t]);
      }
    }
    return chains;
  }

  Widget _daySliver(List<TaskItem> tasks, Map<String, Member> byId,
      Map<String, CalendarEventItem> eventsById, Member? me, int threshold) {
    final chains = _chains(tasks, threshold);
    return SliverList.separated(
      itemCount: chains.length,
      separatorBuilder: (_, __) => const SizedBox(height: 11),
      itemBuilder: (_, i) {
        final chain = chains[i];
        if (chain.length == 1) return _row(chain.first, byId, eventsById, me);
        return _ThreadedChain(
          rows: [for (final t in chain) _row(t, byId, eventsById, me)],
          gaps: [
            for (var j = 1; j < chain.length; j++)
              chain[j]
                  .start
                  .difference(chain[j - 1].end ?? chain[j - 1].start)
                  .inMinutes,
          ],
          onClaimAll: chain.every((t) => t.isUnowned)
              ? () async {
                  for (final t in chain) {
                    await _claim(t.id);
                  }
                }
              : null,
        );
      },
    );
  }

  Future<void> _resolveDecision(PendingDecision d) async {
    // Resolve accepts the event onto the calendar as a normal day; what tasks
    // it generates then follows the member's task rules.
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).resolvePendingDecision(familyId, d.id);
      _refresh();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Resolve failed: $e')));
      }
    }
  }

  Future<void> _dismissDecision(PendingDecision d) async {
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).dismissPendingDecision(familyId, d.id);
      _refresh();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Dismiss failed: $e')));
      }
    }
  }

  Widget _header(DateTime now) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(child: Text(greeting(now), style: AppText.screenTitleAlt)),
                  const SizedBox(width: 7),
                  const Icon(Icons.wb_sunny_rounded, color: AppColors.amberHero, size: 22),
                ],
              ),
              const SizedBox(height: 3),
              Text(longDate(now), style: AppText.subtitle),
            ],
          ),
        ),
        RefreshFeedsButton(busy: _refreshingFeeds, onTap: _refreshFeeds),
      ],
    );
  }

  Widget _row(TaskItem t, Map<String, Member> byId,
      Map<String, CalendarEventItem> eventsById, Member? me) {
    final child = byId[t.familyMemberId];
    final color = child != null ? personColor(child) : AppColors.textSecondary;
    final owned = t.status == 'owned';
    final meColor = me == null ? AppColors.indigo : personColor(me);
    return TaskRow(
      icon: taskIcon(t.type),
      iconColor: color,
      typeLabel: taskTitle(t, eventsById[t.calendarEventId]),
      personName: child?.relationName ?? 'child',
      personColor: color,
      subtitle: '${taskCategory(t.type)} · ${friendlyTime(t.start)}',
      ownedColor: owned ? meColor : null,
      onTap: () => showTaskActions(context, ref, t),
      trailing: owned
          ? YouChip(initial: initialFor(me?.relationName ?? '?'), color: meColor)
          : PillButton(label: 'Claim', dense: true, onPressed: () => _claim(t.id)),
    );
  }

  Widget _pad(Widget child) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 22),
        child: child,
      );

  Widget _empty(String msg) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 40),
        child: Center(child: Text(msg, style: AppText.subtitle)),
      );

  Widget _error(String msg) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Text(msg, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
      );
}

/// An unmatched exception-feed event awaiting a human decision (6b): amber
/// dashed card with Resolve / Dismiss. The system never guesses.
class _DecisionCard extends StatelessWidget {
  const _DecisionCard({
    required this.decision,
    required this.member,
    required this.onResolve,
    required this.onDismiss,
  });
  final PendingDecision decision;
  final Member? member;
  final VoidCallback onResolve;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final memberColor =
        member != null ? personColor(member!) : AppColors.textSecondary;
    final when = decision.allDay
        ? homeDayHeader(dayKey(decision.start), DateTime.now())
        : friendlyTime(decision.start);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.tint(AppColors.amber, 0.07),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.amber.withValues(alpha: 0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const IconTile(icon: Icons.help_outline_rounded, color: AppColors.amber, size: 38),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text.rich(
                      TextSpan(children: [
                        TextSpan(
                            text: decision.summary ?? 'Unmatched event',
                            style: AppText.sectionItemTitle),
                        TextSpan(
                            text: ' · ${member?.relationName ?? 'member'}',
                            style: font(kBodyFont, 14, 700, color: memberColor)),
                      ]),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'No rule matched · $when — what should this generate?',
                      style: font(kBodyFont, 12, 500, color: AppColors.amber),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: PillButton(
                    label: 'Resolve', variant: PillVariant.amber, onPressed: onResolve),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: PillButton(label: 'Dismiss', onPressed: onDismiss),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Threaded chain (6d, treatment 1 — "connector thread"): separate cards joined
/// by a dotted coral spine + "then… same trip" note; each leg stays
/// independently claimable, with an optional "Claim both".
class _ThreadedChain extends StatelessWidget {
  const _ThreadedChain({
    required this.rows,
    required this.gaps,
    this.onClaimAll,
  });
  final List<Widget> rows;
  final List<int> gaps;
  final Future<void> Function()? onClaimAll;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: AppColors.coral.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.coral.withValues(alpha: 0.16)),
      ),
      child: Column(
        children: [
          for (var i = 0; i < rows.length; i++) ...[
            if (i > 0)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  children: [
                    const SizedBox(width: 26),
                    Container(
                      width: 2,
                      height: 16,
                      decoration: BoxDecoration(
                        color: AppColors.coral.withValues(alpha: 0.55),
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Text(
                      'then, ${gaps[i - 1]} min later — same trip',
                      style: font(kBodyFont, 11.5, 600, color: AppColors.coral),
                    ),
                  ],
                ),
              ),
            rows[i],
          ],
          if (onClaimAll != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () => onClaimAll!(),
                  child: Text('Claim both',
                      style: font(kBodyFont, 12.5, 700, color: AppColors.coral)),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// The discoverability hint for the long-press quick-actions.
class _HintChip extends StatelessWidget {
  const _HintChip();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.card,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Row(
        children: [
          const Icon(Icons.touch_app_outlined, size: 17, color: AppColors.textTertiary),
          const SizedBox(width: 10),
          Expanded(
            child: Text('Tap a task to reassign, change its type, or mark it not needed',
                style: font(kBodyFont, 12.5, 500, color: AppColors.textSecondary)),
          ),
        ],
      ),
    );
  }
}

/// Sticky per-day header: "TODAY · TUE JUL 1" with the open (unclaimed) count.
class _DayHeaderDelegate extends SliverPersistentHeaderDelegate {
  _DayHeaderDelegate({required this.label, required this.openCount});
  final String label;
  final int openCount;

  @override
  double get minExtent => 42;
  @override
  double get maxExtent => 42;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    return Container(
      color: AppColors.bg,
      padding: const EdgeInsets.fromLTRB(24, 10, 24, 10),
      alignment: Alignment.center,
      child: Row(
        children: [
          Expanded(child: Text(label, style: AppText.eyebrow(AppColors.amberHero))),
          Text('$openCount open', style: AppText.secondary),
        ],
      ),
    );
  }

  @override
  bool shouldRebuild(_DayHeaderDelegate old) =>
      old.label != label || old.openCount != openCount;
}
