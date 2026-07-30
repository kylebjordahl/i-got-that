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
import 'conflict_resolution_sheet.dart';
import 'task_actions_sheet.dart';

const _hourPx = 42.0;
const _labelWidth = 46.0;
// Edge-tab (drop-off / pick-up) height — snug around the compact label + owner
// avatar; tabs straddle their block's edge by half this and stack by the full.
const _tabHeight = 24.0;
// Left indentation for edge tabs so they don't flush-align with the block
// underneath — 1.5x the tab's pill corner radius (half its height).
const _tabLeftInset = _tabHeight / 2 * 1.5;
// A block shorter than this can't give half a tab's height to a straddling edge
// tab without the tab covering its label, so its tabs sit fully outside instead.
const _tabStraddleMinHeight = 46.0;
// Horizontal gap between two side-by-side blocks (and a block's right edge).
const _blockGap = 6.0;
// However crowded the lane gets, a block never renders narrower than this: past
// that point the columns stop shrinking and start overlapping (each still offset
// from the last, so every block keeps a strip of its own to show and be tapped).
const _minBlockWidth = 96.0;
// A block wholly inside a longer one cascades on top of it — inset from its
// host's left edge by this fraction of the lane, the way iOS Calendar layers a
// midday appointment over the school day instead of halving the lane.
const _nestIndent = 0.045;
// ...but only when the host keeps at least this much of its own top edge clear:
// that strip carries the host's label and is what's left of it to tap.
const _nestHeaderPx = 20.0;
// How deep the cascade goes before a contained event takes a column instead.
const _maxNestDepth = 3;
// The grid always shows at least this window, then expands to fit the day's
// events (and the now-line) so nothing is clipped — the page scrolls to reveal
// the extra hours.
const _defaultStartHour = 7;
const _defaultEndHour = 19; // 7 PM
// A block is only ever as tall as its real duration — short segments are no
// longer inflated to a fixed height (which overlapped their neighbours on the
// split calendars from #98). The only floor left is one label line, so even a
// brief block still says what it is and stays comfortably tappable.
const _minBlockHeight = 26.0;
// A block's label metrics: the description's line, the time's line under it,
// the attendee avatars riding on the description's line, and the padding around
// the lot. Kept here because the layout has to know how much a block can say
// before it decides what to give it.
// The pinned all-day row above the grid: its pills' avatars, and how tall the
// row grows before it scrolls instead of eating the grid's height (~3 rows).
const _allDayAvatarSize = 17.0;
const _allDayRowMaxHeight = 104.0;
const _titleLineH = 15.0;
const _timeLineH = 13.0;
const _avatarSize = 18.0;
const _lineGap = 1.0;
const _blockPadV = 4.0;
const _blockPadH = 10.0;
// Minimum fling speed (logical px/s) for a horizontal grid drag to count as a
// day-change swipe rather than an incidental sideways wobble.
const _swipeVelocityThreshold = 250.0;

/// One item on the Plan grid: a unified-calendar event (synthesized / human /
/// claimed — colored by whose calendar it's on) or an unowned task (dashed).
class _PlanItem {
  _PlanItem.event(CalendarEventItem this.event) : task = null;
  _PlanItem.task(TaskItem this.task) : event = null;

  final CalendarEventItem? event;
  final TaskItem? task;

  bool get isEvent => event != null;
  String get memberId => event?.familyMemberId ?? task!.familyMemberId;
  DateTime get start => event?.start ?? task!.start;
  DateTime? get end => event?.end ?? task!.end;
}

/// Plan — an iOS-Calendar-style day view of every member's unified calendar.
/// Kids and caretakers each have a calendar chip; a claimed task shows up as an
/// event on the claimer's calendar (the recursion, visible), and unclaimed
/// tasks render hatched. Tapping any block or tab opens its management sheet —
/// or, when the event has no tasks to manage, its own details sheet.
class PlanScreen extends ConsumerStatefulWidget {
  const PlanScreen({super.key});

  @override
  ConsumerState<PlanScreen> createState() => _PlanScreenState();
}

class _PlanScreenState extends ConsumerState<PlanScreen> {
  // The current calendar day, recomputed live on every read so navigation (the
  // "Today" button, the day strip's today marker) stays correct even when the
  // page is left open past midnight. A cached value would freeze at the day the
  // page was first built.
  DateTime get _today => _dateOnly(DateTime.now());
  late DateTime _selected = _today;

  // Which way the grid should slide on the next day change: +1 (new day
  // enters from the right, as on a forward swipe) or -1 (enters from the
  // left). Set right before `_selected` changes so the transition matches
  // the swipe/tap direction that caused it.
  int _slideDirection = 1;
  int _dirTo(DateTime d) =>
      d.isAfter(_selected) ? 1 : (d.isBefore(_selected) ? -1 : _slideDirection);

  // Filters are stored as *exclusions* (empty ⇒ show all): a chip is selected
  // when it's NOT in the set, so a category only constrains once you deselect
  // something. `_exOwners` uses caretaker ids + the sentinel `__unowned__`;
  // `_exTypes` uses the groups 'transition' / 'attendance'.
  final Set<String> _exChildren = {};
  final Set<String> _exOwners = {};
  final Set<String> _exTypes = {};
  bool _showCompleted = false;
  bool _onlyMyKids = false;
  bool _refreshingFeeds = false;

  // The visible hour window for the current day (computed each build).
  int _gridStart = _defaultStartHour;
  int _gridEnd = _defaultEndHour;
  double get _gridHeight => (_gridEnd - _gridStart) * _hourPx;

  // The time grid scrolls internally (the day chips stay put). It opens showing
  // the default 7 AM–6 PM window even when the grid has expanded to earlier hours.
  final ScrollController _gridScroll = ScrollController();
  String? _scrolledKey;

  /// Scroll the grid so [_defaultStartHour] (7 AM) sits at the top of the window.
  /// Keyed on the day *and* the computed range so it re-defaults once the day's
  /// tasks finish loading (the first, empty build has no early hours yet).
  void _scheduleDefaultScroll() {
    final key = '$_selected|$_gridStart';
    if (_scrolledKey == key) return;
    _scrolledKey = key;
    final target = ((_defaultStartHour - _gridStart).clamp(0, 24)) * _hourPx;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_gridScroll.hasClients) return;
      _gridScroll.jumpTo(target.clamp(0.0, _gridScroll.position.maxScrollExtent));
    });
  }

  /// Expand the default window to fit every item on the day (+ the now-line),
  /// so nothing is clipped and the whole day is reachable by scrolling.
  void _computeRange(List<_PlanItem> dayItems) {
    var start = _defaultStartHour;
    var end = _defaultEndHour;
    for (final it in dayItems) {
      final l = it.start.toLocal();
      if (l.hour < start) start = l.hour;
      final endL = it.end?.toLocal();
      final endH = endL != null && endL.isAfter(l) ? endL.hour + 1 : l.hour + 1;
      if (endH > end) end = endH;
    }
    final now = DateTime.now();
    if (_selected == _dateOnly(now)) {
      if (now.hour < start) start = now.hour;
      if (now.hour + 1 > end) end = now.hour + 1;
    }
    _gridStart = start.clamp(0, 23);
    _gridEnd = end.clamp(_gridStart + 1, 24);
  }

  // The day scroller is an effectively-infinite lazy list centred on [_today]:
  // index [_dayAnchor] is today, and it opens scrolled so today sits 3rd.
  static const _dayTileExtent = 58.0; // 50px chip + 8px gap
  static const _dayAnchor = 10000;
  late final ScrollController _dayScroll =
      ScrollController(initialScrollOffset: (_dayAnchor - 2) * _dayTileExtent);

  static DateTime _dateOnly(DateTime d) => DateTime(d.year, d.month, d.day);

  @override
  void dispose() {
    _dayScroll.dispose();
    _gridScroll.dispose();
    super.dispose();
  }

  int get _filterCount =>
      (_exChildren.isNotEmpty ? 1 : 0) +
      (_exOwners.isNotEmpty ? 1 : 0) +
      (_exTypes.isNotEmpty ? 1 : 0) +
      (_onlyMyKids ? 1 : 0);

  bool _passesFilter(TaskItem t, Set<String> myKids) {
    if (_exChildren.contains(t.familyMemberId)) return false;
    if (_exOwners.contains(t.ownerMemberId ?? '__unowned__')) return false;
    final group = t.type == 'attendance' ? 'attendance' : 'transition';
    if (_exTypes.contains(group)) return false;
    if (_onlyMyKids && !myKids.contains(t.familyMemberId)) return false;
    return true;
  }

  Future<void> _refreshFeeds() async {
    setState(() => _refreshingFeeds = true);
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).refreshAllFeeds(familyId);
      ref.invalidate(allTasksProvider);
      ref.invalidate(unownedTasksProvider);
      ref.invalidate(calendarEventsProvider);
      ref.invalidate(pendingDecisionsProvider);
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

  @override
  Widget build(BuildContext context) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final byId = {for (final m in members) m.id: m};
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final rawTasks = ref.watch(allTasksProvider).valueOrNull ?? const <TaskItem>[];
    final events =
        ref.watch(calendarEventsProvider).valueOrNull ?? const <CalendarEventItem>[];
    final eventsById = {for (final e in events) e.id: e};
    // Children I'm covering (for the "only my kids" filter): kids with a task I own.
    final myKids = {
      for (final t in rawTasks)
        if (t.ownerMemberId == me?.id) t.familyMemberId
    };
    final allTasks = [
      for (final t in rawTasks)
        if (_showCompleted || !t.isDismissed) t
    ];

    bool taskVisible(TaskItem t) =>
        dayKey(t.start) == _selected &&
        !_exChildren.contains(t.familyMemberId) &&
        _passesFilter(t, myKids);

    // Drop-off / pick-up tasks (claimed or not) attach to their source event as
    // edge tabs rather than taking their own grid column (6c).
    final tabsByEvent = <String, List<TaskItem>>{};
    // Transitions with no source event (e.g. a manual pick-up) can't attach to a
    // block, so they float standalone at their time.
    final looseTransitions = <TaskItem>[];
    for (final t in allTasks) {
      if (t.type == 'attendance') continue;
      if (!taskVisible(t)) continue;
      if (t.calendarEventId == null) {
        looseTransitions.add(t);
      } else {
        (tabsByEvent[t.calendarEventId!] ??= []).add(t);
      }
    }
    for (final list in tabsByEvent.values) {
      list.sort((a, b) => a.start.compareTo(b.start));
    }

    // Attendee avatars on an event = the child whose calendar it's on plus any
    // caretaker who has claimed the *attendance* task generated from it. A
    // claimed drop-off/pick-up only ever adds the claimant's avatar to its own
    // edge tab (below) — the actual attendee at the event is still just the
    // child, so a pickup/dropoff claim must not add a badge to the block.
    final ownersByEvent = <String, List<Member>>{};
    for (final t in rawTasks) {
      if (t.status != 'owned' || t.calendarEventId == null) continue;
      if (t.type != 'attendance') continue;
      final owner = byId[t.ownerMemberId];
      if (owner == null) continue;
      final list = ownersByEvent[t.calendarEventId!] ??= [];
      if (!list.any((m) => m.id == owner.id)) list.add(owner);
    }

    // An unowned attendance task's own block stands in for its source event
    // (below) so tapping it manages the task — rendering the source event too
    // would duplicate it (the real "Fiddle practice" event plus a second,
    // generic "Attendance" block for the same time).
    final unownedAttendanceEventIds = {
      for (final t in allTasks)
        if (t.isUnowned && t.type == 'attendance' && taskVisible(t) && t.calendarEventId != null)
          t.calendarEventId!
    };

    // Blocks: calendar events (minus every claimed-task event and every event
    // already represented by an unowned attendance task below) + unowned
    // attendance tasks. A claimed task already shows up on its *source* event —
    // as an owner avatar on that block (attendance) or a solid edge tab
    // (transition) — so rendering the claimer's mirrored copy too would
    // duplicate it (two "Fiddle practice" blocks for one claimed practice).
    //
    // All-day events don't take a lane at all: a holiday or an "initial
    // parental leave" spanning midnight to midnight isn't a thing that happens
    // *at* a time, and drawing it as a 24-hour block stretched the grid over the
    // whole day and pushed every real appointment into a sliver beside it. They
    // ride in the pinned all-day row above the grid instead, on every day they
    // cover. Any transitions they generate still land on the grid at their own
    // time (as standalone tags, via `orphanTabs` below).
    final dayItems = <_PlanItem>[];
    final allDayItems = <_PlanItem>[];
    bool eventVisible(CalendarEventItem e) =>
        !_exChildren.contains(e.familyMemberId) &&
        !_exOwners.contains(e.familyMemberId) &&
        (!_onlyMyKids || myKids.contains(e.familyMemberId)) &&
        !e.isClaimedTask &&
        !unownedAttendanceEventIds.contains(e.id);
    for (final e in events) {
      if (!eventVisible(e)) continue;
      if (e.allDay) {
        if (e.coversDay(_selected)) allDayItems.add(_PlanItem.event(e));
      } else if (dayKey(e.start) == _selected) {
        dayItems.add(_PlanItem.event(e));
      }
    }
    for (final t in allTasks) {
      if (!t.isUnowned || t.type != 'attendance' || !taskVisible(t)) continue;
      // An unowned attendance task stands in for its source event, so it goes
      // wherever that event would have gone.
      final src = t.calendarEventId == null ? null : eventsById[t.calendarEventId];
      (src != null && src.allDay ? allDayItems : dayItems).add(_PlanItem.task(t));
    }
    final blockEventIds = {
      for (final it in dayItems)
        if (it.isEvent) it.event!.id
    };
    // Tabs whose source event isn't on the grid (plus the loose transitions)
    // render standalone at their time.
    final orphanTabs = <TaskItem>[
      ...looseTransitions,
      for (final entry in tabsByEvent.entries)
        if (!blockEventIds.contains(entry.key)) ...entry.value
    ];

    // Range must cover the tab times too, not just the block times.
    _computeRange([
      ...dayItems,
      for (final t in looseTransitions) _PlanItem.task(t),
      for (final list in tabsByEvent.values)
        for (final t in list) _PlanItem.task(t),
    ]);
    final placed = _layout(dayItems);

    // Double-booked indicators (§8a): a coral collision seam + pulsing chip over
    // each pending conflict whose overlap lands on the selected day. Hidden for a
    // member the current filters have hidden — the seam must never float over an
    // empty lane. All-day / open-ended overlaps have no timeline seam.
    final conflicts = ref.watch(conflictsProvider).valueOrNull ?? const <Conflict>[];
    final conflictOverlays = <_ConflictOverlay>[];
    for (final cf in conflicts) {
      final fmId = cf.familyMemberId;
      if (_exChildren.contains(fmId) || _exOwners.contains(fmId)) continue;
      if (_onlyMyKids && !myKids.contains(fmId)) continue;
      final le = cf.loser.end;
      final we = cf.winner.end;
      if (cf.loser.allDay || cf.winner.allDay || le == null || we == null) continue;
      final ls = cf.loser.start;
      final ws = cf.winner.start;
      final oStart = ls.isAfter(ws) ? ls : ws;
      final oEnd = le.isBefore(we) ? le : we;
      if (!oEnd.isAfter(oStart)) continue;
      if (dayKey(oStart) != _selected) continue;
      conflictOverlays.add(_ConflictOverlay(
        conflict: cf,
        member: byId[fmId],
        start: oStart,
        end: oEnd,
      ));
    }

    // Default the grid's scroll to the 7 AM–6 PM window (once per day change).
    _scheduleDefaultScroll();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(22, 14, 22, 0),
          child: _header(),
        ),
        const SizedBox(height: 16),
        Padding(
          padding: const EdgeInsets.only(left: 22),
          child: _dayScroller(allTasks, byId),
        ),
        const SizedBox(height: 16),
        // All-day events sit in their own pinned row above the grid, never as
        // blocks down it.
        if (allDayItems.isNotEmpty)
          _allDayRow(allDayItems, byId, ownersByEvent, eventsById),
        // The time grid scrolls on its own; the day chips above stay fixed. The
        // amber edge glows flag events scrolled out of view above/below. A
        // horizontal swipe over the grid steps the selected day ± 1, alongside
        // the vertical drag the ScrollView already claims for its own axis.
        Expanded(
          child: GestureDetector(
            behavior: HitTestBehavior.translucent,
            onHorizontalDragEnd: (details) {
              final v = details.primaryVelocity ?? 0.0;
              if (v.abs() < _swipeVelocityThreshold) return;
              _shiftDay(v < 0 ? 1 : -1);
            },
            child: Stack(
              children: [
                SingleChildScrollView(
                  controller: _gridScroll,
                  padding: const EdgeInsets.fromLTRB(22, 0, 22, 130),
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 260),
                    switchInCurve: Curves.easeOutCubic,
                    switchOutCurve: Curves.easeOutCubic,
                    transitionBuilder: (child, animation) {
                      final incoming = child.key == ValueKey(_selected);
                      final dx = (incoming ? _slideDirection : -_slideDirection).toDouble();
                      return SlideTransition(
                        position: Tween<Offset>(begin: Offset(dx, 0), end: Offset.zero)
                            .animate(animation),
                        child: child,
                      );
                    },
                    layoutBuilder: (currentChild, previousChildren) => Stack(
                      alignment: Alignment.topCenter,
                      children: [
                        ...previousChildren,
                        if (currentChild != null) currentChild,
                      ],
                    ),
                    child: KeyedSubtree(
                      key: ValueKey(_selected),
                      child: _grid(placed, byId, tabsByEvent, ownersByEvent,
                          orphanTabs, eventsById, conflictOverlays),
                    ),
                  ),
                ),
                _EdgeGlow(controller: _gridScroll, placed: placed, top: true),
                _EdgeGlow(controller: _gridScroll, placed: placed, top: false),
              ],
            ),
          ),
        ),
      ],
    );
  }

  void _goToToday() {
    setState(() {
      _slideDirection = _dirTo(_today);
      _selected = _today;
      _scrolledKey = null; // re-default the grid scroll to 7 AM
    });
    if (_dayScroll.hasClients) {
      _dayScroll.animateTo(
        (_dayAnchor - 2) * _dayTileExtent,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOutCubic,
      );
    }
  }

  /// Step the selected day by [delta] (±1) — the grid's left/right swipe
  /// gesture. Mirrors tapping a day chip, then nudges the day strip into view
  /// if the swipe walked the selection off its visible range.
  void _shiftDay(int delta) {
    setState(() {
      _slideDirection = delta;
      _selected = _selected.add(Duration(days: delta));
    });
    _keepSelectedDayChipVisible();
  }

  void _keepSelectedDayChipVisible() {
    if (!_dayScroll.hasClients) return;
    final idx = _dayAnchor + _selected.difference(_today).inDays;
    final chipStart = idx * _dayTileExtent;
    final chipEnd = chipStart + _dayTileExtent;
    final viewport = _dayScroll.position.viewportDimension;
    final viewStart = _dayScroll.offset;
    final viewEnd = viewStart + viewport;
    if (chipStart >= viewStart && chipEnd <= viewEnd) return;
    // Land the new chip one tile in from whichever edge it crossed, so the
    // next day over stays visible as a hint there's more to swipe to.
    final target = chipStart < viewStart
        ? chipStart - _dayTileExtent
        : chipEnd - viewport + _dayTileExtent;
    _dayScroll.animateTo(
      target.clamp(0.0, _dayScroll.position.maxScrollExtent),
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOutCubic,
    );
  }

  Widget _header() {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Plan', style: AppText.screenTitle),
              const SizedBox(height: 3),
              Text(longDateComma(_selected), style: AppText.subtitle),
            ],
          ),
        ),
        _PillIconButton(icon: Icons.schedule_rounded, label: 'Today', onTap: _goToToday),
        const SizedBox(width: 8),
        FiltersButton(count: _filterCount, onTap: () => _openFilters(caretakersFor())),
        const SizedBox(width: 8),
        RefreshFeedsButton(busy: _refreshingFeeds, onTap: _refreshFeeds, size: 36),
      ],
    );
  }

  List<Member> caretakersFor() =>
      (ref.read(membersProvider).valueOrNull ?? const <Member>[])
          .where((m) => m.isCaretaker)
          .toList();

  Widget _dayScroller(List<TaskItem> allTasks, Map<String, Member> byId) {
    final byDay = <DateTime, List<TaskItem>>{};
    for (final t in allTasks) {
      (byDay[dayKey(t.start)] ??= []).add(t);
    }
    return SizedBox(
      height: 78,
      child: ListView.builder(
        controller: _dayScroll,
        scrollDirection: Axis.horizontal,
        itemExtent: _dayTileExtent,
        itemCount: _dayAnchor * 2, // ±27 years — lazily built, effectively infinite
        itemBuilder: (_, i) {
          final d = _today.add(Duration(days: i - _dayAnchor));
          final dots = <Color>[
            for (final t in (byDay[d] ?? const <TaskItem>[]).take(3))
              t.ownerMemberId != null && byId[t.ownerMemberId] != null
                  ? personColor(byId[t.ownerMemberId]!)
                  : AppColors.amberHero,
          ];
          return Padding(
            padding: const EdgeInsets.only(right: 8),
            child: _DayChip(
              weekday: weekdayShort(d),
              day: d.day,
              active: d == _selected,
              isToday: d == _today,
              dots: dots,
              onTap: () => setState(() {
                _slideDirection = _dirTo(d);
                _selected = d;
              }),
            ),
          );
        },
      ),
    );
  }

  /// The source child a block belongs to (the claimer's calendar for a claimed
  /// event still traces back to the child the task is about).
  Member? _childOf(_PlanItem it, Map<String, Member> byId) {
    if (it.isEvent) {
      final e = it.event!;
      final id = e.isClaimedTask ? _taskFor(e)?.familyMemberId : e.familyMemberId;
      return byId[id];
    }
    return byId[it.task!.familyMemberId];
  }

  String? _eventIdOf(_PlanItem it) =>
      it.isEvent ? it.event!.id : it.task!.calendarEventId;

  /// Who's at an item: the child whose calendar it's on, plus any caretaker who
  /// has claimed the *attendance* task generated from it.
  List<Member> _attendeesOf(_PlanItem it, Map<String, Member> byId,
      Map<String, List<Member>> ownersByEvent) {
    final res = <Member>[];
    final child = _childOf(it, byId);
    if (child != null) res.add(child);
    final eid = _eventIdOf(it);
    if (eid != null) {
      for (final o in ownersByEvent[eid] ?? const <Member>[]) {
        if (!res.any((m) => m.id == o.id)) res.add(o);
      }
    }
    return res;
  }

  /// Every (non-dismissed) task an item's event generated — the drop-off,
  /// pick-up and/or attendance the block manages as one. Falls back to the
  /// item's own task when it isn't tied to a calendar event (a manual task).
  List<TaskItem> _groupTasksFor(_PlanItem it) {
    final eid = _eventIdOf(it);
    if (eid == null) return it.task != null ? [it.task!] : const [];
    final all = ref.read(allTasksProvider).valueOrNull ?? const <TaskItem>[];
    final group =
        all.where((t) => t.calendarEventId == eid && !t.isDismissed).toList();
    if (group.isEmpty && it.task != null) return [it.task!];
    return group;
  }

  /// The event's tasks that were marked not needed — what the details sheet
  /// offers to restore when an event has nothing live left to claim.
  List<TaskItem> _dismissedTasksFor(_PlanItem it) {
    final eid = _eventIdOf(it);
    if (eid == null) return const [];
    final all = ref.read(allTasksProvider).valueOrNull ?? const <TaskItem>[];
    return all.where((t) => t.calendarEventId == eid && t.isDismissed).toList();
  }

  /// The task that best represents a group in the actions sheet header —
  /// the attendance one if present, else the first transition.
  TaskItem _repTask(List<TaskItem> group) =>
      group.firstWhere((t) => t.type == 'attendance', orElse: () => group.first);

  /// What tapping an item — a grid block or an all-day pill — opens: the sheet
  /// that manages every task its event generates (switch the type, (re)assign
  /// the drop-off and pick-up as one). An item with no live tasks (a
  /// caretaker's calendar doesn't generate them; an event's tasks may all have
  /// been marked not needed) opens its own details sheet instead, so everything
  /// on Plan answers a tap.
  void _openItem(
      _PlanItem it, CalendarEventItem? sourceEvent, Map<String, Member> byId) {
    final group = _groupTasksFor(it);
    if (group.isNotEmpty) {
      showTaskActions(context, ref, _repTask(group),
          scopeTasks: group, sourceEvent: sourceEvent);
    } else if (sourceEvent != null) {
      showEventDetails(context, ref, sourceEvent,
          member: _childOf(it, byId), dismissedTasks: _dismissedTasksFor(it));
    }
  }

  /// The pinned all-day row: everything that covers the whole selected day,
  /// as pills above the grid rather than blocks down it (iOS Calendar's shape).
  /// Nothing all-day ⇒ no row, so an ordinary day loses no height to it.
  Widget _allDayRow(
    List<_PlanItem> items,
    Map<String, Member> byId,
    Map<String, List<Member>> ownersByEvent,
    Map<String, CalendarEventItem> eventsById,
  ) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(22, 0, 22, 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: _labelWidth,
            child: Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Text('all-day',
                  style: font(kBodyFont, 11, 600, color: AppColors.textMuted)),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            // A day with a pile of all-day events scrolls the pills rather than
            // pushing the grid off the screen.
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: _allDayRowMaxHeight),
              child: SingleChildScrollView(
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final it in items)
                      () {
                        final eid = _eventIdOf(it);
                        final source = it.event ?? (eid == null ? null : eventsById[eid]);
                        return _AllDayPill(
                          item: it,
                          sourceEvent: source,
                          accent: personColor(_childOf(it, byId) ?? _fallbackMember),
                          attendees: _attendeesOf(it, byId, ownersByEvent),
                          onTap: () => _openItem(it, source, byId),
                        );
                      }(),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _grid(
    List<_Placed> placed,
    Map<String, Member> byId,
    Map<String, List<TaskItem>> tabsByEvent,
    Map<String, List<Member>> ownersByEvent,
    List<TaskItem> orphanTabs,
    Map<String, CalendarEventItem> eventsById,
    List<_ConflictOverlay> conflictOverlays,
  ) {
    final now = DateTime.now();
    final showNow = _selected == _dateOnly(now) &&
        now.hour >= _gridStart &&
        now.hour < _gridEnd;
    final nowY = ((now.hour + now.minute / 60) - _gridStart) * _hourPx;

    double taskTop(DateTime t) =>
        ((t.toLocal().hour + t.toLocal().minute / 60) - _gridStart) * _hourPx;

    Widget tab(TaskItem t, double left, double width, double top) => Positioned(
          top: top,
          left: left,
          height: _tabHeight,
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: width),
            child: _EdgeTab(
              task: t,
              accent: personColor(byId[t.familyMemberId] ?? _fallbackMember),
              owner: t.status == 'owned' ? byId[t.ownerMemberId] : null,
              // Tapping a tag manages just this one drop-off / pick-up task.
              onTap: () => showTaskActions(context, ref, t,
                  sourceEvent: t.calendarEventId == null ? null : eventsById[t.calendarEventId]),
            ),
          ),
        );

    return LayoutBuilder(builder: (context, constraints) {
      const laneLeft = _labelWidth + 8;
      final laneWidth = constraints.maxWidth - laneLeft;
      // A block's share of the lane, floored at _minBlockWidth: once the lane is
      // crowded enough that the columns would go unreadable they overlap into a
      // cascade instead, each still offset from — and drawn over — the last.
      final floor = _minBlockWidth.clamp(0.0, laneWidth);
      double blockWidth(_Placed p) =>
          (p.width * laneWidth - _blockGap).clamp(floor, laneWidth);
      double blockLeft(_Placed p) => (laneLeft + p.left * laneWidth)
          .clamp(laneLeft, laneLeft + laneWidth - blockWidth(p));

      /// Whether a block other than [self] occupies the vertical band
      /// [y0, y1) anywhere across [self]'s own strip — the test behind "would my
      /// edge tab land on somebody else's block?". A block [self] cascades on
      /// top of doesn't count: its host is *behind* it, and a tab has never had
      /// to dodge the block it belongs to.
      bool bandTaken(_Placed self, double y0, double y1) {
        final left = blockLeft(self);
        final right = left + blockWidth(self);
        return placed.any((q) {
          if (identical(q, self)) return false;
          final hosts = q.depth < self.depth &&
              q.top <= self.top &&
              q.top + q.height >= self.top + self.height;
          if (hosts) return false;
          return q.top < y1 &&
              q.top + q.height > y0 &&
              blockLeft(q) < right &&
              blockLeft(q) + blockWidth(q) > left;
        });
      }

      final blocks = <Widget>[];
      final tabs = <Widget>[];
      for (final p in placed) {
        final eid = _eventIdOf(p.item);
        final edgeTabs = eid == null ? const <TaskItem>[] : (tabsByEvent[eid] ?? const []);
        final dropoffs = [for (final t in edgeTabs) if (t.type == 'dropoff') t];
        final pickups = [for (final t in edgeTabs) if (t.type != 'dropoff') t];
        // The block's own event when it wraps one, else the source event of the
        // task it wraps (so an unowned attendance task still reads as the
        // child's real event title, not the generic "Attendance" fallback).
        final sourceEvent = p.item.event ?? (eid == null ? null : eventsById[eid]);
        final left = blockLeft(p);
        final width = blockWidth(p);
        // Where this block's transition tags go. Normally a tab straddles the
        // block's edge by half its height. Two things move it:
        //
        //  * a block too short to spare that half would have its own label
        //    buried, so its tags sit fully outside its edges instead;
        //  * when the space a tag would occupy already belongs to another block
        //    it tucks fully inside its own block — tags are drawn (and
        //    hit-tested) above every block, so a resolved conflict's flush
        //    winner would otherwise have every tap meant for it swallowed by
        //    the neighbouring halves' tags, leaving it unclaimable.
        //
        // Either way the tag itself is never dropped.
        final short = p.height < _tabStraddleMinHeight;
        _TabEdge edgeFor(List<TaskItem> group, {required bool atTop}) {
          if (group.isEmpty) return _TabEdge.none;
          final reach = short
              ? _tabHeight * group.length
              : _tabHeight / 2 + _tabHeight * (group.length - 1);
          final y = atTop ? p.top : p.top + p.height;
          final clear = atTop
              ? !bandTaken(p, y - reach, y)
              : !bandTaken(p, y, y + reach);
          if (!clear) return _TabEdge.tuck;
          return short ? _TabEdge.outside : _TabEdge.straddle;
        }

        final topEdge = edgeFor(dropoffs, atTop: true);
        final bottomEdge = edgeFor(pickups, atTop: false);
        final topTabInset = topEdge.contentInset;
        final bottomTabInset = bottomEdge.contentInset;
        blocks.add(Positioned(
          top: p.top,
          left: left,
          width: width,
          height: p.height,
          child: _ItemBlock(
            placed: p,
            sourceEvent: sourceEvent,
            accent: personColor(_childOf(p.item, byId) ?? _fallbackMember),
            attendees: _attendeesOf(p.item, byId, ownersByEvent),
            topTabInset: topTabInset,
            bottomTabInset: bottomTabInset,
            onTapBlock: () => _openItem(p.item, sourceEvent, byId),
          ),
        ));
        for (var i = 0; i < dropoffs.length; i++) {
          final y = switch (topEdge) {
            _TabEdge.tuck => p.top + i * _tabHeight,
            _TabEdge.outside => p.top - _tabHeight * (i + 1),
            _ => p.top - _tabHeight / 2 - i * _tabHeight,
          };
          tabs.add(
              tab(dropoffs[i], left + _tabLeftInset, width - _tabLeftInset, y));
        }
        for (var i = 0; i < pickups.length; i++) {
          final bottom = p.top + p.height;
          final y = switch (bottomEdge) {
            _TabEdge.tuck => bottom - _tabHeight * (i + 1),
            _TabEdge.outside => bottom + _tabHeight * i,
            _ => bottom - _tabHeight / 2 + i * _tabHeight,
          };
          tabs.add(
              tab(pickups[i], left + _tabLeftInset, width - _tabLeftInset, y));
        }
      }
      // Transitions whose source event isn't on the grid: a standalone pill.
      for (final t in orphanTabs) {
        tabs.add(tab(t, laneLeft + _tabLeftInset, laneWidth - 6 - _tabLeftInset,
            taskTop(t.start) - _tabHeight / 2));
      }

      // Double-booked seams (over the blocks) + their pulsing tap chips (topmost).
      final seams = <Widget>[];
      final chips = <Widget>[];
      for (final ov in conflictOverlays) {
        final s = ov.start.toLocal();
        final e = ov.end.toLocal();
        final top = ((s.hour + s.minute / 60) - _gridStart) * _hourPx;
        final height = (e.difference(s).inMinutes / 60 * _hourPx)
            .clamp(_tabHeight, _gridHeight);
        seams.add(Positioned(
          top: top,
          left: laneLeft - 4,
          right: 0,
          height: height,
          child: const _ConflictSeam(),
        ));
        // Coral bracket in the hour-label gutter.
        seams.add(Positioned(
          top: top,
          left: _labelWidth - 2,
          width: 3,
          height: height,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: AppColors.coral,
              borderRadius: BorderRadius.circular(3),
            ),
          ),
        ));
        chips.add(Positioned(
          top: top - 13,
          left: laneLeft + 6,
          child: _ConflictChip(
            onTap: () => showConflictResolution(context, ref, ov.conflict,
                member: ov.member),
          ),
        ));
      }

      return SizedBox(
        height: _gridHeight + 12,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            // Hour gridlines + labels.
            for (var h = _gridStart; h <= _gridEnd; h++)
              Positioned(
                top: (h - _gridStart) * _hourPx,
                left: 0,
                right: 0,
                child: _HourLine(label: _hourLabel(h)),
              ),
            ...blocks,
            // Double-booked collision seams sit above the overlapping blocks.
            ...seams,
            // Now-line.
            if (showNow)
              Positioned(
                top: nowY,
                left: _labelWidth - 2,
                right: 0,
                child: Row(
                  children: [
                    Container(width: 8, height: 8, decoration: const BoxDecoration(color: AppColors.nowLine, shape: BoxShape.circle)),
                    Expanded(child: Container(height: 2, color: AppColors.nowLine)),
                  ],
                ),
              ),
            // Transition tabs float above their blocks.
            ...tabs,
            // Double-booked chips are the topmost tap target.
            ...chips,
          ],
        ),
      );
    });
  }

  static final Member _fallbackMember = Member(
    id: '__none__',
    relationName: '?',
    isCaretaker: false,
    isAdmin: false,
    requiresCaretaker: false,
  );

  /// The task behind a claimed event (so tapping it opens the quick actions).
  TaskItem? _taskFor(CalendarEventItem? event) {
    if (event?.taskId == null) return null;
    final all = ref.read(allTasksProvider).valueOrNull ?? const <TaskItem>[];
    return all.where((t) => t.id == event!.taskId).firstOrNull;
  }

  String _hourLabel(int h) {
    final h24 = h % 24;
    final period = h24 < 12 ? 'AM' : 'PM';
    var hh = h24 % 12;
    if (hh == 0) hh = 12;
    return '$hh $period';
  }

  void _openFilters(List<Member> caretakers) {
    final members = ref.read(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.read(currentMemberProvider).valueOrNull;
    final children = members.where((m) => m.requiresCaretaker).toList();

    showModalBottomSheet<void>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      isScrollControlled: true,
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
                        _exOwners.clear();
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
                Text('Caretakers', style: AppText.eyebrow()),
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final m in caretakers)
                    TaskFilterChip(
                      label: m.id == me?.id ? 'You' : m.relationName,
                      dotColor: personColor(m),
                      selected: !_exOwners.contains(m.id),
                      onTap: () => toggle(_exOwners, m.id),
                    ),
                  TaskFilterChip(
                    label: 'Unowned',
                    dotColor: AppColors.textSecondary,
                    selected: !_exOwners.contains('__unowned__'),
                    onTap: () => toggle(_exOwners, '__unowned__'),
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
                        _exOwners.clear();
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

  // --- Layout: position + pack the day's items ----------------------------

  /// Whether an item renders as a tall duration block (events, attendance)
  /// rather than a slim transition pill.
  static bool _isBlock(_PlanItem it) =>
      it.isEvent || it.task!.type == 'attendance';

  /// How long after its host a block has to start to cascade on top of it
  /// rather than take a column beside it — [_nestHeaderPx] worth of grid.
  static final _nestHeaderGap =
      Duration(minutes: (_nestHeaderPx / _hourPx * 60).round());

  /// Can [child] cascade *over* [parent] instead of halving the lane with it?
  /// Only when the parent wholly contains it and still keeps its own header
  /// strip exposed — that strip carries the parent's label and is the only part
  /// of it left to tap once the cascade is drawn on top.
  static bool _cascades(_Ev parent, _Ev child, int childDepth) =>
      childDepth < _maxNestDepth &&
      !child.start.isBefore(parent.start.add(_nestHeaderGap)) &&
      !child.end.isAfter(parent.end);

  /// Place the day's blocks: a cascade forest (an event wholly inside a longer
  /// one sits *on top of* it, iOS-Calendar style, instead of squeezing it into
  /// a sliver), then greedy columns per level with each block widening
  /// rightwards over every column nothing collides with it in.
  ///
  /// Geometry comes back as fractions of the lane so the layout stays pure —
  /// `_grid` turns them into pixels (and enforces the minimum block width).
  List<_Placed> _layout(List<_PlanItem> items) {
    final evs = [
      for (final it in items)
        _Ev(
          item: it,
          start: it.start.toLocal(),
          // Real end when present; nominal durations for point items.
          end: (it.end != null && it.end!.isAfter(it.start))
              ? it.end!.toLocal()
              : it.start.toLocal().add(Duration(minutes: _isBlock(it) ? 90 : 30)),
        )
    ]..sort((a, b) {
        final byStart = a.start.compareTo(b.start);
        // Longest first on a tie: the event that can host a cascade is the one
        // that has to get there first.
        return byStart != 0 ? byStart : b.end.compareTo(a.end);
      });

    // The cascade forest: `open` is the chain of hosts the next event could
    // nest into, innermost last.
    final roots = <_Node>[];
    final open = <_Node>[];
    for (final ev in evs) {
      while (open.isNotEmpty && !_cascades(open.last.ev, ev, open.length)) {
        open.removeLast();
      }
      final node = _Node(ev);
      (open.isEmpty ? roots : open.last.children).add(node);
      open.add(node);
    }

    final placed = <_Placed>[];
    _placeLevel(roots, 0, 1, 0, placed);
    // Paint order: hosts first, then each cascade level left to right, so a
    // block only ever covers one it deliberately sits on top of.
    placed.sort((a, b) =>
        a.depth != b.depth ? a.depth - b.depth : a.left.compareTo(b.left));
    return placed;
  }

  /// Lay one level of the cascade out across the lane fraction [left, right).
  ///
  /// Each run of transitively-overlapping blocks is packed on its own, so one
  /// crowded hour never narrows the rest of the day: a morning appointment and a
  /// five-deep 4 PM don't share a column count.
  void _placeLevel(
      List<_Node> nodes, double left, double right, int depth, List<_Placed> out) {
    var i = 0;
    while (i < nodes.length) {
      final cluster = <_Node>[nodes[i]];
      var end = nodes[i].ev.end;
      var j = i + 1;
      while (j < nodes.length && nodes[j].ev.start.isBefore(end)) {
        cluster.add(nodes[j]);
        if (nodes[j].ev.end.isAfter(end)) end = nodes[j].ev.end;
        j++;
      }
      _placeCluster(cluster, left, right, depth, out);
      i = j;
    }
  }

  /// Column-pack one cluster of overlapping blocks across [left, right).
  void _placeCluster(
      List<_Node> nodes, double left, double right, int depth, List<_Placed> out) {
    if (nodes.isEmpty) return;
    // Greedy columns. Within a column the blocks never overlap and are in start
    // order, so the last one always holds that column's latest end.
    final cols = <List<_Node>>[];
    final colOf = <int>[];
    for (final n in nodes) {
      var c = 0;
      while (c < cols.length && n.ev.start.isBefore(cols[c].last.ev.end)) {
        c++;
      }
      if (c == cols.length) cols.add(<_Node>[]);
      cols[c].add(n);
      colOf.add(c);
    }
    final colWidth = (right - left) / cols.length;
    for (var i = 0; i < nodes.length; i++) {
      final n = nodes[i];
      final col = colOf[i];
      // Widen over every following column that has nothing overlapping this
      // block in it: in a three-column cluster, the block that only collides
      // with one of them takes the other's width rather than leaving a hole.
      var span = 1;
      for (var c = col + 1; c < cols.length; c++) {
        final clash = cols[c].any((m) =>
            m.ev.start.isBefore(n.ev.end) && m.ev.end.isAfter(n.ev.start));
        if (clash) break;
        span++;
      }
      final l = left + col * colWidth;
      final r = l + span * colWidth;
      final ev = n.ev;
      final top = (((ev.start.hour + ev.start.minute / 60) - _gridStart) * _hourPx)
          .clamp(0.0, _gridHeight);
      final height = _isBlock(ev.item)
          // As tall as the event's real duration (never below the floor one
          // label line needs); _ItemBlock fits its content to whatever it gets.
          ? (ev.end.difference(ev.start).inMinutes / 60 * _hourPx)
              .clamp(_minBlockHeight, _gridHeight)
          : 34.0;
      out.add(_Placed(
        item: ev.item,
        top: top,
        height: height,
        left: l,
        width: r - l,
        depth: depth,
      ));
      // Whatever cascades over this block runs from just inside its left edge
      // to its right one.
      _placeLevel(n.children, (l + _nestIndent).clamp(l, r), r, depth + 1, out);
    }
  }
}

/// A pending double-booking to flag on the timeline: the interval [start, end)
/// where one member's [Conflict.loser] and [Conflict.winner] overlap.
class _ConflictOverlay {
  _ConflictOverlay({
    required this.conflict,
    required this.member,
    required this.start,
    required this.end,
  });
  final Conflict conflict;
  final Member? member;
  final DateTime start;
  final DateTime end;
}

/// The coral collision seam bracketing a double-booked overlap on the grid —
/// a diagonally-hatched fill inside an inset coral outline (§8a).
class _ConflictSeam extends StatelessWidget {
  const _ConflictSeam();

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.coral.withValues(alpha: 0.55), width: 1.5),
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: CustomPaint(
            painter: _HatchPainter(color: AppColors.coral.withValues(alpha: 0.16)),
            child: const SizedBox.expand(),
          ),
        ),
      ),
    );
  }
}

/// Diagonal hatch fill (the collision seam's texture).
class _HatchPainter extends CustomPainter {
  _HatchPainter({required this.color});
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 7
      ..style = PaintingStyle.stroke;
    const step = 14.0;
    // 135° stripes: walk the diagonal offset across the box's full extent.
    for (var x = -size.height; x < size.width; x += step) {
      canvas.drawLine(
        Offset(x, 0),
        Offset(x + size.height, size.height),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_HatchPainter old) => old.color != color;
}

/// The pulsing "Conflict" chip — the double-booking's only new tap target (§8a).
/// Tapping opens the shared resolution sheet.
class _ConflictChip extends StatefulWidget {
  const _ConflictChip({required this.onTap});
  final VoidCallback onTap;

  @override
  State<_ConflictChip> createState() => _ConflictChipState();
}

class _ConflictChipState extends State<_ConflictChip>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    const onCoral = Color(0xFF3A0F0A);
    return GestureDetector(
      onTap: widget.onTap,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, child) {
          // A coral ring that expands and fades out on each cycle.
          final t = _c.value;
          return Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(999),
              boxShadow: [
                BoxShadow(
                  color: AppColors.coral.withValues(alpha: (0.55 * (1 - t)).clamp(0.0, 1.0)),
                  blurRadius: 0,
                  spreadRadius: 7 * t,
                ),
              ],
            ),
            child: child,
          );
        },
        child: Container(
          padding: const EdgeInsets.fromLTRB(8, 5, 11, 5),
          decoration: BoxDecoration(
            color: AppColors.coral,
            borderRadius: BorderRadius.circular(999),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.warning_amber_rounded, size: 13, color: onCoral),
              const SizedBox(width: 5),
              Text('Conflict',
                  style: font(kBodyFont, 11, 700, color: onCoral, letterSpacing: 0.2)),
              const SizedBox(width: 3),
              const Icon(Icons.chevron_right_rounded, size: 14, color: onCoral),
            ],
          ),
        ),
      ),
    );
  }
}

class _Ev {
  _Ev({required this.item, required this.start, required this.end});
  final _PlanItem item;
  final DateTime start;
  final DateTime end;
}

/// Where a block's drop-off / pick-up tags sit relative to the edge they belong
/// to, and how much of the block's own content they push out of the way.
enum _TabEdge {
  /// No tag on that edge.
  none(0),

  /// The usual look: the tag straddles the edge, half in, half out.
  straddle(_tabHeight / 2 + 2),

  /// Fully outside the block — a block too short to give up half a tag's height.
  outside(0),

  /// Fully inside the block, because another block owns the space outside it.
  tuck(_tabHeight);

  const _TabEdge(this.contentInset);

  /// How far the block's own label has to clear this edge.
  final double contentInset;
}

/// One node of the cascade forest: an event plus everything laid out on top of
/// it (blocks wholly inside its span).
class _Node {
  _Node(this.ev);
  final _Ev ev;
  final List<_Node> children = [];
}

class _Placed {
  _Placed({
    required this.item,
    required this.top,
    required this.height,
    required this.left,
    required this.width,
    required this.depth,
  });
  final _PlanItem item;
  final double top;
  final double height;

  /// Horizontal band, as fractions of the lane (0 = the lane's left edge).
  final double left;
  final double width;

  /// 0 for a block on the lane itself, +1 for each cascade level on top of it.
  final int depth;
}

/// An amber glow at the top or bottom edge of the grid, shown when one or more
/// task blocks are scrolled out of view in that direction.
class _EdgeGlow extends StatelessWidget {
  const _EdgeGlow({required this.controller, required this.placed, required this.top});

  final ScrollController controller;
  final List<_Placed> placed;
  final bool top;

  @override
  Widget build(BuildContext context) {
    return Positioned(
      top: top ? 0 : null,
      bottom: top ? null : 0,
      left: 0,
      right: 0,
      child: IgnorePointer(
        child: AnimatedBuilder(
          animation: controller,
          builder: (context, _) {
            var hidden = false;
            if (controller.hasClients && controller.position.hasViewportDimension) {
              final off = controller.offset;
              final vp = controller.position.viewportDimension;
              for (final p in placed) {
                if (top && p.top + p.height <= off + 6) {
                  hidden = true;
                  break;
                }
                if (!top && p.top >= off + vp - 6) {
                  hidden = true;
                  break;
                }
              }
            }
            return AnimatedOpacity(
              duration: const Duration(milliseconds: 200),
              opacity: hidden ? 1 : 0,
              child: Container(
                height: 56,
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: top ? Alignment.topCenter : Alignment.bottomCenter,
                    end: top ? Alignment.bottomCenter : Alignment.topCenter,
                    colors: [
                      AppColors.amberHero.withValues(alpha: 0.30),
                      AppColors.amberHero.withValues(alpha: 0.0),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class _DayChip extends StatelessWidget {
  const _DayChip({
    required this.weekday,
    required this.day,
    required this.active,
    required this.isToday,
    required this.dots,
    required this.onTap,
  });
  final String weekday;
  final int day;
  final bool active;
  final bool isToday;
  final List<Color> dots;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // Today (when not the selected day) gets an indigo outline + accented number.
    final borderColor =
        active ? AppColors.indigo : (isToday ? AppColors.indigo : AppColors.border);
    final dayColor = active
        ? const Color(0xFF17162B)
        : (isToday ? AppColors.indigo : AppColors.textPrimary);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 50,
        padding: const EdgeInsets.symmetric(vertical: 9),
        decoration: BoxDecoration(
          color: active ? AppColors.indigo : AppColors.card,
          borderRadius: BorderRadius.circular(15),
          border: Border.all(color: borderColor),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(weekday,
                style: font(kBodyFont, 10.5, 700,
                    color: active ? const Color(0xCC17162B) : AppColors.textMuted,
                    letterSpacing: 0.5)),
            const SizedBox(height: 4),
            Text('$day', style: font(kBodyFont, 17, 700, color: dayColor)),
            const SizedBox(height: 4),
            SizedBox(
              height: 5,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (final c in dots)
                    Container(
                      width: 4,
                      height: 4,
                      margin: const EdgeInsets.symmetric(horizontal: 1),
                      decoration: BoxDecoration(
                        color: active ? const Color(0xFF17162B) : c,
                        shape: BoxShape.circle,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _HourLine extends StatelessWidget {
  const _HourLine({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        SizedBox(
          width: _labelWidth,
          child: Text(label,
              style: font(kBodyFont, 11, 600, color: AppColors.textMuted)),
        ),
        Expanded(child: Container(height: 1, color: AppColors.divider)),
      ],
    );
  }
}

/// A compact outlined pill with an icon + label (the Plan "Today" button).
class _PillIconButton extends StatelessWidget {
  const _PillIconButton({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.card,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(999),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 16, color: AppColors.textSecondary),
              const SizedBox(width: 7),
              Text(label, style: font(kBodyFont, 13.5, 600, color: AppColors.textSecondary)),
            ],
          ),
        ),
      ),
    );
  }
}

/// A positioned grid block: an attendance event / task, drawn with a uniform
/// source-colour border, "Summary · Person" title, a category + time-range
/// subtitle, and its attendees as avatar badges top-right (6c). Drop-off /
/// pick-up transitions are drawn separately as edge tabs, not here.
class _ItemBlock extends StatelessWidget {
  const _ItemBlock({
    required this.placed,
    required this.accent,
    required this.attendees,
    required this.topTabInset,
    required this.bottomTabInset,
    this.sourceEvent,
    this.onTapBlock,
  });
  final _Placed placed;
  // The block's own event, or — when it wraps a task instead — that task's
  // source event, so the title always reads as the real event, not a
  // generic type label like "Attendance".
  final CalendarEventItem? sourceEvent;
  final Color accent;
  final List<Member> attendees;

  /// How far the content has to clear each edge for the block's own edge tabs:
  /// half a tab plus a hair for a tab that straddles the edge, a whole tab when
  /// it tucked inside instead (see the tuck in `_grid`). 0 ⇒ no tab that side.
  final double topTabInset;
  final double bottomTabInset;
  final VoidCallback? onTapBlock;

  @override
  Widget build(BuildContext context) {
    final it = placed.item;
    final e = it.event;
    final t = it.task;
    final start = it.start;
    final end = it.end;
    final human = e?.isHuman ?? sourceEvent?.isHuman ?? false;

    final summary = e != null ? e.displaySummary : taskTitle(t!, sourceEvent);
    final personName = attendees.isNotEmpty ? attendees.first.relationName : 'child';

    final hasRange = end != null && end.isAfter(start);
    final timeText = hasRange ? friendlyRange(start, end) : clockShort(start);

    // What the block says, in priority order — the description first, because
    // it's the only line that says *what* the block is (the grid already puts it
    // at its time). Each label sheds its trailing tag before it will truncate:
    // the description drops "· Theo" (the attendee avatar still says whose it
    // is) and the time drops "· manual" (issue 98).
    Widget title(int maxLines) => _FittedLabel(
          text: summary,
          style: font(kBodyFont, 12.5, 600, color: AppColors.textPrimary),
          tag: ' · $personName',
          tagStyle: font(kBodyFont, 12.5, 700, color: accent),
          maxLines: maxLines,
        );
    final time = _FittedLabel(
      text: timeText,
      style: font(kBodyFont, 11, 500, color: AppColors.textTertiary),
      tag: human ? ' · manual' : null,
    );

    return GestureDetector(
      onTap: onTapBlock,
      behavior: HitTestBehavior.opaque,
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          // Opaque, not a translucent tint: cascaded blocks stack on top of one
          // another now, and washes of the same accent over each other read as
          // mud rather than as two separate things.
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              Color.alphaBlend(AppColors.tint(accent, 0.22), AppColors.bg),
              Color.alphaBlend(AppColors.tint(accent, 0.10), AppColors.bg),
            ],
          ),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: accent.withValues(alpha: 0.55)),
        ),
        // A block is only ever as tall as its duration, so it fits its content
        // to the space: the description always, wrapping to a second line when
        // there's room, then the start–end time. An edge tag is cleared with the
        // padding its side was given — half a tag for the usual straddle, a
        // whole one when it had to tuck inside to keep off a neighbour.
        child: LayoutBuilder(builder: (context, constraints) {
          final h = constraints.maxHeight;
          final topPad = topTabInset > 0 ? topTabInset : _blockPadV;
          final botPad = bottomTabInset > 0 ? bottomTabInset : _blockPadV;
          // The avatars ride on the description's line, so that line is as tall
          // as whichever of the two is bigger.
          final titleH = attendees.isEmpty
              ? _titleLineH
              : (_avatarSize > _titleLineH ? _avatarSize : _titleLineH);
          final room = h - topPad - botPad;
          final showTime = room >= titleH + _lineGap + _timeLineH;
          final wrapTitle = room >=
              titleH +
                  _lineGap +
                  _titleLineH +
                  (showTime ? _lineGap + _timeLineH : 0);
          final contentH = titleH +
              (wrapTitle ? _lineGap + _titleLineH : 0) +
              (showTime ? _lineGap + _timeLineH : 0);
          // Positioned rather than padded: a block with barely any height left
          // (a 15-minute segment carrying a tucked tag) then clips its label
          // instead of overflowing, and never loses it to the tag.
          final top = topPad.clamp(1.0, (h - contentH - 1).clamp(1.0, h));
          return Stack(
            children: [
              Positioned(
                top: top,
                left: _blockPadH,
                right: _blockPadH,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(child: title(wrapTitle ? 2 : 1)),
                        if (attendees.isNotEmpty) ...[
                          const SizedBox(width: 6),
                          _attendeeAvatars(),
                        ],
                      ],
                    ),
                    if (showTime) ...[
                      const SizedBox(height: _lineGap),
                      time,
                    ],
                  ],
                ),
              ),
            ],
          );
        }),
      ),
    );
  }

  Widget _attendeeAvatars() {
    if (attendees.length == 1) {
      final m = attendees.first;
      return PersonAvatar(
          initial: initialFor(m.relationName),
          color: personColor(m),
          size: _avatarSize);
    }
    return AvatarCluster(
      avatars: [
        for (final m in attendees) (initialFor(m.relationName), personColor(m)),
      ],
      size: _avatarSize,
      overlap: 8,
    );
  }
}

/// A Plan block's label line: [text] with an optional trailing [tag] ("· Theo"
/// on the description, "· manual" on the time). The tag is the first thing to
/// go when the block is too narrow — only once it's gone does the text itself
/// truncate, so a cramped block still says what it is and when, never a
/// mangled half of either (issue 98).
class _FittedLabel extends StatelessWidget {
  const _FittedLabel({
    required this.text,
    required this.style,
    this.tag,
    this.tagStyle,
    this.maxLines = 1,
  });

  final String text;
  final TextStyle style;
  final String? tag;

  /// The tag's own style; null keeps [style] (and renders as one plain [Text],
  /// tag included).
  final TextStyle? tagStyle;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    final tag = this.tag;
    Widget plain() => Text(text,
        maxLines: maxLines, overflow: TextOverflow.ellipsis, style: style);
    if (tag == null) return plain();
    return LayoutBuilder(builder: (context, constraints) {
      final maxWidth = constraints.maxWidth;
      final span = TextSpan(children: [
        TextSpan(text: text, style: style),
        TextSpan(text: tag, style: tagStyle ?? style),
      ]);
      final painter = TextPainter(
        text: span,
        maxLines: maxLines,
        textDirection: TextDirection.ltr,
      )..layout(maxWidth: maxWidth.isFinite ? maxWidth : double.infinity);
      if (painter.didExceedMaxLines) return plain();
      return tagStyle == null
          ? Text('$text$tag',
              maxLines: maxLines, overflow: TextOverflow.ellipsis, style: style)
          : Text.rich(span,
              maxLines: maxLines, overflow: TextOverflow.ellipsis);
    });
  }
}

/// One all-day event (or the unowned attendance task standing in for it) in the
/// pinned row above the grid: a compact pill in the source colour, carrying the
/// description and its attendees. It has no time to show — being all day is the
/// whole point — and tapping it opens exactly what tapping a block would.
class _AllDayPill extends StatelessWidget {
  const _AllDayPill({
    required this.item,
    required this.accent,
    required this.attendees,
    this.sourceEvent,
    this.onTap,
  });

  final _PlanItem item;
  final CalendarEventItem? sourceEvent;
  final Color accent;
  final List<Member> attendees;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final e = item.event;
    final summary =
        e != null ? e.displaySummary : taskTitle(item.task!, sourceEvent);
    final person = attendees.isNotEmpty ? attendees.first.relationName : 'child';

    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        // Wide enough for a real title, capped so one long summary can't take
        // the whole row from the pills beside it.
        constraints: const BoxConstraints(maxWidth: 230),
        padding: const EdgeInsets.fromLTRB(8, 5, 10, 5),
        decoration: BoxDecoration(
          color: Color.alphaBlend(AppColors.tint(accent, 0.22), AppColors.bg),
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: accent.withValues(alpha: 0.55)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (attendees.length == 1)
              PersonAvatar(
                  initial: initialFor(attendees.first.relationName),
                  color: personColor(attendees.first),
                  size: _allDayAvatarSize)
            else if (attendees.length > 1)
              AvatarCluster(
                avatars: [
                  for (final m in attendees)
                    (initialFor(m.relationName), personColor(m)),
                ],
                size: _allDayAvatarSize,
                overlap: 7,
              )
            else
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
              ),
            const SizedBox(width: 7),
            Flexible(
              child: _FittedLabel(
                text: summary,
                style: font(kBodyFont, 12.5, 600, color: AppColors.textPrimary),
                tag: ' · $person',
                tagStyle: font(kBodyFont, 12.5, 700, color: accent),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A drop-off / pick-up transition rendered as a tab clipped onto the top or
/// bottom edge of its parent event block (6c). Solid in the source colour with
/// the owner's avatar when claimed; a dashed amber outline when it still needs
/// an owner.
class _EdgeTab extends StatelessWidget {
  const _EdgeTab({
    required this.task,
    required this.accent,
    required this.owner,
    this.onTap,
  });
  final TaskItem task;
  final Color accent;
  final Member? owner;
  final VoidCallback? onTap;

  String get _label {
    final kind = task.type == 'dropoff' ? 'Drop-off' : 'Pick-up';
    return '$kind · ${clockShort(task.start)}';
  }

  @override
  Widget build(BuildContext context) {
    final claimed = owner != null;
    const onAccent = Color(0xFF17162B);
    final glyph = Icon(taskIcon(task.type), size: 13,
        color: claimed ? onAccent : AppColors.amber);
    final labelStyle = font(kBodyFont, 11, 700,
        color: claimed ? onAccent : AppColors.textPrimary);

    final row = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        glyph,
        const SizedBox(width: 6),
        Flexible(
          child: Text(_label,
              maxLines: 1, overflow: TextOverflow.ellipsis, style: labelStyle),
        ),
        if (claimed) ...[
          const SizedBox(width: 6),
          PersonAvatar(
              initial: initialFor(owner!.relationName),
              color: personColor(owner!),
              size: 16),
        ],
      ],
    );

    // A rounded background (no hard clip) so the trailing owner avatar is never
    // cut by the pill's rounded end.
    final inner = Padding(
      padding: const EdgeInsets.fromLTRB(10, 1, 10, 1),
      child: row,
    );

    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: claimed
          ? DecoratedBox(
              decoration: BoxDecoration(
                color: accent,
                borderRadius: BorderRadius.circular(999),
              ),
              child: inner,
            )
          : DecoratedBox(
              decoration: BoxDecoration(
                color: AppColors.bg.withValues(alpha: 0.9),
                borderRadius: BorderRadius.circular(999),
              ),
              child: CustomPaint(
                foregroundPainter: _DashedBox(color: AppColors.amber, radius: 999),
                child: inner,
              ),
            ),
    );
  }
}

/// Dashed rounded-rect border (unowned Plan blocks and the unclaimed edge tabs).
class _DashedBox extends CustomPainter {
  _DashedBox({required this.color, this.radius = 12});
  final Color color;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4;
    final r = radius >= 900 ? size.height / 2 : radius;
    final rrect = RRect.fromRectAndRadius(
      Offset.zero & size,
      Radius.circular(r),
    );
    final path = Path()..addRRect(rrect);
    const dash = 5.0, gap = 4.0;
    for (final metric in path.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        canvas.drawPath(
          metric.extractPath(d, (d + dash).clamp(0, metric.length)),
          paint,
        );
        d += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedBox old) => old.color != color || old.radius != radius;
}
