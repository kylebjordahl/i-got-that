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

/// Quick-actions for a timeline task (Home rows + Plan blocks/tags): change its
/// type (transition / attendance / both), (re)assign or unassign it, or mark it
/// not needed.
///
/// [scopeTasks] scopes the assign / unassign / dismiss actions: pass the whole
/// event group (a Plan block tap) to act on the drop-off *and* pick-up at once,
/// or omit it (a tag tap / Home row) to act on [task] alone. [titleOverride]
/// replaces the header's type label with the event's own summary.
Future<void> showTaskActions(
  BuildContext context,
  WidgetRef ref,
  TaskItem task, {
  List<TaskItem>? scopeTasks,
  String? titleOverride,
}) async {
  final members = ref.read(membersProvider).valueOrNull ?? const <Member>[];
  final byId = {for (final m in members) m.id: m};
  final caretakers = members.where((m) => m.isCaretaker).toList();
  final me = ref.read(currentMemberProvider).valueOrNull;
  final isAdmin = me?.isAdmin ?? false;
  final canClaim = me?.isCaretaker ?? false;
  // Any caretaker may reassign; a non-caretaker admin can still route work.
  final canAssign = canClaim || isAdmin;
  final child = byId[task.familyMemberId];
  final color = child != null ? personColor(child) : AppColors.textSecondary;
  // Only event-derived tasks are convertible (fully-manual ones have no event).
  final isFeedTask = task.calendarEventId != null;

  // Tasks the assign/unassign/dismiss actions operate on (the event's whole
  // group for a block tap; just this task otherwise).
  final scope = (scopeTasks == null || scopeTasks.isEmpty) ? [task] : scopeTasks;
  final anyUnowned = scope.any((t) => t.status == 'unowned');
  final anyOwned = scope.any((t) => t.status == 'owned');
  final allUnowned = scope.every((t) => t.status == 'unowned');

  // Derive the current change-type segment from the whole event group.
  final all = ref.read(allTasksProvider).valueOrNull ?? const <TaskItem>[];
  final group =
      all.where((t) => t.calendarEventId == task.calendarEventId).toList();
  final types = (group.isEmpty ? [task] : group).map((t) => t.type).toSet();
  final hasAtt = types.contains('attendance');
  final hasTrans = types.contains('pickup') || types.contains('dropoff');
  final transSub = types.contains('pickup') ? 'pickup' : 'dropoff';
  final currentSeg = hasAtt && hasTrans ? 'both' : (hasAtt ? 'attendance' : 'transition');

  List<String> targetOf(String seg) => switch (seg) {
        'attendance' => ['attendance'],
        'both' => [transSub, 'attendance'],
        _ => [transSub],
      };

  final owners = scope
      .where((t) => t.status == 'owned')
      .map((t) => byId[t.ownerMemberId]?.relationName)
      .whereType<String>()
      .toSet();
  final statusText = allUnowned
      ? 'unclaimed'
      : (owners.length == 1 ? owners.first : '${owners.length} assigned');

  await showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    builder: (sheetCtx) => SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              IconTile(icon: taskIcon(task.type), color: color, size: 44),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${titleOverride ?? taskTypeLabel(task.type)} · ${child?.relationName ?? 'child'}',
                        style: AppText.sectionItemTitle),
                    const SizedBox(height: 2),
                    Text('${taskCategory(task.type)} · ${friendlyTime(task.start)} · $statusText',
                        style: AppText.subtitle),
                  ],
                ),
              ),
            ],
          ),
          if (isFeedTask) ...[
            const SizedBox(height: 20),
            Text('CHANGE TYPE', style: AppText.eyebrow()),
            const SizedBox(height: 10),
            Row(
              children: [
                for (final (seg, label, icon) in const [
                  ('transition', 'Transition', Icons.swap_horiz_rounded),
                  ('attendance', 'Attendance', Icons.groups_rounded),
                  ('both', 'Both', Icons.dashboard_customize_rounded),
                ]) ...[
                  Expanded(
                    child: _SegTile(
                      label: label,
                      icon: icon,
                      selected: seg == currentSeg,
                      onTap: seg == currentSeg
                          ? null
                          : () {
                              Navigator.of(sheetCtx).pop();
                              _run(context, ref,
                                  (api, fid) => api.convertTask(fid, task.id, targetOf(seg)),
                                  'Type updated');
                            },
                    ),
                  ),
                  if (seg != 'both') const SizedBox(width: 8),
                ],
              ],
            ),
          ],
          const SizedBox(height: 20),
          AppCard(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
            child: Column(
              children: [
                if (anyUnowned && canClaim) ...[
                  _ActionRow(
                    icon: Icons.check_circle_outline_rounded,
                    iconColor: AppColors.indigo,
                    label: 'Claim for myself',
                    onTap: () {
                      Navigator.of(sheetCtx).pop();
                      _runScope(
                          context,
                          ref,
                          scope.where((t) => t.status == 'unowned'),
                          (api, fid, t) => api.assignTask(fid, t.id),
                          'Claimed');
                    },
                  ),
                  const Divider(height: 18),
                ],
                if (canAssign && caretakers.length > (allUnowned ? 0 : 1)) ...[
                  _ActionRow(
                    icon: Icons.person_add_alt_1_rounded,
                    iconColor: AppColors.blue,
                    label: allUnowned ? 'Assign to someone…' : 'Reassign to someone…',
                    onTap: () {
                      Navigator.of(sheetCtx).pop();
                      _pickAndAssign(context, ref, scope, caretakers);
                    },
                  ),
                  const Divider(height: 18),
                ],
                if (anyOwned && canAssign) ...[
                  _ActionRow(
                    icon: Icons.person_off_outlined,
                    iconColor: AppColors.textSecondary,
                    label: 'Unassign',
                    onTap: () {
                      Navigator.of(sheetCtx).pop();
                      _runScope(
                          context,
                          ref,
                          scope.where((t) => t.status == 'owned'),
                          (api, fid, t) => api.unassignTask(fid, t.id),
                          'Returned to the queue');
                    },
                  ),
                  const Divider(height: 18),
                ],
                _ActionRow(
                  icon: Icons.block_rounded,
                  iconColor: AppColors.coral,
                  label: 'Mark as not needed',
                  destructive: true,
                  onTap: () {
                    Navigator.of(sheetCtx).pop();
                    _runScope(context, ref, scope,
                        (api, fid, t) => api.dismissTask(fid, t.id),
                        'Marked not needed');
                  },
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

/// Pick a caretaker to (re)assign the scope's tasks to. Hides a caretaker only
/// when they already own every task in the scope (nothing to move to them).
Future<void> _pickAndAssign(
  BuildContext context,
  WidgetRef ref,
  List<TaskItem> scope,
  List<Member> caretakers,
) async {
  final options = caretakers
      .where((m) => !scope.every((t) => t.ownerMemberId == m.id))
      .toList();
  await showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    builder: (sheetCtx) => SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Assign to', style: AppText.subPageTitle),
          const SizedBox(height: 12),
          for (final m in options)
            InkWell(
              onTap: () {
                Navigator.of(sheetCtx).pop();
                _runScope(context, ref, scope,
                    (api, fid, t) => api.assignTask(fid, t.id, memberId: m.id),
                    'Assigned to ${m.relationName}');
              },
              borderRadius: BorderRadius.circular(14),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  children: [
                    PersonAvatar(
                        initial: initialFor(m.relationName), color: personColor(m), size: 40),
                    const SizedBox(width: 14),
                    Text(m.relationName, style: AppText.sectionItemTitle),
                  ],
                ),
              ),
            ),
        ],
      ),
    ),
  );
}

Future<void> _run(
  BuildContext context,
  WidgetRef ref,
  Future<void> Function(dynamic api, String familyId) action,
  String success,
) async {
  try {
    final familyId = await ref.read(familyProvider.future);
    await action(ref.read(apiClientProvider), familyId);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
    // Claims move events between calendars (the recursion) — refresh Plan too.
    ref.invalidate(calendarEventsProvider);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(success)));
    }
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
    }
  }
}

/// Run a per-task [action] across every task in a scope (a Plan block's group),
/// then refresh once. A single snackbar reports the whole batch.
Future<void> _runScope(
  BuildContext context,
  WidgetRef ref,
  Iterable<TaskItem> tasks,
  Future<void> Function(dynamic api, String familyId, TaskItem task) action,
  String success,
) async {
  try {
    final familyId = await ref.read(familyProvider.future);
    final api = ref.read(apiClientProvider);
    for (final t in tasks) {
      await action(api, familyId, t);
    }
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
    // Claims move events between calendars (the recursion) — refresh Plan too.
    ref.invalidate(calendarEventsProvider);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(success)));
    }
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
    }
  }
}

/// A change-type segment tile.
class _SegTile extends StatelessWidget {
  const _SegTile({
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? AppColors.tint(AppColors.indigo, 0.18) : AppColors.card,
      borderRadius: BorderRadius.circular(15),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(15),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(15),
            border: Border.all(
                color: selected ? AppColors.indigo : AppColors.border, width: selected ? 1.5 : 1),
          ),
          child: Column(
            children: [
              Icon(icon,
                  size: 22, color: selected ? AppColors.indigo : AppColors.textSecondary),
              const SizedBox(height: 7),
              Text(label,
                  style: font(kBodyFont, 12.5, 600,
                      color: selected ? AppColors.textPrimary : AppColors.textSecondary)),
            ],
          ),
        ),
      ),
    );
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({
    required this.icon,
    required this.iconColor,
    required this.label,
    required this.onTap,
    this.destructive = false,
  });

  final IconData icon;
  final Color iconColor;
  final String label;
  final VoidCallback onTap;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            Icon(icon, color: iconColor, size: 22),
            const SizedBox(width: 14),
            Text(label,
                style: font(kBodyFont, 14.5, 600,
                    color: destructive ? AppColors.coral : AppColors.textPrimary)),
          ],
        ),
      ),
    );
  }
}
