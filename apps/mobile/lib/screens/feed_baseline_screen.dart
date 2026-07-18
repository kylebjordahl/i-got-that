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

/// Feed setup (6g): how one source calendar shapes a member's SCHEDULE. Feed
/// type (standard / exception-only), the baseline for normal days on exception
/// feeds, and the override pipeline — cancel/modify/ignore, first match wins,
/// unmatched exception events become pending decisions. Task typing lives
/// separately in Task rules (6k).
class FeedBaselineScreen extends ConsumerStatefulWidget {
  const FeedBaselineScreen({
    super.key,
    required this.member,
    required this.feed,
    required this.existingLink,
  });

  final Member member;
  final FeedItem feed;
  final FeedLink existingLink;

  @override
  ConsumerState<FeedBaselineScreen> createState() => _FeedBaselineScreenState();
}

class _FeedBaselineScreenState extends ConsumerState<FeedBaselineScreen> {
  late FeedItem _feed = widget.feed;
  final Set<int> _weekdays = {0, 1, 2, 3, 4};
  final _location = TextEditingController();
  final _dayStart = TextEditingController(text: '08:30');
  final _dayEnd = TextEditingController(text: '14:45');
  bool _busy = false;
  String? _error;

  bool get _isException => _feed.isException;

  @override
  void initState() {
    super.initState();
    final ex = widget.existingLink;
    final mask = ex.weekdayMask ?? 31;
    _weekdays
      ..clear()
      ..addAll([for (var i = 0; i < 7; i++) if ((mask & (1 << i)) != 0) i]);
    _location.text = ex.location ?? '';
    _dayStart.text = ex.dayStart ?? '08:30';
    _dayEnd.text = ex.dayEnd ?? '14:45';
  }

  @override
  void dispose() {
    for (final c in [_location, _dayStart, _dayEnd]) {
      c.dispose();
    }
    super.dispose();
  }

  int get _weekdayMask => _weekdays.fold(0, (m, b) => m | (1 << b));

  void _refresh() {
    ref.invalidate(feedsProvider);
    ref.invalidate(feedLinksProvider(_feed.id));
    ref.invalidate(calendarEventsProvider);
    ref.invalidate(pendingDecisionsProvider);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
  }

  Future<void> _setMode(String mode) async {
    if (_feed.mode == mode) return;
    setState(() => _busy = true);
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).updateFeed(familyId, _feed.id, mode: mode);
      setState(() => _feed = FeedItem(
            id: _feed.id,
            kind: _feed.kind,
            mode: mode,
            url: _feed.url,
            sourceCalendarName: _feed.sourceCalendarName,
            timezone: _feed.timezone,
            status: _feed.status,
          ));
      _refresh();
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).updateMemberLink(
            familyId,
            _feed.id,
            widget.existingLink.id,
            weekdayMask: _isException ? _weekdayMask : null,
            dayStart: _isException ? _dayStart.text.trim() : null,
            dayEnd: _isException ? _dayEnd.text.trim() : null,
            location: _location.text.trim().isEmpty ? null : _location.text.trim(),
          );
      _refresh();
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _unlink() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Unlink feed?'),
        content: Text('Stop synthesizing ${widget.member.relationName}\'s events '
            'from this feed? Its events, rules, and generated tasks are removed.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          PillButton(label: 'Unlink', variant: PillVariant.white, onPressed: () => Navigator.of(context).pop(true)),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).deleteMemberLink(familyId, _feed.id, widget.existingLink.id);
      _refresh();
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Unlink failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(22, 12, 22, 18),
              child: SubPageHeader(title: 'Feed setup'),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 150),
                children: [
                  const SectionEyebrow('Feed source'),
                  const SizedBox(height: 12),
                  AppCard(
                    child: SettingRow(
                      icon: _feed.kind == 'ics' ? Icons.rss_feed_rounded : Icons.calendar_month_rounded,
                      iconColor: AppColors.feedBlue,
                      title: _feed.displayName,
                      subtitle: _feed.kind.toUpperCase(),
                    ),
                  ),
                  const SizedBox(height: 24),
                  const SectionEyebrow('Feed type'),
                  const SizedBox(height: 8),
                  if (_feed.isBusy) ...[
                    // Busy feeds can't change mode (the server refuses:
                    // interval-keyed data is incompatible with the other
                    // pipelines) — recreate the feed instead.
                    Text(
                      'Busy-only: opaque availability blocks read via Google '
                      'free/busy — event details never leave the source '
                      'calendar. The type is fixed; to change it, remove this '
                      'feed and set up a new one.',
                      style: AppText.subtitle,
                    ),
                  ] else ...[
                    Text(
                      'Exception-only feeds are empty on normal days and carry only '
                      'deviations; normal days come from the baseline below.',
                      style: AppText.subtitle,
                    ),
                    const SizedBox(height: 12),
                    _Segmented(
                      options: const [('standard', 'Standard'), ('exception', 'Exception-only')],
                      value: _feed.mode,
                      activeColor: _isException ? AppColors.amber : AppColors.indigo,
                      onChanged: _busy ? null : _setMode,
                    ),
                  ],
                  if (_isException) ...[
                    const SizedBox(height: 24),
                    const SectionEyebrow('Baseline — the normal school day', color: AppColors.amber),
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
                                  onTap: () => setState(() =>
                                      _weekdays.contains(i) ? _weekdays.remove(i) : _weekdays.add(i)),
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
                          _field(_location, 'Default location', 'Prefilled onto every task'),
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),
                    _OverridePipeline(feed: _feed, link: widget.existingLink),
                  ] else ...[
                    const SizedBox(height: 16),
                    Text(
                      'Standard feeds pass events through as-is. What tasks they '
                      'generate is set in Task rules (Family logistics).',
                      style: AppText.subtitle,
                    ),
                  ],
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
                  ],
                  const SizedBox(height: 28),
                  _PrimaryButton(label: 'Save linked feed', busy: _busy, onPressed: _busy ? null : _save),
                  const SizedBox(height: 12),
                  _RemoveButton(label: 'Unlink feed', onTap: _unlink),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _field(TextEditingController c, String label, String hint) => TextField(
        controller: c,
        decoration: InputDecoration(labelText: label, hintText: hint),
      );
}

/// The override pipeline (schedule only; first match wins): incoming event →
/// rules in order → the unmatched terminal (pending decision). Rules edit via
/// the 6m bottom sheet.
class _OverridePipeline extends ConsumerWidget {
  const _OverridePipeline({required this.feed, required this.link});
  final FeedItem feed;
  final FeedLink link;

  ({String feedId, String linkId}) get _key => (feedId: feed.id, linkId: link.id);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rules = ref.watch(linkRulesProvider(_key)).valueOrNull ?? const <OverrideRule>[];

    Future<void> reorder(int oldIndex, int newIndex) async {
      final ids = rules.map((r) => r.id).toList();
      final moved = ids.removeAt(oldIndex);
      ids.insert(newIndex, moved);
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).reorderLinkRules(familyId, feed.id, link.id, ids);
      ref.invalidate(linkRulesProvider(_key));
      ref.invalidate(calendarEventsProvider);
      ref.invalidate(pendingDecisionsProvider);
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionEyebrow('Override pipeline', color: AppColors.purple),
        const SizedBox(height: 8),
        Text('How feed exceptions change the baseline. Drag to reorder · first match wins.',
            style: AppText.subtitle),
        const SizedBox(height: 12),
        AppCard(
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
                    onTap: () => showOverrideRuleSheet(context, ref, feed: feed, link: link, existing: rules[i]),
                  ),
                ),
            ],
          ),
        Center(
          child: TextButton.icon(
            onPressed: () => showOverrideRuleSheet(context, ref, feed: feed, link: link),
            icon: const Icon(Icons.add_rounded, size: 18, color: AppColors.purple),
            label: Text('Add rule', style: font(kBodyFont, 13, 700, color: AppColors.purple)),
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
                  'Everything else — unmatched: not on the baseline and no rule '
                  'matched → pending decision. The system won’t guess.',
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
        _ => AppColors.textMuted,
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
                  child: Icon(Icons.drag_indicator_rounded, color: AppColors.textMuted, size: 20),
                ),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Text(rule.matcher,
                    maxLines: 2, overflow: TextOverflow.ellipsis, style: AppText.sectionItemTitle),
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

/// Override-rule editor bottom sheet (6m): match + Then (cancel/modify/ignore).
/// [prefillMatchValue] seeds a new rule's match value (e.g. from an unmatched
/// event's title) — ignored when editing an [existing] rule.
Future<void> showOverrideRuleSheet(
  BuildContext context,
  WidgetRef ref, {
  required FeedItem feed,
  required FeedLink link,
  OverrideRule? existing,
  String? prefillMatchValue,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _OverrideRuleSheet(
      feed: feed,
      link: link,
      existing: existing,
      prefillMatchValue: prefillMatchValue,
    ),
  );
}

class _OverrideRuleSheet extends ConsumerStatefulWidget {
  const _OverrideRuleSheet({
    required this.feed,
    required this.link,
    this.existing,
    this.prefillMatchValue,
  });
  final FeedItem feed;
  final FeedLink link;
  final OverrideRule? existing;
  final String? prefillMatchValue;

  @override
  ConsumerState<_OverrideRuleSheet> createState() => _OverrideRuleSheetState();
}

class _OverrideRuleSheetState extends ConsumerState<_OverrideRuleSheet> {
  late String _matchOp; // contains | regex
  late String _outcome; // cancel_day | modify_day | ignore
  final _value = TextEditingController();
  final _newStart = TextEditingController();
  final _newEnd = TextEditingController();
  bool _busy = false;
  String? _error;

  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final ex = widget.existing;
    _matchOp = ex?.matchOp == 'regex' ? 'regex' : 'contains';
    _outcome = ex?.outcome ?? 'cancel_day';
    _value.text = ex?.matchValue ?? widget.prefillMatchValue ?? '';
    _newStart.text = (ex?.params?['dayStart'] as String?) ?? '';
    _newEnd.text = (ex?.params?['dayEnd'] as String?) ?? '';
  }

  @override
  void dispose() {
    for (final c in [_value, _newStart, _newEnd]) {
      c.dispose();
    }
    super.dispose();
  }

  Map<String, dynamic>? get _params {
    if (_outcome != 'modify_day') return null;
    return {
      if (_newStart.text.trim().isNotEmpty) 'dayStart': _newStart.text.trim(),
      if (_newEnd.text.trim().isNotEmpty) 'dayEnd': _newEnd.text.trim(),
    };
  }

  void _invalidate() {
    ref.invalidate(linkRulesProvider((feedId: widget.feed.id, linkId: widget.link.id)));
    ref.invalidate(calendarEventsProvider);
    ref.invalidate(pendingDecisionsProvider);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
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
          familyId, widget.feed.id, widget.link.id, widget.existing!.id,
          matchField: 'summary',
          matchOp: _matchOp,
          outcome: _outcome,
          matchValue: matchValue,
          params: _params,
        );
      } else {
        await api.createLinkRule(
          familyId, widget.feed.id, widget.link.id,
          matchField: 'summary',
          matchOp: _matchOp,
          outcome: _outcome,
          matchValue: matchValue,
          params: _params,
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
      await ref.read(apiClientProvider).deleteLinkRule(familyId, widget.feed.id, widget.link.id, widget.existing!.id);
      _invalidate();
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
          children: [
            Row(
              children: [
                Text(_editing ? 'Edit override rule' : 'New override rule', style: AppText.subPageTitle),
                const Spacer(),
                if (_editing)
                  IconButton(
                    onPressed: _busy ? null : _delete,
                    icon: const Icon(Icons.delete_outline_rounded, color: AppColors.coral),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            Text('${widget.feed.displayName} · exception feed', style: AppText.subtitle),
            const SizedBox(height: 16),
            Text('MATCH', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            _Segmented(
              options: const [('contains', 'Contains'), ('regex', 'Regex')],
              value: _matchOp,
              activeColor: AppColors.indigo,
              onChanged: (v) => setState(() => _matchOp = v),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _value,
              decoration: InputDecoration(
                labelText: 'Title ${_matchOp == 'regex' ? 'pattern' : 'value'}',
                hintText: _matchOp == 'regex' ? '/no school|closed/i' : 'No School',
              ),
            ),
            const SizedBox(height: 20),
            Text('THEN', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            _Segmented(
              options: const [('cancel_day', 'Cancel day'), ('modify_day', 'Modify day'), ('ignore', 'Ignore')],
              value: _outcome,
              activeColor: AppColors.purple,
              onChanged: (v) => setState(() => _outcome = v),
            ),
            if (_outcome == 'cancel_day') ...[
              const SizedBox(height: 12),
              Text('A matched day is dropped from the baseline entirely — nothing generates.',
                  style: AppText.subtitle),
            ] else if (_outcome == 'modify_day') ...[
              const SizedBox(height: 12),
              Text('Overrides the baseline’s hours for matched days.', style: AppText.subtitle),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _newStart,
                      decoration: const InputDecoration(labelText: 'New day starts', hintText: 'HH:MM'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: TextField(
                      controller: _newEnd,
                      decoration: const InputDecoration(labelText: 'New day ends', hintText: 'HH:MM'),
                    ),
                  ),
                ],
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
            ],
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              child: PillButton(label: 'Save rule', variant: PillVariant.indigo, onPressed: _busy ? null : _save),
            ),
          ],
        ),
      ),
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
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: v == value ? activeColor : Colors.transparent,
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
        child: Text(label,
            style: font(kBodyFont, 13, 600,
                color: selected ? const Color(0xFF2A1E05) : AppColors.textSecondary)),
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
                  child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF17162B)),
                )
              : Text(label, style: font(kBodyFont, 14.5, 700, color: const Color(0xFF17162B))),
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
