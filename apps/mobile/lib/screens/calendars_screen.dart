import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../widgets/primitives.dart';

/// Output feeds (delivery destinations): an email invite, or a calendar from a
/// connected account. Created here, editable in place (name/active/alerts only —
/// the target calendar is immutable), deletable.
class CalendarsScreen extends ConsumerWidget {
  const CalendarsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final targetsAsync = ref.watch(targetsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Calendars')),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'fab-calendars',
        onPressed: () async {
          final added = await Navigator.of(context).push<bool>(
            MaterialPageRoute(builder: (_) => const OutputFeedPage()),
          );
          if (added == true) ref.invalidate(targetsProvider);
        },
        icon: const Icon(Icons.add_link),
        label: const Text('Add output'),
      ),
      body: targetsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (targets) => targets.isEmpty
            ? const Center(child: Text('No output feeds yet'))
            : ListView(
                children: [
                  for (final t in targets)
                    ListTile(
                      leading: IconTile(
                        icon: _iconFor(t['method'] as String),
                        color: _colorFor(t['method'] as String),
                      ),
                      title: Text(t['name'] as String),
                      subtitle: Text(
                        '${_methodLabel(t)} · ${t['memberRelation']} · ${t['addressOrUrl']}'
                        '${_alertsLabel(t)}'
                        '${(t['active'] as bool? ?? true) ? '' : ' · paused'}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: PopupMenuButton<String>(
                        onSelected: (v) => _onAction(context, ref, v, t),
                        itemBuilder: (_) => const [
                          PopupMenuItem(value: 'edit', child: Text('Edit')),
                          PopupMenuItem(value: 'delete', child: Text('Delete')),
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
    Map<String, dynamic> target,
  ) async {
    if (action == 'edit') {
      final changed = await Navigator.of(context).push<bool>(
        MaterialPageRoute(builder: (_) => OutputFeedPage(existing: target)),
      );
      if (changed == true) ref.invalidate(targetsProvider);
    } else if (action == 'delete') {
      final confirm = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
          title: const Text('Delete output feed?'),
          content: Text('Remove "${target['name']}"? This cannot be undone.'),
          actions: [
            TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
          ],
        ),
      );
      if (confirm == true) {
        final familyId = await ref.read(familyProvider.future);
        await ref.read(apiClientProvider).deleteCalendarTarget(familyId, target['id'] as String);
        ref.invalidate(targetsProvider);
      }
    }
  }

  String _alertsLabel(Map<String, dynamic> t) {
    final alerts = (t['alertMinutes'] as List?)?.cast<num>() ?? const [];
    if (alerts.isEmpty) return '';
    return ' · ⏰ ${alerts.map((m) => '${m.toInt()}m').join(', ')}';
  }

  IconData _iconFor(String method) => switch (method) {
        'email' => Icons.mail_outline,
        'google' => Icons.calendar_month,
        _ => Icons.cloud_outlined,
      };

  Color _colorFor(String method) => switch (method) {
        'email' => AppColors.coral,
        'google' => AppColors.blue,
        _ => AppColors.purple,
      };

  String _methodLabel(Map<String, dynamic> t) {
    final hint = t['providerHint'];
    if (hint == 'icloud') return 'iCloud';
    if (hint == 'google' || t['method'] == 'google') return 'Google';
    if (hint == 'generic_caldav') return 'CalDAV';
    return t['method'] as String;
  }
}

/// Create an output feed (caretaker + email or account calendar), or edit an
/// existing one's name/active/alerts. The target calendar + linked account are
/// immutable once created — recreate to change them.
class OutputFeedPage extends ConsumerStatefulWidget {
  const OutputFeedPage({super.key, this.existing});

  final Map<String, dynamic>? existing;

  @override
  ConsumerState<OutputFeedPage> createState() => _OutputFeedPageState();
}

class _OutputFeedPageState extends ConsumerState<OutputFeedPage> {
  String? _memberId;
  String _kind = 'email'; // 'email' | 'account'
  bool _active = true;
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _alert1 = TextEditingController();
  final _alert2 = TextEditingController();

  String? _accountId;
  List<Map<String, dynamic>> _calendars = const [];
  String? _selectedCalId;
  bool _loadingCals = false;

  bool _busy = false;
  String? _error;

  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final ex = widget.existing;
    if (ex != null) {
      _memberId = ex['memberId'] as String?;
      _kind = ex['method'] == 'email' ? 'email' : 'account';
      _name.text = ex['name'] as String? ?? '';
      _active = ex['active'] as bool? ?? true;
      final alerts = (ex['alertMinutes'] as List?)?.cast<num>() ?? const [];
      if (alerts.isNotEmpty) _alert1.text = '${alerts[0].toInt()}';
      if (alerts.length > 1) _alert2.text = '${alerts[1].toInt()}';
    }
  }

  @override
  void dispose() {
    for (final c in [_name, _email, _alert1, _alert2]) {
      c.dispose();
    }
    super.dispose();
  }

  List<int> get _alertMinutes => [
        for (final c in [_alert1, _alert2])
          if (int.tryParse(c.text.trim()) != null) int.parse(c.text.trim()),
      ];

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
    if (_name.text.trim().isEmpty) {
      setState(() => _error = 'Give the output feed a name');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);

      if (_editing) {
        await api.updateCalendarTarget(
          familyId,
          widget.existing!['id'] as String,
          name: _name.text.trim(),
          active: _active,
          alertMinutes: _alertMinutes,
        );
        if (mounted) Navigator.of(context).pop(true);
        return;
      }

      if (_memberId == null) {
        setState(() => _error = 'Pick a caretaker');
        return;
      }

      if (_kind == 'email') {
        if (!_email.text.trim().contains('@')) {
          setState(() => _error = 'Enter a delivery email');
          return;
        }
        await api.createCalendarTarget(
          familyId,
          memberId: _memberId!,
          name: _name.text.trim(),
          method: 'email',
          addressOrUrl: _email.text.trim(),
          alertMinutes: _alertMinutes,
        );
      } else {
        if (_accountId == null || _selectedCalId == null) {
          setState(() => _error = 'Pick an account and a calendar');
          return;
        }
        final account = accounts.firstWhere((a) => a.id == _accountId);
        await api.createCalendarTarget(
          familyId,
          memberId: _memberId!,
          name: _name.text.trim(),
          method: account.method,
          externalAccountId: account.id,
          addressOrUrl: _selectedCalId!,
          externalCalendarId: account.method == 'google' ? _selectedCalId : null,
          alertMinutes: _alertMinutes,
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
    final caretakers = ref.watch(caretakersProvider);
    final accounts = ref.watch(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
    return Scaffold(
      appBar: AppBar(title: Text(_editing ? 'Edit output feed' : 'Add output feed')),
      body: caretakers.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (people) {
          if (!_editing && people.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text('Add a caretaker on the Family tab first.'),
              ),
            );
          }
          return ListView(
            padding: const EdgeInsets.all(16),
            children: _editing ? _editFields() : _createFields(people, accounts),
          );
        },
      ),
    );
  }

  List<Widget> _createFields(List<dynamic> people, List<ExternalAccount> accounts) {
    return [
      DropdownButtonFormField<String>(
        initialValue: _memberId,
        decoration: const InputDecoration(labelText: 'Caretaker'),
        items: [
          for (final c in people)
            DropdownMenuItem(value: c.id as String, child: Text(c.relationName as String)),
        ],
        onChanged: (v) => setState(() => _memberId = v),
      ),
      const SizedBox(height: 16),
      SegmentedButton<String>(
        segments: const [
          ButtonSegment(value: 'email', label: Text('Email')),
          ButtonSegment(value: 'account', label: Text('Account calendar')),
        ],
        selected: {_kind},
        onSelectionChanged: (s) => setState(() {
          _kind = s.first;
          _error = null;
        }),
      ),
      const SizedBox(height: 16),
      if (_kind == 'email')
        TextField(
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          decoration: const InputDecoration(labelText: 'Delivery email', hintText: 'you@example.com'),
        )
      else ...[
        if (accounts.isEmpty)
          const _Hint('Connect an account on the Accounts tab first — only your own '
              'accounts can be used, and only for your own caretaker role.')
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
      const SizedBox(height: 16),
      TextField(
        controller: _name,
        decoration: const InputDecoration(labelText: 'Output feed name', hintText: 'e.g. Work calendar'),
      ),
      const SizedBox(height: 16),
      ..._alertsSection(),
      _errorAndSave(accounts),
    ];
  }

  List<Widget> _editFields() {
    return [
      const _Hint('The caretaker, method, and target calendar are fixed. To change '
          'the calendar, delete this feed and create a new one.'),
      const SizedBox(height: 12),
      TextField(
        controller: _name,
        decoration: const InputDecoration(labelText: 'Output feed name'),
      ),
      SwitchListTile(
        value: _active,
        onChanged: (v) => setState(() => _active = v),
        title: const Text('Active'),
        subtitle: const Text('Deliver tasks to this calendar'),
        contentPadding: EdgeInsets.zero,
      ),
      const SizedBox(height: 8),
      ..._alertsSection(),
      _errorAndSave(const []),
    ];
  }

  List<Widget> _alertsSection() => [
        Text('Default reminders', style: Theme.of(context).textTheme.labelLarge),
        const _Hint('Minutes before each event to alert (up to two). Leave blank for none.'),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _alert1,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Alert 1 (min)', hintText: 'e.g. 30'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextField(
                controller: _alert2,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Alert 2 (min)', hintText: 'e.g. 10'),
              ),
            ),
          ],
        ),
      ];

  Widget _errorAndSave(List<ExternalAccount> accounts) => Padding(
        padding: const EdgeInsets.only(top: 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ),
            FilledButton(
              onPressed: _busy ? null : () => _save(accounts),
              child: _busy
                  ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text(_editing ? 'Save' : 'Create'),
            ),
          ],
        ),
      );
}

class _Hint extends StatelessWidget {
  const _Hint(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Text(text, style: Theme.of(context).textTheme.bodySmall),
    );
  }
}
