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
  void _refresh() {
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
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
    final byId = {for (final m in members) m.id: m};
    final now = DateTime.now();

    // Unowned tasks + my own claimed tasks, grouped by day.
    final visible = [
      for (final t in allAsync.valueOrNull ?? const <TaskItem>[])
        if (!t.isDismissed && (t.status == 'unowned' || t.ownerMemberId == me?.id)) t
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
                  _header(me, now),
                  const SizedBox(height: 18),
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
            for (final day in days) ...[
              SliverPersistentHeader(
                pinned: true,
                delegate: _DayHeaderDelegate(
                  label: homeDayHeader(day, now),
                  openCount: byDay[day]!.where((t) => t.status == 'unowned').length,
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 8),
                sliver: SliverList.separated(
                  itemCount: byDay[day]!.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 11),
                  itemBuilder: (_, i) => _row(byDay[day]![i], byId, me),
                ),
              ),
            ],
          const SliverToBoxAdapter(child: SizedBox(height: 120)),
        ],
      ),
    );
  }

  Widget _header(Member? me, DateTime now) {
    final meColor = me == null ? AppColors.indigo : personColor(me);
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
        PersonAvatar(initial: initialFor(me?.relationName ?? '?'), color: meColor),
      ],
    );
  }

  Widget _row(TaskItem t, Map<String, Member> byId, Member? me) {
    final child = byId[t.familyMemberId];
    final color = child != null ? personColor(child) : AppColors.textSecondary;
    final owned = t.status == 'owned';
    final meColor = me == null ? AppColors.indigo : personColor(me);
    return TaskRow(
      icon: taskIcon(t.type),
      iconColor: color,
      typeLabel: taskTypeLabel(t.type),
      personName: child?.relationName ?? 'child',
      personColor: color,
      subtitle: '${taskCategory(t.type)} · ${friendlyTime(t.start)}',
      ownedColor: owned ? meColor : null,
      onLongPress: () => showTaskActions(context, ref, t),
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
            child: Text('Long-press a task to change its type or mark it not needed',
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
