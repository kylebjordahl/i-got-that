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

/// Plan — an iOS-Calendar-style day view. Shows who's covering what across the
/// day so caretakers can spot and claim gaps.
class PlanScreen extends ConsumerStatefulWidget {
  const PlanScreen({super.key});

  @override
  ConsumerState<PlanScreen> createState() => _PlanScreenState();
}

class _PlanScreenState extends ConsumerState<PlanScreen> {
  late final DateTime _today = _dateOnly(DateTime.now());
  late DateTime _selected = _today;

  // Filters are stored as *exclusions* (empty ⇒ show all): a chip is selected
  // when it's NOT in the set, so a category only constrains once you deselect
  // something. `_exOwners` uses caretaker ids + the sentinel `__unowned__`;
  // `_exTypes` uses the groups 'transition' / 'attendance'.
  final Set<String> _exChildren = {};
  final Set<String> _exOwners = {};
  final Set<String> _exTypes = {};
  bool _showCompleted = false;
  bool _onlyMyKids = false;

  // The visible hour window for the current day (computed each build).
  int _gridStart = _defaultStartHour;
  int _gridEnd = _defaultEndHour;
  double get _gridHeight => (_gridEnd - _gridStart) * _hourPx;

  /// Expand the default window to fit every event on the day (+ the now-line),
  /// so nothing is clipped and the whole day is reachable by scrolling.
  void _computeRange(List<TaskItem> dayTasks) {
    var start = _defaultStartHour;
    var end = _defaultEndHour;
    for (final t in dayTasks) {
      final l = t.start.toLocal();
      if (l.hour < start) start = l.hour;
      final endH = l.hour + (t.type == 'attendance' ? 2 : 1);
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
  }

  @override
  Widget build(BuildContext context) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final byId = {for (final m in members) m.id: m};
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final rawTasks = ref.watch(allTasksProvider).valueOrNull ?? const <TaskItem>[];
    // Children I'm covering (for the "only my kids" filter): kids with a task I own.
    final myKids = {
      for (final t in rawTasks)
        if (t.ownerMemberId == me?.id) t.familyMemberId
    };
    final allTasks = [
      for (final t in rawTasks)
        if (_showCompleted || !t.isDismissed) t
    ];

    final dayTasks = [
      for (final t in allTasks)
        if (dayKey(t.start) == _selected && _passesFilter(t, myKids)) t
    ];
    _computeRange(dayTasks);
    final placed = _layout(dayTasks);

    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 14, 22, 130),
      children: [
        _header(),
        const SizedBox(height: 18),
        _dayScroller(allTasks, byId),
        const SizedBox(height: 18),
        _legend(),
        const SizedBox(height: 14),
        _grid(placed, byId),
      ],
    );
  }

  void _goToToday() {
    setState(() => _selected = _today);
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
        _FiltersButton(count: _filterCount, onTap: () => _openFilters(caretakersFor())),
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
            // Task blocks.
            for (final p in placed)
              Positioned(
                top: p.top,
                left: laneLeft + p.colIndex * (laneWidth / p.colCount),
                width: laneWidth / p.colCount - 6,
                height: p.height,
                child: _TaskBlock(
                  placed: p,
                  byId: byId,
                  onClaim: () => _claim(p.task.id),
                  onTapBlock: () => showTaskActions(context, ref, p.task),
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
                    _FilterChip(
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
                    _FilterChip(
                      label: m.id == me?.id ? 'You' : m.relationName,
                      dotColor: personColor(m),
                      selected: !_exOwners.contains(m.id),
                      onTap: () => toggle(_exOwners, m.id),
                    ),
                  _FilterChip(
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
                  _FilterChip(
                    label: 'Transitions',
                    selected: !_exTypes.contains('transition'),
                    onTap: () => toggle(_exTypes, 'transition'),
                  ),
                  _FilterChip(
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

  // --- Layout: position + column-pack the day's tasks --------------------

  List<_Placed> _layout(List<TaskItem> tasks) {
    final evs = [
      for (final t in tasks)
        _Ev(
          task: t,
          start: t.start.toLocal(),
          // No end-time in the model: nominal durations for layout only.
          end: t.start.toLocal().add(Duration(minutes: t.type == 'attendance' ? 90 : 30)),
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
        final isAtt = ev.task.type == 'attendance';
        final height = isAtt
            ? (ev.end.difference(ev.start).inMinutes / 60 * _hourPx).clamp(48.0, _gridHeight)
            : 34.0;
        placed.add(_Placed(
          task: ev.task,
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
  _Ev({required this.task, required this.start, required this.end});
  final TaskItem task;
  final DateTime start;
  final DateTime end;
}

class _Placed {
  _Placed({
    required this.task,
    required this.top,
    required this.height,
    required this.colIndex,
    required this.colCount,
  });
  final TaskItem task;
  final double top;
  final double height;
  final int colIndex;
  final int colCount;
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

/// A filter chip. Person chips (with a [dotColor]) tint to that color when
/// selected and show a colored dot; type chips fill solid indigo.
class _FilterChip extends StatelessWidget {
  const _FilterChip({
    required this.label,
    required this.selected,
    required this.onTap,
    this.dotColor,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final Color? dotColor;

  @override
  Widget build(BuildContext context) {
    final person = dotColor != null;
    final accent = dotColor ?? AppColors.indigo;
    final Color bg, fg, border;
    if (selected) {
      bg = person ? AppColors.tint(accent, 0.18) : AppColors.indigo;
      fg = person ? AppColors.textPrimary : const Color(0xFF17162B);
      border = accent;
    } else {
      bg = Colors.transparent;
      fg = AppColors.textSecondary;
      border = AppColors.border;
    }
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (person && selected) ...[
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
              ),
              const SizedBox(width: 7),
            ],
            Text(label, style: font(kBodyFont, 13, 600, color: fg)),
          ],
        ),
      ),
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

class _FiltersButton extends StatelessWidget {
  const _FiltersButton({required this.count, required this.onTap});
  final int count;
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
              const Icon(Icons.tune_rounded, size: 17, color: AppColors.textSecondary),
              const SizedBox(width: 7),
              Text('Filters', style: font(kBodyFont, 13.5, 600, color: AppColors.textSecondary)),
              if (count > 0) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(color: AppColors.indigo, borderRadius: BorderRadius.circular(999)),
                  child: Text('$count', style: font(kBodyFont, 11, 700, color: const Color(0xFF17162B))),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// A single positioned task block (transition pill or attendance block).
class _TaskBlock extends StatelessWidget {
  const _TaskBlock({
    required this.placed,
    required this.byId,
    required this.onClaim,
    this.onTapBlock,
  });
  final _Placed placed;
  final Map<String, Member> byId;
  final VoidCallback onClaim;
  final VoidCallback? onTapBlock;

  @override
  Widget build(BuildContext context) {
    final t = placed.task;
    final child = byId[t.familyMemberId];
    final owner = t.ownerMemberId != null ? byId[t.ownerMemberId] : null;
    final unowned = owner == null;
    final accent = owner != null
        ? personColor(owner)
        : (child != null ? personColor(child) : AppColors.indigo);
    final isAtt = t.type == 'attendance';

    final label = '${taskTypeLabel(t.type)} · ${child?.relationName ?? 'child'}';
    final time = clockShort(t.start);

    final content = isAtt
        ? Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: font(kBodyFont, 12.5, 600, color: AppColors.textPrimary)),
              const SizedBox(height: 2),
              Text(time, style: font(kBodyFont, 11, 500, color: AppColors.textTertiary)),
              const Spacer(),
              if (unowned)
                Align(
                  alignment: Alignment.centerLeft,
                  child: PillButton(label: 'Claim', dense: true, onPressed: onClaim),
                )
              else
                Row(children: _avatars(child, owner)),
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
              if (unowned)
                PillButton(label: 'Claim', compact: true, onPressed: onClaim)
              else
                PersonAvatar(initial: initialFor(owner.relationName), color: accent, size: 20),
            ],
          );

    final Widget box = unowned
        ? CustomPaint(
            painter: _DashedBox(color: accent.withValues(alpha: 0.7)),
            child: Container(
              padding: EdgeInsets.symmetric(horizontal: 10, vertical: isAtt ? 9 : 4),
              decoration: BoxDecoration(
                color: AppColors.tint(accent, 0.06),
                borderRadius: BorderRadius.circular(12),
              ),
              child: content,
            ),
          )
        : Container(
            padding: EdgeInsets.symmetric(horizontal: 10, vertical: isAtt ? 9 : 6),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.centerLeft,
                end: Alignment.centerRight,
                colors: [AppColors.tint(accent, 0.22), AppColors.tint(accent, 0.10)],
              ),
              borderRadius: BorderRadius.circular(12),
              border: Border(left: BorderSide(color: accent, width: 3)),
            ),
            child: content,
          );

    return GestureDetector(
      onTap: onTapBlock,
      behavior: HitTestBehavior.opaque,
      child: box,
    );
  }

  List<Widget> _avatars(Member? child, Member? owner) {
    final chips = <Widget>[];
    if (child != null) {
      chips.add(PersonAvatar(initial: initialFor(child.relationName), color: personColor(child), size: 20));
    }
    if (owner != null) {
      if (chips.isNotEmpty) chips.add(const SizedBox(width: 4));
      chips.add(PersonAvatar(initial: initialFor(owner.relationName), color: personColor(owner), size: 20));
    }
    return chips;
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
