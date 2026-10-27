import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../util/format.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import '../widgets/time_fields.dart';
import 'task_rule_matches_screen.dart';

/// Task rules (6k) — pick an active calendar (a source feed, or the member's
/// own Unified calendar) and see its resolution order as one pipeline:
/// calendar-specific + inherited "all calendars" rules, first match wins,
/// ending in that calendar's default. Task typing only; the schedule lives on
/// the feed editor.
class TaskRulesScreen extends ConsumerStatefulWidget {
  const TaskRulesScreen({super.key, required this.member});
  final Member member;

  @override
  ConsumerState<TaskRulesScreen> createState() => _TaskRulesScreenState();
}

class _TaskRulesScreenState extends ConsumerState<TaskRulesScreen> {
  /// The active calendar: a feed link id, or null for the Unified calendar.
  String? _activeLinkId;
  bool _initialised = false;

  /// (label, linkId?) chips for the member's linked feeds + the Unified calendar.
  List<(String, String?)> _calendars() {
    final feeds = ref.read(feedsProvider).valueOrNull ?? const <FeedItem>[];
    final chips = <(String, String?)>[];
    for (final f in feeds) {
      final links =
          ref.read(feedLinksProvider(f.id)).valueOrNull ?? const <FeedLink>[];
      final link = links
          .where((l) => l.familyMemberId == widget.member.id)
          .firstOrNull;
      if (link != null) chips.add((f.displayName, link.id));
    }
    chips.add(('Unified', null));
    return chips;
  }

  void _refresh() {
    ref.invalidate(taskRulesProvider(widget.member.id));
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
  }

  @override
  Widget build(BuildContext context) {
    final setAsync = ref.watch(taskRulesProvider(widget.member.id));
    final calendars = _calendars();
    if (!_initialised && calendars.isNotEmpty) {
      _activeLinkId = calendars.first.$2;
      _initialised = true;
    }

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 12, 22, 18),
              child: SubPageHeader(
                title: 'Task rules',
                subtitle: widget.member.relationName,
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 150),
                children: [
                  Text('ACTIVE CALENDAR', style: AppText.eyebrow()),
                  const SizedBox(height: 10),
                  SizedBox(
                    height: 38,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      children: [
                        for (final (label, linkId) in calendars)
                          Padding(
                            padding: const EdgeInsets.only(right: 8),
                            child: _CalChip(
                              label: label,
                              selected: _activeLinkId == linkId,
                              onTap: () =>
                                  setState(() => _activeLinkId = linkId),
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  setAsync.when(
                    loading: () => const Padding(
                      padding: EdgeInsets.symmetric(vertical: 40),
                      child: Center(child: CircularProgressIndicator()),
                    ),
                    error: (e, _) => Text(
                      '$e',
                      style: font(kBodyFont, 13, 500, color: AppColors.coral),
                    ),
                    data: (ruleSet) => _pipeline(ruleSet),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _pipeline(TaskRuleSet ruleSet) {
    final rules = ruleSet.forCalendar(_activeLinkId);
    final dfault = ruleSet.defaultFor(_activeLinkId);
    final unified = _activeLinkId == null;
    final activeLabel = _calendars()
        .firstWhere(
          (c) => c.$2 == _activeLinkId,
          orElse: () => ('Unified', null),
        )
        .$1;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (unified)
          Container(
            padding: const EdgeInsets.all(14),
            margin: const EdgeInsets.only(bottom: 14),
            decoration: BoxDecoration(
              color: AppColors.tint(AppColors.green, 0.07),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: AppColors.green.withValues(alpha: 0.35),
              ),
            ),
            child: Text(
              'Only applies to events added directly to the unified calendar. '
              'Events synthesized from a feed use that source calendar’s own pipeline.',
              style: font(kBodyFont, 12, 500, color: AppColors.green),
            ),
          ),
        SectionEyebrow(
          '$activeLabel’s pipeline',
          color: AppColors.purple,
          trailing: Text('First match applies', style: AppText.secondary),
        ),
        const SizedBox(height: 12),
        AppCard(
          padding: EdgeInsets.zero,
          child: SettingRow(
            icon: Icons.input_rounded,
            iconColor: AppColors.feedBlue,
            title: 'Incoming event · $activeLabel',
          ),
        ),
        const SizedBox(height: 10),
        for (final r in rules) ...[
          _RuleCard(
            rule: r,
            // Inherited (all-calendars) rules aren't editable from another
            // calendar's view — they belong to the pipeline as a whole.
            onTap: () => _openSheet(existing: r),
            onShowMatches: () => _openMatches(r, ruleSet),
          ),
          const SizedBox(height: 10),
        ],
        Center(
          child: TextButton.icon(
            onPressed: () => _openSheet(),
            icon: const Icon(
              Icons.add_rounded,
              size: 18,
              color: AppColors.purple,
            ),
            label: Text(
              'Add rule',
              style: font(kBodyFont, 13, 700, color: AppColors.purple),
            ),
          ),
        ),
        const SizedBox(height: 6),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.tint(AppColors.amber, 0.07),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppColors.amber.withValues(alpha: 0.35)),
          ),
          child: Column(
            key: ValueKey(_activeLinkId),
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'No matches → default',
                style: AppText.eyebrow(AppColors.amber),
              ),
              const SizedBox(height: 10),
              _ResultSegmented(
                value: dfault.resultType,
                onChanged: (v) => _saveDefault(v),
              ),
              if (dfault.resultType == 'transition') ...[
                const SizedBox(height: 12),
                _DefaultWindowFields(
                  dropoffWindowMin: dfault.dropoffWindowMin,
                  pickupWindowMin: dfault.pickupWindowMin,
                  onSave: (dropoff, pickup) => _saveDefault(
                    dfault.resultType,
                    dropoffWindowMin: dropoff,
                    pickupWindowMin: pickup,
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _openSheet({TaskRule? existing}) async {
    final changed = await showTaskRuleSheet(
      context,
      member: widget.member,
      activeLinkId: _activeLinkId,
      existing: existing,
    );
    if (changed == true) _refresh();
  }

  Future<void> _openMatches(TaskRule rule, TaskRuleSet ruleSet) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => TaskRuleMatchesScreen(
          member: widget.member,
          rule: rule,
          ruleSet: ruleSet,
          calendarLabels: {for (final (label, id) in _calendars()) id: label},
        ),
      ),
    );
    // Omissions re-type events, which can change what the list shows here.
    _refresh();
  }

  Future<void> _saveDefault(
    String resultType, {
    int? dropoffWindowMin,
    int? pickupWindowMin,
  }) async {
    final familyId = await ref.read(familyProvider.future);
    await ref
        .read(apiClientProvider)
        .setTaskDefault(
          familyId,
          widget.member.id,
          linkId: _activeLinkId,
          defaultResultType: resultType,
          dropoffWindowMin: dropoffWindowMin,
          pickupWindowMin: pickupWindowMin,
        );
    _refresh();
  }
}

class _CalChip extends StatelessWidget {
  const _CalChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? AppColors.indigo : AppColors.card,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: selected ? AppColors.indigo : AppColors.border,
          ),
        ),
        child: Text(
          label,
          style: font(
            kBodyFont,
            13,
            600,
            color: selected ? const Color(0xFF17162B) : AppColors.textSecondary,
          ),
        ),
      ),
    );
  }
}

class _RuleCard extends StatelessWidget {
  const _RuleCard({
    required this.rule,
    required this.onTap,
    required this.onShowMatches,
  });
  final TaskRule rule;
  final VoidCallback onTap;

  /// Opens the rule's match list (what it catches, ±30 days).
  final VoidCallback onShowMatches;

  @override
  Widget build(BuildContext context) {
    final resultColor = rule.isTransition
        ? AppColors.green
        : (rule.isNone ? AppColors.coral : AppColors.purple);
    return AppCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              TintBadge(
                rule.scopeLabel,
                color: rule.scope == 'all_calendars'
                    ? AppColors.blue
                    : AppColors.feedBlue,
              ),
              const Spacer(),
              TintBadge('→ ${rule.resultLabel}', color: resultColor),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            rule.matcher,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: AppText.sectionItemTitle,
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: onShowMatches,
              style: TextButton.styleFrom(
                padding: EdgeInsets.zero,
                visualDensity: VisualDensity.compact,
              ),
              icon: const Icon(
                Icons.manage_search_rounded,
                size: 18,
                color: AppColors.purple,
              ),
              label: Text(
                'See what it catches',
                style: font(kBodyFont, 12.5, 700, color: AppColors.purple),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ResultSegmented extends StatelessWidget {
  const _ResultSegmented({
    required this.value,
    required this.onChanged,
    this.allowNone = false,
  });
  final String value;
  final ValueChanged<String> onChanged;

  /// Offer "No tasks" — rules only; a calendar's default always makes tasks.
  final bool allowNone;

  @override
  Widget build(BuildContext context) {
    Widget seg(String v, String label) {
      final selected = v == value;
      return Expanded(
        child: GestureDetector(
          onTap: () => onChanged(v),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 10),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: selected ? AppColors.green : Colors.transparent,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: font(
                kBodyFont,
                12,
                700,
                color: selected
                    ? const Color(0xFF14231A)
                    : AppColors.textSecondary,
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppColors.bg,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          seg('transition', 'Drop-off & pickup'),
          seg('attendance', 'Attendance'),
          if (allowNone) seg('none', 'No tasks'),
        ],
      ),
    );
  }
}

/// Window-size inputs for the calendar's terminal default, shown only when
/// that default resolves to a transition (drop-off & pickup) task.
class _DefaultWindowFields extends StatefulWidget {
  const _DefaultWindowFields({
    required this.dropoffWindowMin,
    required this.pickupWindowMin,
    required this.onSave,
  });

  final int dropoffWindowMin;
  final int pickupWindowMin;
  final void Function(int dropoffWindowMin, int pickupWindowMin) onSave;

  @override
  State<_DefaultWindowFields> createState() => _DefaultWindowFieldsState();
}

class _DefaultWindowFieldsState extends State<_DefaultWindowFields> {
  late int _dropoff = widget.dropoffWindowMin;
  late int _pickup = widget.pickupWindowMin;
  bool _dirty = false;

  void _commit() {
    widget.onSave(_dropoff, _pickup);
    setState(() => _dirty = false);
  }

  Widget _windowField(String label, int minutes, ValueChanged<int> onChanged) =>
      DurationPickerField(
        label: label,
        minutes: minutes,
        onChanged: (m) => setState(() {
          onChanged(m);
          _dirty = true;
        }),
      );

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('The time window allowed for each task.', style: AppText.subtitle),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: _windowField('Drop-off', _dropoff, (m) => _dropoff = m),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _windowField('Pickup', _pickup, (m) => _pickup = m),
            ),
          ],
        ),
        if (_dirty) ...[
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerRight,
            child: PillButton(
              label: 'Save',
              variant: PillVariant.amber,
              compact: true,
              onPressed: _commit,
            ),
          ),
        ],
      ],
    );
  }
}

/// Task-rule edit sheet (6n). Returns true when something changed.
///
/// A new rule can be prefilled — [initialMatch] / [initialResult] — and placed
/// at [position] in the member's pipeline (appended when null); [intro] says
/// where the draft came from (e.g. an event just marked not needed).
Future<bool?> showTaskRuleSheet(
  BuildContext context, {
  required Member member,
  required String? activeLinkId,
  TaskRule? existing,
  String? initialMatch,
  String? initialResult,
  int? position,
  String? intro,
}) {
  return showModalBottomSheet<bool>(
    context: context,
    useSafeArea: true,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _TaskRuleSheet(
      member: member,
      activeLinkId: activeLinkId,
      existing: existing,
      initialMatch: initialMatch,
      initialResult: initialResult,
      position: position,
      intro: intro,
    ),
  );
}

class _TaskRuleSheet extends ConsumerStatefulWidget {
  const _TaskRuleSheet({
    required this.member,
    required this.activeLinkId,
    this.existing,
    this.initialMatch,
    this.initialResult,
    this.position,
    this.intro,
  });
  final Member member;
  final String? activeLinkId;
  final TaskRule? existing;
  final String? initialMatch;
  final String? initialResult;
  final int? position;
  final String? intro;

  @override
  ConsumerState<_TaskRuleSheet> createState() => _TaskRuleSheetState();
}

class _TaskRuleSheetState extends ConsumerState<_TaskRuleSheet> {
  late bool _allCalendars;
  late String _result;
  final _match = TextEditingController();
  int _dropoff = 15;
  int _pickup = 15;
  bool _busy = false;
  String? _error;

  /// The live "what would this catch" preview, re-run (debounced) as the match,
  /// scope or result changes. Null while there's no pattern to try.
  Future<List<TaskRuleMatch>>? _preview;
  Timer? _previewDebounce;
  String? _previewKey;

  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final ex = widget.existing;
    _allCalendars = ex?.scope == 'all_calendars';
    _result = ex?.resultType ?? widget.initialResult ?? 'transition';
    _match.text = ex?.matchValue ?? widget.initialMatch ?? '';
    _dropoff = ex?.dropoffWindowMin ?? 15;
    _pickup = ex?.pickupWindowMin ?? 15;
    _match.addListener(_schedulePreview);
    _preview = _startPreview();
  }

  @override
  void dispose() {
    _previewDebounce?.cancel();
    _match.dispose();
    super.dispose();
  }

  /// What the preview is asked with; a change is what re-runs it (the
  /// controller also notifies on cursor moves, which shouldn't).
  String get _previewQuery => '$_allCalendars|$_result|${_match.text.trim()}';

  void _schedulePreview() {
    if (_previewQuery == _previewKey) return;
    _previewDebounce?.cancel();
    _previewDebounce = Timer(const Duration(milliseconds: 400), () {
      // A block, not `=>`: setState rejects a callback that returns a Future.
      if (!mounted) return;
      setState(() {
        _preview = _startPreview();
      });
    });
  }

  /// Dry-runs the draft against the past and next 30 days — the saved rule's
  /// place and omissions when editing, else where the save would put it.
  Future<List<TaskRuleMatch>>? _startPreview() {
    _previewKey = _previewQuery;
    final pattern = _match.text.trim();
    if (pattern.isEmpty) return null;
    final ex = widget.existing;
    // Both read now: the sheet (and its ref) may be gone when they'd be used.
    final family = ref.read(familyProvider.future);
    final api = ref.read(apiClientProvider);
    return () async {
      final res = await api.previewTaskRule(
        await family,
        widget.member.id,
        ruleId: ex?.id,
        // An edit keeps its calendar (the save doesn't move it).
        linkId: _allCalendars
            ? null
            : (ex != null ? ex.linkId : widget.activeLinkId),
        scope: _allCalendars ? 'all_calendars' : 'this_calendar',
        resultType: _result,
        matchValue: pattern,
        matchField: ex?.matchField ?? 'summary',
        matchOp: ex?.matchOp ?? 'regex',
        position: ex == null ? widget.position : null,
      );
      return ((res['matches'] as List?) ?? const [])
          .map((m) => TaskRuleMatch.fromJson(m as Map<String, dynamic>))
          .toList();
    }();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      final scope = _allCalendars ? 'all_calendars' : 'this_calendar';
      final matchValue = _match.text.trim().isEmpty ? null : _match.text.trim();
      final drop = _result == 'transition' ? _dropoff : null;
      final pick = _result == 'transition' ? _pickup : null;
      if (_editing) {
        await api.updateTaskRule(
          familyId,
          widget.member.id,
          widget.existing!.id,
          scope: scope,
          resultType: _result,
          matchValue: matchValue,
          dropoffWindowMin: drop,
          pickupWindowMin: pick,
        );
      } else {
        await api.createTaskRule(
          familyId,
          widget.member.id,
          linkId: _allCalendars ? null : widget.activeLinkId,
          scope: scope,
          resultType: _result,
          matchValue: matchValue,
          position: widget.position,
          dropoffWindowMin: drop,
          pickupWindowMin: pick,
        );
      }
      if (mounted) Navigator.of(context).pop(true);
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
      await ref
          .read(apiClientProvider)
          .deleteTaskRule(familyId, widget.member.id, widget.existing!.id);
      if (mounted) Navigator.of(context).pop(true);
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
        padding: EdgeInsets.fromLTRB(
          22,
          4,
          22,
          28 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  _editing ? 'Edit task rule' : 'New task rule',
                  style: AppText.subPageTitle,
                ),
                const Spacer(),
                if (_editing)
                  IconButton(
                    onPressed: _busy ? null : _delete,
                    icon: const Icon(
                      Icons.delete_outline_rounded,
                      color: AppColors.coral,
                    ),
                  ),
              ],
            ),
            if (widget.intro != null) ...[
              const SizedBox(height: 4),
              Text(widget.intro!, style: AppText.subtitle),
            ],
            const SizedBox(height: 12),
            Text('APPLIES TO', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            Row(
              children: [
                _PillToggle(
                  label: 'This calendar',
                  selected: !_allCalendars,
                  onTap: () {
                    setState(() => _allCalendars = false);
                    _schedulePreview();
                  },
                ),
                const SizedBox(width: 8),
                _PillToggle(
                  label: 'All calendars',
                  selected: _allCalendars,
                  onTap: () {
                    setState(() => _allCalendars = true);
                    _schedulePreview();
                  },
                ),
              ],
            ),
            const SizedBox(height: 18),
            Text('MATCH', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            TextField(
              controller: _match,
              decoration: const InputDecoration(
                labelText: 'Title matches (regex)',
                hintText: '/field trip/i',
              ),
            ),
            if (_preview != null) ...[
              const SizedBox(height: 10),
              _RulePreview(
                preview: _preview!,
                draftId: widget.existing?.id ?? 'draft',
              ),
            ],
            const SizedBox(height: 18),
            Text('THEN', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            _ResultSegmented(
              value: _result,
              allowNone: true,
              onChanged: (v) {
                setState(() => _result = v);
                _schedulePreview();
              },
            ),
            if (_result == 'transition') ...[
              const SizedBox(height: 14),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppColors.tint(AppColors.green, 0.07),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(
                    color: AppColors.green.withValues(alpha: 0.3),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Task window',
                      style: AppText.eyebrow(AppColors.green),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'The time window allowed for each task.',
                      style: AppText.subtitle,
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: DurationPickerField(
                            label: 'Drop-off',
                            minutes: _dropoff,
                            onChanged: (m) => setState(() => _dropoff = m),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: DurationPickerField(
                            label: 'Pickup',
                            minutes: _pickup,
                            onChanged: (m) => setState(() => _pickup = m),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ] else ...[
              const SizedBox(height: 10),
              Text(
                _result == 'none'
                    ? 'Matching events stay on the calendar, but nobody is asked to cover them.'
                    : 'Attendance tasks span the matched event itself — no window to configure.',
                style: AppText.subtitle,
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                style: font(kBodyFont, 13, 500, color: AppColors.coral),
              ),
            ],
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              child: PillButton(
                label: 'Save rule',
                variant: PillVariant.indigo,
                onPressed: _busy ? null : _save,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The editor's live preview: how many events in the past and next 30 days
/// the draft catches, how many it would actually decide, and the first few.
class _RulePreview extends StatelessWidget {
  const _RulePreview({required this.preview, required this.draftId});

  final Future<List<TaskRuleMatch>> preview;

  /// The id the preview reports for the draft ('draft', or the edited rule's).
  final String draftId;

  static const _shown = 4;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.tint(AppColors.purple, 0.07),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.purple.withValues(alpha: 0.3)),
      ),
      child: FutureBuilder<List<TaskRuleMatch>>(
        future: preview,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return Text(
              'Checking the past and next 30 days…',
              style: AppText.subtitle,
            );
          }
          if (snap.hasError) {
            final e = snap.error;
            return Text(
              e is DioException && e.response?.statusCode == 400
                  ? 'That pattern isn’t valid yet.'
                  : 'Couldn’t preview: $e',
              style: font(kBodyFont, 12.5, 500, color: AppColors.coral),
            );
          }
          final matches = snap.data ?? const <TaskRuleMatch>[];
          if (matches.isEmpty) {
            return Text(
              'Catches nothing in the past or next 30 days.',
              style: AppText.subtitle,
            );
          }
          final decides = matches
              .where((m) => m.decidedByRuleId == draftId)
              .length;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Catches ${matches.length} '
                '${matches.length == 1 ? 'event' : 'events'} in the past and '
                'next 30 days; $decides would follow this rule.',
                style: font(kBodyFont, 12.5, 700, color: AppColors.purple),
              ),
              const SizedBox(height: 6),
              for (final m in matches.take(_shown))
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    '${dayHeading(dayKey(m.start), DateTime.now())} · '
                    '${m.displaySummary}'
                    '${m.omitted ? ' (omitted)' : (m.decidedByRuleId == draftId ? '' : ' (earlier rule wins)')}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.subtitle,
                  ),
                ),
              if (matches.length > _shown)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    '+ ${matches.length - _shown} more',
                    style: AppText.subtitle,
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _PillToggle extends StatelessWidget {
  const _PillToggle({
    required this.label,
    required this.selected,
    required this.onTap,
  });
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? AppColors.indigo : AppColors.card,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: selected ? AppColors.indigo : AppColors.border,
          ),
        ),
        child: Text(
          label,
          style: font(
            kBodyFont,
            12.5,
            700,
            color: selected ? const Color(0xFF17162B) : AppColors.textSecondary,
          ),
        ),
      ),
    );
  }
}
