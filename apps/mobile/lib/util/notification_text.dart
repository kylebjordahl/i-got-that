import '../models.dart';
import 'assignment_text.dart' show kWeekdayLabels;

/// One-line summary of a schedule for the Me screen row: when it goes out, what
/// it covers, and how many kinds of thing it counts.
///
/// e.g. "Weekdays · 8:00 PM · tomorrow · 3 kinds"
String describeSchedule(NotificationSchedule s) {
  final parts = <String>[_days(s), _time(s.sendAt), _coverage(s)];
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

/// 24h `HH:MM` from the API rendered as a 12-hour clock, matching the rest of
/// the app's time copy.
String _time(String sendAt) {
  final parts = sendAt.split(':');
  final hour = int.tryParse(parts.first) ?? 0;
  final minute = parts.length > 1 ? parts[1] : '00';
  final suffix = hour < 12 ? 'AM' : 'PM';
  final display = hour % 12 == 0 ? 12 : hour % 12;
  return '$display:$minute $suffix';
}

String _coverage(NotificationSchedule s) {
  if (s.horizonDays > 1) {
    return '${s.horizonDays} days from '
        '${s.startOffsetDays == 0 ? 'today' : 'tomorrow'}';
  }
  return s.startOffsetDays == 0 ? 'rest of today' : 'tomorrow';
}
