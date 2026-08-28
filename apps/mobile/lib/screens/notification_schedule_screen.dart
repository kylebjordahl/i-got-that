import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/notifications.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../util/assignment_text.dart' show kWeekdayLabels;
import '../widgets/app_bottom_nav.dart'
    show kBottomNavClearance, snackBarMarginAboveNav;
import '../widgets/day_chip.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import '../widgets/time_fields.dart';

/// Editor for one notification schedule — when the digest goes out, which days
/// it covers, and which kinds of outstanding work it counts.
///
/// [schedule] null ⇒ creating. The send time snaps to quarter hours because the
/// dispatching cron ticks every 15 minutes; offering finer control would
/// promise a precision the scheduler doesn't have.
class NotificationScheduleScreen extends ConsumerStatefulWidget {
  const NotificationScheduleScreen({super.key, this.schedule, this.timezone});

  final NotificationSchedule? schedule;

  /// The device's IANA zone, used when creating. Falls back to the edited
  /// schedule's own zone.
  final String? timezone;

  @override
  ConsumerState<NotificationScheduleScreen> createState() =>
      _NotificationScheduleScreenState();
}

class _NotificationScheduleScreenState
    extends ConsumerState<NotificationScheduleScreen> {
  late final TextEditingController _label;
  late TimeOfDay _sendAt;
  late Set<int> _weekdays;
  late int _startOffsetDays;
  late int _horizonDays;
  late Set<NotificationCategory> _categories;
  late bool _skipWhenEmpty;
  bool _saving = false;
  String? _error;

  bool get _isNew => widget.schedule == null;

  @override
  void initState() {
    super.initState();
    final s = widget.schedule;
    _label = TextEditingController(text: s?.label ?? 'Daily brief');
    _sendAt = parseClockTime(s?.sendAt) ?? const TimeOfDay(hour: 20, minute: 0);
    _weekdays = {...?s?.weekdays};
    if (_weekdays.isEmpty) _weekdays = {0, 1, 2, 3, 4, 5, 6};
    _startOffsetDays = s?.startOffsetDays ?? 1;
    _horizonDays = s?.horizonDays ?? 1;
    _categories = {...?s?.categories};
    if (_categories.isEmpty) {
      _categories = {
        NotificationCategory.conflicts,
        NotificationCategory.pendingDecisions,
        NotificationCategory.unclaimedTasks,
      };
    }
    _skipWhenEmpty = s?.skipWhenEmpty ?? true;
  }

  @override
  void dispose() {
    _label.dispose();
    super.dispose();
  }

  int get _weekdayMask => _weekdays.fold(0, (m, b) => m | (1 << b));

  String get _sendAtWire => formatClockTime(_sendAt);

  String get _timezone => widget.schedule?.timezone ?? widget.timezone ?? 'UTC';

  /// Plain-English restatement of the window, so nobody has to reason about
  /// "start offset" and "horizon" in the abstract.
  String get _coverageSentence {
    final start = switch (_startOffsetDays) {
      0 => 'the rest of today',
      1 => 'tomorrow',
      _ => 'in $_startOffsetDays days',
    };
    if (_horizonDays == 1) {
      return _startOffsetDays == 0
          ? 'Covers what is left of today.'
          : 'Covers $start.';
    }
    return 'Covers $_horizonDays days, starting ${_startOffsetDays == 0 ? 'today' : start}.';
  }

  /// Round to the quarter hour the dispatching cron can actually honour.
  /// Neither platform picker offers a minute interval, so the snap happens on
  /// the way out rather than being enforced by the wheel.
  static TimeOfDay _snapToQuarterHour(TimeOfDay picked) {
    final snapped = (picked.minute / 15).round() * 15;
    return snapped == 60
        ? TimeOfDay(hour: (picked.hour + 1) % 24, minute: 0)
        : TimeOfDay(hour: picked.hour, minute: snapped);
  }

  Future<void> _save() async {
    if (_categories.isEmpty) {
      setState(() => _error = 'Pick at least one thing to be told about.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final api = ref.read(apiClientProvider);
    final categories = _categories.map((c) => c.wire).toList();
    try {
      if (_isNew) {
        await api.createNotificationSchedule(
          label: _label.text.trim().isEmpty
              ? 'Daily brief'
              : _label.text.trim(),
          sendAt: _sendAtWire,
          timezone: _timezone,
          weekdayMask: _weekdayMask,
          startOffsetDays: _startOffsetDays,
          horizonDays: _horizonDays,
          categories: categories,
          skipWhenEmpty: _skipWhenEmpty,
        );
      } else {
        await api.updateNotificationSchedule(
          widget.schedule!.id,
          label: _label.text.trim().isEmpty
              ? 'Daily brief'
              : _label.text.trim(),
          sendAt: _sendAtWire,
          weekdayMask: _weekdayMask,
          startOffsetDays: _startOffsetDays,
          horizonDays: _horizonDays,
          categories: categories,
          skipWhenEmpty: _skipWhenEmpty,
        );
      }
      ref.invalidate(notificationSchedulesProvider);
      if (mounted) Navigator.of(context).pop();
    } catch (err) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = '$err';
        });
      }
    }
  }

  Future<void> _sendTest() async {
    final schedule = widget.schedule;
    if (schedule == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final margin = snackBarMarginAboveNav(context);
    try {
      final result = await ref
          .read(apiClientProvider)
          .testNotificationSchedule(schedule.id);
      final digest = result['digest'] as Map<String, dynamic>?;
      final total = digest?['total'] as int? ?? 0;
      final delivered = result['delivered'] as int? ?? 0;
      final skipped = result['skipped'] as String?;
      final failures = (result['failures'] as List<dynamic>?)?.cast<String>();
      messenger.showSnackBar(
        SnackBar(
          content: Text(switch (skipped) {
            'no_devices' =>
              'Nothing to send to — turn push notifications on first.',
            _ when failures != null && failures.isNotEmpty =>
              'APNs rejected it: ${failures.join(', ')}',
            _ =>
              total == 0
                  ? 'Nothing outstanding right now. Sent to $delivered device(s).'
                  : '$total outstanding. Sent to $delivered device(s).',
          }),
          margin: margin,
        ),
      );
    } catch (err) {
      messenger.showSnackBar(
        SnackBar(content: Text('Test failed: $err'), margin: margin),
      );
    }
  }

  Future<void> _delete() async {
    final schedule = widget.schedule;
    if (schedule == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delete this notification?'),
        content: Text('“${schedule.label}” will stop being sent.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await ref.read(apiClientProvider).deleteNotificationSchedule(schedule.id);
    ref.invalidate(notificationSchedulesProvider);
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 12, 22, 18),
              child: SubPageHeader(
                title: _isNew ? 'New notification' : 'Notification',
                subtitle: _timezone,
              ),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(
                  22,
                  0,
                  22,
                  40 + kBottomNavClearance,
                ),
                children: [
                  Text('NAME', style: AppText.eyebrow()),
                  const SizedBox(height: 10),
                  AppCard(
                    child: TextField(
                      controller: _label,
                      decoration: const InputDecoration(
                        border: InputBorder.none,
                        hintText: 'Evening brief',
                      ),
                    ),
                  ),
                  const SizedBox(height: 22),

                  Text('WHEN', style: AppText.eyebrow()),
                  const SizedBox(height: 10),
                  ClockTimePickerField(
                    label: 'Send at',
                    value: _sendAt,
                    helperText: 'Sent to the quarter hour',
                    onChanged: (picked) =>
                        setState(() => _sendAt = _snapToQuarterHour(picked)),
                  ),
                  const SizedBox(height: 18),

                  Row(
                    children: [
                      Text('DAYS', style: AppText.eyebrow()),
                      const Spacer(),
                      DayPreset(
                        label: 'Every day',
                        onTap: () =>
                            setState(() => _weekdays = {0, 1, 2, 3, 4, 5, 6}),
                      ),
                      const SizedBox(width: 8),
                      DayPreset(
                        label: 'Weekdays',
                        onTap: () =>
                            setState(() => _weekdays = {0, 1, 2, 3, 4}),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (var i = 0; i < 7; i++)
                        DayChip(
                          label: kWeekdayLabels[i],
                          selected: _weekdays.contains(i),
                          onTap: () => setState(
                            () => _weekdays.contains(i)
                                ? _weekdays.remove(i)
                                : _weekdays.add(i),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(height: 22),

                  Text('WHAT IT COVERS', style: AppText.eyebrow()),
                  const SizedBox(height: 10),
                  AppCard(
                    child: Column(
                      children: [
                        _ChoiceRow(
                          label: 'Starts',
                          options: const [(0, 'Today'), (1, 'Tomorrow')],
                          value: _startOffsetDays,
                          onChanged: (v) =>
                              setState(() => _startOffsetDays = v),
                        ),
                        const Divider(height: 20),
                        _ChoiceRow(
                          label: 'Days',
                          options: const [(1, '1'), (2, '2'), (3, '3')],
                          value: _horizonDays,
                          onChanged: (v) => setState(() => _horizonDays = v),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(_coverageSentence, style: AppText.subtitle),
                  const SizedBox(height: 22),

                  Text('TELL ME ABOUT', style: AppText.eyebrow()),
                  const SizedBox(height: 10),
                  AppCard(
                    child: Column(
                      children: [
                        for (final category in NotificationCategory.values) ...[
                          SwitchRow(
                            icon: _categoryIcon(category),
                            iconColor: _categoryColor(category),
                            title: category.label,
                            value: _categories.contains(category),
                            onChanged: (on) => setState(
                              () => on
                                  ? _categories.add(category)
                                  : _categories.remove(category),
                            ),
                          ),
                          if (category != NotificationCategory.values.last)
                            const Divider(height: 20),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                  AppCard(
                    child: SwitchRow(
                      icon: Icons.notifications_paused_rounded,
                      iconColor: AppColors.textMuted,
                      title: 'Only when there is something',
                      subtitle: 'Stay quiet on a clear day',
                      value: _skipWhenEmpty,
                      onChanged: (v) => setState(() => _skipWhenEmpty = v),
                    ),
                  ),

                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    Text(
                      _error!,
                      style: font(kBodyFont, 13, 500, color: AppColors.coral),
                    ),
                  ],

                  const SizedBox(height: 26),
                  PillButton(
                    label: _saving ? 'Saving…' : 'Save',
                    onPressed: _saving ? null : _save,
                    variant: PillVariant.amber,
                  ),
                  if (!_isNew) ...[
                    const SizedBox(height: 12),
                    PillButton(
                      label: 'Send a test now',
                      onPressed: _sendTest,
                      variant: PillVariant.ghost,
                    ),
                    const SizedBox(height: 12),
                    TextButton(
                      onPressed: _delete,
                      child: Text(
                        'Delete notification',
                        style: font(kBodyFont, 13, 600, color: AppColors.coral),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

IconData _categoryIcon(NotificationCategory c) => switch (c) {
  NotificationCategory.conflicts => Icons.warning_amber_rounded,
  NotificationCategory.pendingDecisions => Icons.help_outline_rounded,
  NotificationCategory.unclaimedTasks => Icons.pan_tool_alt_rounded,
  NotificationCategory.myTasks => Icons.check_circle_outline_rounded,
};

Color _categoryColor(NotificationCategory c) => switch (c) {
  NotificationCategory.conflicts => AppColors.coral,
  NotificationCategory.pendingDecisions => AppColors.amber,
  NotificationCategory.unclaimedTasks => AppColors.indigo,
  NotificationCategory.myTasks => AppColors.green,
};

/// A labelled row of mutually exclusive pills (Today/Tomorrow, 1/2/3 days).
class _ChoiceRow extends StatelessWidget {
  const _ChoiceRow({
    required this.label,
    required this.options,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final List<(int, String)> options;
  final int value;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Text(label, style: font(kBodyFont, 14, 600)),
        const Spacer(),
        for (final (optionValue, optionLabel) in options)
          Padding(
            padding: const EdgeInsets.only(left: 8),
            child: DayChip(
              label: optionLabel,
              selected: value == optionValue,
              onTap: () => onChanged(optionValue),
            ),
          ),
      ],
    );
  }
}
