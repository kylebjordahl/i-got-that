import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../widgets/primitives.dart';

/// The "Add another calendar" sheet (6i): link a feed that already exists, or
/// set up a new one (ICS URL + optional name, or a calendar from a connected
/// account) — without leaving the member-detail context.
Future<void> showAddCalendarSheet(BuildContext context, WidgetRef ref, Member member) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _AddCalendarSheet(member: member),
  );
}

class _AddCalendarSheet extends ConsumerStatefulWidget {
  const _AddCalendarSheet({required this.member});
  final Member member;

  @override
  ConsumerState<_AddCalendarSheet> createState() => _AddCalendarSheetState();
}

class _AddCalendarSheetState extends ConsumerState<_AddCalendarSheet> {
  bool _newFeed = false;
  String _source = 'ics'; // 'ics' | 'account'
  String _mode = 'exception';
  final _url = TextEditingController();
  final _name = TextEditingController();

  String? _accountId;
  List<Map<String, dynamic>> _calendars = const [];
  String? _calId;
  bool _loadingCals = false;

  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    _name.dispose();
    super.dispose();
  }

  /// Feeds not yet linked to this member.
  List<FeedItem> _unlinked() {
    final feeds = ref.read(feedsProvider).valueOrNull ?? const <FeedItem>[];
    final out = <FeedItem>[];
    for (final f in feeds) {
      final links = ref.read(feedLinksProvider(f.id)).valueOrNull ?? const <FeedLink>[];
      if (!links.any((l) => l.familyMemberId == widget.member.id)) out.add(f);
    }
    return out;
  }

  void _refresh(String feedId) {
    ref.invalidate(feedsProvider);
    ref.invalidate(feedLinksProvider(feedId));
    ref.invalidate(calendarEventsProvider);
    ref.invalidate(pendingDecisionsProvider);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
  }

  Future<void> _link(FeedItem feed) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref
          .read(apiClientProvider)
          .createMemberLink(familyId, feed.id, familyMemberId: widget.member.id);
      _refresh(feed.id);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = '$e';
      });
    }
  }

  Future<void> _loadCalendars(String accountId) async {
    setState(() {
      _accountId = accountId;
      _loadingCals = true;
      _error = null;
      _calendars = const [];
      _calId = null;
    });
    try {
      final cals = await ref.read(apiClientProvider).listAccountCalendars(accountId);
      setState(() => _calendars = cals.cast<Map<String, dynamic>>());
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loadingCals = false);
    }
  }

  Future<void> _createAndLink() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      Map<String, dynamic> created;
      if (_source == 'ics') {
        if (!_url.text.trim().startsWith('http')) {
          setState(() {
            _busy = false;
            _error = 'Enter a valid ICS URL';
          });
          return;
        }
        created = await api.createFeed(
          familyId,
          mode: _mode,
          url: _url.text.trim(),
          name: _name.text.trim().isEmpty ? null : _name.text.trim(),
        );
      } else {
        final accounts = ref.read(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
        final account = accounts.where((a) => a.id == _accountId).firstOrNull;
        if (account == null || _calId == null) {
          setState(() {
            _busy = false;
            _error = 'Pick an account and a calendar';
          });
          return;
        }
        final cal = _calendars.firstWhere((c) => c['id'] == _calId);
        created = await api.createFeed(
          familyId,
          mode: _mode,
          kind: account.method,
          externalAccountId: account.id,
          sourceCalendarId: _calId,
          sourceCalendarName: cal['name'] as String?,
        );
      }
      final feedId = (created['feed'] as Map<String, dynamic>)['id'] as String;
      await api.createMemberLink(familyId, feedId, familyMemberId: widget.member.id);
      _refresh(feedId);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(22, 4, 22, 28 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: _newFeed ? _newFeedView() : _linkView(),
        ),
      ),
    );
  }

  List<Widget> _linkView() {
    final unlinked = _unlinked();
    return [
      Text('Add a calendar to ${widget.member.relationName}', style: AppText.subPageTitle),
      const SizedBox(height: 6),
      Text(
        unlinked.isEmpty
            ? "You haven't set up any input feeds yet. Set one up — you'll come straight back to link it."
            : 'Each one is transformed, then merged into their target. Link one that already exists:',
        style: AppText.subtitle,
      ),
      const SizedBox(height: 14),
      if (unlinked.isEmpty)
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.border),
          ),
          child: Center(
            child: Column(
              children: [
                const Icon(Icons.rss_feed_rounded, color: AppColors.textMuted, size: 28),
                const SizedBox(height: 8),
                Text('No feeds yet', style: AppText.sectionItemTitle),
              ],
            ),
          ),
        )
      else
        for (final f in unlinked)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: AppCard(
              padding: const EdgeInsets.fromLTRB(14, 10, 12, 10),
              child: Row(
                children: [
                  IconTile(
                    icon: f.kind == 'ics' ? Icons.rss_feed_rounded : Icons.calendar_month_rounded,
                    color: f.isException ? AppColors.amber : AppColors.feedBlue,
                    size: 38,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(f.displayName, maxLines: 1, overflow: TextOverflow.ellipsis, style: AppText.sectionItemTitle),
                        const SizedBox(height: 2),
                        Text(f.isException ? 'Exception-only' : 'Standard · ${f.kind.toUpperCase()}',
                            style: AppText.subtitle),
                      ],
                    ),
                  ),
                  PillButton(
                      label: 'Link', dense: true, variant: PillVariant.indigo, onPressed: _busy ? null : () => _link(f)),
                ],
              ),
            ),
          ),
      const SizedBox(height: 10),
      SizedBox(
        width: double.infinity,
        child: OutlinedButton.icon(
          onPressed: () => setState(() => _newFeed = true),
          icon: const Icon(Icons.add_rounded, size: 18),
          label: Text(unlinked.isEmpty ? 'Set up a new feed' : 'Set up a new feed instead'),
        ),
      ),
      if (_error != null) ...[
        const SizedBox(height: 10),
        Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
      ],
    ];
  }

  List<Widget> _newFeedView() {
    final accounts = ref.watch(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
    return [
      Row(
        children: [
          IconButton(
            onPressed: () => setState(() => _newFeed = false),
            icon: const Icon(Icons.arrow_back_rounded, color: AppColors.textSecondary),
          ),
          Text('Set up a new feed', style: AppText.subPageTitle),
        ],
      ),
      const SizedBox(height: 6),
      _Segmented(
        options: const [('ics', 'ICS URL'), ('account', 'From an account')],
        value: _source,
        onChanged: (v) => setState(() => _source = v),
      ),
      const SizedBox(height: 16),
      if (_source == 'ics') ...[
        TextField(
          controller: _url,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(labelText: 'Calendar URL', hintText: 'https://…/feed.ics'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _name,
          decoration: const InputDecoration(labelText: 'Name · optional'),
        ),
        const SizedBox(height: 6),
        Text("Left blank, we'll use the feed's own calendar title once it's fetched.",
            style: AppText.subtitle),
      ] else if (accounts.isEmpty)
        Text('Connect a calendar account on the Me tab first.', style: AppText.subtitle)
      else ...[
        DropdownButtonFormField<String>(
          initialValue: _accountId,
          decoration: const InputDecoration(labelText: 'Account'),
          items: [
            for (final a in accounts) DropdownMenuItem(value: a.id, child: Text('${a.name} (${a.kindLabel})')),
          ],
          onChanged: (v) {
            if (v != null) _loadCalendars(v);
          },
        ),
        if (_loadingCals)
          const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
        if (_calendars.isNotEmpty) ...[
          const SizedBox(height: 12),
          DropdownButtonFormField<String>(
            initialValue: _calId,
            decoration: const InputDecoration(labelText: 'Calendar'),
            items: [
              for (final c in _calendars)
                DropdownMenuItem(
                  value: c['id'] as String,
                  child: Text(c['name'] as String, maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
            ],
            onChanged: (v) => setState(() => _calId = v),
          ),
        ],
      ],
      const SizedBox(height: 14),
      _Segmented(
        options: const [('exception', 'Exception-only'), ('standard', 'Standard')],
        value: _mode,
        onChanged: (v) => setState(() => _mode = v),
      ),
      const SizedBox(height: 6),
      Text(
        _mode == 'exception'
            ? 'Empty on normal days; carries only deviations from a baseline.'
            : 'Events mean what they say.',
        style: AppText.subtitle,
      ),
      if (_error != null) ...[
        const SizedBox(height: 12),
        Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
      ],
      const SizedBox(height: 18),
      SizedBox(
        width: double.infinity,
        child: PillButton(
          label: 'Add feed',
          variant: PillVariant.indigo,
          onPressed: _busy ? null : _createAndLink,
        ),
      ),
    ];
  }
}

class _Segmented extends StatelessWidget {
  const _Segmented({required this.options, required this.value, required this.onChanged});
  final List<(String, String)> options;
  final String value;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppColors.bg,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          for (final (v, label) in options)
            Expanded(
              child: GestureDetector(
                onTap: () => onChanged(v),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: v == value ? AppColors.indigo : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: font(kBodyFont, 12, 700,
                          color: v == value ? const Color(0xFF17162B) : AppColors.textSecondary)),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
