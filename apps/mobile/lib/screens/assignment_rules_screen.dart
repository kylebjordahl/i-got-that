import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

const _weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

String _initialFor(String name) =>
    name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase();

/// Family auto-assignment rules (issue #24): a first-match-wins pipeline that
/// claims matching generated tasks for a caretaker automatically, so families
/// don't have to claim every logistics task by hand. Day-of-week and
/// every-other-week patterns are set inline on each rule — no separate pattern
/// resource to manage.
class AssignmentRulesScreen extends ConsumerWidget {
  const AssignmentRulesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final setAsync = ref.watch(assignmentRulesProvider);
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final feeds = ref.watch(feedsProvider).valueOrNull ?? const <FeedItem>[];

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(22, 12, 22, 18),
              child: SubPageHeader(
                title: 'Assignment rules',
                subtitle: 'Auto-claim tasks for a caretaker',
              ),
            ),
            Expanded(
              child: setAsync.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => Center(
                  child: Text('$e',
                      style: font(kBodyFont, 13, 500, color: AppColors.coral)),
                ),
                data: (ruleSet) =>
                    _body(context, ref, ruleSet, members, feeds),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(
    BuildContext context,
    WidgetRef ref,
    AssignmentRuleSet ruleSet,
    List<Member> members,
    List<FeedItem> feeds,
  ) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 0, 22, 150),
      children: [
        Container(
          padding: const EdgeInsets.all(14),
          margin: const EdgeInsets.only(bottom: 18),
          decoration: BoxDecoration(
            color: AppColors.tint(AppColors.indigo, 0.07),
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: AppColors.indigo.withValues(alpha: 0.35)),
          ),
          child: Text(
            'When a task matches a rule it’s claimed for that caretaker '
            'automatically. Rules run top to bottom — the first match wins. '
            'Claiming or unassigning a task by hand always overrides a rule.',
            style: font(kBodyFont, 12, 500, color: AppColors.indigo),
          ),
        ),
        SectionEyebrow('Rules',
            color: AppColors.purple,
            trailing: Text('First match applies', style: AppText.secondary)),
        const SizedBox(height: 12),
        if (ruleSet.rules.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 26),
            child: Center(
              child: Text('No rules yet — tap “Add rule” to create one',
                  style: AppText.subtitle),
            ),
          ),
        for (final r in ruleSet.rules) ...[
          _RuleCard(
            rule: r,
            members: members,
            feeds: feeds,
            links: ruleSet.links,
            onTap: () => _openSheet(context, ref, ruleSet, existing: r),
          ),
          const SizedBox(height: 10),
        ],
        Center(
          child: TextButton.icon(
            onPressed: () => _openSheet(context, ref, ruleSet),
            icon: const Icon(Icons.add_rounded, size: 18, color: AppColors.purple),
            label: Text('Add rule',
                style: font(kBodyFont, 13, 700, color: AppColors.purple)),
          ),
        ),
      ],
    );
  }

  Future<void> _openSheet(
    BuildContext context,
    WidgetRef ref,
    AssignmentRuleSet ruleSet, {
    AssignmentRule? existing,
  }) async {
    final changed = await showAssignmentRuleSheet(
      context,
      ref,
      ruleSet: ruleSet,
      existing: existing,
    );
    if (changed == true) {
      ref.invalidate(assignmentRulesProvider);
      ref.invalidate(unownedTasksProvider);
      ref.invalidate(allTasksProvider);
      ref.invalidate(calendarEventsProvider);
    }
  }
}

/// Human-readable one-liner describing who a rule assigns and when.
String describeRule(
  AssignmentRule r,
  List<Member> members,
  List<FeedItem> feeds,
  List<AssignmentLink> links,
) {
  String memberName(String? id) =>
      members.where((m) => m.id == id).map((m) => m.relationName).firstOrNull ??
      'someone';

  final parts = <String>[];
  parts.add(switch (r.taskType) {
    'pickup' => 'Pickup',
    'dropoff' => 'Drop-off',
    'attendance' => 'Attendance',
    _ => 'All tasks',
  });

  if (r.linkId != null) {
    final link = links.where((l) => l.id == r.linkId).firstOrNull;
    final feed = feeds.where((f) => f.id == link?.feedId).firstOrNull;
    parts.add('from ${feed?.displayName ?? 'a feed'}');
  } else if (r.aboutMemberId != null) {
    parts.add('for ${memberName(r.aboutMemberId)}');
  } else {
    parts.add('for any child');
  }

  final days = r.weekdays;
  if (days.isEmpty) {
    parts.add('any day');
  } else if (days.length == 7) {
    parts.add('every day');
  } else {
    parts.add(days.map((d) => _weekdayLabels[d]).join(', '));
  }
  if (r.isBiweekly) parts.add('every other week');

  return parts.join(' · ');
}

class _RuleCard extends StatelessWidget {
  const _RuleCard({
    required this.rule,
    required this.members,
    required this.feeds,
    required this.links,
    required this.onTap,
  });

  final AssignmentRule rule;
  final List<Member> members;
  final List<FeedItem> feeds;
  final List<AssignmentLink> links;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final owner = members.where((m) => m.id == rule.ownerMemberId).firstOrNull;
    final color = owner != null ? personColor(owner) : AppColors.indigo;
    return AppCard(
      onTap: onTap,
      child: Row(
        children: [
          PersonAvatar(
            initial: _initialFor(owner?.relationName ?? '?'),
            color: color,
            size: 38,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(owner?.relationName ?? 'Unknown',
                    style: AppText.sectionItemTitle),
                const SizedBox(height: 3),
                Text(describeRule(rule, members, feeds, links),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: AppText.secondary),
              ],
            ),
          ),
          const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
        ],
      ),
    );
  }
}

/// The create / edit sheet for one assignment rule. Returns true when the
/// pipeline changed (created / updated / deleted).
Future<bool?> showAssignmentRuleSheet(
  BuildContext context,
  WidgetRef ref, {
  required AssignmentRuleSet ruleSet,
  AssignmentRule? existing,
}) {
  return showModalBottomSheet<bool>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _AssignmentRuleSheet(ruleSet: ruleSet, existing: existing),
  );
}

class _AssignmentRuleSheet extends ConsumerStatefulWidget {
  const _AssignmentRuleSheet({required this.ruleSet, this.existing});
  final AssignmentRuleSet ruleSet;
  final AssignmentRule? existing;

  @override
  ConsumerState<_AssignmentRuleSheet> createState() =>
      _AssignmentRuleSheetState();
}

class _AssignmentRuleSheetState extends ConsumerState<_AssignmentRuleSheet> {
  String? _ownerId;
  String? _aboutMemberId; // null = any child
  String? _linkId; // null = any feed
  String? _taskType; // null = any type
  final Set<int> _weekdays = {};
  bool _biweekly = false;
  DateTime _anchor = _mondayOf(DateTime.now());
  bool _saving = false;
  String? _error;

  static DateTime _mondayOf(DateTime d) {
    final day = DateTime(d.year, d.month, d.day);
    return day.subtract(Duration(days: day.weekday - 1)); // weekday: Mon=1
  }

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    if (e != null) {
      _ownerId = e.ownerMemberId;
      _aboutMemberId = e.aboutMemberId;
      _linkId = e.linkId;
      _taskType = e.taskType;
      _weekdays.addAll(e.weekdays);
      _biweekly = e.isBiweekly;
      if (e.anchorDate != null) _anchor = _mondayOf(e.anchorDate!.toLocal());
    }
  }

  int get _weekdayMask => _weekdays.fold(0, (m, b) => m | (1 << b));

  @override
  Widget build(BuildContext context) {
    final caretakers =
        ref.watch(caretakersProvider).valueOrNull ?? const <Member>[];
    final children =
        ref.watch(dependentsProvider).valueOrNull ?? const <Member>[];
    final feeds = ref.watch(feedsProvider).valueOrNull ?? const <FeedItem>[];
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];

    return Padding(
      padding: EdgeInsets.fromLTRB(
          22, 4, 22, 28 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(widget.existing == null ? 'New rule' : 'Edit rule',
                style: AppText.subPageTitle),
            const SizedBox(height: 18),

            // Owner (required).
            Text('CARETAKER', style: AppText.eyebrow()),
            const SizedBox(height: 10),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (final m in caretakers)
                  _OwnerChip(
                    member: m,
                    selected: _ownerId == m.id,
                    onTap: () => setState(() => _ownerId = m.id),
                  ),
              ],
            ),
            const SizedBox(height: 20),

            // Applies to — child (or any).
            Text('APPLIES TO', style: AppText.eyebrow()),
            const SizedBox(height: 10),
            _ChoiceRow(
              options: [
                (null, 'Any child'),
                for (final c in children) (c.id, c.relationName),
              ],
              value: _aboutMemberId,
              onChanged: (v) => setState(() => _aboutMemberId = v),
            ),
            const SizedBox(height: 20),

            // Feed (optional) — the per-feed layer.
            Text('SOURCE FEED', style: AppText.eyebrow()),
            const SizedBox(height: 10),
            _ChoiceRow(
              options: [
                (null, 'Any feed'),
                for (final l in widget.ruleSet.links)
                  (
                    l.id,
                    _feedLabel(l, feeds, members),
                  ),
              ],
              value: _linkId,
              onChanged: (v) => setState(() => _linkId = v),
            ),
            const SizedBox(height: 20),

            // Task type (optional).
            Text('TASK TYPE', style: AppText.eyebrow()),
            const SizedBox(height: 10),
            _ChoiceRow(
              options: const [
                (null, 'Any'),
                ('dropoff', 'Drop-off'),
                ('pickup', 'Pickup'),
                ('attendance', 'Attendance'),
              ],
              value: _taskType,
              onChanged: (v) => setState(() => _taskType = v),
            ),
            const SizedBox(height: 20),

            // Days of the week + presets.
            Row(
              children: [
                Text('DAYS', style: AppText.eyebrow()),
                const Spacer(),
                _preset('Every day', () => _setDays({0, 1, 2, 3, 4, 5, 6})),
                const SizedBox(width: 8),
                _preset('Weekdays', () => _setDays({0, 1, 2, 3, 4})),
              ],
            ),
            const SizedBox(height: 10),
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
            const SizedBox(height: 4),
            Text('No days selected means any day.',
                style: font(kBodyFont, 11, 500, color: AppColors.textMuted)),
            const SizedBox(height: 20),

            // Cadence.
            Text('HOW OFTEN', style: AppText.eyebrow()),
            const SizedBox(height: 10),
            _Segmented(
              options: const [(false, 'Every week'), (true, 'Every other week')],
              value: _biweekly,
              onChanged: (v) => setState(() => _biweekly = v),
            ),
            if (_biweekly) ...[
              const SizedBox(height: 12),
              InkWell(
                onTap: _pickAnchor,
                borderRadius: BorderRadius.circular(12),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  decoration: BoxDecoration(
                    color: AppColors.bg,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.event_rounded,
                          size: 18, color: AppColors.textSecondary),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text('Starting the week of ${_fmtDate(_anchor)}',
                            style: font(kBodyFont, 13, 600,
                                color: AppColors.textSecondary)),
                      ),
                      const Icon(Icons.chevron_right_rounded,
                          color: AppColors.textMuted),
                    ],
                  ),
                ),
              ),
            ],

            if (_error != null) ...[
              const SizedBox(height: 14),
              Text(_error!,
                  style: font(kBodyFont, 12, 600, color: AppColors.coral)),
            ],
            const SizedBox(height: 22),
            Row(
              children: [
                if (widget.existing != null) ...[
                  IconButton(
                    onPressed: _saving ? null : _delete,
                    icon: const Icon(Icons.delete_outline_rounded,
                        color: AppColors.coral),
                  ),
                  const SizedBox(width: 6),
                ],
                Expanded(
                  child: PillButton(
                    label: _saving ? 'Saving…' : 'Save rule',
                    variant: PillVariant.indigo,
                    onPressed: _saving ? () {} : _save,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _setDays(Set<int> days) => setState(() {
        _weekdays
          ..clear()
          ..addAll(days);
      });

  Widget _preset(String label, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Text(label,
            style: font(kBodyFont, 12, 700, color: AppColors.indigo)),
      );

  String _feedLabel(
      AssignmentLink l, List<FeedItem> feeds, List<Member> members) {
    final feed = feeds.where((f) => f.id == l.feedId).firstOrNull;
    final member =
        members.where((m) => m.id == l.familyMemberId).firstOrNull;
    final name = feed?.displayName ?? 'Feed';
    return member != null ? '$name · ${member.relationName}' : name;
  }

  Future<void> _pickAnchor() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _anchor,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 2),
    );
    if (picked != null) setState(() => _anchor = _mondayOf(picked));
  }

  String _fmtDate(DateTime d) => '${d.month}/${d.day}/${d.year}';

  Future<void> _save() async {
    if (_ownerId == null) {
      setState(() => _error = 'Pick a caretaker to assign to.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final familyId = await ref.read(familyProvider.future);
      final anchorMs = _biweekly ? _anchor.millisecondsSinceEpoch : null;
      if (widget.existing == null) {
        await api.createAssignmentRule(
          familyId,
          ownerMemberId: _ownerId!,
          aboutMemberId: _aboutMemberId,
          linkId: _linkId,
          taskType: _taskType,
          weekdayMask: _weekdayMask,
          cadenceWeeks: _biweekly ? 2 : 1,
          anchorDate: anchorMs,
        );
      } else {
        await api.updateAssignmentRule(
          familyId,
          widget.existing!.id,
          ownerMemberId: _ownerId,
          aboutMemberId: _aboutMemberId,
          linkId: _linkId,
          taskType: _taskType,
          weekdayMask: _weekdayMask,
          cadenceWeeks: _biweekly ? 2 : 1,
          anchorDate: anchorMs,
        );
      }
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (e) {
      setState(() {
        _saving = false;
        _error = 'Failed: ${e.response?.statusCode ?? e.message}';
      });
    } catch (e) {
      setState(() {
        _saving = false;
        _error = 'Failed: $e';
      });
    }
  }

  Future<void> _delete() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final familyId = await ref.read(familyProvider.future);
      await api.deleteAssignmentRule(familyId, widget.existing!.id);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() {
        _saving = false;
        _error = 'Failed: $e';
      });
    }
  }
}

class _OwnerChip extends StatelessWidget {
  const _OwnerChip(
      {required this.member, required this.selected, required this.onTap});
  final Member member;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = personColor(member);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(6, 6, 14, 6),
        decoration: BoxDecoration(
          color: selected ? AppColors.tint(color, 0.14) : AppColors.card,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: selected ? color : AppColors.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            PersonAvatar(
                initial: _initialFor(member.relationName),
                color: color,
                size: 30),
            const SizedBox(width: 8),
            Text(member.relationName,
                style: font(kBodyFont, 13, 600,
                    color: selected ? AppColors.textPrimary : AppColors.textSecondary)),
          ],
        ),
      ),
    );
  }
}

/// A wrapping single-select row of pill options; `T?` value, first option's
/// value may be null ("Any").
class _ChoiceRow<T> extends StatelessWidget {
  const _ChoiceRow(
      {required this.options, required this.value, required this.onChanged});
  final List<(T?, String)> options;
  final T? value;
  final ValueChanged<T?> onChanged;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final (v, label) in options)
          GestureDetector(
            onTap: () => onChanged(v),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
              decoration: BoxDecoration(
                color: v == value ? AppColors.indigo : AppColors.card,
                borderRadius: BorderRadius.circular(999),
                border: Border.all(
                    color: v == value ? AppColors.indigo : AppColors.border),
              ),
              child: Text(label,
                  style: font(kBodyFont, 13, 600,
                      color: v == value
                          ? const Color(0xFF17162B)
                          : AppColors.textSecondary)),
            ),
          ),
      ],
    );
  }
}

class _Segmented<T> extends StatelessWidget {
  const _Segmented(
      {required this.options, required this.value, required this.onChanged});
  final List<(T, String)> options;
  final T value;
  final ValueChanged<T> onChanged;

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
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: v == value ? AppColors.indigo : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: font(kBodyFont, 12, 700,
                          color: v == value
                              ? const Color(0xFF17162B)
                              : AppColors.textSecondary)),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _DayChip extends StatelessWidget {
  const _DayChip(
      {required this.label, required this.selected, required this.onTap});
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
