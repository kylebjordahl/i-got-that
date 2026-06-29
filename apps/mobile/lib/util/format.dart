// Human-friendly date/time helpers (no intl dependency).

const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _months = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/// Local date with time zeroed — used as a grouping key by day.
DateTime dayKey(DateTime dt) {
  final l = dt.toLocal();
  return DateTime(l.year, l.month, l.day);
}

/// e.g. "3:00 PM", "8:05 AM".
String friendlyTime(DateTime dt) {
  final l = dt.toLocal();
  final period = l.hour < 12 ? 'AM' : 'PM';
  var h = l.hour % 12;
  if (h == 0) h = 12;
  final m = l.minute.toString().padLeft(2, '0');
  return '$h:$m $period';
}

/// "Today" / "Tomorrow" / "Yesterday", else "Wed, Jul 8".
String dayHeading(DateTime day, DateTime now) {
  final d = DateTime(day.year, day.month, day.day);
  final t = DateTime(now.year, now.month, now.day);
  switch (d.difference(t).inDays) {
    case 0:
      return 'Today';
    case 1:
      return 'Tomorrow';
    case -1:
      return 'Yesterday';
  }
  return '${_weekdays[d.weekday - 1]}, ${_months[d.month - 1]} ${d.day}';
}
