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

/// Long-press action sheet for a timeline task (Home rows + Plan blocks).
/// Exposes the oversight actions that don't have a home in the new UI:
/// change type (feed-event tasks), mark the task unneeded, and — for admins —
/// mark the whole feed event unneeded.
Future<void> showTaskActions(BuildContext context, WidgetRef ref, TaskItem task) async {
  final members = ref.read(membersProvider).valueOrNull ?? const <Member>[];
  final byId = {for (final m in members) m.id: m};
  final isAdmin = ref.read(currentMemberProvider).valueOrNull?.isAdmin ?? false;
  final child = byId[task.familyMemberId];
  final color = child != null ? personColor(child) : AppColors.textSecondary;
  final isFeedTask = task.sourceEventId != null;

  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheetCtx) => SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              IconTile(icon: taskIcon(task.type), color: color, size: 40),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${taskTypeLabel(task.type)} · ${child?.relationName ?? 'child'}',
                        style: AppText.sectionItemTitle),
                    const SizedBox(height: 2),
                    Text('${taskCategory(task.type)} · ${friendlyTime(task.start)}',
                        style: AppText.subtitle),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),
          if (isFeedTask)
            _ActionRow(
              icon: Icons.swap_horiz_rounded,
              iconColor: AppColors.indigo,
              label: 'Change type…',
              subtitle: 'Turn this into a drop-off, pickup, and/or attendance',
              onTap: () {
                Navigator.of(sheetCtx).pop();
                _changeType(context, ref, task);
              },
            ),
          _ActionRow(
            icon: Icons.block_rounded,
            iconColor: AppColors.coral,
            label: 'Mark task unneeded',
            subtitle: "Drops it from the queue and the owner's calendar",
            onTap: () async {
              Navigator.of(sheetCtx).pop();
              await _run(context, ref, (api, familyId) => api.dismissTask(familyId, task.id),
                  'Task marked unneeded');
            },
          ),
          if (isAdmin && isFeedTask)
            _ActionRow(
              icon: Icons.event_busy_rounded,
              iconColor: AppColors.amber,
              label: 'Mark event unneeded',
              subtitle: 'Removes every task from this feed event',
              onTap: () async {
                Navigator.of(sheetCtx).pop();
                await _dismissEvent(context, ref, task);
              },
            ),
        ],
      ),
    ),
  );
}

/// Prefill the type picker from the whole feed-event group (so opening from any
/// sibling keeps the others checked), then convert.
Future<void> _changeType(BuildContext context, WidgetRef ref, TaskItem task) async {
  final all = ref.read(allTasksProvider).valueOrNull ??
      ref.read(unownedTasksProvider).valueOrNull ??
      const <TaskItem>[];
  final current = all
      .where((t) => t.sourceEventId == task.sourceEventId)
      .map((t) => t.type)
      .toSet();
  if (current.isEmpty) current.add(task.type);

  final chosen = await showDialog<List<String>>(
    context: context,
    builder: (_) => _ConvertTypeDialog(initial: current),
  );
  if (chosen == null || chosen.isEmpty) return;
  if (!context.mounted) return;
  await _run(context, ref, (api, familyId) => api.convertTask(familyId, task.id, chosen),
      'Type updated');
}

Future<void> _dismissEvent(BuildContext context, WidgetRef ref, TaskItem task) async {
  // The task carries the source event id but not its feed — resolve it.
  final events = await ref.read(sourceEventsProvider.future);
  final feedId = events.where((e) => e.id == task.sourceEventId).map((e) => e.feedId).firstOrNull;
  if (feedId == null) {
    if (context.mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text("Couldn't find the feed event")));
    }
    return;
  }
  if (!context.mounted) return;
  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => AlertDialog(
      title: const Text('Mark event unneeded?'),
      content: const Text(
          'This removes every task generated from this feed event (e.g. an '
          'erroneous closure). You can restore it later from the feed.'),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
        PillButton(
          label: 'Mark unneeded',
          variant: PillVariant.white,
          onPressed: () => Navigator.of(context).pop(true),
        ),
      ],
    ),
  );
  if (ok != true || !context.mounted) return;
  await _run(context, ref,
      (api, familyId) => api.dismissEvent(familyId, feedId, task.sourceEventId!),
      'Event marked unneeded');
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
    ref.invalidate(sourceEventsProvider);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(success)));
    }
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
    }
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({
    required this.icon,
    required this.iconColor,
    required this.label,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final Color iconColor;
  final String label;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            IconTile(icon: icon, color: iconColor),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label, style: AppText.toggleLabel),
                  const SizedBox(height: 2),
                  Text(subtitle, style: AppText.subtitle),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Multi-select of task types for a feed event. Returns the chosen type ids
/// (`attendance`/`pickup`/`dropoff`), or null on cancel. At least one required.
class _ConvertTypeDialog extends StatefulWidget {
  const _ConvertTypeDialog({required this.initial});
  final Set<String> initial;

  @override
  State<_ConvertTypeDialog> createState() => _ConvertTypeDialogState();
}

class _ConvertTypeDialogState extends State<_ConvertTypeDialog> {
  static const _types = [
    ('dropoff', 'Drop-off', Icons.login_rounded),
    ('pickup', 'Pickup', Icons.logout_rounded),
    ('attendance', 'Attendance', Icons.groups_rounded),
  ];
  late final Set<String> _selected = {...widget.initial};

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Change type'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text('This event can produce more than one task.',
                style: AppText.subtitle),
          ),
          for (final (id, label, icon) in _types)
            CheckboxListTile(
              value: _selected.contains(id),
              title: Text(label, style: AppText.listItemTitle),
              secondary: Icon(icon, color: AppColors.textSecondary, size: 20),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.trailing,
              activeColor: AppColors.indigo,
              onChanged: (v) => setState(() {
                if (v ?? false) {
                  _selected.add(id);
                } else {
                  _selected.remove(id);
                }
              }),
            ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        PillButton(
          label: 'Save',
          variant: PillVariant.amber,
          onPressed: _selected.isEmpty ? null : () => Navigator.pop(context, _selected.toList()),
        ),
      ],
    );
  }
}
