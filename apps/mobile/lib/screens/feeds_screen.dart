import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/auth.dart';
import '../state/family.dart';
import 'rules_screen.dart';

const _weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/// Input feeds: create, expand to manage linked children (+ baselines), refresh.
class FeedsScreen extends ConsumerWidget {
  const FeedsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final feedsAsync = ref.watch(feedsProvider);
    final isAdmin = ref.watch(currentMemberProvider).valueOrNull?.isAdmin ?? false;
    return Scaffold(
      appBar: AppBar(title: const Text('Feeds')),
      floatingActionButton: isAdmin
          ? FloatingActionButton.extended(
              heroTag: 'fab-feeds',
              onPressed: () async {
                final added = await showDialog<bool>(
                  context: context,
                  builder: (_) => const _AddFeedDialog(),
                );
                if (added == true) ref.invalidate(feedsProvider);
              },
              icon: const Icon(Icons.add),
              label: const Text('Add feed'),
            )
          : null,
      body: feedsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (feeds) => feeds.isEmpty
            ? const Center(child: Text('No feeds yet — add a school calendar ICS'))
            : ListView(
                children: [
                  for (final f in feeds)
                    _FeedTile(feed: f),
                ],
              ),
      ),
    );
  }
}

class _FeedTile extends ConsumerWidget {
  const _FeedTile({required this.feed});
  final Map<String, dynamic> feed;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final feedId = feed['id'] as String;
    final isException = feed['mode'] == 'exception';
    final isAdmin = ref.watch(currentMemberProvider).valueOrNull?.isAdmin ?? false;
    final linksAsync = ref.watch(feedLinksProvider(feedId));
    final rulesAsync = ref.watch(classificationRulesProvider);

    return ExpansionTile(
      leading: const CircleAvatar(child: Icon(Icons.rss_feed)),
      title: Text(feed['url'] as String, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        '${feed['mode']} · ${feed['status']} · ${feed['timezone'] ?? 'UTC'} · every ${feed['refreshMinutes']}m',
      ),
      childrenPadding: const EdgeInsets.only(bottom: 8),
      children: [
        linksAsync.when(
          loading: () => const Padding(
            padding: EdgeInsets.all(12),
            child: LinearProgressIndicator(),
          ),
          error: (e, _) => Padding(padding: const EdgeInsets.all(12), child: Text('$e')),
          data: (links) => Column(
            children: [
              if (links.isEmpty)
                const ListTile(dense: true, title: Text('No children linked yet')),
              for (final link in links)
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.child_care),
                  title: Text(link['memberRelation'] as String),
                  subtitle: Text(_baselineSummary(link, isException)),
                  trailing: isAdmin
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            IconButton(
                              icon: const Icon(Icons.edit, size: 20),
                              onPressed: () => _linkDialog(context, ref, feedId, isException, link),
                            ),
                            IconButton(
                              icon: const Icon(Icons.delete_outline, size: 20),
                              onPressed: () => _removeLink(context, ref, feedId, link),
                            ),
                          ],
                        )
                      : null,
                ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              if (isAdmin)
                TextButton.icon(
                  onPressed: () => _linkDialog(context, ref, feedId, isException, null),
                  icon: const Icon(Icons.add),
                  label: const Text('Link a child'),
                ),
              const Spacer(),
              TextButton.icon(
                onPressed: () => _refresh(context, ref, feedId),
                icon: const Icon(Icons.sync),
                label: const Text('Refresh'),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 12, 0),
          child: Row(
            children: [
              Text('Feed rules', style: Theme.of(context).textTheme.titleSmall),
              const Spacer(),
              if (isAdmin)
                TextButton.icon(
                  onPressed: () => openRuleDialog(context, ref,
                      initialFeedId: feedId, lockFeedScope: true),
                  icon: const Icon(Icons.add),
                  label: const Text('Add rule'),
                ),
            ],
          ),
        ),
        rulesAsync.when(
          loading: () => const Padding(
            padding: EdgeInsets.all(12),
            child: LinearProgressIndicator(),
          ),
          error: (e, _) => Padding(padding: const EdgeInsets.all(12), child: Text('$e')),
          data: (rules) {
            final scoped = rules.where((r) => r.feedId == feedId).toList();
            if (scoped.isEmpty) {
              return const ListTile(dense: true, title: Text('No feed-specific rules yet'));
            }
            return Column(
              children: [
                for (final r in scoped)
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.rule, size: 20),
                    title: Text(describeRule(r)),
                    subtitle: Text(ruleDetail(r)),
                    trailing: isAdmin
                        ? Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                icon: const Icon(Icons.edit, size: 20),
                                onPressed: () => openRuleDialog(context, ref, existing: r),
                              ),
                              IconButton(
                                icon: const Icon(Icons.delete_outline, size: 20),
                                onPressed: () => confirmDeleteRule(context, ref, r),
                              ),
                            ],
                          )
                        : null,
                  ),
              ],
            );
          },
        ),
      ],
    );
  }

  String _baselineSummary(Map<String, dynamic> link, bool isException) {
    if (!isException) return 'Explicit feed';
    final mask = link['weekdayMask'] as int? ?? 0;
    final days = [
      for (var i = 0; i < 7; i++)
        if ((mask & (1 << i)) != 0) _weekdayLabels[i],
    ].join(' ');
    final types = ((link['generatesTypes'] as List?)?.cast<String>() ?? const [])
        .map((t) => t == 'dropoff' ? 'drop-off' : t)
        .join('/');
    final times = '${link['dayStart'] ?? '?'}–${link['dayEnd'] ?? '?'}';
    final dur = link['durationMinutes'] as int?;
    final loc = link['location'] as String?;
    final extras = [
      if (dur != null) '${dur}m block',
      if (loc != null && loc.isNotEmpty) loc,
    ].join(' · ');
    return '${days.isEmpty ? '—' : days} · $times · $types${extras.isEmpty ? '' : ' · $extras'}';
  }

  Future<void> _refresh(BuildContext context, WidgetRef ref, String feedId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).refreshFeed(familyId, feedId);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Refreshed')));
    }
  }

  Future<void> _linkDialog(
    BuildContext context,
    WidgetRef ref,
    String feedId,
    bool isException,
    Map<String, dynamic>? existing,
  ) async {
    final changed = await showDialog<bool>(
      context: context,
      builder: (_) => _LinkChildDialog(feedId: feedId, isException: isException, existing: existing),
    );
    if (changed == true) {
      ref.invalidate(feedLinksProvider(feedId));
      ref.invalidate(unownedTasksProvider);
      ref.invalidate(allTasksProvider);
    }
  }

  Future<void> _removeLink(
    BuildContext context,
    WidgetRef ref,
    String feedId,
    Map<String, dynamic> link,
  ) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Remove child from feed?'),
        content: Text('Stop generating tasks for ${link['memberRelation']} from this feed?'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (confirm == true) {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).deleteMemberLink(familyId, feedId, link['id'] as String);
      ref.invalidate(feedLinksProvider(feedId));
      ref.invalidate(unownedTasksProvider);
      ref.invalidate(allTasksProvider);
    }
  }
}

class _AddFeedDialog extends ConsumerStatefulWidget {
  const _AddFeedDialog();

  @override
  ConsumerState<_AddFeedDialog> createState() => _AddFeedDialogState();
}

class _AddFeedDialogState extends ConsumerState<_AddFeedDialog> {
  final _url = TextEditingController();
  final _refresh = TextEditingController(text: '360');
  String _mode = 'exception';
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    _refresh.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_url.text.trim().startsWith('http')) {
      setState(() => _error = 'Enter a valid ICS URL');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).createFeed(
            familyId,
            url: _url.text.trim(),
            mode: _mode,
            refreshMinutes: int.tryParse(_refresh.text.trim()) ?? 360,
          );
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Add input feed'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _url,
            autofocus: true,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(labelText: 'ICS URL', hintText: 'https://…/basic.ics'),
          ),
          const SizedBox(height: 12),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'exception', label: Text('Exception')),
              ButtonSegment(value: 'explicit', label: Text('Explicit')),
            ],
            selected: {_mode},
            onSelectionChanged: (s) => setState(() => _mode = s.first),
          ),
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text(
              'Exception: events are deviations from a Mon–Fri baseline (no-school, '
              'early dismissal). Explicit: events become tasks directly.',
              style: TextStyle(fontSize: 12),
            ),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _refresh,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Refresh interval (minutes)'),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Add'),
        ),
      ],
    );
  }
}

/// Create or edit a feed↔child link (+ baseline for exception feeds).
class _LinkChildDialog extends ConsumerStatefulWidget {
  const _LinkChildDialog({required this.feedId, required this.isException, this.existing});

  final String feedId;
  final bool isException;
  final Map<String, dynamic>? existing;

  @override
  ConsumerState<_LinkChildDialog> createState() => _LinkChildDialogState();
}

class _LinkChildDialogState extends ConsumerState<_LinkChildDialog> {
  String? _childId;
  final Set<int> _weekdays = {0, 1, 2, 3, 4};
  final Set<String> _types = {'dropoff', 'pickup'};
  final _dayStart = TextEditingController(text: '08:00');
  final _dayEnd = TextEditingController(text: '15:00');
  final _duration = TextEditingController();
  final _location = TextEditingController();
  bool _busy = false;
  String? _error;

  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final ex = widget.existing;
    if (ex != null) {
      _childId = ex['familyMemberId'] as String?;
      final mask = ex['weekdayMask'] as int? ?? 31;
      _weekdays
        ..clear()
        ..addAll([for (var i = 0; i < 7; i++) if ((mask & (1 << i)) != 0) i]);
      _types
        ..clear()
        ..addAll(((ex['generatesTypes'] as List?)?.cast<String>() ?? const ['dropoff', 'pickup']));
      _dayStart.text = ex['dayStart'] as String? ?? '08:00';
      _dayEnd.text = ex['dayEnd'] as String? ?? '15:00';
      final dur = ex['durationMinutes'] as int?;
      _duration.text = dur != null ? '$dur' : '';
      _location.text = ex['location'] as String? ?? '';
    }
  }

  @override
  void dispose() {
    _dayStart.dispose();
    _dayEnd.dispose();
    _duration.dispose();
    _location.dispose();
    super.dispose();
  }

  int get _weekdayMask => _weekdays.fold(0, (m, b) => m | (1 << b));

  Future<void> _save() async {
    if (_childId == null) {
      setState(() => _error = 'Pick a child');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      final duration =
          widget.isException ? int.tryParse(_duration.text.trim()) : null;
      final location = widget.isException ? _location.text.trim() : null;
      if (_editing) {
        await api.updateMemberLink(
          familyId,
          widget.feedId,
          widget.existing!['id'] as String,
          weekdayMask: widget.isException ? _weekdayMask : null,
          dayStart: widget.isException ? _dayStart.text.trim() : null,
          dayEnd: widget.isException ? _dayEnd.text.trim() : null,
          durationMinutes: duration,
          location: location,
          generatesTypes: widget.isException ? _types.toList() : null,
        );
      } else {
        await api.createMemberLink(
          familyId,
          widget.feedId,
          familyMemberId: _childId!,
          weekdayMask: widget.isException ? _weekdayMask : null,
          dayStart: widget.isException ? _dayStart.text.trim() : null,
          dayEnd: widget.isException ? _dayEnd.text.trim() : null,
          durationMinutes: duration,
          location: location,
          generatesTypes: widget.isException ? _types.toList() : null,
          defaultAttendance: widget.isException ? 'any' : null,
        );
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final dependents = ref.watch(dependentsProvider);
    return AlertDialog(
      title: Text(_editing ? 'Edit baseline' : 'Link a child to this feed'),
      content: SingleChildScrollView(
        child: dependents.when(
          loading: () => const Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator()),
          error: (e, _) => Text('$e'),
          data: (children) {
            if (children.isEmpty) {
              return const Text('Add a dependent (child) on the Family tab first.');
            }
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (_editing)
                  Text(
                    widget.existing!['memberRelation'] as String? ?? 'Child',
                    style: Theme.of(context).textTheme.titleMedium,
                  )
                else
                  DropdownButtonFormField<String>(
                    initialValue: _childId,
                    decoration: const InputDecoration(labelText: 'Child'),
                    items: [
                      for (final c in children)
                        DropdownMenuItem(value: c.id, child: Text(c.relationName)),
                    ],
                    onChanged: (v) => setState(() => _childId = v),
                  ),
                if (widget.isException) ...[
                  const SizedBox(height: 16),
                  const Text('School days'),
                  Wrap(
                    spacing: 6,
                    children: [
                      for (var i = 0; i < 7; i++)
                        FilterChip(
                          label: Text(_weekdayLabels[i]),
                          selected: _weekdays.contains(i),
                          onSelected: (s) => setState(() => s ? _weekdays.add(i) : _weekdays.remove(i)),
                        ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _dayStart,
                          decoration: const InputDecoration(labelText: 'Drop-off (HH:MM)'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: TextField(
                          controller: _dayEnd,
                          decoration: const InputDecoration(labelText: 'Pickup (HH:MM)'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _duration,
                          keyboardType: TextInputType.number,
                          decoration: const InputDecoration(
                            labelText: 'Block length (min)',
                            hintText: 'blank = 1h',
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        flex: 2,
                        child: TextField(
                          controller: _location,
                          decoration: const InputDecoration(
                            labelText: 'Location',
                            hintText: 'e.g. school',
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const Text('Generates'),
                  Wrap(
                    spacing: 6,
                    children: [
                      for (final t in const ['dropoff', 'pickup'])
                        FilterChip(
                          label: Text(t == 'dropoff' ? 'Drop-off' : 'Pickup'),
                          selected: _types.contains(t),
                          onSelected: (s) => setState(() => s ? _types.add(t) : _types.remove(t)),
                        ),
                    ],
                  ),
                ],
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  ),
              ],
            );
          },
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : Text(_editing ? 'Save' : 'Link'),
        ),
      ],
    );
  }
}
