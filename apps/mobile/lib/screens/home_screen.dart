import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../util/format.dart';
import '../util/task_visuals.dart';
import '../widgets/app_bottom_nav.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import '../widgets/task_row.dart';
import 'conflict_resolution_sheet.dart';
import 'feed_baseline_screen.dart';
import 'task_actions_sheet.dart';

/// Home — the claim hub. A multi-day list grouped under sticky day headers;
/// unowned tasks read as dashed "needs an owner" rows any caretaker can claim,
/// and the caller's own claimed tasks sit inline (solid bar + "You").
class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  bool _refreshingFeeds = false;

  // Children and task-type filters are stored as *exclusions* (empty ⇒ show
  // all), same as Plan. The owner axis is inverted on purpose: Home is the
  // claim hub, so unowned tasks always show and `_incOwners` is an opt-*in*
  // set — a caretaker's claimed tasks only appear once you pick them here.
  final Set<String> _exChildren = {};
  final Set<String> _incOwners = {};
  final Set<String> _exTypes = {};
  bool _showCompleted = false;
  bool _onlyMyKids = false;

  int get _filterCount =>
      (_exChildren.isNotEmpty ? 1 : 0) +
      (_incOwners.isNotEmpty ? 1 : 0) +
      (_exTypes.isNotEmpty ? 1 : 0) +
      (_onlyMyKids ? 1 : 0);

  // The child / task-type / only-my-kids axes. The owner axis is applied
  // separately when partitioning into the "Needs an owner" vs "You're covering"
  // sections (6b), so it isn't checked here.
  bool _passesBase(TaskItem t, Set<String> myKids) {
    if (_exChildren.contains(t.familyMemberId)) return false;
    final group = t.type == 'attendance' ? 'attendance' : 'transition';
    if (_exTypes.contains(group)) return false;
    if (_onlyMyKids && !myKids.contains(t.familyMemberId)) return false;
    return true;
  }

  void _refresh() {
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
    ref.invalidate(pendingDecisionsProvider);
    ref.invalidate(conflictsProvider);
    ref.invalidate(calendarEventsProvider);
  }

  Future<void> _refreshFeeds() async {
    setState(() => _refreshingFeeds = true);
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).refreshAllFeeds(familyId);
      ref.invalidate(feedsProvider);
      _refresh();
      await ref.read(allTasksProvider.future);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Refresh failed: $e'),
          margin: snackBarMarginAboveNav(context),
        ));
      }
    } finally {
      if (mounted) setState(() => _refreshingFeeds = false);
    }
  }

  Future<void> _claim(String taskId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).assignTask(familyId, taskId);
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    final allAsync = ref.watch(allTasksProvider);
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final decisions =
        ref.watch(pendingDecisionsProvider).valueOrNull ?? const <PendingDecision>[];
    final conflicts =
        ref.watch(conflictsProvider).valueOrNull ?? const <Conflict>[];
    final threshold = ref.watch(threadingThresholdProvider).valueOrNull ?? 30;
    final events =
        ref.watch(calendarEventsProvider).valueOrNull ?? const <CalendarEventItem>[];
    final eventsById = {for (final e in events) e.id: e};
    final byId = {for (final m in members) m.id: m};
    final now = DateTime.now();
    final rawTasks = allAsync.valueOrNull ?? const <TaskItem>[];
    // Children I'm covering (for the "only my kids" filter): kids with a task I own.
    final myKids = {
      for (final t in rawTasks)
        if (t.ownerMemberId == me?.id) t.familyMemberId
    };

    // Upcoming tasks passing the base filters (child / type / only-my-kids).
    // The mockup shows a single day, but this flexes to however many days of
    // claimable work exist — each day keeps its own sticky header.
    final upcoming = [
      for (final t in rawTasks)
        if ((_showCompleted || !t.isDismissed) &&
            !t.start.isBefore(now) &&
            _passesBase(t, myKids))
          t
    ];
    // The two 6b buckets. "Needs an owner" is everything unclaimed; "You're
    // covering" is what I own — plus any other caretakers opted into via
    // Filters. My own claimed tasks always show.
    final unowned = [for (final t in upcoming) if (t.isUnowned) t];
    final covering = [
      for (final t in upcoming)
        if (!t.isUnowned &&
            !t.isDismissed &&
            (t.ownerMemberId == me?.id || _incOwners.contains(t.ownerMemberId)))
          t
    ];

    final unownedByDay = _groupByDay(unowned);
    final coveringByDay = _groupByDay(covering);
    final unownedDays = unownedByDay.keys.toList()..sort();
    final coveringDays = coveringByDay.keys.toList()..sort();
    final nothing =
        conflicts.isEmpty && decisions.isEmpty && unowned.isEmpty && covering.isEmpty;

    return RefreshIndicator(
      onRefresh: () async {
        _refresh();
        await ref.read(allTasksProvider.future);
      },
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(22, 14, 22, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _header(now),
                  const SizedBox(height: 18),
                  // Agenda conflicts rank ABOVE everything — a member can't be
                  // in two places at once, so they block until an admin acts.
                  if (conflicts.isNotEmpty) ...[
                    SectionEyebrow(
                      'Double-booked',
                      color: AppColors.coral,
                      trailing: TintBadge('${conflicts.length}', color: AppColors.coral),
                    ),
                    const SizedBox(height: 10),
                    for (final conflict in conflicts) ...[
                      _ConflictCard(
                        conflict: conflict,
                        member: byId[conflict.familyMemberId],
                        onOpen: () => showConflictResolution(
                          context,
                          ref,
                          conflict,
                          member: byId[conflict.familyMemberId],
                        ),
                      ),
                      const SizedBox(height: 10),
                    ],
                    const SizedBox(height: 8),
                  ],
                  // Pending decisions rank ABOVE unclaimed tasks — they block
                  // the pipeline until a human decides.
                  if (decisions.isNotEmpty) ...[
                    SectionEyebrow(
                      'Needs a decision',
                      color: AppColors.amber,
                      trailing: TintBadge('${decisions.length}', color: AppColors.amber),
                    ),
                    const SizedBox(height: 10),
                    for (final d in decisions) ...[
                      _DecisionCard(
                        decision: d,
                        member: byId[d.familyMemberId],
                        onResolve: () => _openRuleEditor(d),
                        onDismiss: () => _dismissDecision(d),
                      ),
                      const SizedBox(height: 10),
                    ],
                    const SizedBox(height: 8),
                  ],
                ],
              ),
            ),
          ),
          if (allAsync.hasError)
            SliverToBoxAdapter(child: _pad(_error('${allAsync.error}')))
          else if (nothing)
            SliverToBoxAdapter(
              child: _pad(_empty(allAsync.isLoading
                  ? 'Loading…'
                  : 'Nothing to cover — all clear 🎉')))
          else ...[
            // Needs an owner — the claim queue, threaded. On a single day the
            // eyebrow carries the day + count ("Today · 3", as in 6b); across
            // several days the per-day sticky headers take over.
            if (unowned.isNotEmpty)
              ..._section(
                label: 'Needs an owner',
                labelColor: AppColors.textPrimary,
                trailing: Text(
                  unownedDays.length == 1
                      ? '${_relDayCap(unownedDays.first, now)} · ${unowned.length}'
                      : '${unowned.length}',
                  style: AppText.secondary,
                ),
                byDay: unownedByDay,
                days: unownedDays,
                showOpen: true,
                thread: true,
                now: now,
                byId: byId,
                eventsById: eventsById,
                me: me,
                threshold: threshold,
              ),
            // You're covering — tasks I (or opted-in caretakers) already own.
            if (covering.isNotEmpty)
              ..._section(
                label: "You're covering",
                labelColor: AppColors.textMuted,
                trailing: null,
                byDay: coveringByDay,
                days: coveringDays,
                showOpen: false,
                thread: false,
                now: now,
                byId: byId,
                eventsById: eventsById,
                me: me,
                threshold: threshold,
              ),
          ],
          const SliverToBoxAdapter(child: SizedBox(height: 120)),
        ],
      ),
    );
  }

  Map<DateTime, List<TaskItem>> _groupByDay(List<TaskItem> tasks) {
    final byDay = <DateTime, List<TaskItem>>{};
    for (final t in tasks) {
      (byDay[dayKey(t.start)] ??= []).add(t);
    }
    for (final list in byDay.values) {
      list.sort((a, b) => a.start.compareTo(b.start));
    }
    return byDay;
  }

  /// A 6b section: an eyebrow header, then the tasks grouped by day. Each day is
  /// its own SliverMainAxisGroup so its header stays pinned only within that day
  /// — the next day's header pushes it out instead of stacking.
  List<Widget> _section({
    required String label,
    required Color labelColor,
    required Widget? trailing,
    required Map<DateTime, List<TaskItem>> byDay,
    required List<DateTime> days,
    required bool showOpen,
    required bool thread,
    required DateTime now,
    required Map<String, Member> byId,
    required Map<String, CalendarEventItem> eventsById,
    required Member? me,
    required int threshold,
  }) {
    // A single day needs no sticky day header — the eyebrow already names it
    // (matching 6b). Multiple days each get their own pinned header.
    final showDayHeaders = days.length > 1;
    return [
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 6, 22, 8),
          child: SectionEyebrow(label, color: labelColor, trailing: trailing),
        ),
      ),
      for (final day in days)
        if (showDayHeaders)
          SliverMainAxisGroup(
            slivers: [
              SliverPersistentHeader(
                pinned: true,
                delegate: _DayHeaderDelegate(
                  label: homeDayHeader(day, now),
                  trailing: showOpen ? '${byDay[day]!.length} open' : null,
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 8),
                sliver: _daySliver(byDay[day]!, byId, eventsById, me, threshold,
                    thread: thread),
              ),
            ],
          )
        else
          SliverPadding(
            padding: const EdgeInsets.fromLTRB(22, 2, 22, 8),
            sliver: _daySliver(byDay[day]!, byId, eventsById, me, threshold,
                thread: thread),
          ),
    ];
  }

  /// "Today" / "Tomorrow" / "Fri Jul 11" — the capitalized relative day used in
  /// the single-day section eyebrow.
  String _relDayCap(DateTime day, DateTime now) {
    final r = relativeDayLower(day, now);
    return r.isEmpty ? r : '${r[0].toUpperCase()}${r.substring(1)}';
  }

  /// Stitch a day's tasks into threaded chains: consecutive tasks whose gap is
  /// within the family threshold render joined by a dotted spine ("same trip")
  /// while staying independently claimable. Presentation only — nothing stored.
  List<List<TaskItem>> _chains(List<TaskItem> tasks, int thresholdMinutes) {
    final chains = <List<TaskItem>>[];
    for (final t in tasks) {
      if (chains.isEmpty) {
        chains.add([t]);
        continue;
      }
      final prev = chains.last.last;
      final anchor = prev.end ?? prev.start;
      final gap = t.start.difference(anchor).inMinutes;
      if (gap >= 0 && gap <= thresholdMinutes) {
        chains.last.add(t);
      } else {
        chains.add([t]);
      }
    }
    return chains;
  }

  Widget _daySliver(List<TaskItem> tasks, Map<String, Member> byId,
      Map<String, CalendarEventItem> eventsById, Member? me, int threshold,
      {bool thread = true}) {
    // "You're covering" rows aren't threaded — they're already claimed, so the
    // "same trip / claim both" affordance doesn't apply.
    if (!thread) {
      return SliverList.separated(
        itemCount: tasks.length,
        separatorBuilder: (_, __) => const SizedBox(height: 11),
        itemBuilder: (_, i) => _row(tasks[i], byId, eventsById, me),
      );
    }
    final chains = _chains(tasks, threshold);
    return SliverList.separated(
      itemCount: chains.length,
      separatorBuilder: (_, __) => const SizedBox(height: 11),
      itemBuilder: (_, i) {
        final chain = chains[i];
        if (chain.length == 1) return _row(chain.first, byId, eventsById, me);
        return _ThreadedChain(
          rows: [for (final t in chain) _row(t, byId, eventsById, me)],
          gaps: [
            for (var j = 1; j < chain.length; j++)
              chain[j]
                  .start
                  .difference(chain[j - 1].end ?? chain[j - 1].start)
                  .inMinutes,
          ],
          onClaimAll: chain.every((t) => t.isUnowned)
              ? () async {
                  for (final t in chain) {
                    await _claim(t.id);
                  }
                }
              : null,
        );
      },
    );
  }

  /// Resolve opens the override-rule editor (6m, shared with Feed setup) with
  /// the match pre-filled to this event's title — saving a rule there is what
  /// actually clears the decision, by resynthesizing the feed.
  Future<void> _openRuleEditor(PendingDecision d) async {
    try {
      final feeds = await ref.read(feedsProvider.future);
      final feed = feeds.firstWhere((f) => f.id == d.feedId);
      final links = await ref.read(feedLinksProvider(d.feedId).future);
      final link = links.firstWhere((l) => l.id == d.linkId);
      if (!mounted) return;
      await showOverrideRuleSheet(
        context,
        ref,
        feed: feed,
        link: link,
        prefillMatchValue: d.summary,
      );
      _refresh();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Couldn\'t open rule editor: $e'),
          margin: snackBarMarginAboveNav(context),
        ));
      }
    }
  }

  Future<void> _dismissDecision(PendingDecision d) async {
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).dismissPendingDecision(familyId, d.id);
      _refresh();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Dismiss failed: $e'),
          margin: snackBarMarginAboveNav(context),
        ));
      }
    }
  }

  Widget _header(DateTime now) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(child: Text(greeting(now), style: AppText.screenTitleAlt)),
                  const SizedBox(width: 7),
                  const Icon(Icons.wb_sunny_rounded, color: AppColors.amberHero, size: 22),
                ],
              ),
              const SizedBox(height: 3),
              Text(longDate(now), style: AppText.subtitle),
            ],
          ),
        ),
        FiltersButton(count: _filterCount, onTap: _openFilters),
        const SizedBox(width: 8),
        RefreshFeedsButton(busy: _refreshingFeeds, onTap: _refreshFeeds),
      ],
    );
  }

  /// Same filter categories as Plan (children / task type / show completed /
  /// only my kids); the "Caretakers" section is opt-*in* here instead of
  /// opt-out — Home only ever shows a claimed task once you pick its owner,
  /// since the whole point of this screen is what's still unclaimed.
  void _openFilters() {
    final members = ref.read(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.read(currentMemberProvider).valueOrNull;
    final children = members.where((m) => m.requiresCaretaker).toList();
    // My own covered tasks always show under "You're covering", so the opt-in
    // list is only the *other* caretakers.
    final caretakers =
        members.where((m) => m.isCaretaker && m.id != me?.id).toList();

    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      useRootNavigator: true,
      builder: (_) => StatefulBuilder(
        builder: (context, setSheet) {
          void toggle(Set<String> set, String key) => setSheet(() {
                set.contains(key) ? set.remove(key) : set.add(key);
                setState(() {});
              });
          return DraggableScrollableSheet(
            expand: false,
            initialChildSize: 0.72,
            maxChildSize: 0.92,
            builder: (context, scroll) => ListView(
              controller: scroll,
              padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
              children: [
                Row(
                  children: [
                    Text('Filters', style: AppText.subPageTitle),
                    const Spacer(),
                    TextButton(
                      onPressed: () => setSheet(() {
                        _exChildren.clear();
                        _incOwners.clear();
                        _exTypes.clear();
                        _showCompleted = false;
                        _onlyMyKids = false;
                        setState(() {});
                      }),
                      child: const Text('Reset'),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text('Children', style: AppText.eyebrow()),
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final c in children)
                    TaskFilterChip(
                      label: c.relationName,
                      dotColor: personColor(c),
                      selected: !_exChildren.contains(c.id),
                      onTap: () => toggle(_exChildren, c.id),
                    ),
                ]),
                const SizedBox(height: 18),
                Text('Also show claimed by', style: AppText.eyebrow()),
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final m in caretakers)
                    TaskFilterChip(
                      label: m.id == me?.id ? 'You' : m.relationName,
                      dotColor: personColor(m),
                      selected: _incOwners.contains(m.id),
                      onTap: () => toggle(_incOwners, m.id),
                    ),
                ]),
                const SizedBox(height: 18),
                Text('Task type', style: AppText.eyebrow()),
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  TaskFilterChip(
                    label: 'Transitions',
                    selected: !_exTypes.contains('transition'),
                    onTap: () => toggle(_exTypes, 'transition'),
                  ),
                  TaskFilterChip(
                    label: 'Attendance',
                    selected: !_exTypes.contains('attendance'),
                    onTap: () => toggle(_exTypes, 'attendance'),
                  ),
                ]),
                const SizedBox(height: 20),
                AppCard(
                  child: Column(
                    children: [
                      SwitchRow(
                        icon: Icons.check_circle_outline_rounded,
                        iconColor: AppColors.green,
                        title: 'Show completed',
                        subtitle: 'Include tasks already done',
                        value: _showCompleted,
                        onChanged: (v) => setSheet(() {
                          _showCompleted = v;
                          setState(() {});
                        }),
                      ),
                      const Divider(height: 20),
                      SwitchRow(
                        icon: Icons.person_outline_rounded,
                        iconColor: AppColors.indigo,
                        title: 'Only my kids',
                        subtitle: "Hide children I don't cover",
                        value: _onlyMyKids,
                        onChanged: (v) => setSheet(() {
                          _onlyMyKids = v;
                          setState(() {});
                        }),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
                Row(
                  children: [
                    PillButton(
                      label: 'Clear',
                      variant: PillVariant.ghost,
                      onPressed: () => setSheet(() {
                        _exChildren.clear();
                        _incOwners.clear();
                        _exTypes.clear();
                        _showCompleted = false;
                        _onlyMyKids = false;
                        setState(() {});
                      }),
                    ),
                    const Spacer(),
                    PillButton(
                      label: _filterCount == 0
                          ? 'Apply'
                          : 'Apply · $_filterCount filter${_filterCount == 1 ? '' : 's'}',
                      variant: PillVariant.amber,
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _row(TaskItem t, Map<String, Member> byId,
      Map<String, CalendarEventItem> eventsById, Member? me) {
    final child = byId[t.familyMemberId];
    final color = child != null ? personColor(child) : AppColors.textSecondary;
    final owned = t.status == 'owned';
    final owner = owned ? byId[t.ownerMemberId] : null;
    final ownerColor = owner != null ? personColor(owner) : AppColors.indigo;
    final isMine = owner?.id == me?.id;
    return TaskRow(
      icon: taskIcon(t.type),
      iconColor: color,
      // The source-person badge names whose calendar the task came from (6b).
      // Only on the unclaimed rows, where the trailing chip isn't already an
      // avatar of a person.
      sourceInitial: !owned && child != null ? initialFor(child.relationName) : null,
      sourceColor: !owned && child != null ? color : null,
      typeLabel: taskTitle(t, eventsById[t.calendarEventId]),
      personName: child?.relationName ?? 'child',
      personColor: color,
      subtitle: t.type == 'attendance' && t.end != null
          ? 'Attendance · ${friendlyRange(t.start, t.end!)}'
          : '${taskCategory(t.type)} · ${friendlyTime(t.start)}',
      ownedColor: owned ? ownerColor : null,
      onTap: () => showTaskActions(context, ref, t,
          sourceEvent: t.calendarEventId == null ? null : eventsById[t.calendarEventId]),
      trailing: owned
          ? (isMine
              ? YouChip(
                  initial: initialFor(me?.relationName ?? '?'), color: ownerColor)
              : _CoveredByChip(
                  initial: initialFor(owner?.relationName ?? '?'),
                  name: owner?.relationName ?? 'them',
                  color: ownerColor))
          : PillButton(label: 'Claim', dense: true, onPressed: () => _claim(t.id)),
    );
  }

  Widget _pad(Widget child) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 22),
        child: child,
      );

  Widget _empty(String msg) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 40),
        child: Center(child: Text(msg, style: AppText.subtitle)),
      );

  Widget _error(String msg) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Text(msg, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
      );
}

/// An unmatched exception-feed event awaiting a human decision (6b): amber
/// dashed card with Resolve / Dismiss. The system never guesses.
class _DecisionCard extends StatelessWidget {
  const _DecisionCard({
    required this.decision,
    required this.member,
    required this.onResolve,
    required this.onDismiss,
  });
  final PendingDecision decision;
  final Member? member;
  final VoidCallback onResolve;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final memberColor =
        member != null ? personColor(member!) : AppColors.textSecondary;
    final when = decision.allDay
        ? homeDayHeader(dayKey(decision.start), DateTime.now())
        : friendlyTime(decision.start);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.tint(AppColors.amber, 0.07),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.amber.withValues(alpha: 0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const IconTile(icon: Icons.help_outline_rounded, color: AppColors.amber, size: 38),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text.rich(
                      TextSpan(children: [
                        TextSpan(
                            text: decision.summary ?? 'Unmatched event',
                            style: AppText.sectionItemTitle),
                        TextSpan(
                            text: ' · ${member?.relationName ?? 'member'}',
                            style: font(kBodyFont, 14, 700, color: memberColor)),
                      ]),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 3),
                    Text(
                      'No rule matched · $when — what should this generate?',
                      style: font(kBodyFont, 12, 500, color: AppColors.amber),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: PillButton(
                    label: 'Resolve', variant: PillVariant.amber, onPressed: onResolve),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: PillButton(label: 'Dismiss', onPressed: onDismiss),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// An agenda overlap (6b, ranked above pending decisions): a coral card naming
/// the two events that collide. "Split around it" accepts the default
/// resolution — trim/split the lower-priority event around the higher one, which
/// then generates its own drop-off/pickup; "Dismiss" accepts the double-book.
class _ConflictCard extends StatelessWidget {
  const _ConflictCard({
    required this.conflict,
    required this.member,
    required this.onOpen,
  });
  final Conflict conflict;
  final Member? member;

  /// Opens the shared conflict-resolution sheet (design §8b).
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final memberColor =
        member != null ? personColor(member!) : AppColors.textSecondary;
    final winner = conflict.winner;
    final loser = conflict.loser;
    final when = winner.allDay
        ? homeDayHeader(dayKey(winner.start), DateTime.now())
        : friendlyTime(winner.start);
    return Material(
      color: AppColors.tint(AppColors.coral, 0.07),
      borderRadius: BorderRadius.circular(18),
      child: InkWell(
        onTap: onOpen,
        borderRadius: BorderRadius.circular(18),
        child: Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: AppColors.coral.withValues(alpha: 0.45)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const IconTile(icon: Icons.event_busy_rounded, color: AppColors.coral, size: 38),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text.rich(
                          TextSpan(children: [
                            TextSpan(
                                text: loser.summary ?? 'An event',
                                style: AppText.sectionItemTitle),
                            TextSpan(
                                text: ' · ${member?.relationName ?? 'member'}',
                                style: font(kBodyFont, 14, 700, color: memberColor)),
                          ]),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          'Overlaps ${winner.summary ?? 'another event'} · $when — '
                          "can't be in two places at once.",
                          style: font(kBodyFont, 12, 500, color: AppColors.coral),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: PillButton(
                        label: 'Review & resolve',
                        variant: PillVariant.amber,
                        onPressed: onOpen),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Threaded chain (6d, treatment 1 — "connector thread"): separate cards joined
/// by a dotted coral spine + "then… same trip" note; each leg stays
/// independently claimable, with an optional "Claim both".
class _ThreadedChain extends StatelessWidget {
  const _ThreadedChain({
    required this.rows,
    required this.gaps,
    this.onClaimAll,
  });
  final List<Widget> rows;
  final List<int> gaps;
  final Future<void> Function()? onClaimAll;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: AppColors.coral.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: AppColors.coral.withValues(alpha: 0.16)),
      ),
      child: Column(
        children: [
          for (var i = 0; i < rows.length; i++) ...[
            if (i > 0)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  children: [
                    const SizedBox(width: 26),
                    Container(
                      width: 2,
                      height: 16,
                      decoration: BoxDecoration(
                        color: AppColors.coral.withValues(alpha: 0.55),
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Text(
                      'then, ${gaps[i - 1]} min later — same trip',
                      style: font(kBodyFont, 11.5, 600, color: AppColors.coral),
                    ),
                  ],
                ),
              ),
            rows[i],
          ],
          if (onClaimAll != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () => onClaimAll!(),
                  child: Text('Claim both',
                      style: font(kBodyFont, 12.5, 700, color: AppColors.coral)),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// The trailing chip on a "You're covering" row when the owner isn't me: the
/// covering caretaker's avatar + name.
class _CoveredByChip extends StatelessWidget {
  const _CoveredByChip({
    required this.initial,
    required this.name,
    required this.color,
  });
  final String initial;
  final String name;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PersonAvatar(initial: initial, color: color, size: 24),
        const SizedBox(width: 6),
        Text(name, style: font(kBodyFont, 12.5, 600, color: AppColors.textSecondary)),
      ],
    );
  }
}

/// Sticky per-day header: "TODAY · TUE JUL 1" with an optional trailing note
/// (the open-count on the claim queue; nothing on the covering list).
class _DayHeaderDelegate extends SliverPersistentHeaderDelegate {
  _DayHeaderDelegate({required this.label, this.trailing});
  final String label;
  final String? trailing;

  @override
  double get minExtent => 42;
  @override
  double get maxExtent => 42;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    return Container(
      color: AppColors.bg,
      padding: const EdgeInsets.fromLTRB(24, 10, 24, 10),
      alignment: Alignment.center,
      child: Row(
        children: [
          Expanded(child: Text(label, style: AppText.eyebrow(AppColors.amberHero))),
          if (trailing != null) Text(trailing!, style: AppText.secondary),
        ],
      ),
    );
  }

  @override
  bool shouldRebuild(_DayHeaderDelegate old) =>
      old.label != label || old.trailing != trailing;
}
