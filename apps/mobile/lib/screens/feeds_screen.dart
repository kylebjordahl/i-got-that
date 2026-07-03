import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../widgets/primitives.dart';

/// Input feeds: the calendars that generate tasks. Add feeds here; link them to
/// specific children — and configure each baseline — from the child's detail
/// screen. Each row summarises how many family members the feed is linked to.
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
    final kind = feed['kind'] as String? ?? 'ics';
    final title = (feed['url'] as String?) ??
        (feed['sourceCalendarName'] as String?) ??
        (feed['sourceCalendarId'] as String?) ??
        'Account calendar';
    final sourceLabel = switch (kind) {
      'google' => 'Google',
      'caldav' => 'CalDAV',
      _ => 'ICS',
    };
    final n = (ref.watch(feedLinksProvider(feedId)).valueOrNull ?? const []).length;
    final linkedLabel = '$n ${n == 1 ? 'member' : 'members'} linked';

    return ListTile(
      leading: IconTile(
        icon: kind == 'ics' ? Icons.rss_feed : Icons.link,
        color: kind == 'ics' ? AppColors.feedBlue : AppColors.purple,
      ),
      title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text('$sourceLabel · ${feed['mode']} · $linkedLabel'),
      trailing: IconButton(
        icon: const Icon(Icons.sync),
        tooltip: 'Refresh now',
        onPressed: () => _refresh(context, ref, feedId),
      ),
    );
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
}

class _AddFeedDialog extends ConsumerStatefulWidget {
  const _AddFeedDialog();

  @override
  ConsumerState<_AddFeedDialog> createState() => _AddFeedDialogState();
}

class _AddFeedDialogState extends ConsumerState<_AddFeedDialog> {
  String _source = 'ics'; // 'ics' | 'account'
  final _url = TextEditingController();
  final _refresh = TextEditingController(text: '360');
  String _mode = 'exception';

  String? _accountId;
  List<Map<String, dynamic>> _calendars = const [];
  String? _selectedCalId;
  bool _loadingCals = false;

  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    _refresh.dispose();
    super.dispose();
  }

  Future<void> _loadCalendars(String accountId) async {
    setState(() {
      _loadingCals = true;
      _error = null;
      _calendars = const [];
      _selectedCalId = null;
    });
    try {
      final cals = await ref.read(apiClientProvider).listAccountCalendars(accountId);
      setState(() {
        _calendars = cals.cast<Map<String, dynamic>>();
        _selectedCalId = _calendars.isNotEmpty ? _calendars.first['id'] as String : null;
        if (_calendars.isEmpty) _error = 'No calendars found in this account';
      });
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loadingCals = false);
    }
  }

  Future<void> _save(List<ExternalAccount> accounts) async {
    final refreshMinutes = int.tryParse(_refresh.text.trim()) ?? 360;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      if (_source == 'ics') {
        if (!_url.text.trim().startsWith('http')) {
          setState(() => _error = 'Enter a valid ICS URL');
          return;
        }
        await api.createFeed(familyId, url: _url.text.trim(), mode: _mode, refreshMinutes: refreshMinutes);
      } else {
        if (_accountId == null || _selectedCalId == null) {
          setState(() => _error = 'Pick an account and a calendar');
          return;
        }
        final account = accounts.firstWhere((a) => a.id == _accountId);
        final cal = _calendars.firstWhere((c) => c['id'] == _selectedCalId);
        await api.createFeed(
          familyId,
          kind: account.method,
          externalAccountId: account.id,
          sourceCalendarId: _selectedCalId,
          sourceCalendarName: cal['name'] as String?,
          mode: _mode,
          refreshMinutes: refreshMinutes,
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
    final accountsAsync = ref.watch(accountsProvider);
    final accounts = accountsAsync.valueOrNull ?? const <ExternalAccount>[];
    return AlertDialog(
      title: const Text('Add input feed'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'ics', label: Text('ICS URL')),
                ButtonSegment(value: 'account', label: Text('Account')),
              ],
              selected: {_source},
              onSelectionChanged: (s) => setState(() {
                _source = s.first;
                _error = null;
              }),
            ),
            const SizedBox(height: 12),
            if (_source == 'ics')
              TextField(
                controller: _url,
                autofocus: true,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(labelText: 'ICS URL', hintText: 'https://…/basic.ics'),
              )
            else ...[
              if (accounts.isEmpty)
                const Text('Connect an account on the Accounts tab first.', style: TextStyle(fontSize: 13))
              else
                DropdownButtonFormField<String>(
                  initialValue: _accountId,
                  decoration: const InputDecoration(labelText: 'Account'),
                  items: [
                    for (final a in accounts)
                      DropdownMenuItem(value: a.id, child: Text('${a.name} (${a.kindLabel})')),
                  ],
                  onChanged: (v) {
                    setState(() => _accountId = v);
                    if (v != null) _loadCalendars(v);
                  },
                ),
              if (_loadingCals)
                const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
              if (_calendars.isNotEmpty) ...[
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _selectedCalId,
                  decoration: const InputDecoration(labelText: 'Calendar'),
                  items: [
                    for (final c in _calendars)
                      DropdownMenuItem(
                        value: c['id'] as String,
                        child: Text(c['name'] as String, maxLines: 1, overflow: TextOverflow.ellipsis),
                      ),
                  ],
                  onChanged: (v) => setState(() => _selectedCalId = v),
                ),
              ],
            ],
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
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : () => _save(accounts),
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Add'),
        ),
      ],
    );
  }
}
