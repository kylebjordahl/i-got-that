import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

const _weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/// The linked-feed editor (6g): how one source calendar shapes a member's
/// unified calendar. Feed type (standard / exception-only), the baseline that
/// generates normal days on exception feeds, and the override pipeline —
/// priority-ordered rules, first match wins, unmatched exception events become
/// pending decisions.
class FeedBaselineScreen extends ConsumerStatefulWidget {
  const FeedBaselineScreen({
    super.key,
    required this.member,
    this.feed,
    this.existingLink,
  });

  final Member member;

  /// The feed being linked. Null in "Add another calendar" mode — pick it here.
  final FeedItem? feed;

  /// The current member-link (with baseline), or null to create a new link.
  final FeedLink? existingLink;

  @override
  ConsumerState<FeedBaselineScreen> createState() => _FeedBaselineScreenState();
}

class _FeedBaselineScreenState extends ConsumerState<FeedBaselineScreen> {
  FeedItem? _feed;
  final Set<int> _weekdays = {0, 1, 2, 3, 4};
  final _location = TextEditingController();
  final _dayStart = TextEditingController(text: '08:30');
  final _dayEnd = TextEditingController(text: '14:45');
  bool _genTransition = true;
  bool _genAttendance = false;
  bool _busy = false;
  String? _error;

  bool get _linked => widget.existingLink != null;
  bool get _isException => _feed?.isException ?? false;

  @override
  void initState() {
    super.initState();
    _feed = widget.feed;
    final ex = widget.existingLink;
    if (ex != null) {
      final mask = ex.weekdayMask ?? 31;
      _weekdays
        ..clear()
        ..addAll([for (var i = 0; i < 7; i++) if ((mask & (1 << i)) != 0) i]);
      final types = ex.generatesTypes ?? const [];
      _genTransition =
          types.contains('dropoff') || types.contains('pickup') || types.isEmpty;
      _genAttendance = types.contains('attendance');
      _location.text = ex.location ?? '';
      _dayStart.text = ex.dayStart ?? '08:30';
      _dayEnd.text = ex.dayEnd ?? '14:45';
    }
  }

  @override
  void dispose() {
    for (final c in [_location, _dayStart, _dayEnd]) {
      c.dispose();
    }
    super.dispose();
  }

  int get _weekdayMask => _weekdays.fold(0, (m, b) => m | (1 << b));

  List<String> get _generatesTypes => [
        if (_genTransition) ...['dropoff', 'pickup'],
        if (_genAttendance) 'attendance',
      ];

  void _refresh(String feedId) {
    ref.invalidate(feedsProvider);
    ref.invalidate(feedLinksProvider(feedId));
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
    ref.invalidate(calendarEventsProvider);
    ref.invalidate(pendingDecisionsProvider);
  }

  Future<void> _setMode(String mode) async {
    final feed = _feed;
    if (feed == null || feed.mode == mode) return;
    setState(() => _busy = true);
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).updateFeed(familyId, feed.id, mode: mode);
      setState(() => _feed = FeedItem(
            id: feed.id,
            kind: feed.kind,
            mode: mode,
            url: feed.url,
            sourceCalendarName: feed.sourceCalendarName,
            timezone: feed.timezone,
            status: feed.status,
          ));
      _refresh(feed.id);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    final feed = _feed;
    if (feed == null) {
      setState(() => _error = 'Pick a feed source');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      final location = _location.text.trim().isEmpty ? null : _location.text.trim();
      if (_linked) {
        await api.updateMemberLink(
          familyId,
          feed.id,
          widget.existingLink!.id,
          weekdayMask: _isException ? _weekdayMask : null,
          dayStart: _isException ? _dayStart.text.trim() : null,
          dayEnd: _isException ? _dayEnd.text.trim() : null,
          location: location,
          generatesTypes: _generatesTypes,
        );
      } else {
        await api.createMemberLink(
          familyId,
          feed.id,
          familyMemberId: widget.member.id,
          weekdayMask: _isException ? _weekdayMask : null,
          dayStart: _isException ? _dayStart.text.trim() : null,
          dayEnd: _isException ? _dayEnd.text.trim() : null,
          location: location,
          generatesTypes: _generatesTypes,
          defaultAttendance: _genAttendance ? 'any' : null,
        );
      }
      _refresh(feed.id);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _unlink() async {
    final feedId = _feed!.id;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Unlink feed?'),
        content: Text('Stop synthesizing ${widget.member.relationName}\'s events '
            'from this feed? Its events, rules, and generated tasks are removed.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel')),
          PillButton(
            label: 'Unlink',
            variant: PillVariant.white,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref
          .read(apiClientProvider)
          .deleteMemberLink(familyId, feedId, widget.existingLink!.id);
      _refresh(feedId);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Unlink failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 40),
          children: [
            const SubPageHeader(title: 'Linked feed'),
            const SizedBox(height: 18),
            const SectionEyebrow('Feed source'),
            const SizedBox(height: 12),
            AppCard(
              padding: EdgeInsets.zero,
              child: _PickerRow(
                label: 'Source',
                value: _feed == null ? 'Choose a feed' : _feed!.displayName,
                enabled: !_linked,
                onTap: _pickSource,
              ),
            ),
            if (_feed != null) ...[
              const SizedBox(height: 24),
              const SectionEyebrow('Feed type'),
              const SizedBox(height: 8),
              Text(
                'Exception-only feeds are empty on normal days and carry only '
                'deviations; normal days come from the baseline below.',
                style: AppText.subtitle,
              ),
              const SizedBox(height: 12),
              _Segmented(
                options: const [('standard', 'Standard'), ('exception', 'Exception-only')],
                value: _feed!.mode,
                activeColor: _isException ? AppColors.amber : AppColors.indigo,
                onChanged: _busy ? null : _setMode,
              ),
            ],
            if (_isException) ...[
              const SizedBox(height: 24),
              const SectionEyebrow('Baseline — the normal school day',
                  color: AppColors.amber),
              const SizedBox(height: 12),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (var i = 0; i < 7; i++)
                          _DayChip(
                            label: _weekdayLabels[i],
                            selected: _weekdays.contains(i),
                            onTap: () => setState(() => _weekdays.contains(i)
                                ? _weekdays.remove(i)
                                : _weekdays.add(i)),
                          ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Expanded(child: _field(_dayStart, 'Day starts', 'HH:MM')),
                        const SizedBox(width: 12),
                        Expanded(child: _field(_dayEnd, 'Day ends', 'HH:MM')),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _field(_location, 'Location', 'e.g. Lincoln Elementary'),
                    const SizedBox(height: 16),
                    const Divider(height: 1),
                    const SizedBox(height: 12),
                    SwitchRow(
                      icon: Icons.login_rounded,
                      iconColor: AppColors.green,
                      title: 'Drop-off + pickup',
                      subtitle: 'Each school day generates both transitions',
                      value: _genTransition,
                      onChanged: (v) => setState(() => _genTransition = v),
                    ),
                    const Divider(height: 20),
                    SwitchRow(
                      icon: Icons.groups_rounded,
                      iconColor: AppColors.purple,
                      title: 'Attendance',
                      subtitle: 'Someone stays for the duration',
                      value: _genAttendance,
                      onChanged: (v) => setState(() => _genAttendance = v),
                    ),
                  ],
                ),
              ),
            ] else if (_feed != null) ...[
              const SizedBox(height: 24),
              const SectionEyebrow('Generates'),
              const SizedBox(height: 8),
              Text(
                'Unmatched events land on the calendar as-is and generate a '
                'convertible attendance task; rules below can set other types.',
                style: AppText.subtitle,
              ),
            ],
            if (_linked) ...[
              const SizedBox(height: 24),
              _OverridePipeline(
                feed: _feed!,
                link: widget.existingLink!,
                isException: _isException,
              ),
            ] else if (_feed != null) ...[
              const SizedBox(height: 16),
              Text('Save the link first to configure its override pipeline.',
                  style: AppText.subtitle),
            ],
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
            ],
            const SizedBox(height: 28),
            _PrimaryButton(
              label: _linked ? 'Save linked feed' : 'Link feed',
              busy: _busy,
              onPressed: _busy ? null : _save,
            ),
            if (_linked) ...[
              const SizedBox(height: 12),
              _RemoveButton(label: 'Unlink feed', onTap: _unlink),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _pickSource() async {
    if (_linked) return;
    final feeds = ref.read(feedsProvider).valueOrNull ?? const <FeedItem>[];
    final unlinked = <FeedItem>[];
    for (final f in feeds) {
      final links = ref.read(feedLinksProvider(f.id)).valueOrNull ?? const <FeedLink>[];
      final linked = links.any((l) => l.familyMemberId == widget.member.id);
      if (!linked) unlinked.add(f);
    }
    if (unlinked.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('No more feeds to link — add one in Input feeds')));
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetCtx) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Feed source', style: AppText.subPageTitle),
            const SizedBox(height: 12),
            for (final f in unlinked)
              SettingRow(
                icon: f.kind == 'ics'
                    ? Icons.rss_feed_rounded
                    : Icons.calendar_month_rounded,
                iconColor:
                    f.kind == 'ics' ? AppColors.feedBlue : AppColors.purple,
                title: f.displayName,
                subtitle: f.isException ? 'Exception-only' : 'Standard',
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  setState(() => _feed = f);
                },
              ),
          ],
        ),
      ),
    );
  }

  Widget _field(TextEditingController c, String label, String hint) {
    return TextField(
      controller: c,
      decoration: InputDecoration(labelText: label, hintText: hint),
    );
  }
}

/// The override pipeline (first match wins): incoming event → rules in priority
/// order → the unmatched terminal. Drag to reorder; "+" inserts; tap to edit.
class _OverridePipeline extends ConsumerWidget {
  const _OverridePipeline({
    required this.feed,
    required this.link,
    required this.isException,
  });
  final FeedItem feed;
  final FeedLink link;
  final bool isException;

  ({String feedId, String linkId}) get _key => (feedId: feed.id, linkId: link.id);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rules = ref.watch(linkRulesProvider(_key)).valueOrNull ?? const <OverrideRule>[];

    // onReorderItem's newIndex is already adjusted for the removed item.
    Future<void> reorder(int oldIndex, int newIndex) async {
      final ids = rules.map((r) => r.id).toList();
      final moved = ids.removeAt(oldIndex);
      ids.insert(newIndex, moved);
      final familyId = await ref.read(familyProvider.future);
      await ref
          .read(apiClientProvider)
          .reorderLinkRules(familyId, feed.id, link.id, ids);
      ref.invalidate(linkRulesProvider(_key));
      ref.invalidate(calendarEventsProvider);
      ref.invalidate(pendingDecisionsProvider);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionEyebrow('Override pipeline', color: AppColors.purple),
        const SizedBox(height: 8),
        Text(
          'How feed events change the result. Drag to reorder · first match wins.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 12),
        AppCard(
          padding: EdgeInsets.zero,
          child: SettingRow(
            icon: Icons.input_rounded,
            iconColor: AppColors.feedBlue,
            title: 'Incoming event',
            subtitle: feed.displayName,
          ),
        ),
        const SizedBox(height: 10),
        if (rules.isNotEmpty)
          ReorderableListView(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            buildDefaultDragHandles: false,
            onReorderItem: reorder,
            children: [
              for (var i = 0; i < rules.length; i++)
                Padding(
                  key: ValueKey(rules[i].id),
                  padding: const EdgeInsets.only(bottom: 10),
                  child: _RuleCard(
                    index: i,
                    rule: rules[i],
                    onTap: () => showRuleSheet(context, ref,
                        feed: feed, link: link, existing: rules[i]),
                  ),
                ),
            ],
          ),
        Center(
          child: TextButton.icon(
            onPressed: () => showRuleSheet(context, ref, feed: feed, link: link),
            icon: const Icon(Icons.add_rounded, size: 18, color: AppColors.purple),
            label: Text('Add rule',
                style: font(kBodyFont, 13, 700, color: AppColors.purple)),
          ),
        ),
        const SizedBox(height: 4),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.tint(AppColors.amber, 0.07),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppColors.amber.withValues(alpha: 0.35)),
          ),
          child: Row(
            children: [
              const Icon(Icons.help_outline_rounded, color: AppColors.amber, size: 18),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  isException
                      ? 'Everything else — unmatched: not on the baseline and no '
                          'rule matched → pending decision on Home. The system '
                          'won\'t guess.'
                      : 'Everything else — unmatched: lands on the calendar as-is '
                          'with a convertible attendance task.',
                  style: font(kBodyFont, 12, 500, color: AppColors.amber),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _RuleCard extends StatelessWidget {
  const _RuleCard({required this.index, required this.rule, required this.onTap});
  final int index;
  final OverrideRule rule;
  final VoidCallback onTap;

  Color get _outcomeColor => switch (rule.outcome) {
        'cancel_day' => AppColors.coral,
        'modify_day' => AppColors.amber,
        'annotate' => AppColors.blue,
        _ => AppColors.purple,
      };

  @override
  Widget build(BuildContext context) {
    return AppCard(
      padding: EdgeInsets.zero,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(18),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 12, 14, 12),
          child: Row(
            children: [
              ReorderableDragStartListener(
                index: index,
                child: const Padding(
                  padding: EdgeInsets.all(6),
                  child: Icon(Icons.drag_indicator_rounded,
                      color: AppColors.textMuted, size: 20),
                ),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(rule.matcherSummary,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppText.sectionItemTitle),
                    const SizedBox(height: 3),
                    Text(
                      rule.matchOp == 'regex' ? 'Regex · event field' : 'Matcher',
                      style: AppText.subtitle,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              TintBadge(rule.outcomeLabel, color: _outcomeColor),
            ],
          ),
        ),
      ),
    );
  }
}

/// Bottom-sheet rule editor (5r reworked): matcher (field + condition + value)
/// and the outcome with its params. ECMAScript regexes, `/pattern/flags` form.
Future<void> showRuleSheet(
  BuildContext context,
  WidgetRef ref, {
  required FeedItem feed,
  required FeedLink link,
  OverrideRule? existing,
}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _RuleSheet(feed: feed, link: link, existing: existing),
  );
}

class _RuleSheet extends ConsumerStatefulWidget {
  const _RuleSheet({required this.feed, required this.link, this.existing});
  final FeedItem feed;
  final FeedLink link;
  final OverrideRule? existing;

  @override
  ConsumerState<_RuleSheet> createState() => _RuleSheetState();
}

class _RuleSheetState extends ConsumerState<_RuleSheet> {
  late String _matchField;
  late String _matchOp;
  late String _outcome;
  final _value = TextEditingController();
  final _annotateText = TextEditingController();
  final _dayEnd = TextEditingController();
  bool _genTransition = false;
  bool _genAttendance = false;
  bool _busy = false;
  String? _error;

  bool get _editing => widget.existing != null;
  bool get _isException => widget.feed.isException;

  @override
  void initState() {
    super.initState();
    final ex = widget.existing;
    _matchField = ex?.matchField ?? 'summary';
    _matchOp = ex?.matchOp ?? 'contains';
    _outcome = ex?.outcome ?? (_isException ? 'cancel_day' : 'set_event');
    _value.text = ex?.matchValue ?? '';
    _annotateText.text = (ex?.params?['text'] as String?) ?? '';
    _dayEnd.text = (ex?.params?['dayEnd'] as String?) ?? '';
    final types = ex?.generatesTypes ?? const [];
    _genTransition = types.contains('dropoff') || types.contains('pickup');
    _genAttendance = types.contains('attendance');
  }

  @override
  void dispose() {
    for (final c in [_value, _annotateText, _dayEnd]) {
      c.dispose();
    }
    super.dispose();
  }

  bool get _isTextField =>
      const {'summary', 'location', 'description', 'any_text'}.contains(_matchField);

  Map<String, dynamic>? get _params => switch (_outcome) {
        'annotate' => {'text': _annotateText.text.trim()},
        'modify_day' =>
          _dayEnd.text.trim().isEmpty ? null : {'dayEnd': _dayEnd.text.trim()},
        _ => null,
      };

  List<String>? get _generatesTypes {
    if (!_genTransition && !_genAttendance) return null;
    return [
      if (_genTransition) ...['dropoff', 'pickup'],
      if (_genAttendance) 'attendance',
    ];
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      final matchValue = _value.text.trim().isEmpty ? null : _value.text.trim();
      if (_editing) {
        await api.updateLinkRule(
          familyId,
          widget.feed.id,
          widget.link.id,
          widget.existing!.id,
          matchField: _matchField,
          matchOp: _matchOp,
          outcome: _outcome,
          matchValue: matchValue,
          params: _params,
          generatesTypes: _generatesTypes,
        );
      } else {
        await api.createLinkRule(
          familyId,
          widget.feed.id,
          widget.link.id,
          matchField: _matchField,
          matchOp: _matchOp,
          outcome: _outcome,
          matchValue: matchValue,
          params: _params,
          generatesTypes: _generatesTypes,
        );
      }
      _invalidate();
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = '$e';
      });
    }
  }

  Future<void> _delete() async {
    setState(() => _busy = true);
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).deleteLinkRule(
          familyId, widget.feed.id, widget.link.id, widget.existing!.id);
      _invalidate();
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = '$e';
      });
    }
  }

  void _invalidate() {
    ref.invalidate(
        linkRulesProvider((feedId: widget.feed.id, linkId: widget.link.id)));
    ref.invalidate(calendarEventsProvider);
    ref.invalidate(pendingDecisionsProvider);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
  }

  @override
  Widget build(BuildContext context) {
    final outcomes = [
      if (_isException) ...[('cancel_day', 'Cancel day'), ('modify_day', 'Modify day')],
      ('annotate', 'Annotate'),
      ('set_event', 'Set event'),
    ];
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
            22, 4, 22, 28 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(_editing ? 'Edit rule' : 'New rule', style: AppText.subPageTitle),
                const Spacer(),
                if (_editing)
                  IconButton(
                    onPressed: _busy ? null : _delete,
                    icon: const Icon(Icons.delete_outline_rounded,
                        color: AppColors.coral),
                  ),
              ],
            ),
            const SizedBox(height: 14),
            Text('WHEN AN EVENT…', style: AppText.eyebrow()),
            const SizedBox(height: 10),
            _Dropdown(
              label: 'Match on',
              value: _matchField,
              items: const [
                ('summary', 'Event title'),
                ('location', 'Location'),
                ('description', 'Description'),
                ('any_text', 'Any text'),
                ('all_day', 'All-day'),
                ('duration', 'Duration'),
              ],
              onChanged: (v) => setState(() {
                _matchField = v;
                _matchOp = switch (v) {
                  'all_day' => 'is_true',
                  'duration' => 'gte',
                  _ => const {'contains', 'starts_with', 'equals', 'regex'}
                          .contains(_matchOp)
                      ? _matchOp
                      : 'contains',
                };
              }),
            ),
            const SizedBox(height: 12),
            if (_isTextField)
              _Segmented(
                options: const [
                  ('contains', 'Contains'),
                  ('regex', 'Matches regex'),
                  ('starts_with', 'Starts with'),
                ],
                value: _matchOp == 'equals' ? 'contains' : _matchOp,
                activeColor: AppColors.indigo,
                onChanged: (v) => setState(() => _matchOp = v),
              )
            else if (_matchField == 'all_day')
              _Segmented(
                options: const [('is_true', 'Is all-day'), ('is_false', 'Is timed')],
                value: _matchOp,
                activeColor: AppColors.indigo,
                onChanged: (v) => setState(() => _matchOp = v),
              )
            else
              _Segmented(
                options: const [('gte', 'At least (min)'), ('lte', 'At most (min)')],
                value: _matchOp,
                activeColor: AppColors.indigo,
                onChanged: (v) => setState(() => _matchOp = v),
              ),
            if (_matchField != 'all_day') ...[
              const SizedBox(height: 12),
              TextField(
                controller: _value,
                keyboardType:
                    _matchField == 'duration' ? TextInputType.number : null,
                decoration: InputDecoration(
                  labelText:
                      _matchField == 'duration' ? 'Minutes' : 'Value / pattern',
                  hintText: _matchOp == 'regex' ? '/no school|closed/i' : null,
                ),
              ),
              if (_matchOp == 'regex') ...[
                const SizedBox(height: 8),
                Text(
                  'Uses ECMAScript regular expressions — the same flavor as '
                  'JavaScript. Flags after the closing slash (e.g. i for '
                  'case-insensitive).',
                  style: AppText.subtitle,
                ),
              ],
            ],
            const SizedBox(height: 20),
            Text('THEN…', style: AppText.eyebrow()),
            const SizedBox(height: 10),
            _Segmented(
              options: outcomes,
              value: _outcome,
              activeColor: AppColors.purple,
              onChanged: (v) => setState(() => _outcome = v),
            ),
            if (_outcome == 'annotate') ...[
              const SizedBox(height: 12),
              TextField(
                controller: _annotateText,
                decoration: const InputDecoration(
                    labelText: 'Annotation', hintText: 'e.g. Photo Day'),
              ),
            ],
            if (_outcome == 'modify_day') ...[
              const SizedBox(height: 12),
              TextField(
                controller: _dayEnd,
                decoration: const InputDecoration(
                    labelText: 'New day end', hintText: 'HH:MM (e.g. 12:00)'),
              ),
            ],
            if (_outcome == 'set_event' || _outcome == 'modify_day') ...[
              const SizedBox(height: 12),
              Text('Generates (optional — overrides the link default)',
                  style: AppText.subtitle),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: [
                  FilterChip(
                    label: const Text('Transitions'),
                    selected: _genTransition,
                    onSelected: (v) => setState(() => _genTransition = v),
                  ),
                  FilterChip(
                    label: const Text('Attendance'),
                    selected: _genAttendance,
                    onSelected: (v) => setState(() => _genAttendance = v),
                  ),
                ],
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
            ],
            const SizedBox(height: 20),
            _PrimaryButton(
                label: 'Save rule', busy: _busy, onPressed: _busy ? null : _save),
          ],
        ),
      ),
    );
  }
}

class _Dropdown extends StatelessWidget {
  const _Dropdown({
    required this.label,
    required this.value,
    required this.items,
    required this.onChanged,
  });
  final String label;
  final String value;
  final List<(String, String)> items;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    return DropdownButtonFormField<String>(
      initialValue: value,
      decoration: InputDecoration(labelText: label),
      items: [
        for (final (v, l) in items) DropdownMenuItem(value: v, child: Text(l)),
      ],
      onChanged: (v) {
        if (v != null) onChanged(v);
      },
    );
  }
}

class _Segmented extends StatelessWidget {
  const _Segmented({
    required this.options,
    required this.value,
    required this.activeColor,
    required this.onChanged,
  });
  final List<(String, String)> options;
  final String value;
  final Color activeColor;
  final ValueChanged<String>? onChanged;

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
                onTap: onChanged == null ? null : () => onChanged!(v),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  decoration: BoxDecoration(
                    color: v == value ? activeColor : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  alignment: Alignment.center,
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: font(kBodyFont, 12, 700,
                        color: v == value
                            ? const Color(0xFF17162B)
                            : AppColors.textSecondary),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _PickerRow extends StatelessWidget {
  const _PickerRow({
    required this.label,
    required this.value,
    required this.onTap,
    this.enabled = true,
  });
  final String label;
  final String value;
  final VoidCallback onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: enabled ? onTap : null,
      borderRadius: BorderRadius.circular(20),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        child: Row(
          children: [
            Text(label, style: AppText.sectionItemTitle),
            const Spacer(),
            Flexible(
              child: Text(value,
                  textAlign: TextAlign.right,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.subtitle),
            ),
            if (enabled) ...[
              const SizedBox(width: 8),
              const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
            ],
          ],
        ),
      ),
    );
  }
}

class _DayChip extends StatelessWidget {
  const _DayChip({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? AppColors.amber : AppColors.bg,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: selected ? AppColors.amber : AppColors.border),
        ),
        child: Text(
          label,
          style: font(kBodyFont, 13, 600,
              color: selected ? const Color(0xFF2A1E05) : AppColors.textSecondary),
        ),
      ),
    );
  }
}

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({required this.label, required this.busy, required this.onPressed});
  final String label;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.indigo,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(999),
        child: Container(
          height: 50,
          alignment: Alignment.center,
          child: busy
              ? const SizedBox(
                  height: 20,
                  width: 20,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: Color(0xFF17162B)),
                )
              : Text(label,
                  style: font(kBodyFont, 14.5, 700, color: const Color(0xFF17162B))),
        ),
      ),
    );
  }
}

class _RemoveButton extends StatelessWidget {
  const _RemoveButton({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.tint(AppColors.coral, 0.10),
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          height: 50,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.coral.withValues(alpha: 0.5)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.link_off_rounded, color: AppColors.coral, size: 19),
              const SizedBox(width: 8),
              Text(label, style: font(kBodyFont, 14, 700, color: AppColors.coral)),
            ],
          ),
        ),
      ),
    );
  }
}
