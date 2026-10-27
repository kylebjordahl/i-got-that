import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../util/assignment_text.dart';
import '../util/format.dart';
import '../util/task_visuals.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

/// An assignment rule's match list: every task its filters match in the past
/// and next 30 days, and who has each. It's where a rule that claims too much
/// shows it — and where an admin can omit one task from the rule (a one-off:
/// it falls to the next matching rule, or back to the queue) or put an omitted
/// one back, rather than bend the rule around a single exception.
///
/// Tasks an earlier rule claims are listed too, and so are tasks a person took
/// in hand (claimed or reassigned by hand), which no rule touches.
class AssignmentRuleMatchesScreen extends ConsumerWidget {
  const AssignmentRuleMatchesScreen({
    super.key,
    required this.rule,
    required this.ruleSet,
  });

  final AssignmentRule rule;

  /// The family's pipeline, to name the rule that claims a shadowed task.
  final AssignmentRuleSet ruleSet;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(assignmentRuleMatchesProvider(rule.id));
    final isAdmin = ref.watch(currentMemberProvider).valueOrNull?.isAdmin;
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final feeds = ref.watch(feedsProvider).valueOrNull ?? const <FeedItem>[];
    final owner = members.where((m) => m.id == rule.ownerMemberId).firstOrNull;

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 12, 22, 18),
              child: SubPageHeader(
                title: 'What this rule claims',
                subtitle:
                    '${owner?.relationName ?? 'Unknown'} · '
                    '${describeRule(rule, members, feeds, ruleSet.links)}',
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
                    _list(context, matches, members, feeds, isAdmin ?? false),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _list(
    BuildContext context,
    List<AssignmentRuleMatch> matches,
    List<Member> members,
    List<FeedItem> feeds,
    bool isAdmin,
  ) {
    final claims = matches.where((m) => m.applies).length;
    final now = DateTime.now();
    final past = matches.where((m) => m.start.isBefore(now)).toList();
    final upcoming = matches.where((m) => !m.start.isBefore(now)).toList();
    final names = {for (final m in members) m.id: m.relationName};

    Widget section(String label, List<AssignmentRuleMatch> items) => Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SectionEyebrow(label),
        const SizedBox(height: 10),
        for (final m in items) ...[
          _MatchCard(
            match: m,
            names: names,
            statusText: _statusText(m, names, members, feeds),
            onToggleOmit: isAdmin && (m.applies || m.omitted)
                ? () => _toggleOmit(context, m)
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
              : '${matches.length} ${matches.length == 1 ? 'task' : 'tasks'} '
                    'in the past and next 30 days match; this rule claims '
                    '$claims of them.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 18),
        if (upcoming.isNotEmpty) section('Next 30 days', upcoming),
        if (past.isNotEmpty) section('Past 30 days', past.reversed.toList()),
      ],
    );
  }

  /// What the pipeline does with the task, from this rule's point of view.
  (String, Color) _statusText(
    AssignmentRuleMatch m,
    Map<String, String> names,
    List<Member> members,
    List<FeedItem> feeds,
  ) {
    String otherRule() {
      final other = ruleSet.rules
          .where((r) => r.id == m.decidedByRuleId)
          .firstOrNull;
      if (other == null) return 'another rule';
      final who = names[other.ownerMemberId] ?? 'someone';
      return '“$who · ${describeRule(other, members, feeds, ruleSet.links)}”';
    }

    return switch (m.status) {
      'applies' => (
        '→ claimed for ${names[rule.ownerMemberId] ?? 'the caretaker'}',
        AppColors.green,
      ),
      'omitted' => (
        m.decidedByRuleId == null
            ? 'Omitted · back in the queue'
            : 'Omitted · claimed by ${otherRule()} instead',
        AppColors.amber,
      ),
      'held' => (
        'Handled by hand, so no rule changes who has it',
        AppColors.textSecondary,
      ),
      'owner_unavailable' => (
        '${names[rule.ownerMemberId] ?? 'Its caretaker'} can’t take tasks any '
            'more, so this rule claims nothing',
        AppColors.coral,
      ),
      _ => (
        'Claimed by an earlier rule, ${otherRule()}',
        AppColors.textSecondary,
      ),
    };
  }

  Future<void> _toggleOmit(BuildContext context, AssignmentRuleMatch m) async {
    // Read up front: the screen may be gone by the time the request returns,
    // and the change still needs its refresh.
    final messenger = ScaffoldMessenger.of(context);
    final container = ProviderScope.containerOf(context, listen: false);
    final label = '${taskTypeLabel(m.task.type)} for “${m.displaySummary}”';
    try {
      final familyId = await container.read(familyProvider.future);
      final api = container.read(apiClientProvider);
      if (m.omitted) {
        await api.restoreAssignmentRuleTask(
          familyId,
          rule.id,
          m.eventId,
          m.task.type,
        );
      } else {
        await api.omitAssignmentRuleTask(
          familyId,
          rule.id,
          m.eventId,
          m.task.type,
        );
      }
      container
        ..invalidate(assignmentRuleMatchesProvider(rule.id))
        ..invalidate(unownedTasksProvider)
        ..invalidate(allTasksProvider)
        ..invalidate(calendarEventsProvider);
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            m.omitted
                ? '$label follows this rule again'
                : '$label omitted from this rule',
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
    required this.names,
    required this.statusText,
    required this.onToggleOmit,
  });

  final AssignmentRuleMatch match;
  final Map<String, String> names;
  final (String, Color) statusText;
  final VoidCallback? onToggleOmit;

  @override
  Widget build(BuildContext context) {
    final m = match;
    final t = m.task;
    final day = dayHeading(dayKey(m.start), DateTime.now());
    final when = m.allDay ? day : '$day · ${friendlyTime(t.start)}';
    final (status, statusColor) = statusText;
    final owners = t.ownerMemberIds
        .map((id) => names[id])
        .whereType<String>()
        .toList();

    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(when, style: AppText.secondary)),
              TintBadge(
                names[m.aboutMemberId] ?? 'Child',
                color: AppColors.feedBlue,
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            '${taskTypeLabel(t.type)} · ${m.displaySummary}',
            style: AppText.sectionItemTitle,
          ),
          const SizedBox(height: 8),
          Text(status, style: font(kBodyFont, 12.5, 600, color: statusColor)),
          const SizedBox(height: 10),
          TintBadge(
            owners.isEmpty ? 'Unclaimed' : 'Has it: ${owners.join(' & ')}',
            color: owners.isEmpty ? AppColors.coral : AppColors.indigo,
          ),
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
}
