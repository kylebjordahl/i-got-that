import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/auth.dart';
import '../state/family.dart';

/// Input feeds (school ICS, etc.): create, link to a child (+ baseline for
/// exception feeds), and force a refresh.
class FeedsScreen extends ConsumerWidget {
  const FeedsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final feedsAsync = ref.watch(feedsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Feeds')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final added = await showDialog<bool>(
            context: context,
            builder: (_) => const _AddFeedDialog(),
          );
          if (added == true) ref.invalidate(feedsProvider);
        },
        icon: const Icon(Icons.add),
        label: const Text('Add feed'),
      ),
      body: feedsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (feeds) => feeds.isEmpty
            ? const Center(child: Text('No feeds yet — add a school calendar ICS'))
            : ListView(
                children: [
                  for (final f in feeds)
                    ListTile(
                      leading: const CircleAvatar(child: Icon(Icons.rss_feed)),
                      title: Text(
                        f['url'] as String,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        '${f['mode']} · ${f['status']} · every ${f['refreshMinutes']}m',
                      ),
                      trailing: PopupMenuButton<String>(
                        onSelected: (v) => _onAction(context, ref, v, f),
                        itemBuilder: (_) => const [
                          PopupMenuItem(value: 'link', child: Text('Link a child')),
                          PopupMenuItem(value: 'refresh', child: Text('Refresh now')),
                        ],
                      ),
                    ),
                ],
              ),
      ),
    );
  }

  Future<void> _onAction(
    BuildContext context,
    WidgetRef ref,
    String action,
    Map<String, dynamic> feed,
  ) async {
    if (action == 'refresh') {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).refreshFeed(familyId, feed['id'] as String);
      ref.invalidate(unownedTasksProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Refreshed')));
      }
    } else if (action == 'link') {
      await showDialog<void>(
        context: context,
        builder: (_) => _LinkChildDialog(
          feedId: feed['id'] as String,
          isException: feed['mode'] == 'exception',
        ),
      );
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
            decoration: const InputDecoration(
              labelText: 'ICS URL',
              hintText: 'https://…/basic.ics',
            ),
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
              'Exception: events are deviations from a Mon–Fri baseline '
              '(no-school, early dismissal). Explicit: events become tasks directly.',
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

class _LinkChildDialog extends ConsumerStatefulWidget {
  const _LinkChildDialog({required this.feedId, required this.isException});

  final String feedId;
  final bool isException;

  @override
  ConsumerState<_LinkChildDialog> createState() => _LinkChildDialogState();
}

class _LinkChildDialogState extends ConsumerState<_LinkChildDialog> {
  static const _weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  String? _childId;
  final Set<int> _weekdays = {0, 1, 2, 3, 4}; // Mon–Fri
  final Set<String> _types = {'dropoff', 'pickup'};
  final _dayStart = TextEditingController(text: '08:00');
  final _dayEnd = TextEditingController(text: '15:00');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _dayStart.dispose();
    _dayEnd.dispose();
    super.dispose();
  }

  int get _weekdayMask =>
      _weekdays.fold(0, (mask, bit) => mask | (1 << bit));

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
      await ref.read(apiClientProvider).createMemberLink(
            familyId,
            widget.feedId,
            familyMemberId: _childId!,
            weekdayMask: widget.isException ? _weekdayMask : null,
            dayStart: widget.isException ? _dayStart.text.trim() : null,
            dayEnd: widget.isException ? _dayEnd.text.trim() : null,
            generatesTypes: widget.isException ? _types.toList() : null,
            defaultAttendance: widget.isException ? 'any' : null,
          );
      if (mounted) Navigator.of(context).pop();
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
      title: const Text('Link a child to this feed'),
      content: SingleChildScrollView(
        child: dependents.when(
          loading: () => const Center(child: Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator())),
          error: (e, _) => Text('$e'),
          data: (children) {
            if (children.isEmpty) {
              return const Text('Add a dependent (child) on the Family tab first.');
            }
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
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
                          onSelected: (s) => setState(
                            () => s ? _weekdays.add(i) : _weekdays.remove(i),
                          ),
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
                  const Text('Generates'),
                  Wrap(
                    spacing: 6,
                    children: [
                      for (final t in const ['dropoff', 'pickup'])
                        FilterChip(
                          label: Text(t == 'dropoff' ? 'Drop-off' : 'Pickup'),
                          selected: _types.contains(t),
                          onSelected: (s) => setState(
                            () => s ? _types.add(t) : _types.remove(t),
                          ),
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
          onPressed: _busy ? null : () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Link'),
        ),
      ],
    );
  }
}
