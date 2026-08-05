import '../models.dart';

/// Shared wording for assignment rules — used by the rules screen and by the
/// task sheet, which names the rule responsible for an auto-assignment.

/// Monday-first weekday labels, matching a rule's `weekdayMask` bit order.
const kWeekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/// Human-readable one-liner describing who a rule assigns and when.
String describeRule(
  AssignmentRule r,
  List<Member> members,
  List<FeedItem> feeds,
  List<AssignmentLink> links,
) {
  String memberName(String? id) =>
      members.where((m) => m.id == id).map((m) => m.relationName).firstOrNull ??
      'someone';

  final parts = <String>[];
  parts.add(switch (r.taskType) {
    'pickup' => 'Pickup',
    'dropoff' => 'Drop-off',
    'attendance' => 'Attendance',
    _ => 'All tasks',
  });

  if (r.linkId != null) {
    final link = links.where((l) => l.id == r.linkId).firstOrNull;
    final feed = feeds.where((f) => f.id == link?.feedId).firstOrNull;
    parts.add('from ${feed?.displayName ?? 'a feed'}');
  } else if (r.aboutMemberId != null) {
    parts.add('for ${memberName(r.aboutMemberId)}');
  } else {
    parts.add('for any child');
  }

  final days = r.weekdays;
  if (days.isEmpty) {
    parts.add('any day');
  } else if (days.length == 7) {
    parts.add('every day');
  } else {
    parts.add(days.map((d) => kWeekdayLabels[d]).join(', '));
  }
  if (r.isBiweekly) parts.add('every other week');

  return parts.join(' · ');
}
