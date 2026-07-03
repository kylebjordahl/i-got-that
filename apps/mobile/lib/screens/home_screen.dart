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

/// Home — the claim hub. Surfaces unowned tasks first (any caretaker can claim
/// them); the caller's own claimed tasks for today sit below.
class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  bool _claiming = false;

  void _refresh() {
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
  }

  Future<void> _claim(String taskId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).assignTask(familyId, taskId);
    _refresh();
  }

  Future<void> _claimAll(List<TaskItem> unowned) async {
    if (unowned.isEmpty || _claiming) return;
    setState(() => _claiming = true);
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      for (final t in unowned) {
        await api.assignTask(familyId, t.id);
      }
      _refresh();
    } finally {
      if (mounted) setState(() => _claiming = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final unownedAsync = ref.watch(unownedTasksProvider);
    final allAsync = ref.watch(allTasksProvider);
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final byId = {for (final m in members) m.id: m};

    final now = DateTime.now();
    final unowned = [...(unownedAsync.valueOrNull ?? const <TaskItem>[])]
      ..sort((a, b) => a.start.compareTo(b.start));
    final mine = [
      for (final t in allAsync.valueOrNull ?? const <TaskItem>[])
        if (t.status == 'owned' &&
            t.ownerMemberId == me?.id &&
            dayKey(t.start) == dayKey(now))
          t
    ]..sort((a, b) => a.start.compareTo(b.start));

    return RefreshIndicator(
      onRefresh: () async {
        _refresh();
        await ref.read(unownedTasksProvider.future);
      },
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(22, 14, 22, 130),
        children: [
          _header(me, now),
          const SizedBox(height: 20),
          _hero(unowned),
          const SizedBox(height: 26),
          if (unownedAsync.hasError)
            _error('${unownedAsync.error}')
          else ...[
            SectionEyebrow(
              'Needs an owner',
              color: AppColors.amberHero,
              trailing: Text('${unowned.length} today', style: AppText.secondary),
            ),
            const SizedBox(height: 12),
            if (unowned.isEmpty)
              _empty('Nothing unowned — all covered 🎉')
            else
              for (final t in unowned) ...[
                _unownedRow(t, byId),
                const SizedBox(height: 11),
              ],
          ],
          if (mine.isNotEmpty) ...[
            const SizedBox(height: 14),
            const SectionEyebrow("You're covering today"),
            const SizedBox(height: 12),
            for (final t in mine) ...[
              _mineRow(t, byId, me),
              const SizedBox(height: 11),
            ],
          ],
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
        PersonAvatar(
          initial: initialFor(me?.relationName ?? '?'),
          color: meColor,
        ),
      ],
    );
  }

  Widget _hero(List<TaskItem> unowned) {
    final n = unowned.length;
    final headline = n == 0
        ? "You're all\ncaught up"
        : '$n task${n == 1 ? '' : 's'} still\nneed an owner';
    return AppCard(
      gradient: AppColors.heroGradient,
      radius: 26,
      padding: const EdgeInsets.all(20),
      border: Border.all(color: AppColors.amberHero.withValues(alpha: 0.25)),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(
            right: -6,
            bottom: -10,
            child: Icon(
              Icons.wb_sunny_outlined,
              size: 120,
              color: AppColors.amberHero.withValues(alpha: 0.16),
            ),
          ),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 210),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text("TODAY'S HANDOFFS",
                    style: font(kBodyFont, 12, 600,
                        color: AppColors.amberHero, letterSpacing: 0.5)),
                const SizedBox(height: 8),
                Text(headline, style: AppText.heroHeadline),
                const SizedBox(height: 14),
                if (n > 0)
                  PillButton(
                    label: _claiming ? 'Claiming…' : 'Claim what I can',
                    variant: PillVariant.amber,
                    onPressed: _claiming ? null : () => _claimAll(unowned),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _unownedRow(TaskItem t, Map<String, Member> byId) {
    final child = byId[t.familyMemberId];
    final color = child != null ? personColor(child) : AppColors.textSecondary;
    return TaskRow(
      icon: taskIcon(t.type),
      iconColor: color,
      typeLabel: taskTypeLabel(t.type),
      personName: child?.relationName ?? 'child',
      personColor: color,
      subtitle: '${taskCategory(t.type)} · ${friendlyTime(t.start)}',
      trailing: PillButton(
        label: 'Claim',
        dense: true,
        onPressed: () => _claim(t.id),
      ),
    );
  }

  Widget _mineRow(TaskItem t, Map<String, Member> byId, Member? me) {
    final child = byId[t.familyMemberId];
    final color = child != null ? personColor(child) : AppColors.textSecondary;
    final meColor = me == null ? AppColors.indigo : personColor(me);
    return TaskRow(
      icon: taskIcon(t.type),
      iconColor: color,
      typeLabel: taskTypeLabel(t.type),
      personName: child?.relationName ?? 'child',
      personColor: color,
      subtitle: '${taskCategory(t.type)} · ${friendlyTime(t.start)}',
      ownedColor: meColor,
      trailing: YouChip(initial: initialFor(me?.relationName ?? '?'), color: meColor),
    );
  }

  Widget _empty(String msg) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Center(child: Text(msg, style: AppText.subtitle)),
      );

  Widget _error(String msg) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Text(msg, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
      );
}
