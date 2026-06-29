import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../util/format.dart';

/// Unowned-task dashboard: tasks grouped by day (Today/Tomorrow/date) with the
/// child's name and a friendly time, each claimable.
class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  Future<void> _refreshFeeds(WidgetRef ref) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).refreshAllFeeds(familyId);
    ref.invalidate(unownedTasksProvider);
  }

  Future<void> _claim(WidgetRef ref, String taskId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).assignTask(familyId, taskId);
    ref.invalidate(unownedTasksProvider);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tasksAsync = ref.watch(unownedTasksProvider);
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final names = {for (final m in members) m.id: m.relationName};

    return Scaffold(
      appBar: AppBar(
        title: const Text('Unowned tasks'),
        actions: [
          IconButton(
            tooltip: 'Refresh feeds',
            onPressed: () => _refreshFeeds(ref),
            icon: const Icon(Icons.sync),
          ),
          IconButton(
            tooltip: 'Sign out',
            onPressed: () => ref.read(authControllerProvider.notifier).logout(),
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: tasksAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (tasks) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(unownedTasksProvider);
            await ref.read(unownedTasksProvider.future);
          },
          child: tasks.isEmpty
              ? ListView(
                  children: const [
                    SizedBox(height: 160),
                    Center(child: Text('Nothing unowned — all covered 🎉')),
                  ],
                )
              : _GroupedTaskList(tasks: tasks, names: names, onClaim: (id) => _claim(ref, id)),
        ),
      ),
    );
  }
}

class _GroupedTaskList extends StatelessWidget {
  const _GroupedTaskList({
    required this.tasks,
    required this.names,
    required this.onClaim,
  });

  final List<TaskItem> tasks;
  final Map<String, String> names;
  final void Function(String taskId) onClaim;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final sorted = [...tasks]..sort((a, b) => a.start.compareTo(b.start));

    final groups = <DateTime, List<TaskItem>>{};
    for (final t in sorted) {
      (groups[dayKey(t.start)] ??= []).add(t);
    }
    final days = groups.keys.toList()..sort();

    final theme = Theme.of(context);
    final children = <Widget>[];
    for (final day in days) {
      children.add(
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 6),
          child: Text(
            dayHeading(day, now),
            style: theme.textTheme.titleSmall?.copyWith(
              color: theme.colorScheme.primary,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      );
      for (final t in groups[day]!) {
        final child = names[t.familyMemberId] ?? 'child';
        children.add(
          ListTile(
            leading: CircleAvatar(child: Icon(_iconFor(t.type))),
            title: Text('${t.typeLabel} · $child'),
            subtitle: Text(friendlyTime(t.start)),
            trailing: FilledButton(
              onPressed: () => onClaim(t.id),
              child: const Text('Claim'),
            ),
          ),
        );
      }
    }
    return ListView(children: children);
  }

  IconData _iconFor(String type) => switch (type) {
        'pickup' => Icons.directions_car,
        'dropoff' => Icons.login,
        _ => Icons.event,
      };
}
