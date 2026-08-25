import 'package:flutter/widgets.dart';
import '../models.dart';
import '../widgets/time_fields.dart';
import 'assignment_text.dart' show kWeekdayLabels;

/// One-line summary of a schedule for the Me screen row: when it goes out, what
/// it covers, and how many kinds of thing it counts.
///
/// e.g. "Weekdays · 8:00 PM · tomorrow · 3 kinds". Takes a [BuildContext] so the
/// send time reads in the viewer's own clock convention — the stored `HH:MM` is
/// an API detail, not what anyone should be shown.
String describeSchedule(BuildContext context, NotificationSchedule s) {
  final parts = <String>[_days(s), _time(context, s.sendAt), _coverage(s)];
  if (s.categories.length != NotificationCategory.values.length) {
    parts.add(
      s.categories.length == 1
          ? s.categories.single.shortLabel
          : '${s.categories.length} kinds',
    );
  }
  if (!s.enabled) parts.add('paused');
  return parts.join(' · ');
}

String _days(NotificationSchedule s) {
  if (s.isEveryDay) return 'Every day';
  if (s.isWeekdaysOnly) return 'Weekdays';
  final days = s.weekdays;
  if (days.isEmpty) return 'Never';
  return days.map((d) => kWeekdayLabels[d]).join(', ');
}

String _time(BuildContext context, String sendAt) {
  final time = parseClockTime(sendAt);
  return time == null ? sendAt : formatClockTimeForDisplay(context, time);
}

String _coverage(NotificationSchedule s) {
  if (s.horizonDays > 1) {
    return '${s.horizonDays} days from '
        '${s.startOffsetDays == 0 ? 'today' : 'tomorrow'}';
  }
  return s.startOffsetDays == 0 ? 'rest of today' : 'tomorrow';
}
