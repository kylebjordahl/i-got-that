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
import 'task_actions_sheet.dart';

const _startHour = 7;
const _endHour = 18; // 6 PM
const _hourPx = 42.0;
const _labelWidth = 46.0;
const _gridHeight = (_endHour - _startHour) * _hourPx;

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

  // Active filters (empty ⇒ show all). Types are task types; owners include the
  // sentinel `__unowned__`.
  final Set<String> _typeFilter = {};
  final Set<String> _ownerFilter = {};

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

  int get _filterCount => _typeFilter.length + _ownerFilter.length;

  bool _passesFilter(TaskItem t) {
    if (_typeFilter.isNotEmpty && !_typeFilter.contains(t.type)) return false;
    if (_ownerFilter.isNotEmpty) {
      final key = t.ownerMemberId ?? '__unowned__';
      if (!_ownerFilter.contains(key)) return false;
    }
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
    final allTasks = [
      for (final t in ref.watch(allTasksProvider).valueOrNull ?? const <TaskItem>[])
        if (!t.isDismissed) t
    ];

    final dayTasks = [
      for (final t in allTasks)
        if (dayKey(t.start) == _selected && _passesFilter(t)) t
    ];
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
      height: 74,
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
        now.hour >= _startHour &&
        now.hour < _endHour;
    final nowY = ((now.hour + now.minute / 60) - _startHour) * _hourPx;

    return LayoutBuilder(builder: (context, constraints) {
      const laneLeft = _labelWidth + 8;
      final laneWidth = constraints.maxWidth - laneLeft;
      return SizedBox(
        height: _gridHeight + 12,
        child: Stack(
          children: [
            // Hour gridlines + labels.
            for (var h = _startHour; h <= _endHour; h++)
              Positioned(
                top: (h - _startHour) * _hourPx,
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
                  onLongPress: () => showTaskActions(context, ref, p.task),
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
    final period = h < 12 ? 'AM' : 'PM';
    var hh = h % 12;
    if (hh == 0) hh = 12;
    return '$hh $period';
  }

  void _openFilters(List<Member> caretakers) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => StatefulBuilder(
        builder: (context, setSheet) {
          void toggle(Set<String> set, String key) => setSheet(() {
                set.contains(key) ? set.remove(key) : set.add(key);
                setState(() {});
              });
          Widget chip(String label, bool on, VoidCallback onTap) => GestureDetector(
                onTap: onTap,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                  decoration: BoxDecoration(
                    color: on ? AppColors.indigo : AppColors.bg,
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: on ? AppColors.indigo : AppColors.border),
                  ),
                  child: Text(label,
                      style: font(kBodyFont, 13, 600,
                          color: on ? const Color(0xFF17162B) : AppColors.textSecondary)),
                ),
              );
          return Padding(
            padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Filters', style: AppText.subPageTitle),
                const SizedBox(height: 16),
                Text('Task type', style: AppText.eyebrow()),
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  for (final (id, label) in const [('dropoff', 'Drop-off'), ('pickup', 'Pickup'), ('attendance', 'Attendance')])
                    chip(label, _typeFilter.contains(id), () => toggle(_typeFilter, id)),
                ]),
                const SizedBox(height: 18),
                Text('Owner', style: AppText.eyebrow()),
                const SizedBox(height: 10),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  chip('Needs owner', _ownerFilter.contains('__unowned__'), () => toggle(_ownerFilter, '__unowned__')),
                  for (final m in caretakers)
                    chip(m.relationName, _ownerFilter.contains(m.id), () => toggle(_ownerFilter, m.id)),
                ]),
                const SizedBox(height: 22),
                Row(
                  children: [
                    TextButton(
                      onPressed: () => setSheet(() {
                        _typeFilter.clear();
                        _ownerFilter.clear();
                        setState(() {});
                      }),
                      child: const Text('Clear all'),
                    ),
                    const Spacer(),
                    PillButton(
                      label: 'Done',
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
          start: t.start,
          // No end-time in the model: nominal durations for layout only.
          end: t.start.add(Duration(minutes: t.type == 'attendance' ? 90 : 30)),
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
        final top = (((ev.start.hour + ev.start.minute / 60) - _startHour) * _hourPx)
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
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: active ? AppColors.indigo : AppColors.card,
          borderRadius: BorderRadius.circular(15),
          border: Border.all(color: borderColor),
        ),
        child: Column(
          children: [
            Text(weekday,
                style: font(kBodyFont, 10.5, 700,
                    color: active ? const Color(0xCC17162B) : AppColors.textMuted,
                    letterSpacing: 0.5)),
            const SizedBox(height: 4),
            Text('$day', style: font(kBodyFont, 17, 700, color: dayColor)),
            const SizedBox(height: 5),
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
    this.onLongPress,
  });
  final _Placed placed;
  final Map<String, Member> byId;
  final VoidCallback onClaim;
  final VoidCallback? onLongPress;

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
      onLongPress: onLongPress,
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
