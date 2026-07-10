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
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import 'task_actions_sheet.dart';

const _hourPx = 42.0;
const _labelWidth = 46.0;
// The grid always shows at least this window, then expands to fit the day's
// events (and the now-line) so nothing is clipped — the page scrolls to reveal
// the extra hours.
const _defaultStartHour = 7;
const _defaultEndHour = 19; // 7 PM

/// One item on the Plan grid: a unified-calendar event (synthesized / human /
/// claimed — colored by whose calendar it's on) or an unowned task (dashed,
/// claimable inline).
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
/// tasks render hatched with an inline Claim.
class PlanScreen extends ConsumerStatefulWidget {
  const PlanScreen({super.key});

  @override
  ConsumerState<PlanScreen> createState() => _PlanScreenState();
}

class _PlanScreenState extends ConsumerState<PlanScreen> {
  late final DateTime _today = _dateOnly(DateTime.now());
  late DateTime _selected = _today;

  /// The member whose unified calendar is shown; null ⇒ Everyone (merged).
  String? _selectedMemberId;

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

  Future<void> _claim(String taskId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).assignTask(familyId, taskId);
    ref.invalidate(allTasksProvider);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(calendarEventsProvider);
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
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Refresh failed: $e')));
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
    // Children I'm covering (for the "only my kids" filter): kids with a task I own.
    final myKids = {
      for (final t in rawTasks)
        if (t.ownerMemberId == me?.id) t.familyMemberId
    };
    final allTasks = [
      for (final t in rawTasks)
        if (_showCompleted || !t.isDismissed) t
    ];

    bool memberVisible(String memberId) =>
        _selectedMemberId == null || _selectedMemberId == memberId;

    // The grid merges the selected unified calendar(s) with the day's unowned
    // tasks. Owned tasks aren't drawn directly — they appear as claimed events
    // on their owner's calendar.
    final dayItems = <_PlanItem>[
      for (final e in events)
        if (dayKey(e.start) == _selected &&
            memberVisible(e.familyMemberId) &&
            !_exChildren.contains(e.familyMemberId))
          _PlanItem.event(e),
      for (final t in allTasks)
        if (t.isUnowned &&
            dayKey(t.start) == _selected &&
            memberVisible(t.familyMemberId) &&
            _passesFilter(t, myKids))
          _PlanItem.task(t),
    ];
    _computeRange(dayItems);
    final placed = _layout(dayItems);
    // Default the grid's scroll to the 7 AM–6 PM window (once per day change).
    _scheduleDefaultScroll();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(22, 14, 22, 0),
          child: _header(),
        ),
        const SizedBox(height: 14),
        Padding(
          padding: const EdgeInsets.only(left: 22),
          child: _memberChips(members),
        ),
        const SizedBox(height: 14),
        Padding(
          padding: const EdgeInsets.only(left: 22),
          child: _dayScroller(allTasks, byId),
        ),
        const SizedBox(height: 18),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 22),
          child: _legend(),
        ),
        const SizedBox(height: 14),
        // The time grid scrolls on its own; the day chips above stay fixed. The
        // amber edge glows flag events scrolled out of view above/below.
        Expanded(
          child: Stack(
            children: [
              SingleChildScrollView(
                controller: _gridScroll,
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 130),
                child: _grid(placed, byId),
              ),
              _EdgeGlow(controller: _gridScroll, placed: placed, top: true),
              _EdgeGlow(controller: _gridScroll, placed: placed, top: false),
            ],
          ),
        ),
      ],
    );
  }

  void _goToToday() {
    setState(() {
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

  /// Unified-calendar chips: Everyone + one per member — kids AND caretakers
  /// each have their own calendar (6c).
  Widget _memberChips(List<Member> members) {
    return SizedBox(
      height: 38,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: TaskFilterChip(
              label: 'Everyone',
              selected: _selectedMemberId == null,
              onTap: () => setState(() => _selectedMemberId = null),
            ),
          ),
          for (final m in members)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: TaskFilterChip(
                label: m.relationName,
                dotColor: personColor(m),
                selected: _selectedMemberId == m.id,
                onTap: () => setState(() =>
                    _selectedMemberId = _selectedMemberId == m.id ? null : m.id),
              ),
            ),
          const SizedBox(width: 14),
        ],
      ),
    );
  }

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
              onTap: () => setState(() => _selected = d),
            ),
          );
        },
      ),
    );
  }

  Widget _legend() {
    Widget item(Widget swatch, String label) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            swatch,
            const SizedBox(width: 6),
            Text(label, style: AppText.secondary),
          ],
        );
    return Row(
      children: [
        item(
          Container(width: 8, height: 8, decoration: const BoxDecoration(color: AppColors.indigo, shape: BoxShape.circle)),
          'Transition',
        ),
        const SizedBox(width: 18),
        item(
          Container(width: 14, height: 8, decoration: BoxDecoration(color: AppColors.purple, borderRadius: BorderRadius.circular(3))),
          'Attendance',
        ),
        const SizedBox(width: 18),
        item(
          Container(
            width: 14,
            height: 10,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(3),
              border: Border.all(color: const Color(0x52FFFFFF)),
            ),
          ),
          'Needs owner',
        ),
      ],
    );
  }

  Widget _grid(List<_Placed> placed, Map<String, Member> byId) {
    final now = DateTime.now();
    final showNow = _selected == _dateOnly(now) &&
        now.hour >= _gridStart &&
        now.hour < _gridEnd;
    final nowY = ((now.hour + now.minute / 60) - _gridStart) * _hourPx;

    return LayoutBuilder(builder: (context, constraints) {
      const laneLeft = _labelWidth + 8;
      final laneWidth = constraints.maxWidth - laneLeft;
      return SizedBox(
        height: _gridHeight + 12,
        child: Stack(
          children: [
            // Hour gridlines + labels.
            for (var h = _gridStart; h <= _gridEnd; h++)
              Positioned(
                top: (h - _gridStart) * _hourPx,
                left: 0,
                right: 0,
                child: _HourLine(label: _hourLabel(h)),
              ),
            // Item blocks (events + unowned tasks).
            for (final p in placed)
              Positioned(
                top: p.top,
                left: laneLeft + p.colIndex * (laneWidth / p.colCount),
                width: laneWidth / p.colCount - 6,
                height: p.height,
                child: _ItemBlock(
                  placed: p,
                  byId: byId,
                  onClaim:
                      p.item.task != null ? () => _claim(p.item.task!.id) : null,
                  onTapBlock: () {
                    final task = p.item.task ?? _taskFor(p.item.event);
                    if (task != null) showTaskActions(context, ref, task);
                  },
                ),
              ),
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
          ],
        ),
      );
    });
  }

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

  // --- Layout: position + column-pack the day's items --------------------

  /// Whether an item renders as a tall duration block (events, attendance)
  /// rather than a slim transition pill.
  static bool _isBlock(_PlanItem it) =>
      it.isEvent || it.task!.type == 'attendance';

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
    ]..sort((a, b) => a.start.compareTo(b.start));

    final placed = <_Placed>[];
    var i = 0;
    while (i < evs.length) {
      // Build a cluster of transitively-overlapping events.
      final cluster = <_Ev>[evs[i]];
      var clusterEnd = evs[i].end;
      var j = i + 1;
      while (j < evs.length && evs[j].start.isBefore(clusterEnd)) {
        cluster.add(evs[j]);
        if (evs[j].end.isAfter(clusterEnd)) clusterEnd = evs[j].end;
        j++;
      }
      // Greedy column assignment within the cluster.
      final colEnds = <DateTime>[];
      final colOf = <int>[];
      for (final ev in cluster) {
        var col = -1;
        for (var c = 0; c < colEnds.length; c++) {
          if (!ev.start.isBefore(colEnds[c])) {
            col = c;
            break;
          }
        }
        if (col == -1) {
          col = colEnds.length;
          colEnds.add(ev.end);
        } else {
          colEnds[col] = ev.end;
        }
        colOf.add(col);
      }
      final colCount = colEnds.length;
      for (var k = 0; k < cluster.length; k++) {
        final ev = cluster[k];
        final top = (((ev.start.hour + ev.start.minute / 60) - _gridStart) * _hourPx)
            .clamp(0.0, _gridHeight);
        final height = _isBlock(ev.item)
            // Tall enough for the title + time + a Claim/avatar footer.
            ? (ev.end.difference(ev.start).inMinutes / 60 * _hourPx)
                .clamp(76.0, _gridHeight)
            : 34.0;
        placed.add(_Placed(
          item: ev.item,
          top: top,
          height: height,
          colIndex: colOf[k],
          colCount: colCount,
        ));
      }
      i = j;
    }
    return placed;
  }
}

class _Ev {
  _Ev({required this.item, required this.start, required this.end});
  final _PlanItem item;
  final DateTime start;
  final DateTime end;
}

class _Placed {
  _Placed({
    required this.item,
    required this.top,
    required this.height,
    required this.colIndex,
    required this.colCount,
  });
  final _PlanItem item;
  final double top;
  final double height;
  final int colIndex;
  final int colCount;
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

/// A positioned grid item: a unified-calendar event block (solid, tinted to
/// whose calendar it's on — a claimed task therefore renders in the OWNER's
/// color, the recursion made visible) or an unowned task (dashed + Claim).
class _ItemBlock extends StatelessWidget {
  const _ItemBlock({
    required this.placed,
    required this.byId,
    required this.onClaim,
    this.onTapBlock,
  });
  final _Placed placed;
  final Map<String, Member> byId;
  final VoidCallback? onClaim;
  final VoidCallback? onTapBlock;

  @override
  Widget build(BuildContext context) {
    final event = placed.item.event;
    if (event != null) return _eventBlock(event);
    return _taskBlock(placed.item.task!);
  }

  Widget _eventBlock(CalendarEventItem e) {
    final calendarOwner = byId[e.familyMemberId];
    final accent =
        calendarOwner != null ? personColor(calendarOwner) : AppColors.indigo;
    final time = e.end != null
        ? '${clockShort(e.start)} – ${clockShort(e.end!)}'
        : clockShort(e.start);
    final subtitle = e.isClaimedTask
        ? "$time · on ${calendarOwner?.relationName ?? 'their'}'s calendar"
        : time;

    return GestureDetector(
      onTap: onTapBlock,
      behavior: HitTestBehavior.opaque,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
            colors: [AppColors.tint(accent, 0.22), AppColors.tint(accent, 0.10)],
          ),
          borderRadius: BorderRadius.circular(12),
          border: Border(left: BorderSide(color: accent, width: 3)),
        ),
        child: Stack(
          fit: StackFit.expand,
          children: [
            Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(e.displaySummary,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: font(kBodyFont, 12.5, 600, color: AppColors.textPrimary)),
                const SizedBox(height: 2),
                Text(subtitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: font(kBodyFont, 11, 500, color: AppColors.textTertiary)),
              ],
            ),
            Align(
              alignment: Alignment.bottomLeft,
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (calendarOwner != null)
                  PersonAvatar(
                      initial: initialFor(calendarOwner.relationName),
                      color: accent,
                      size: 20),
                if (e.isHuman) ...[
                  const SizedBox(width: 6),
                  Text('manual',
                      style: font(kBodyFont, 10, 600, color: AppColors.textMuted)),
                ],
              ]),
            ),
          ],
        ),
      ),
    );
  }

  Widget _taskBlock(TaskItem t) {
    final child = byId[t.familyMemberId];
    final accent = child != null ? personColor(child) : AppColors.indigo;
    final isAtt = t.type == 'attendance';
    final label = '${taskTypeLabel(t.type)} · ${child?.relationName ?? 'child'}';
    final time = clockShort(t.start);

    // Title pinned to the top, Claim to the bottom. A Stack (not a Column) so a
    // too-short block can never throw a flex overflow.
    final content = isAtt
        ? Stack(
            fit: StackFit.expand,
            children: [
              Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: font(kBodyFont, 12.5, 600, color: AppColors.textPrimary)),
                  const SizedBox(height: 2),
                  Text(time, style: font(kBodyFont, 11, 500, color: AppColors.textTertiary)),
                ],
              ),
              Align(
                alignment: Alignment.bottomLeft,
                child: PillButton(label: 'Claim', compact: true, onPressed: onClaim),
              ),
            ],
          )
        : Row(
            children: [
              Icon(taskIcon(t.type), size: 15, color: accent),
              const SizedBox(width: 7),
              Expanded(
                child: Text('$label · $time',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: font(kBodyFont, 12, 600, color: AppColors.textPrimary)),
              ),
              PillButton(label: 'Claim', compact: true, onPressed: onClaim),
            ],
          );

    return GestureDetector(
      onTap: onTapBlock,
      behavior: HitTestBehavior.opaque,
      child: CustomPaint(
        painter: _DashedBox(color: accent.withValues(alpha: 0.7)),
        child: Container(
          padding: EdgeInsets.symmetric(horizontal: 10, vertical: isAtt ? 9 : 4),
          decoration: BoxDecoration(
            color: AppColors.tint(accent, 0.06),
            borderRadius: BorderRadius.circular(12),
          ),
          child: content,
        ),
      ),
    );
  }
}

/// Dashed rounded-rect border for unowned Plan blocks.
class _DashedBox extends CustomPainter {
  _DashedBox({required this.color});
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4;
    final rrect = RRect.fromRectAndRadius(
      Offset.zero & size,
      const Radius.circular(12),
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
  bool shouldRepaint(_DashedBox old) => old.color != color;
}
