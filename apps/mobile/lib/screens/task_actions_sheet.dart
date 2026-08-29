import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../util/assignment_text.dart';
import '../util/format.dart';
import '../util/task_visuals.dart';
import '../widgets/app_bottom_nav.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import '../widgets/time_fields.dart';

/// Quick-actions for a timeline task (Home rows + Plan blocks/tags): change its
/// type (drop off / attend / pick up, any combination), (re)assign or unassign
/// it, or mark it not needed.
///
/// [scopeTasks] scopes the assign / unassign / dismiss actions: pass the whole
/// event group (a Plan block tap) to act on the drop-off *and* pick-up at once,
/// or omit it (a tag tap / Home row) to act on [task] alone. [sourceEvent], when
/// the task traces back to a real calendar event, swaps the header's type label
/// for the event's own title and adds a details block (time range, location,
/// description) above the actions.
Future<void> showTaskActions(
  BuildContext context,
  WidgetRef ref,
  TaskItem task, {
  List<TaskItem>? scopeTasks,
  CalendarEventItem? sourceEvent,
}) async {
  final members = ref.read(membersProvider).valueOrNull ?? const <Member>[];
  final byId = {for (final m in members) m.id: m};
  final caretakers = members.where((m) => m.isCaretaker).toList();
  final me = ref.read(currentMemberProvider).valueOrNull;
  final isAdmin = me?.isAdmin ?? false;
  final canClaim = me?.isCaretaker ?? false;
  // Any caretaker may reassign; a non-caretaker admin can still route work.
  final canAssign = canClaim || isAdmin;
  final child = byId[task.familyMemberId];
  final color = child != null ? personColor(child) : AppColors.textSecondary;
  // Only event-derived tasks are convertible (fully-manual ones have no event).
  final isFeedTask = task.calendarEventId != null;

  // Tasks the assign/unassign/dismiss actions operate on (the event's whole
  // group for a block tap; just this task otherwise).
  final scope = (scopeTasks == null || scopeTasks.isEmpty)
      ? [task]
      : scopeTasks;
  final anyUnowned = scope.any((t) => t.status == 'unowned');
  final anyOwned = scope.any((t) => t.status == 'owned');
  final allUnowned = scope.every((t) => t.status == 'unowned');

  // The task's current type(s), derived from the whole event group.
  final all = ref.read(allTasksProvider).valueOrNull ?? const <TaskItem>[];
  final group = all
      .where((t) => t.calendarEventId == task.calendarEventId)
      .toList();
  final types = (group.isEmpty ? [task] : group).map((t) => t.type).toSet();
  // A tag/row tap scopes to just [task], but its event has other legs too —
  // the TYPE switches below still edit all of them, so callers need a nudge
  // that they're not just retyping this one drop-off or pick-up.
  final isSingleLegOfGroup =
      group.length > 1 && (scopeTasks == null || scopeTasks.isEmpty);

  final owners = scope
      .where((t) => t.status == 'owned')
      .expand((t) => t.ownerMemberIds)
      .map((id) => byId[id]?.relationName)
      .whereType<String>()
      .toSet();
  // Several caretakers on one task is an attendance thing — a drop-off or
  // pickup is one person's trip — and only makes sense on a single task, not a
  // whole event group where each leg has its own claimant.
  final canShare = scope.length == 1 && scope.first.type == 'attendance';
  // Rules responsible for the owned tasks in scope — drives the "assigned by a
  // rule" note (and the header's "· auto" hint) so a rule-claim never looks
  // like a person quietly claiming for you.
  final autoRuleIds = scope
      .map((t) => t.autoAssignedRuleId)
      .whereType<String>()
      .toSet();
  final allAuto =
      !allUnowned &&
      scope.where((t) => t.status == 'owned').every((t) => t.isAutoAssigned);
  final statusText =
      (allUnowned
          ? 'unclaimed'
          : (owners.length == 1 ? owners.first : '${owners.length} assigned')) +
      (allAuto ? ' · auto' : '');

  // Transition tasks in scope get an editable duration field (keyboard-aware,
  // so the sheet lifts above it). A single tag/row scopes to one; a Plan block
  // tap scopes to the whole pair.
  final transitions = scope.where((t) => t.isTransition).toList();

  // Travel time belongs to the *claimed* event — the copy of this task that
  // mirrors out to the owner's calendar — and this is the sheet a drop-off or
  // pickup opens (Plan draws them as tabs on their source event, never as
  // claim blocks). An unclaimed task has no such event yet, so nothing to set.
  final events =
      ref.read(calendarEventsProvider).valueOrNull ??
      const <CalendarEventItem>[];
  CalendarEventItem? claimEventFor(TaskItem t) {
    for (final e in events) {
      if (e.isClaimedTask && e.taskId == t.id) return e;
    }
    return null;
  }

  final travelTargets = <(TaskItem, CalendarEventItem)>[
    for (final t in transitions)
      if (claimEventFor(t) case final claim?) (t, claim),
  ];

  // The event's own time range when it has one, else just the task's start.
  final eventEnd = sourceEvent?.end;
  final eventTime =
      sourceEvent != null &&
          eventEnd != null &&
          eventEnd.isAfter(sourceEvent.start)
      ? friendlyRange(sourceEvent.start, eventEnd)
      : friendlyTime(sourceEvent?.start ?? task.start);

  final location = sourceEvent?.location;
  final description = sourceEvent?.description;
  final hasLocation = location != null && location.isNotEmpty;
  final hasDescription = description != null && description.isNotEmpty;

  await showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetCtx) => SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          22,
          4,
          22,
          28 + MediaQuery.of(sheetCtx).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                IconTile(icon: taskIcon(task.type), color: color, size: 44),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${sourceEvent?.displaySummary ?? taskTypeLabel(task.type)} · ${child?.relationName ?? 'child'}',
                        style: AppText.sectionItemTitle,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${taskCategory(task.type)} · $eventTime · $statusText',
                        style: AppText.subtitle,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (hasLocation || hasDescription) ...[
              const SizedBox(height: 14),
              if (hasLocation)
                _DetailRow(icon: Icons.location_on_outlined, text: location),
              if (hasLocation && hasDescription) const SizedBox(height: 8),
              if (hasDescription)
                _DetailRow(icon: Icons.notes_rounded, text: description),
            ],
            if (autoRuleIds.isNotEmpty) ...[
              const SizedBox(height: 14),
              _AutoAssignedNote(ruleIds: autoRuleIds),
            ],
            if (isFeedTask) ...[
              const SizedBox(height: 20),
              Text('TYPE', style: AppText.eyebrow()),
              const SizedBox(height: 6),
              for (final (type, label, icon, color) in const [
                (
                  'dropoff',
                  'Drop off',
                  Icons.login_rounded,
                  AppColors.feedBlue,
                ),
                (
                  'attendance',
                  'Attend',
                  Icons.groups_rounded,
                  AppColors.purple,
                ),
                ('pickup', 'Pick up', Icons.logout_rounded, AppColors.blue),
              ])
                SwitchRow(
                  icon: icon,
                  iconColor: color,
                  title: label,
                  value: types.contains(type),
                  // A task always needs at least one type, so the last one
                  // switched on can't be switched off.
                  onChanged: types.length == 1 && types.contains(type)
                      ? null
                      : (enabled) {
                          final next = Set<String>.from(types);
                          if (enabled) {
                            next.add(type);
                          } else {
                            next.remove(type);
                          }
                          Navigator.of(sheetCtx).pop();
                          _run(
                            context,
                            ref,
                            (api, fid) =>
                                api.convertTask(fid, task.id, next.toList()),
                            'Type updated',
                          );
                        },
                ),
              if (isSingleLegOfGroup) ...[
                const SizedBox(height: 6),
                Text(
                  'This changes the type for the whole event, not just this '
                  'one leg.',
                  style: AppText.subtitle,
                ),
              ],
            ],
            if (transitions.isNotEmpty) ...[
              const SizedBox(height: 20),
              Text('DURATION', style: AppText.eyebrow()),
              const SizedBox(height: 10),
              for (final t in transitions)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: _DurationField(
                    task: t,
                    // Label each field when the scope holds both edges (a block
                    // tap); a lone tag/row needs no disambiguation.
                    showLabel: transitions.length > 1,
                    onSubmit: (minutes) {
                      Navigator.of(sheetCtx).pop();
                      _run(
                        context,
                        ref,
                        (api, fid) => api.setTaskDuration(fid, t.id, minutes),
                        'Duration updated',
                      );
                    },
                  ),
                ),
            ],
            if (travelTargets.isNotEmpty) ...[
              const SizedBox(height: 20),
              Text('TRAVEL TIME', style: AppText.eyebrow()),
              const SizedBox(height: 10),
              for (final (t, claim) in travelTargets)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: _TravelTimeField(
                    event: claim,
                    label: travelTargets.length > 1 ? t.typeLabel : null,
                    onSubmit: (minutes) {
                      Navigator.of(sheetCtx).pop();
                      _run(
                        context,
                        ref,
                        (api, fid) =>
                            api.setEventTravelTime(fid, claim.id, minutes),
                        minutes == null
                            ? 'Back to the estimate'
                            : 'Travel time updated',
                      );
                    },
                  ),
                ),
            ],
            const SizedBox(height: 20),
            AppCard(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
              child: Column(
                children: [
                  if (anyUnowned && canClaim) ...[
                    _ActionRow(
                      icon: Icons.check_circle_outline_rounded,
                      iconColor: AppColors.indigo,
                      label: 'Claim for myself',
                      onTap: () {
                        Navigator.of(sheetCtx).pop();
                        _runScope(
                          context,
                          ref,
                          scope.where((t) => t.status == 'unowned'),
                          (api, fid, t) => api.assignTask(fid, t.id),
                          'Claimed',
                        );
                      },
                    ),
                    const Divider(height: 18),
                  ],
                  if (canAssign &&
                      caretakers.length > (allUnowned ? 0 : 1)) ...[
                    _ActionRow(
                      icon: Icons.person_add_alt_1_rounded,
                      iconColor: AppColors.blue,
                      label: canShare
                          ? 'Who’s going…'
                          : (allUnowned
                                ? 'Assign to someone…'
                                : 'Reassign to someone…'),
                      onTap: () {
                        Navigator.of(sheetCtx).pop();
                        if (canShare) {
                          _pickAttendees(context, ref, scope.first, caretakers);
                        } else {
                          _pickAndAssign(context, ref, scope, caretakers);
                        }
                      },
                    ),
                    const Divider(height: 18),
                  ],
                  if (anyOwned && canAssign) ...[
                    _ActionRow(
                      icon: Icons.person_off_outlined,
                      iconColor: AppColors.textSecondary,
                      label: 'Unassign',
                      onTap: () {
                        Navigator.of(sheetCtx).pop();
                        _runScope(
                          context,
                          ref,
                          scope.where((t) => t.status == 'owned'),
                          (api, fid, t) => api.unassignTask(fid, t.id),
                          'Returned to the queue',
                        );
                      },
                    ),
                    const Divider(height: 18),
                  ],
                  _ActionRow(
                    icon: Icons.block_rounded,
                    iconColor: AppColors.coral,
                    label: 'Mark as not needed',
                    destructive: true,
                    onTap: () {
                      Navigator.of(sheetCtx).pop();
                      _runScope(
                        context,
                        ref,
                        scope,
                        (api, fid, t) => api.dismissTask(fid, t.id),
                        'Marked not needed',
                      );
                    },
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

/// Details for a Plan event that has no live task to manage. Every block on the
/// grid answers a tap; this is what the ones with nothing to claim open.
///
/// Shows the event exactly as the unified calendar holds it (title, whose
/// calendar, time, location, notes) and says *why* it carries nothing to claim,
/// which is one of two very different situations:
///
///  * A rule — the event can't have tasks at all. The member's generation is
///    paused, it's a free/busy firewall block, or it already *is* a claim
///    ([CalendarEventItem.taskIneligibleReason]). Nothing to offer here; the
///    fix, where there is one, lives in that member's or feed's settings.
///  * A mishap — the event is eligible, so its tasks were marked not needed
///    (which is sticky: task-gen heals a dismissed row but never resurrects it)
///    or never got built. Rebuilding is offered, which restores the dismissed
///    ones and re-runs the member's task-rule pipeline over the event.
Future<void> showEventDetails(
  BuildContext context,
  WidgetRef ref,
  CalendarEventItem event, {
  Member? member,
  List<TaskItem> dismissedTasks = const [],
}) async {
  final color = member != null ? personColor(member) : AppColors.textSecondary;
  final end = event.end;
  final timeText = event.allDay
      ? 'All day'
      : (end != null && end.isAfter(event.start)
            ? friendlyRange(event.start, end)
            : friendlyTime(event.start));

  final location = event.location;
  final description = event.description;
  final hasLocation = location != null && location.isNotEmpty;
  final hasDescription = description != null && description.isNotEmpty;
  // Only events we mirror out can carry a travel block, and only if they have
  // somewhere to go. A human event already lives on the target calendar with
  // whatever travel time its owner gave it there.
  final canSetTravel = !event.isHuman && hasLocation;

  final name = member?.relationName ?? 'This member';
  final dismissed = dismissedTasks.length;
  final reason = switch (event.taskIneligibleReason) {
    'paused' =>
      "$name's events don't generate family tasks, so there's nothing to claim "
          'here. An admin can turn that back on from $name in Family.',
    'busy_calendar' =>
      "This came from a calendar linked as free/busy, so it's only blocking "
          "$name's availability — those blocks never generate tasks. Switch "
          'that feed off "busy" mode to have its events typed.',
    'claimed' => 'This event is already a claimed task.',
    // Eligible, so the tasks were dismissed or never built — both rebuildable.
    _ =>
      dismissed > 0
          ? 'Its ${dismissed == 1 ? 'task is' : '$dismissed tasks are'} marked not '
                'needed. Marking one not needed sticks, so rebuild to put this '
                'event back in the claim queue.'
          : 'This event has no tasks right now, though it should generate them. '
                'Rebuild to run it back through '
                '${member == null ? 'the' : "$name's"} task rules.',
  };

  await showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetCtx) => SafeArea(
      child: SingleChildScrollView(
        // Keyboard-aware: the travel-time field lifts the sheet above it.
        padding: EdgeInsets.fromLTRB(
          22,
          4,
          22,
          28 + MediaQuery.of(sheetCtx).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                IconTile(icon: Icons.event_rounded, color: color, size: 44),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        member == null
                            ? event.displaySummary
                            : '${event.displaySummary} · ${member.relationName}',
                        style: AppText.sectionItemTitle,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '$timeText${event.isHuman ? ' · manual' : ''}',
                        style: AppText.subtitle,
                      ),
                    ],
                  ),
                ),
              ],
            ),
            if (hasLocation || hasDescription) ...[
              const SizedBox(height: 14),
              if (hasLocation)
                _DetailRow(icon: Icons.location_on_outlined, text: location),
              if (hasLocation && hasDescription) const SizedBox(height: 8),
              if (hasDescription)
                _DetailRow(icon: Icons.notes_rounded, text: description),
            ],
            // Travel time is a property of the trip *out to the target calendar*,
            // so it's offered on the events we mirror — above all a claim, which
            // is somebody's actual journey.
            if (canSetTravel) ...[
              const SizedBox(height: 20),
              Text('TRAVEL TIME', style: AppText.eyebrow()),
              const SizedBox(height: 10),
              _TravelTimeField(
                event: event,
                onSubmit: (minutes) {
                  Navigator.of(sheetCtx).pop();
                  _run(
                    context,
                    ref,
                    (api, fid) =>
                        api.setEventTravelTime(fid, event.id, minutes),
                    minutes == null
                        ? 'Back to the estimate'
                        : 'Travel time updated',
                  );
                },
              ),
            ],
            const SizedBox(height: 18),
            _DetailRow(icon: Icons.info_outline_rounded, text: reason),
            // Only an eligible event can be rebuilt — for the three rule cases
            // there's nothing this sheet could do that wouldn't be a lie.
            if (event.canHaveTasks) ...[
              const SizedBox(height: 18),
              AppCard(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 4,
                ),
                child: _ActionRow(
                  icon: Icons.restore_rounded,
                  iconColor: AppColors.indigo,
                  label: dismissed > 0
                      ? 'Restore ${dismissed == 1 ? 'its task' : 'its $dismissed tasks'}'
                      : "Rebuild this event's tasks",
                  onTap: () {
                    Navigator.of(sheetCtx).pop();
                    _run(
                      context,
                      ref,
                      (api, fid) => api.rebuildEventTasks(fid, event.id),
                      dismissed > 0
                          ? 'Back in the claim queue'
                          : 'Tasks rebuilt',
                    );
                  },
                ),
              ),
            ],
          ],
        ),
      ),
    ),
  );
}

/// Pick everyone going to an attendance event. Unlike the single-caretaker
/// picker below, this one is a multi-select — an attendance task can be covered
/// by several caretakers at once (both parents at the recital), and each of them
/// gets their own copy of the event on their calendar.
///
/// The set is submitted whole, so unchecking someone steps them off; clearing it
/// entirely releases the task back to the claim queue.
Future<void> _pickAttendees(
  BuildContext context,
  WidgetRef ref,
  TaskItem task,
  List<Member> caretakers,
) async {
  final picked = {...task.ownerMemberIds};
  await showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    useRootNavigator: true,
    showDragHandle: true,
    builder: (sheetCtx) => SafeArea(
      child: StatefulBuilder(
        builder: (ctx, setSheetState) => SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Who’s going', style: AppText.subPageTitle),
              const SizedBox(height: 4),
              Text(
                'Everyone you pick gets it on their own calendar.',
                style: AppText.subtitle,
              ),
              const SizedBox(height: 12),
              for (final m in caretakers)
                InkWell(
                  onTap: () => setSheetState(() {
                    if (!picked.remove(m.id)) picked.add(m.id);
                  }),
                  borderRadius: BorderRadius.circular(14),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Row(
                      children: [
                        PersonAvatar(
                          initial: initialFor(m.relationName),
                          color: personColor(m),
                          size: 40,
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Text(
                            m.relationName,
                            style: AppText.sectionItemTitle,
                          ),
                        ),
                        Icon(
                          picked.contains(m.id)
                              ? Icons.check_circle_rounded
                              : Icons.circle_outlined,
                          color: picked.contains(m.id)
                              ? AppColors.indigo
                              : AppColors.textSecondary,
                        ),
                      ],
                    ),
                  ),
                ),
              const SizedBox(height: 18),
              PillButton(
                label: 'Save',
                onPressed: () {
                  final chosen = picked.toList();
                  Navigator.of(sheetCtx).pop();
                  _run(
                    context,
                    ref,
                    (api, fid) => chosen.isEmpty
                        ? api.unassignTask(fid, task.id)
                        : api.assignTask(fid, task.id, memberIds: chosen),
                    switch (chosen.length) {
                      0 => 'Returned to the queue',
                      1 => 'Assigned',
                      _ => '${chosen.length} going',
                    },
                  );
                },
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

/// Pick a caretaker to (re)assign the scope's tasks to. Hides a caretaker only
/// when they already own every task in the scope (nothing to move to them).
Future<void> _pickAndAssign(
  BuildContext context,
  WidgetRef ref,
  List<TaskItem> scope,
  List<Member> caretakers,
) async {
  final options = caretakers
      .where(
        (m) => !scope.every(
          (t) => t.ownerMemberIds.length == 1 && t.ownerMemberIds.first == m.id,
        ),
      )
      .toList();
  await showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    useRootNavigator: true,
    showDragHandle: true,
    builder: (sheetCtx) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Assign to', style: AppText.subPageTitle),
            const SizedBox(height: 12),
            for (final m in options)
              InkWell(
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  _runScope(
                    context,
                    ref,
                    scope,
                    (api, fid, t) => api.assignTask(fid, t.id, memberId: m.id),
                    'Assigned to ${m.relationName}',
                  );
                },
                borderRadius: BorderRadius.circular(14),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Row(
                    children: [
                      PersonAvatar(
                        initial: initialFor(m.relationName),
                        color: personColor(m),
                        size: 40,
                      ),
                      const SizedBox(width: 14),
                      Text(m.relationName, style: AppText.sectionItemTitle),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    ),
  );
}

Future<void> _run(
  BuildContext context,
  WidgetRef ref,
  Future<void> Function(dynamic api, String familyId) action,
  String success,
) async {
  try {
    final familyId = await ref.read(familyProvider.future);
    await action(ref.read(apiClientProvider), familyId);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
    // Claims move events between calendars (the recursion) — refresh Plan too.
    ref.invalidate(calendarEventsProvider);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(success),
          margin: snackBarMarginAboveNav(context),
        ),
      );
    }
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Failed: $e'),
          margin: snackBarMarginAboveNav(context),
        ),
      );
    }
  }
}

/// Run a per-task [action] across every task in a scope (a Plan block's group),
/// then refresh once. A single snackbar reports the whole batch.
Future<void> _runScope(
  BuildContext context,
  WidgetRef ref,
  Iterable<TaskItem> tasks,
  Future<void> Function(dynamic api, String familyId, TaskItem task) action,
  String success,
) async {
  try {
    final familyId = await ref.read(familyProvider.future);
    final api = ref.read(apiClientProvider);
    for (final t in tasks) {
      await action(api, familyId, t);
    }
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
    // Claims move events between calendars (the recursion) — refresh Plan too.
    ref.invalidate(calendarEventsProvider);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(success),
          margin: snackBarMarginAboveNav(context),
        ),
      );
    }
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('Failed: $e'),
          margin: snackBarMarginAboveNav(context),
        ),
      );
    }
  }
}

/// The window length for a single transition (pickup / drop-off) task, picked
/// off a wheel. The value is signed minutes measured from the task's anchor —
/// the parent event's start (drop-off) or end (pickup) — and the sign is picked
/// as a direction rather than typed as a minus.
class _DurationField extends StatelessWidget {
  const _DurationField({
    required this.task,
    required this.showLabel,
    required this.onSubmit,
  });

  final TaskItem task;
  final bool showLabel;
  final ValueChanged<int> onSubmit;

  /// The clock point the window hangs off of, in words.
  String get _anchorWord => task.type == 'dropoff' ? 'start' : 'end';

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (showLabel) ...[
          Text(task.typeLabel, style: AppText.subtitle),
          const SizedBox(height: 6),
        ],
        DurationPickerField(
          label: showLabel ? '${task.typeLabel} window' : 'Task window',
          minutes: task.signedDurationMin,
          directions: (
            forward: 'after $_anchorWord',
            backward: 'before $_anchorWord',
          ),
          onChanged: onSubmit,
        ),
        const SizedBox(height: 6),
        Text(
          'How long the window runs, measured from the event $_anchorWord.',
          style: AppText.subtitle,
        ),
      ],
    );
  }
}

/// The travel-time override on an event: how long getting there takes, in
/// minutes, written straight onto the event that mirrors out.
///
/// The backend estimates this from where the caretaker is coming from — the
/// last place their calendar accounts for, or their home address — which is a
/// guess about distance and traffic made without a routing service. Someone who
/// knows the run takes 25 minutes says so here and that stands. Clearing the
/// field hands it back to the estimate; `0` says this trip needs no travel time.
class _TravelTimeField extends StatelessWidget {
  const _TravelTimeField({
    required this.event,
    required this.onSubmit,
    this.label,
  });

  final CalendarEventItem event;

  /// Names the edge when a scope holds both (a Plan block tap); null for one.
  final String? label;

  /// Minutes, or null to drop the override and go back to the estimate.
  final ValueChanged<int?> onSubmit;

  @override
  Widget build(BuildContext context) {
    final overridden = event.travelTimeOverrideMin != null;
    final location = event.location;
    // Apple hangs travel time off the event's location, so without one there's
    // nothing to reserve time *to* — say so rather than offering a dead field.
    if (location == null || location.isEmpty) {
      return Text(
        'This one has no location, so there\'s nowhere to travel to. Give the '
        'event a place and travel time follows.',
        style: AppText.subtitle,
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (label != null) ...[
          Text(label!, style: AppText.subtitle),
          const SizedBox(height: 6),
        ],
        DurationPickerField(
          label: 'Travel time',
          minutes: event.travelTimeOverrideMin,
          emptyLabel: 'Estimated',
          onChanged: onSubmit,
          onCleared: () => onSubmit(null),
          clearTooltip: 'Back to the estimate',
        ),
        const SizedBox(height: 6),
        Text(
          overridden
              ? 'Your own number, used as-is. Clear it to go back to the '
                    'estimate; 0 means no travel time on this one.'
              : 'Estimated from wherever you\'re coming from. Pick a length to '
                    'override it; 0 means no travel time on this one.',
          style: AppText.subtitle,
        ),
      ],
    );
  }
}

/// Names the assignment rule(s) that auto-claimed the task(s) in scope, so the
/// owner reads as "a rule did this, and here's which one" rather than as a
/// human claim. Rules are readable by any family member, so this renders for
/// caretakers and admins alike; it degrades to the generic line while the rule
/// set is still loading (or if it fails to load).
class _AutoAssignedNote extends ConsumerWidget {
  const _AutoAssignedNote({required this.ruleIds});

  final Set<String> ruleIds;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ruleSet = ref.watch(assignmentRulesProvider).valueOrNull;
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final feeds = ref.watch(feedsProvider).valueOrNull ?? const <FeedItem>[];

    final matched = (ruleSet?.rules ?? const <AssignmentRule>[])
        .where((r) => ruleIds.contains(r.id))
        .toList();

    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: AppColors.indigo.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.indigo.withValues(alpha: 0.35)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.bolt_rounded, size: 16, color: AppColors.indigo),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Assigned automatically',
                  style: font(kBodyFont, 12.5, 700, color: AppColors.indigo),
                ),
                const SizedBox(height: 3),
                if (matched.isEmpty)
                  Text(
                    // The rule was deleted or edited out from under the task —
                    // the claim stands, we just can't name its source.
                    ruleSet == null
                        ? 'Looking up the rule…'
                        : 'By an assignment rule that no longer exists.',
                    style: AppText.subtitle,
                  )
                else
                  for (final r in matched)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 2),
                      child: Text(
                        'By “${describeRule(r, members, feeds, ruleSet?.links ?? const <AssignmentLink>[])}”',
                        style: AppText.subtitle,
                      ),
                    ),
                const SizedBox(height: 3),
                Text(
                  'Claiming or unassigning by hand overrides the rule.',
                  style: font(
                    kBodyFont,
                    11,
                    500,
                    color: AppColors.textTertiary,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// One line of event detail (location / description) under the header — a
/// small leading icon plus wrapping text.
class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 16, color: AppColors.textSecondary),
        const SizedBox(width: 8),
        Expanded(child: Text(text, style: AppText.subtitle)),
      ],
    );
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({
    required this.icon,
    required this.iconColor,
    required this.label,
    required this.onTap,
    this.destructive = false,
  });

  final IconData icon;
  final Color iconColor;
  final String label;
  final VoidCallback onTap;
  final bool destructive;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            Icon(icon, color: iconColor, size: 22),
            const SizedBox(width: 14),
            Text(
              label,
              style: font(
                kBodyFont,
                14.5,
                600,
                color: destructive ? AppColors.coral : AppColors.textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
