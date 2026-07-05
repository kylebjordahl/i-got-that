// Human-friendly date/time helpers (no intl dependency).

const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _weekdaysLong = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
];
const _weekdaysShort = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const _months = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
const _monthsLong = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/// e.g. "Tuesday · July 1" — the Home / detail subtitle format.
String longDate(DateTime dt) {
  final l = dt.toLocal();
  return '${_weekdaysLong[l.weekday - 1]} · ${_monthsLong[l.month - 1]} ${l.day}';
}

/// e.g. "Tuesday, July 1" — the Plan header format.
String longDateComma(DateTime dt) {
  final l = dt.toLocal();
  return '${_weekdaysLong[l.weekday - 1]}, ${_monthsLong[l.month - 1]} ${l.day}';
}

/// Uppercase 3-letter weekday for the Plan day-scroller ("TUE").
String weekdayShort(DateTime dt) => _weekdaysShort[dt.toLocal().weekday - 1];

/// A time-of-day greeting ("Good morning" / "afternoon" / "evening").
String greeting(DateTime now) {
  final h = now.hour;
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/// e.g. "8:00" / "3:30" — 12-hour clock without the AM/PM suffix (Plan blocks).
String clockShort(DateTime dt) {
  final l = dt.toLocal();
  var h = l.hour % 12;
  if (h == 0) h = 12;
  final m = l.minute.toString().padLeft(2, '0');
  return '$h:$m';
}

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

/// Lowercase relative-day suffix for a count subheading: "today" / "tomorrow" /
/// "on Friday" (within the coming week) / "on Jul 8".
String relativeDayLower(DateTime day, DateTime now) {
  final d = DateTime(day.year, day.month, day.day);
  final t = DateTime(now.year, now.month, now.day);
  final diff = d.difference(t).inDays;
  if (diff == 0) return 'today';
  if (diff == 1) return 'tomorrow';
  if (diff == -1) return 'yesterday';
  if (diff > 1 && diff < 7) return 'on ${_weekdaysLong[d.weekday - 1]}';
  return 'on ${_months[d.month - 1]} ${d.day}';
}

/// Uppercase sticky day-header label for Home: "TODAY · TUE JUL 1" /
/// "TOMORROW · WED JUL 2" / "THU · JUL 3".
String homeDayHeader(DateTime day, DateTime now) {
  final d = DateTime(day.year, day.month, day.day);
  final t = DateTime(now.year, now.month, now.day);
  final diff = d.difference(t).inDays;
  final wd = _weekdaysShort[d.weekday - 1];
  final md = '${_months[d.month - 1].toUpperCase()} ${d.day}';
  if (diff == 0) return 'TODAY · $wd $md';
  if (diff == 1) return 'TOMORROW · $wd $md';
  return '$wd · $md';
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
