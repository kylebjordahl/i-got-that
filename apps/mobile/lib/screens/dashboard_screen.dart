import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../util/format.dart';

/// Tasks view. Toggles between the unowned queue and an oversight "All" view
/// that shows the raw feed events with their generated tasks nested beneath,
/// plus baseline tasks. Tasks can be claimed, (re)assigned, or marked unneeded;
/// feed events can be marked unneeded (admins).
class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  bool _showAll = false;

  void _refreshTasks() {
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
    ref.invalidate(sourceEventsProvider);
  }

  Future<void> _refreshFeeds() async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).refreshAllFeeds(familyId);
    _refreshTasks();
  }

  Future<void> _sync() async {
    final familyId = await ref.read(familyProvider.future);
    final res = await ref.read(apiClientProvider).resyncDeliveries(familyId);
    final created = res['created'] ?? 0;
    final updated = res['updated'] ?? 0;
    final removed = res['removed'] ?? 0;
    final errors = (res['errors'] as List?)?.length ?? 0;
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          'Calendars synced: $created added, $updated updated, $removed removed'
          '${errors > 0 ? ' · $errors error(s)' : ''}',
        ),
      ),
    );
  }

  Future<void> _claim(String taskId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).assignTask(familyId, taskId);
    _refreshTasks();
  }

  Future<void> _assign(String taskId, String memberId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).assignTask(familyId, taskId, memberId: memberId);
    _refreshTasks();
  }

  Future<void> _release(String taskId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).unassignTask(familyId, taskId);
    _refreshTasks();
  }

  Future<void> _dismissTask(String taskId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).dismissTask(familyId, taskId);
    _refreshTasks();
  }

  Future<void> _restoreTask(String taskId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).restoreTask(familyId, taskId);
    _refreshTasks();
  }

  Future<void> _dismissEvent(String feedId, String eventId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).dismissEvent(familyId, feedId, eventId);
    _refreshTasks();
  }

  Future<void> _restoreEvent(String feedId, String eventId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).restoreEvent(familyId, feedId, eventId);
    _refreshTasks();
  }

  @override
  Widget build(BuildContext context) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final names = {for (final m in members) m.id: m.relationName};
    final caretakers = members.where((m) => m.isCaretaker).toList();
    final isAdmin = ref.watch(currentMemberProvider).valueOrNull?.isAdmin ?? false;

    final actions = _TaskActions(
      caretakers: caretakers,
      names: names,
      onClaim: _claim,
      onAssign: _assign,
      onRelease: _release,
      onDismiss: _dismissTask,
      onRestore: _restoreTask,
    );

    return Scaffold(
      appBar: AppBar(
        title: const Text('Tasks'),
        actions: [
          IconButton(
            tooltip: 'Sync to calendars',
            onPressed: _sync,
            icon: const Icon(Icons.cloud_upload_outlined),
          ),
          IconButton(
            tooltip: 'Refresh feeds',
            onPressed: _refreshFeeds,
            icon: const Icon(Icons.sync),
          ),
          IconButton(
            tooltip: 'Sign out',
            onPressed: () => ref.read(authControllerProvider.notifier).logout(),
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: false, label: Text('Unowned')),
                ButtonSegment(value: true, label: Text('All')),
              ],
              selected: {_showAll},
              onSelectionChanged: (s) => setState(() => _showAll = s.first),
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                _refreshTasks();
                await ref.read(
                  (_showAll ? allTasksProvider : unownedTasksProvider).future,
                );
              },
              child: _showAll
                  ? _OversightView(
                      actions: actions,
                      isAdmin: isAdmin,
                      onDismissEvent: _dismissEvent,
                      onRestoreEvent: _restoreEvent,
                    )
                  : _UnownedView(actions: actions),
            ),
          ),
        ],
      ),
    );
  }
}

/// Task action callbacks + lookup data, passed down to tiles.
class _TaskActions {
  const _TaskActions({
    required this.caretakers,
    required this.names,
    required this.onClaim,
    required this.onAssign,
    required this.onRelease,
    required this.onDismiss,
    required this.onRestore,
  });

  final List<Member> caretakers;
  final Map<String, String> names;
  final void Function(String taskId) onClaim;
  final void Function(String taskId, String memberId) onAssign;
  final void Function(String taskId) onRelease;
  final void Function(String taskId) onDismiss;
  final void Function(String taskId) onRestore;
}

/// The unowned queue: a flat list grouped by day.
class _UnownedView extends ConsumerWidget {
  const _UnownedView({required this.actions});
  final _TaskActions actions;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tasksAsync = ref.watch(unownedTasksProvider);
    return tasksAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => _ErrorList('$e'),
      data: (tasks) {
        if (tasks.isEmpty) {
          return const _MessageList('Nothing unowned — all covered 🎉');
        }
        final now = DateTime.now();
        final groups = <DateTime, List<TaskItem>>{};
        for (final t in [...tasks]..sort((a, b) => a.start.compareTo(b.start))) {
          (groups[dayKey(t.start)] ??= []).add(t);
        }
        final days = groups.keys.toList()..sort();
        return ListView(
          children: [
            for (final day in days) ...[
              _DayHeading(day: day, now: now),
              for (final t in groups[day]!) _TaskTile(task: t, actions: actions),
            ],
          ],
        );
      },
    );
  }
}

/// Oversight: feed events with their generated tasks nested, plus baseline
/// tasks, grouped by day.
class _OversightView extends ConsumerWidget {
  const _OversightView({
    required this.actions,
    required this.isAdmin,
    required this.onDismissEvent,
    required this.onRestoreEvent,
  });

  final _TaskActions actions;
  final bool isAdmin;
  final void Function(String feedId, String eventId) onDismissEvent;
  final void Function(String feedId, String eventId) onRestoreEvent;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tasksAsync = ref.watch(allTasksProvider);
    final eventsAsync = ref.watch(sourceEventsProvider);

    if (tasksAsync.isLoading || eventsAsync.isLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (tasksAsync.hasError) return _ErrorList('${tasksAsync.error}');
    if (eventsAsync.hasError) return _ErrorList('${eventsAsync.error}');

    final tasks = tasksAsync.value ?? const <TaskItem>[];
    final events = eventsAsync.value ?? const <SourceEventItem>[];
    if (tasks.isEmpty && events.isEmpty) return const _MessageList('No tasks yet');

    final now = DateTime.now();
    final tasksByEvent = <String, List<TaskItem>>{};
    final baseline = <TaskItem>[];
    for (final t in tasks) {
      if (t.sourceEventId != null) {
        (tasksByEvent[t.sourceEventId!] ??= []).add(t);
      } else {
        baseline.add(t);
      }
    }

    // Group both events and baseline tasks by day (each day's list sorted).
    final eventsByDay = <DateTime, List<SourceEventItem>>{};
    for (final e in events) {
      (eventsByDay[dayKey(e.start)] ??= []).add(e);
    }
    for (final list in eventsByDay.values) {
      list.sort((a, b) => a.start.compareTo(b.start));
    }
    final baselineByDay = <DateTime, List<TaskItem>>{};
    for (final t in baseline) {
      (baselineByDay[dayKey(t.start)] ??= []).add(t);
    }
    for (final list in baselineByDay.values) {
      list.sort((a, b) => a.start.compareTo(b.start));
    }
    final days = {...eventsByDay.keys, ...baselineByDay.keys}.toList()..sort();

    return ListView(
      children: [
        for (final day in days) ...[
          _DayHeading(day: day, now: now),
          for (final e in eventsByDay[day] ?? const <SourceEventItem>[])
            _EventCard(
              event: e,
              tasks: tasksByEvent[e.id] ?? const [],
              actions: actions,
              isAdmin: isAdmin,
              onDismissEvent: onDismissEvent,
              onRestoreEvent: onRestoreEvent,
            ),
          for (final t in baselineByDay[day] ?? const <TaskItem>[])
            _TaskTile(task: t, actions: actions),
        ],
      ],
    );
  }
}

/// A feed event with its generated tasks nested beneath. Admins can mark it
/// unneeded (or restore it).
class _EventCard extends StatelessWidget {
  const _EventCard({
    required this.event,
    required this.tasks,
    required this.actions,
    required this.isAdmin,
    required this.onDismissEvent,
    required this.onRestoreEvent,
  });

  final SourceEventItem event;
  final List<TaskItem> tasks;
  final _TaskActions actions;
  final bool isAdmin;
  final void Function(String feedId, String eventId) onDismissEvent;
  final void Function(String feedId, String eventId) onRestoreEvent;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitleParts = [
      event.allDay ? 'All day' : friendlyTime(event.start),
      if (event.location != null && event.location!.isNotEmpty) event.location!,
    ];
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ListTile(
            leading: const Icon(Icons.rss_feed),
            title: Text(
              event.summary?.isNotEmpty == true ? event.summary! : 'Untitled event',
              style: event.dismissed
                  ? const TextStyle(decoration: TextDecoration.lineThrough)
                  : null,
            ),
            subtitle: Text(subtitleParts.join(' · ')),
            trailing: event.dismissed
                ? Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Chip(
                        label: Text('unneeded'),
                        visualDensity: VisualDensity.compact,
                      ),
                      if (isAdmin)
                        TextButton(
                          onPressed: () => onRestoreEvent(event.feedId, event.id),
                          child: const Text('Restore'),
                        ),
                    ],
                  )
                : (isAdmin
                    ? PopupMenuButton<String>(
                        onSelected: (_) => onDismissEvent(event.feedId, event.id),
                        itemBuilder: (_) => const [
                          PopupMenuItem(value: 'dismiss', child: Text('Mark unneeded')),
                        ],
                      )
                    : null),
          ),
          if (!event.dismissed)
            if (tasks.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                child: Text('No tasks generated', style: theme.textTheme.bodySmall),
              )
            else
              for (final t in tasks)
                Padding(
                  padding: const EdgeInsets.only(left: 16),
                  child: _TaskTile(task: t, actions: actions, dense: true),
                ),
        ],
      ),
    );
  }
}

/// A single task row with claim/release, (re)assign, and dismiss/restore.
class _TaskTile extends StatelessWidget {
  const _TaskTile({required this.task, required this.actions, this.dense = false});

  final TaskItem task;
  final _TaskActions actions;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final child = actions.names[task.familyMemberId] ?? 'child';
    final owner = task.ownerMemberId != null ? actions.names[task.ownerMemberId] : null;
    final owned = task.status == 'owned';
    final subtitle = owned && owner != null
        ? '${friendlyTime(task.start)} · $owner'
        : friendlyTime(task.start);

    return ListTile(
      dense: dense,
      leading: dense ? null : CircleAvatar(child: Icon(_iconFor(task.type))),
      title: Text(
        '${task.typeLabel} · $child',
        style: task.isDismissed
            ? const TextStyle(decoration: TextDecoration.lineThrough)
            : null,
      ),
      subtitle: Text(subtitle),
      trailing: _trailing(),
    );
  }

  Widget _trailing() {
    if (task.isDismissed) {
      return TextButton(
        onPressed: () => actions.onRestore(task.id),
        child: const Text('Restore'),
      );
    }
    final owned = task.status == 'owned';
    final assignable = actions.caretakers.where((m) => m.id != task.ownerMemberId).toList();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        owned
            ? TextButton(onPressed: () => actions.onRelease(task.id), child: const Text('Release'))
            : FilledButton(onPressed: () => actions.onClaim(task.id), child: const Text('Claim')),
        PopupMenuButton<String>(
          tooltip: 'More',
          onSelected: (v) {
            if (v == '__dismiss__') {
              actions.onDismiss(task.id);
            } else {
              actions.onAssign(task.id, v);
            }
          },
          itemBuilder: (_) => [
            if (assignable.isNotEmpty) ...[
              PopupMenuItem<String>(
                enabled: false,
                child: Text(owned ? 'Reassign to' : 'Assign to'),
              ),
              for (final m in assignable)
                PopupMenuItem<String>(value: m.id, child: Text(m.relationName)),
              const PopupMenuDivider(),
            ],
            const PopupMenuItem<String>(value: '__dismiss__', child: Text('Mark unneeded')),
          ],
        ),
      ],
    );
  }

  IconData _iconFor(String type) => switch (type) {
        'pickup' => Icons.directions_car,
        'dropoff' => Icons.login,
        _ => Icons.event,
      };
}

class _DayHeading extends StatelessWidget {
  const _DayHeading({required this.day, required this.now});
  final DateTime day;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 6),
      child: Text(
        dayHeading(day, now),
        style: theme.textTheme.titleSmall?.copyWith(
          color: theme.colorScheme.primary,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _MessageList extends StatelessWidget {
  const _MessageList(this.message);
  final String message;
  @override
  Widget build(BuildContext context) => ListView(
        children: [const SizedBox(height: 120), Center(child: Text(message))],
      );
}

class _ErrorList extends StatelessWidget {
  const _ErrorList(this.message);
  final String message;
  @override
  Widget build(BuildContext context) => ListView(
        children: [const SizedBox(height: 120), Center(child: Text(message))],
      );
}
