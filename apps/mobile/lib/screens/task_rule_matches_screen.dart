import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../util/format.dart';
import '../util/task_visuals.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

/// A task rule's match list: every event its matcher catches in the past and
/// next 30 days, and what each one generates. It's where a rule that catches
/// too much shows it — and where an admin can omit one event from the rule (a
/// one-off: the event falls through to the next rule or its calendar's
/// default) or put an omitted one back, rather than loosen or tighten the rule
/// around a single exception.
///
/// Events an earlier rule decides are listed too ("decided by an earlier
/// rule"): they're what to look at when narrowing a broad rule, and they'd
/// start counting the moment the rule above changes.
class TaskRuleMatchesScreen extends ConsumerWidget {
  const TaskRuleMatchesScreen({
    super.key,
    required this.member,
    required this.rule,
    required this.ruleSet,
    required this.calendarLabels,
  });

  final Member member;
  final TaskRule rule;

  /// The member's pipeline, to name the rule that decides a shadowed event.
  final TaskRuleSet ruleSet;

  /// Calendar names by link id; null is the member's Unified calendar.
  final Map<String?, String> calendarLabels;

  ({String memberId, String ruleId}) get _key =>
      (memberId: member.id, ruleId: rule.id);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(taskRuleMatchesProvider(_key));
    final isAdmin = ref.watch(currentMemberProvider).valueOrNull?.isAdmin;

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 12, 22, 18),
              child: SubPageHeader(
                title: 'What this rule catches',
                subtitle: '${rule.matcher} → ${rule.resultLabel}',
              ),
            ),
            Expanded(
              child: async.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => Padding(
                  padding: const EdgeInsets.all(22),
                  child: Text(
                    '$e',
                    style: font(kBodyFont, 13, 500, color: AppColors.coral),
                  ),
                ),
                data: (matches) =>
                    _list(context, ref, matches, isAdmin ?? false),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _list(
    BuildContext context,
    WidgetRef ref,
    List<TaskRuleMatch> matches,
    bool isAdmin,
  ) {
    final applies = matches.where((m) => m.applies).length;
    final now = DateTime.now();
    final past = matches.where((m) => m.start.isBefore(now)).toList();
    final upcoming = matches.where((m) => !m.start.isBefore(now)).toList();

    Widget section(String label, List<TaskRuleMatch> items) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SectionEyebrow(label),
        const SizedBox(height: 10),
        for (final m in items) ...[
          _MatchCard(
            match: m,
            calendarLabel: calendarLabels[m.linkId] ?? 'Unified',
            decidedBy: _decidedByLabel(m),
            members: ref.watch(membersProvider).valueOrNull ?? const [],
            onToggleOmit: isAdmin && !m.shadowed && !m.converted
                ? () => _toggleOmit(context, ref, m)
                : null,
          ),
          const SizedBox(height: 10),
        ],
        const SizedBox(height: 10),
      ],
    );

    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 0, 22, 150),
      children: [
        Text(
          matches.isEmpty
              ? 'Nothing in the past or next 30 days matches this rule.'
              : '${matches.length} ${matches.length == 1 ? 'event' : 'events'} '
                    'in the past and next 30 days match; this rule decides '
                    '$applies of them.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 18),
        if (upcoming.isNotEmpty) section('Next 30 days', upcoming),
        if (past.isNotEmpty) section('Past 30 days', past.reversed.toList()),
      ],
    );
  }

  /// "Decided by: <matcher>" for a shadowed/omitted event, or its default.
  String? _decidedByLabel(TaskRuleMatch m) {
    if (m.applies) return null;
    final id = m.decidedByRuleId;
    if (id == null) {
      return '${calendarLabels[m.linkId] ?? 'Unified'} default';
    }
    final other = ruleSet.rules.where((r) => r.id == id).firstOrNull;
    return other == null ? 'another rule' : '“${other.matcher}”';
  }

  Future<void> _toggleOmit(
    BuildContext context,
    WidgetRef ref,
    TaskRuleMatch m,
  ) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      if (m.omitted) {
        await api.restoreTaskRuleEvent(familyId, member.id, rule.id, m.eventId);
      } else {
        await api.omitTaskRuleEvent(familyId, member.id, rule.id, m.eventId);
      }
      ref
        ..invalidate(taskRuleMatchesProvider(_key))
        ..invalidate(unownedTasksProvider)
        ..invalidate(allTasksProvider)
        ..invalidate(calendarEventsProvider);
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            m.omitted
                ? '“${m.displaySummary}” follows this rule again'
                : '“${m.displaySummary}” omitted from this rule',
          ),
        ),
      );
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Failed: $e')));
    }
  }
}

class _MatchCard extends StatelessWidget {
  const _MatchCard({
    required this.match,
    required this.calendarLabel,
    required this.decidedBy,
    required this.members,
    required this.onToggleOmit,
  });

  final TaskRuleMatch match;
  final String calendarLabel;
  final String? decidedBy;
  final List<Member> members;
  final VoidCallback? onToggleOmit;

  @override
  Widget build(BuildContext context) {
    final m = match;
    final end = m.end;
    final when = m.allDay
        ? dayHeading(dayKey(m.start), DateTime.now())
        : '${dayHeading(dayKey(m.start), DateTime.now())} · '
              '${end != null && end.isAfter(m.start) ? friendlyRange(m.start, end) : friendlyTime(m.start)}';
    final (statusText, statusColor) = switch (m.status) {
      'applies' => ('→ ${taskResultLabel(m.resultType)}', AppColors.green),
      'omitted' => (
        'Omitted · uses $decidedBy → ${taskResultLabel(m.resultType)}',
        AppColors.amber,
      ),
      _ => (
        'Decided by $decidedBy → ${taskResultLabel(m.resultType)}',
        AppColors.textSecondary,
      ),
    };
    final names = {for (final x in members) x.id: x.relationName};
    final tasks = m.tasks ?? const <TaskItem>[];

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(when, style: AppText.secondary)),
              TintBadge(calendarLabel, color: AppColors.feedBlue),
            ],
          ),
          const SizedBox(height: 6),
          Text(m.displaySummary, style: AppText.sectionItemTitle),
          const SizedBox(height: 8),
          Text(
            statusText,
            style: font(kBodyFont, 12.5, 600, color: statusColor),
          ),
          if (m.converted) ...[
            const SizedBox(height: 4),
            Text(
              'Its tasks were converted by hand, so rules don’t change them.',
              style: AppText.subtitle,
            ),
          ],
          if (tasks.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final t in tasks)
                  TintBadge(
                    '${taskTypeLabel(t.type)} · ${_taskState(t, names)}',
                    color: t.isDismissed
                        ? AppColors.textMuted
                        : (t.isUnowned ? AppColors.coral : AppColors.indigo),
                  ),
              ],
            ),
          ],
          if (onToggleOmit != null) ...[
            const SizedBox(height: 6),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: onToggleOmit,
                child: Text(
                  m.omitted ? 'Include again' : 'Omit from this rule',
                  style: font(
                    kBodyFont,
                    13,
                    700,
                    color: m.omitted ? AppColors.green : AppColors.amber,
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  static String _taskState(TaskItem t, Map<String, String> names) {
    if (t.isDismissed) return 'not needed';
    if (t.isUnowned) return 'unclaimed';
    final who = t.ownerMemberIds.map((id) => names[id]).whereType<String>();
    return who.isEmpty ? 'claimed' : who.join(' & ');
  }
}
