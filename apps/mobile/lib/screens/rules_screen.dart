import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';

/// Valid HH:MM (24h) matcher for the shift-to time field.
final _hhmm = RegExp(r'^([01]\d|2[0-3]):[0-5]\d$');

const _matchFields = ['summary', 'location', 'description'];
const _matchOps = ['contains', 'equals', 'regex'];
const _effects = ['create', 'cancel', 'shift', 'ignore'];
const _taskTypes = ['pickup', 'dropoff', 'attendance'];
const _attendanceOpts = ['specific', 'any', 'both'];

String _typeLabel(String t) => t == 'dropoff' ? 'Drop-off' : '${t[0].toUpperCase()}${t.substring(1)}';

/// One-line human summary, e.g. `When summary contains "no school" → cancel`.
String describeRule(ClassificationRule r) {
  final effect = switch (r.effect) {
    'create' => () {
        final types = r.producesTypes.map(_typeLabel).join('/');
        return 'create ${types.isEmpty ? 'task' : types}';
      }(),
    'shift' => 'shift to ${r.shiftToTime ?? '??:??'}',
    'cancel' => 'cancel',
    'ignore' => 'ignore',
    _ => r.effect,
  };
  return 'When ${r.matchField} ${r.matchOp} "${r.matchValue}" → $effect';
}

/// Secondary detail line (priority + effect-specific extras).
String ruleDetail(ClassificationRule r, {String? ownerName}) {
  final parts = <String>['priority ${r.priority}'];
  if (r.effect == 'create') {
    if (r.defaultAttendance != null) parts.add('attendance: ${r.defaultAttendance}');
    if (ownerName != null) parts.add('owner: $ownerName');
  }
  return parts.join(' · ');
}

/// Open the create/edit dialog and refresh providers on success. Shared by the
/// Rules tab and the per-feed embedded section in the Feeds tab.
Future<void> openRuleDialog(
  BuildContext context,
  WidgetRef ref, {
  ClassificationRule? existing,
  String? initialFeedId,
  bool lockFeedScope = false,
}) async {
  final changed = await showDialog<bool>(
    context: context,
    builder: (_) => RuleDialog(
      existing: existing,
      initialFeedId: initialFeedId,
      lockFeedScope: lockFeedScope,
    ),
  );
  if (changed == true) {
    ref.invalidate(classificationRulesProvider);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
  }
}

/// Confirm + delete a rule, then refresh providers.
Future<void> confirmDeleteRule(BuildContext context, WidgetRef ref, ClassificationRule rule) async {
  final confirm = await showDialog<bool>(
    context: context,
    builder: (_) => AlertDialog(
      title: const Text('Delete rule?'),
      content: Text('Remove this rule?\n\n${describeRule(rule)}'),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
      ],
    ),
  );
  if (confirm == true) {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).deleteClassificationRule(familyId, rule.id);
    ref.invalidate(classificationRulesProvider);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
  }
}

/// Central management surface for classification rules, grouped by scope:
/// a "Global rules" section, then one section per feed.
class RulesScreen extends ConsumerWidget {
  const RulesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rulesAsync = ref.watch(classificationRulesProvider);
    final feeds = ref.watch(feedsProvider).valueOrNull ?? const [];
    final caretakers = ref.watch(caretakersProvider).valueOrNull ?? const [];
    final isAdmin = ref.watch(currentMemberProvider).valueOrNull?.isAdmin ?? false;

    final ownerNames = {for (final c in caretakers) c.id: c.relationName};
    final feedLabels = {for (final f in feeds) f['id'] as String: f['url'] as String};

    return Scaffold(
      appBar: AppBar(title: const Text('Rules')),
      floatingActionButton: isAdmin
          ? FloatingActionButton.extended(
              heroTag: 'fab-rules',
              onPressed: () => openRuleDialog(context, ref),
              icon: const Icon(Icons.add),
              label: const Text('Add rule'),
            )
          : null,
      body: rulesAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (rules) {
          if (rules.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'No rules yet — add one to classify feed events into tasks, '
                  'cancellations, or shifts.',
                  textAlign: TextAlign.center,
                ),
              ),
            );
          }

          final sections = <Widget>[];
          final global = rules.where((r) => r.isGlobal).toList();
          if (global.isNotEmpty) {
            sections
              ..add(_header(context, 'Global rules'))
              ..addAll(global.map((r) => _tile(context, ref, r, isAdmin, ownerNames)));
          }
          for (final f in feeds) {
            final fid = f['id'] as String;
            final scoped = rules.where((r) => r.feedId == fid).toList();
            if (scoped.isEmpty) continue;
            sections
              ..add(_header(context, f['url'] as String))
              ..addAll(scoped.map((r) => _tile(context, ref, r, isAdmin, ownerNames)));
          }
          // Rules pointing at a feed that no longer exists (defensive).
          final orphans = rules
              .where((r) => !r.isGlobal && !feedLabels.containsKey(r.feedId))
              .toList();
          if (orphans.isNotEmpty) {
            sections
              ..add(_header(context, 'Unknown feed'))
              ..addAll(orphans.map((r) => _tile(context, ref, r, isAdmin, ownerNames)));
          }

          return ListView(children: sections);
        },
      ),
    );
  }

  Widget _header(BuildContext context, String label) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
        child: Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: Theme.of(context)
              .textTheme
              .titleSmall
              ?.copyWith(color: Theme.of(context).colorScheme.primary),
        ),
      );

  Widget _tile(
    BuildContext context,
    WidgetRef ref,
    ClassificationRule r,
    bool isAdmin,
    Map<String, String> ownerNames,
  ) {
    return ListTile(
      dense: true,
      leading: Icon(_effectIcon(r.effect)),
      title: Text(describeRule(r)),
      subtitle: Text(ruleDetail(r, ownerName: ownerNames[r.defaultOwnerMemberId])),
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
    );
  }
}

IconData _effectIcon(String effect) => switch (effect) {
      'create' => Icons.add_task,
      'cancel' => Icons.event_busy,
      'shift' => Icons.schedule,
      'ignore' => Icons.block,
      _ => Icons.rule,
    };

/// Effect-aware create/edit dialog. Public so the Feeds tab can reuse it for
/// per-feed scoped rules rather than duplicating the form.
class RuleDialog extends ConsumerStatefulWidget {
  const RuleDialog({super.key, this.existing, this.initialFeedId, this.lockFeedScope = false});

  final ClassificationRule? existing;

  /// Pre-select the feed scope on create (e.g. opened from a feed tile).
  final String? initialFeedId;

  /// Hide the feed-scope dropdown entirely (opened pre-scoped from a feed).
  final bool lockFeedScope;

  @override
  ConsumerState<RuleDialog> createState() => _RuleDialogState();
}

class _RuleDialogState extends ConsumerState<RuleDialog> {
  String? _feedId; // null = global / all feeds
  final _matchValue = TextEditingController();
  final _priority = TextEditingController(text: '100');
  final _shiftTo = TextEditingController();
  String _matchField = 'summary';
  String _matchOp = 'contains';
  String _effect = 'create';
  final Set<String> _types = {};
  String? _attendance;
  String? _ownerMemberId;
  bool _busy = false;
  String? _error;

  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final ex = widget.existing;
    if (ex != null) {
      _feedId = ex.feedId;
      _matchValue.text = ex.matchValue;
      _priority.text = '${ex.priority}';
      _shiftTo.text = ex.shiftToTime ?? '';
      _matchField = ex.matchField;
      _matchOp = ex.matchOp;
      _effect = ex.effect;
      _types.addAll(ex.producesTypes);
      _attendance = ex.defaultAttendance;
      _ownerMemberId = ex.defaultOwnerMemberId;
    } else {
      _feedId = widget.initialFeedId;
    }
  }

  @override
  void dispose() {
    _matchValue.dispose();
    _priority.dispose();
    _shiftTo.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final matchValue = _matchValue.text.trim();
    if (matchValue.isEmpty) {
      setState(() => _error = 'Enter a value to match');
      return;
    }
    if (_effect == 'create' && _types.isEmpty) {
      setState(() => _error = 'Pick at least one task type to create');
      return;
    }
    final shiftTo = _shiftTo.text.trim();
    if (_effect == 'shift' && !_hhmm.hasMatch(shiftTo)) {
      setState(() => _error = 'Enter a valid shift time as HH:MM (24h)');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      final priority = int.tryParse(_priority.text.trim()) ?? 100;

      // Effect-aware payload: only the relevant extras carry values; the rest
      // are cleared so a switched effect never leaves stale columns behind.
      final producesTypes = _effect == 'create' ? _types.toList() : null;
      final attendance = _effect == 'create' ? _attendance : null;
      final owner = _effect == 'create' ? _ownerMemberId : null;
      final shift = _effect == 'shift' ? shiftTo : null;

      if (_editing) {
        await api.updateClassificationRule(
          familyId,
          widget.existing!.id,
          feedId: _feedId, // explicit (null => global) — user chose the scope
          priority: priority,
          matchField: _matchField,
          matchOp: _matchOp,
          matchValue: matchValue,
          effect: _effect,
          producesTypes: producesTypes, // null clears via _unset-aware client
          defaultAttendance: attendance,
          shiftToTime: shift,
          defaultOwnerMemberId: owner,
        );
      } else {
        await api.createClassificationRule(
          familyId,
          feedId: _feedId,
          priority: priority,
          matchField: _matchField,
          matchOp: _matchOp,
          matchValue: matchValue,
          effect: _effect,
          producesTypes: producesTypes,
          defaultAttendance: attendance,
          shiftToTime: shift,
          defaultOwnerMemberId: owner,
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
    final feeds = ref.watch(feedsProvider).valueOrNull ?? const [];
    final caretakers = ref.watch(caretakersProvider).valueOrNull ?? const [];

    return AlertDialog(
      title: Text(_editing ? 'Edit rule' : 'New rule'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (!widget.lockFeedScope) ...[
              DropdownButtonFormField<String?>(
                initialValue: _feedId,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Scope'),
                items: [
                  const DropdownMenuItem(value: null, child: Text('All feeds (global)')),
                  for (final f in feeds)
                    DropdownMenuItem(
                      value: f['id'] as String,
                      child: Text(f['url'] as String, overflow: TextOverflow.ellipsis),
                    ),
                ],
                onChanged: (v) => setState(() => _feedId = v),
              ),
              const SizedBox(height: 12),
            ],

            // --- Match: field / op / value ---
            DropdownButtonFormField<String>(
              initialValue: _matchField,
              decoration: const InputDecoration(labelText: 'Match field'),
              items: [
                for (final f in _matchFields) DropdownMenuItem(value: f, child: Text(f)),
              ],
              onChanged: (v) => setState(() => _matchField = v ?? 'summary'),
            ),
            if (_matchField == 'description')
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text(
                  "Feed events don't currently carry descriptions.",
                  style: TextStyle(fontSize: 12),
                ),
              ),
            const SizedBox(height: 12),
            const Align(alignment: Alignment.centerLeft, child: Text('Operator')),
            const SizedBox(height: 4),
            SegmentedButton<String>(
              segments: [
                for (final o in _matchOps) ButtonSegment(value: o, label: Text(o)),
              ],
              selected: {_matchOp},
              onSelectionChanged: (s) => setState(() => _matchOp = s.first),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _matchValue,
              decoration: const InputDecoration(
                labelText: 'Match value',
                hintText: 'e.g. no school',
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _priority,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Priority',
                hintText: 'lower wins ties (default 100)',
              ),
            ),
            const SizedBox(height: 16),

            // --- Effect ---
            const Align(alignment: Alignment.centerLeft, child: Text('Effect')),
            const SizedBox(height: 4),
            SegmentedButton<String>(
              segments: [
                for (final e in _effects) ButtonSegment(value: e, label: Text(e)),
              ],
              selected: {_effect},
              showSelectedIcon: false,
              onSelectionChanged: (s) => setState(() => _effect = s.first),
            ),

            // --- Effect-conditional fields ---
            if (_effect == 'create') ...[
              const SizedBox(height: 16),
              const Text('Creates tasks'),
              const SizedBox(height: 4),
              Wrap(
                spacing: 6,
                children: [
                  for (final t in _taskTypes)
                    FilterChip(
                      label: Text(_typeLabel(t)),
                      selected: _types.contains(t),
                      onSelected: (s) => setState(() => s ? _types.add(t) : _types.remove(t)),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String?>(
                initialValue: _attendance,
                decoration: const InputDecoration(labelText: 'Default attendance'),
                items: [
                  const DropdownMenuItem(value: null, child: Text('— none —')),
                  for (final a in _attendanceOpts) DropdownMenuItem(value: a, child: Text(a)),
                ],
                onChanged: (v) => setState(() => _attendance = v),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String?>(
                initialValue: _ownerMemberId,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Default owner'),
                items: [
                  const DropdownMenuItem(value: null, child: Text('— unassigned —')),
                  for (final c in caretakers)
                    DropdownMenuItem(value: c.id, child: Text(c.relationName)),
                ],
                onChanged: (v) => setState(() => _ownerMemberId = v),
              ),
            ],
            if (_effect == 'shift') ...[
              const SizedBox(height: 16),
              TextField(
                controller: _shiftTo,
                decoration: const InputDecoration(
                  labelText: 'Shift pickup to (HH:MM)',
                  hintText: 'e.g. 14:30',
                ),
              ),
            ],
            if (_effect == 'cancel')
              const Padding(
                padding: EdgeInsets.only(top: 12),
                child: Text(
                  'Cancels the baseline for matching days (removes the day).',
                  style: TextStyle(fontSize: 12),
                ),
              ),
            if (_effect == 'ignore')
              const Padding(
                padding: EdgeInsets.only(top: 12),
                child: Text(
                  'Leaves the baseline intact — matching events are ignored.',
                  style: TextStyle(fontSize: 12),
                ),
              ),

            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Text(
                'Rule changes apply to feed events on the next refresh.',
                style: TextStyle(
                  fontSize: 12,
                  color: Theme.of(context).colorScheme.outline,
                ),
              ),
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
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : Text(_editing ? 'Save' : 'Create'),
        ),
      ],
    );
  }
}
