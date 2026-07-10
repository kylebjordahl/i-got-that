import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

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
      final links = ref.read(feedLinksProvider(f.id)).valueOrNull ?? const <FeedLink>[];
      final link = links.where((l) => l.familyMemberId == widget.member.id).firstOrNull;
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
              child: SubPageHeader(title: 'Task rules', subtitle: widget.member.relationName),
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
                              onTap: () => setState(() => _activeLinkId = linkId),
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
                    error: (e, _) => Text('$e', style: font(kBodyFont, 13, 500, color: AppColors.coral)),
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
    final activeLabel =
        _calendars().firstWhere((c) => c.$2 == _activeLinkId, orElse: () => ('Unified', null)).$1;

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
              border: Border.all(color: AppColors.green.withValues(alpha: 0.35)),
            ),
            child: Text(
              'Only applies to events added directly to the unified calendar. '
              'Events synthesized from a feed use that source calendar’s own pipeline.',
              style: font(kBodyFont, 12, 500, color: AppColors.green),
            ),
          ),
        SectionEyebrow('$activeLabel’s pipeline',
            color: AppColors.purple,
            trailing: Text('First match applies', style: AppText.secondary)),
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
          ),
          const SizedBox(height: 10),
        ],
        Center(
          child: TextButton.icon(
            onPressed: () => _openSheet(),
            icon: const Icon(Icons.add_rounded, size: 18, color: AppColors.purple),
            label: Text('Add rule', style: font(kBodyFont, 13, 700, color: AppColors.purple)),
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
              Text('No matches → default', style: AppText.eyebrow(AppColors.amber)),
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
      ref,
      member: widget.member,
      activeLinkId: _activeLinkId,
      existing: existing,
    );
    if (changed == true) _refresh();
  }

  Future<void> _saveDefault(
    String resultType, {
    int? dropoffWindowMin,
    int? pickupWindowMin,
  }) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).setTaskDefault(
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
  const _CalChip({required this.label, required this.selected, required this.onTap});
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
          border: Border.all(color: selected ? AppColors.indigo : AppColors.border),
        ),
        child: Text(label,
            style: font(kBodyFont, 13, 600,
                color: selected ? const Color(0xFF17162B) : AppColors.textSecondary)),
      ),
    );
  }
}

class _RuleCard extends StatelessWidget {
  const _RuleCard({required this.rule, required this.onTap});
  final TaskRule rule;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final resultColor = rule.isTransition ? AppColors.green : AppColors.purple;
    return AppCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              TintBadge(rule.scopeLabel,
                  color: rule.scope == 'all_calendars' ? AppColors.blue : AppColors.feedBlue),
              const Spacer(),
              TintBadge('→ ${rule.resultLabel}', color: resultColor),
            ],
          ),
          const SizedBox(height: 8),
          Text(rule.matcher,
              maxLines: 2, overflow: TextOverflow.ellipsis, style: AppText.sectionItemTitle),
        ],
      ),
    );
  }
}

class _ResultSegmented extends StatelessWidget {
  const _ResultSegmented({required this.value, required this.onChanged});
  final String value;
  final ValueChanged<String> onChanged;

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
            child: Text(label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: font(kBodyFont, 12, 700,
                    color: selected ? const Color(0xFF14231A) : AppColors.textSecondary)),
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
      child: Row(children: [seg('transition', 'Drop-off & pickup'), seg('attendance', 'Attendance')]),
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
  late final _dropoff = TextEditingController(text: '${widget.dropoffWindowMin}');
  late final _pickup = TextEditingController(text: '${widget.pickupWindowMin}');
  bool _dirty = false;

  @override
  void dispose() {
    _dropoff.dispose();
    _pickup.dispose();
    super.dispose();
  }

  void _commit() {
    final dropoff = int.tryParse(_dropoff.text.trim());
    final pickup = int.tryParse(_pickup.text.trim());
    if (dropoff == null || pickup == null) return;
    widget.onSave(dropoff, pickup);
    setState(() => _dirty = false);
  }

  Widget _numField(TextEditingController c, String label) => TextField(
        controller: c,
        keyboardType: TextInputType.number,
        onChanged: (_) => setState(() => _dirty = true),
        onSubmitted: (_) => _commit(),
        decoration: InputDecoration(labelText: label),
      );

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('The time window allowed for each task (in minutes).', style: AppText.subtitle),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(child: _numField(_dropoff, 'Drop-off')),
            const SizedBox(width: 12),
            Expanded(child: _numField(_pickup, 'Pickup')),
          ],
        ),
        if (_dirty) ...[
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerRight,
            child: PillButton(
                label: 'Save', variant: PillVariant.amber, compact: true, onPressed: _commit),
          ),
        ],
      ],
    );
  }
}

/// Task-rule edit sheet (6n). Returns true when something changed.
Future<bool?> showTaskRuleSheet(
  BuildContext context,
  WidgetRef ref, {
  required Member member,
  required String? activeLinkId,
  TaskRule? existing,
}) {
  return showModalBottomSheet<bool>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _TaskRuleSheet(member: member, activeLinkId: activeLinkId, existing: existing),
  );
}

class _TaskRuleSheet extends ConsumerStatefulWidget {
  const _TaskRuleSheet({required this.member, required this.activeLinkId, this.existing});
  final Member member;
  final String? activeLinkId;
  final TaskRule? existing;

  @override
  ConsumerState<_TaskRuleSheet> createState() => _TaskRuleSheetState();
}

class _TaskRuleSheetState extends ConsumerState<_TaskRuleSheet> {
  late bool _allCalendars;
  late String _result;
  final _match = TextEditingController();
  final _dropoff = TextEditingController(text: '15');
  final _pickup = TextEditingController(text: '15');
  bool _busy = false;
  String? _error;

  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final ex = widget.existing;
    _allCalendars = ex?.scope == 'all_calendars';
    _result = ex?.resultType ?? 'transition';
    _match.text = ex?.matchValue ?? '';
    _dropoff.text = '${ex?.dropoffWindowMin ?? 15}';
    _pickup.text = '${ex?.pickupWindowMin ?? 15}';
  }

  @override
  void dispose() {
    for (final c in [_match, _dropoff, _pickup]) {
      c.dispose();
    }
    super.dispose();
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
      final drop = _result == 'transition' ? int.tryParse(_dropoff.text.trim()) : null;
      final pick = _result == 'transition' ? int.tryParse(_pickup.text.trim()) : null;
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
      await ref.read(apiClientProvider).deleteTaskRule(familyId, widget.member.id, widget.existing!.id);
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
        padding: EdgeInsets.fromLTRB(22, 4, 22, 28 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(_editing ? 'Edit task rule' : 'New task rule', style: AppText.subPageTitle),
                const Spacer(),
                if (_editing)
                  IconButton(
                    onPressed: _busy ? null : _delete,
                    icon: const Icon(Icons.delete_outline_rounded, color: AppColors.coral),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            Text('APPLIES TO', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            Row(
              children: [
                _PillToggle(
                  label: 'This calendar',
                  selected: !_allCalendars,
                  onTap: () => setState(() => _allCalendars = false),
                ),
                const SizedBox(width: 8),
                _PillToggle(
                  label: 'All calendars',
                  selected: _allCalendars,
                  onTap: () => setState(() => _allCalendars = true),
                ),
              ],
            ),
            const SizedBox(height: 18),
            Text('MATCH', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            TextField(
              controller: _match,
              decoration: const InputDecoration(
                  labelText: 'Title matches (regex)', hintText: '/field trip/i'),
            ),
            const SizedBox(height: 18),
            Text('THEN', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            _ResultSegmented(value: _result, onChanged: (v) => setState(() => _result = v)),
            if (_result == 'transition') ...[
              const SizedBox(height: 14),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppColors.tint(AppColors.green, 0.07),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(color: AppColors.green.withValues(alpha: 0.3)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Task window', style: AppText.eyebrow(AppColors.green)),
                    const SizedBox(height: 6),
                    Text('The time window allowed for each task (in minutes).',
                        style: AppText.subtitle),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(child: _numField(_dropoff, 'Drop-off')),
                        const SizedBox(width: 12),
                        Expanded(child: _numField(_pickup, 'Pickup')),
                      ],
                    ),
                  ],
                ),
              ),
            ] else ...[
              const SizedBox(height: 10),
              Text('Attendance tasks span the matched event itself — no window to configure.',
                  style: AppText.subtitle),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
            ],
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              child: PillButton(
                  label: 'Save rule', variant: PillVariant.indigo, onPressed: _busy ? null : _save),
            ),
          ],
        ),
      ),
    );
  }

  Widget _numField(TextEditingController c, String label) => TextField(
        controller: c,
        keyboardType: TextInputType.number,
        decoration: InputDecoration(labelText: label),
      );
}

class _PillToggle extends StatelessWidget {
  const _PillToggle({required this.label, required this.selected, required this.onTap});
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
          border: Border.all(color: selected ? AppColors.indigo : AppColors.border),
        ),
        child: Text(label,
            style: font(kBodyFont, 12.5, 700,
                color: selected ? const Color(0xFF17162B) : AppColors.textSecondary)),
      ),
    );
  }
}
