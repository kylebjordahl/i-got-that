// Light models over the API's JSON. (Replaced by generated models later.)

DateTime parseTimestamp(Object? v) =>
    v is int ? DateTime.fromMillisecondsSinceEpoch(v) : DateTime.parse(v as String);

class Member {
  Member({
    required this.id,
    required this.relationName,
    required this.isCaretaker,
    required this.isAdmin,
    required this.requiresCaretaker,
  });

  final String id;
  final String relationName;
  final bool isCaretaker;
  final bool isAdmin;
  final bool requiresCaretaker;

  factory Member.fromJson(Map<String, dynamic> j) => Member(
        id: j['id'] as String,
        relationName: j['relationName'] as String,
        isCaretaker: j['isCaretaker'] as bool? ?? false,
        isAdmin: j['isAdmin'] as bool? ?? false,
        requiresCaretaker: j['requiresCaretaker'] as bool? ?? false,
      );
}

class TaskItem {
  TaskItem({
    required this.id,
    required this.familyMemberId,
    required this.type,
    required this.start,
    required this.status,
    this.ownerMemberId,
    this.sourceEventId,
  });

  final String id;
  final String familyMemberId;
  final String type;
  final DateTime start;
  final String status;
  final String? ownerMemberId;

  /// The feed event this task was generated from (null for baseline/manual).
  final String? sourceEventId;

  bool get isDismissed => status == 'dismissed';

  factory TaskItem.fromJson(Map<String, dynamic> j) => TaskItem(
        id: j['id'] as String,
        familyMemberId: j['familyMemberId'] as String,
        type: j['type'] as String,
        start: parseTimestamp(j['dtstart']),
        status: j['status'] as String,
        ownerMemberId: j['ownerMemberId'] as String?,
        sourceEventId: j['sourceEventId'] as String?,
      );

  String get typeLabel => switch (type) {
        'pickup' => 'Pickup',
        'dropoff' => 'Drop-off',
        _ => 'Attendance',
      };
}

/// A raw event from a calendar feed (shown in the oversight "All" view).
class SourceEventItem {
  SourceEventItem({
    required this.id,
    required this.feedId,
    required this.start,
    required this.dismissed,
    this.summary,
    this.location,
  });

  final String id;
  final String feedId;
  final DateTime start;
  final bool dismissed;
  final String? summary;
  final String? location;

  factory SourceEventItem.fromJson(Map<String, dynamic> j) => SourceEventItem(
        id: j['id'] as String,
        feedId: j['feedId'] as String,
        start: parseTimestamp(j['dtstart']),
        dismissed: j['dismissedAt'] != null,
        summary: j['summary'] as String?,
        location: j['location'] as String?,
      );
}
