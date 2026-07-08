// Light models over the API's JSON. (Replaced by generated models later.)

/// Parse a task/event timestamp to **local** time. The API sends `dtstart` as a
/// UTC ISO string (a `timestamp_ms` column serialized to JSON), so `DateTime.parse`
/// yields a UTC instant — normalise to local so `.hour`/positioning line up with
/// the clock the user sees. (Epoch-int values are already local.)
DateTime parseTimestamp(Object? v) => v is int
    ? DateTime.fromMillisecondsSinceEpoch(v)
    : DateTime.parse(v as String).toLocal();

/// All-day events are anchored to UTC midnight of their calendar date by the
/// backend. Read the UTC date parts and rebuild them as a *local* midnight so
/// day-grouping/headings land on the right day and never shift by the device's
/// timezone offset (which was turning a Friday holiday into Thursday 5 PM).
DateTime parseAllDayDate(Object? v) {
  final utc = v is int
      ? DateTime.fromMillisecondsSinceEpoch(v, isUtc: true)
      : DateTime.parse(v as String).toUtc();
  return DateTime(utc.year, utc.month, utc.day);
}

class Member {
  Member({
    required this.id,
    required this.relationName,
    required this.isCaretaker,
    required this.isAdmin,
    required this.requiresCaretaker,
    this.userId,
    this.color,
  });

  final String id;
  final String relationName;
  final bool isCaretaker;
  final bool isAdmin;
  final bool requiresCaretaker;

  /// The linked login account, if any. Null ⇒ can be invited to claim this slot.
  final String? userId;

  /// Persistent accent color as a `#RRGGBB` hex string. Null ⇒ derived from id
  /// (see `theme/person_colors.dart`).
  final String? color;

  bool get hasLogin => userId != null;

  factory Member.fromJson(Map<String, dynamic> j) => Member(
        id: j['id'] as String,
        relationName: j['relationName'] as String,
        isCaretaker: j['isCaretaker'] as bool? ?? false,
        isAdmin: j['isAdmin'] as bool? ?? false,
        requiresCaretaker: j['requiresCaretaker'] as bool? ?? false,
        userId: j['userId'] as String?,
        color: j['color'] as String?,
      );
}

/// A user-owned external calendar account (Google / iCloud / CalDAV), reusable
/// across the user's families. Credentials never come back from the API.
class ExternalAccount {
  ExternalAccount({
    required this.id,
    required this.kind,
    required this.name,
    this.serverUrl,
    this.username,
  });

  final String id;
  final String kind; // 'google' | 'icloud' | 'caldav'
  final String name;
  final String? serverUrl;
  final String? username;

  String get kindLabel => switch (kind) {
        'google' => 'Google',
        'icloud' => 'iCloud',
        _ => 'CalDAV',
      };

  /// The mirror method an account of this kind produces (google→google, else caldav).
  String get method => kind == 'google' ? 'google' : 'caldav';

  factory ExternalAccount.fromJson(Map<String, dynamic> j) => ExternalAccount(
        id: j['id'] as String,
        kind: j['kind'] as String,
        name: j['name'] as String,
        serverUrl: j['serverUrl'] as String?,
        username: j['username'] as String?,
      );
}

class TaskItem {
  TaskItem({
    required this.id,
    required this.familyMemberId,
    required this.type,
    required this.start,
    required this.status,
    required this.createdVia,
    this.end,
    this.location,
    this.ownerMemberId,
    this.calendarEventId,
  });

  final String id;

  /// The member the task is *about* (the event's calendar owner) — distinct
  /// from [ownerMemberId], the caretaker who claimed it.
  final String familyMemberId;
  final String type;
  final DateTime start;
  final DateTime? end;
  final String? location;
  final String status;
  final String createdVia; // 'generated' | 'manual'
  final String? ownerMemberId;

  /// The unified-calendar event this task was generated from (null for
  /// fully-manual tasks).
  final String? calendarEventId;

  bool get isDismissed => status == 'dismissed';
  bool get isUnowned => status == 'unowned';

  factory TaskItem.fromJson(Map<String, dynamic> j) => TaskItem(
        id: j['id'] as String,
        familyMemberId: j['familyMemberId'] as String,
        type: j['type'] as String,
        start: parseTimestamp(j['dtstart']),
        end: j['dtend'] == null ? null : parseTimestamp(j['dtend']),
        location: j['location'] as String?,
        status: j['status'] as String,
        createdVia: j['createdVia'] as String? ?? 'generated',
        ownerMemberId: j['ownerMemberId'] as String?,
        calendarEventId: j['calendarEventId'] as String?,
      );

  String get typeLabel => switch (type) {
        'pickup' => 'Pickup',
        'dropoff' => 'Drop-off',
        _ => 'Attendance',
      };
}

/// An input feed (calendar source) as returned by the API.
class FeedItem {
  FeedItem({
    required this.id,
    required this.kind,
    required this.mode,
    this.url,
    this.sourceCalendarName,
    this.timezone,
    this.status,
  });

  final String id;
  final String kind; // 'ics' | 'caldav' | 'google'
  final String mode; // 'standard' | 'exception'
  final String? url;
  final String? sourceCalendarName;
  final String? timezone;
  final String? status;

  bool get isException => mode == 'exception';

  String get displayName =>
      sourceCalendarName ?? (url != null ? Uri.tryParse(url!)?.host ?? url! : 'Feed');

  factory FeedItem.fromJson(Map<String, dynamic> j) => FeedItem(
        id: j['id'] as String,
        kind: j['kind'] as String? ?? 'ics',
        mode: j['mode'] as String,
        url: j['url'] as String?,
        sourceCalendarName: j['sourceCalendarName'] as String?,
        timezone: j['timezone'] as String?,
        status: j['status'] as String?,
      );
}

/// A feed↔member link. Carries the exception-feed baseline plus the task-gen
/// config synthesis stamps onto the events it produces.
class FeedLink {
  FeedLink({
    required this.id,
    required this.familyMemberId,
    required this.active,
    this.memberRelation,
    this.weekdayMask,
    this.dayStart,
    this.dayEnd,
    this.durationMinutes,
    this.location,
    this.generatesTypes,
    this.defaultAttendance,
  });

  final String id;
  final String familyMemberId;
  final String? memberRelation;
  final bool active;
  final int? weekdayMask;
  final String? dayStart; // "HH:MM"
  final String? dayEnd;
  final int? durationMinutes;
  final String? location;
  final List<String>? generatesTypes;
  final String? defaultAttendance;

  factory FeedLink.fromJson(Map<String, dynamic> j) => FeedLink(
        id: j['id'] as String,
        familyMemberId: j['familyMemberId'] as String,
        memberRelation: j['memberRelation'] as String?,
        active: j['active'] as bool? ?? true,
        weekdayMask: j['weekdayMask'] as int?,
        dayStart: j['dayStart'] as String?,
        dayEnd: j['dayEnd'] as String?,
        durationMinutes: j['durationMinutes'] as int?,
        location: j['location'] as String?,
        generatesTypes: (j['generatesTypes'] as List?)?.cast<String>(),
        defaultAttendance: j['defaultAttendance'] as String?,
      );
}

/// One rule of a link's override pipeline (first match wins by [position]).
class OverrideRule {
  OverrideRule({
    required this.id,
    required this.position,
    required this.matchField,
    required this.matchOp,
    required this.outcome,
    this.matchValue,
    this.params,
    this.generatesTypes,
    this.defaultAttendance,
  });

  final String id;
  final int position;
  final String matchField; // summary|location|description|any_text|all_day|duration
  final String matchOp; // contains|starts_with|equals|regex|is_true|is_false|gte|lte
  final String? matchValue;
  final String outcome; // cancel_day|modify_day|annotate|set_event
  final Map<String, dynamic>? params;
  final List<String>? generatesTypes;
  final String? defaultAttendance;

  String get outcomeLabel => switch (outcome) {
        'cancel_day' => 'Cancel day',
        'modify_day' => 'Modify day',
        'annotate' => 'Annotate',
        _ => 'Set event',
      };

  /// A compact matcher summary, e.g. `Title matches /no school/i`.
  String get matcherSummary {
    final field = switch (matchField) {
      'summary' => 'Title',
      'location' => 'Location',
      'description' => 'Description',
      'any_text' => 'Any text',
      'all_day' => 'All-day',
      _ => 'Duration',
    };
    return switch (matchOp) {
      'contains' => '$field contains "$matchValue"',
      'starts_with' => '$field starts with "$matchValue"',
      'equals' => '$field equals "$matchValue"',
      'regex' => '$field matches $matchValue',
      'is_true' => '$field is true',
      'is_false' => '$field is false',
      'gte' => '$field ≥ $matchValue min',
      _ => '$field ≤ $matchValue min',
    };
  }

  factory OverrideRule.fromJson(Map<String, dynamic> j) => OverrideRule(
        id: j['id'] as String,
        position: j['position'] as int,
        matchField: j['matchField'] as String,
        matchOp: j['matchOp'] as String,
        matchValue: j['matchValue'] as String?,
        outcome: j['outcome'] as String,
        params: j['params'] as Map<String, dynamic>?,
        generatesTypes: (j['generatesTypes'] as List?)?.cast<String>(),
        defaultAttendance: j['defaultAttendance'] as String?,
      );
}

/// An event on a member's unified calendar (what Plan renders).
class CalendarEventItem {
  CalendarEventItem({
    required this.id,
    required this.familyMemberId,
    required this.provenance,
    required this.start,
    required this.allDay,
    this.end,
    this.summary,
    this.location,
    this.annotation,
    this.taskId,
    this.generatesTypes,
  });

  final String id;

  /// Whose unified calendar the event is on (the claimer, for claimed events).
  final String familyMemberId;
  final String provenance; // 'synthesized' | 'human' | 'claimed_task'
  final DateTime start;
  final DateTime? end;
  final bool allDay;
  final String? summary;
  final String? location;

  /// Note stamped by an annotate rule ("Photo Day").
  final String? annotation;

  /// For claimed_task events: the task this event reflects (the recursion).
  final String? taskId;
  final List<String>? generatesTypes;

  bool get isClaimedTask => provenance == 'claimed_task';
  bool get isHuman => provenance == 'human';

  String get displaySummary {
    final base = summary ?? 'Event';
    return annotation != null ? '$base · $annotation' : base;
  }

  factory CalendarEventItem.fromJson(Map<String, dynamic> j) {
    final allDay = j['allDay'] as bool? ?? false;
    return CalendarEventItem(
      id: j['id'] as String,
      familyMemberId: j['familyMemberId'] as String,
      provenance: j['provenance'] as String,
      allDay: allDay,
      start: allDay ? parseAllDayDate(j['dtstart']) : parseTimestamp(j['dtstart']),
      end: j['dtend'] == null ? null : parseTimestamp(j['dtend']),
      summary: j['summary'] as String?,
      location: j['location'] as String?,
      annotation: j['annotation'] as String?,
      taskId: j['taskId'] as String?,
      generatesTypes: (j['generatesTypes'] as List?)?.cast<String>(),
    );
  }
}

/// An unmatched exception-feed event awaiting a human decision.
class PendingDecision {
  PendingDecision({
    required this.id,
    required this.feedId,
    required this.familyMemberId,
    required this.start,
    required this.allDay,
    this.end,
    this.summary,
    this.location,
  });

  final String id;
  final String feedId;

  /// The member whose calendar the event would land on.
  final String familyMemberId;
  final DateTime start;
  final DateTime? end;
  final bool allDay;
  final String? summary;
  final String? location;

  factory PendingDecision.fromJson(Map<String, dynamic> j) {
    final allDay = j['allDay'] as bool? ?? false;
    return PendingDecision(
      id: j['id'] as String,
      feedId: j['feedId'] as String,
      familyMemberId: j['familyMemberId'] as String,
      allDay: allDay,
      start: allDay ? parseAllDayDate(j['dtstart']) : parseTimestamp(j['dtstart']),
      end: j['dtend'] == null ? null : parseTimestamp(j['dtend']),
      summary: j['summary'] as String?,
      location: j['location'] as String?,
    );
  }
}

/// A member's designated unified-calendar target (the write-through mirror).
class MemberCalendarConfig {
  MemberCalendarConfig({
    required this.id,
    required this.familyMemberId,
    required this.targetMethod,
    required this.targetCalendarId,
    required this.active,
    this.targetExternalAccountId,
    this.targetCalendarName,
    this.alertMinutes,
  });

  final String id;
  final String familyMemberId;
  final String? targetExternalAccountId;
  final String targetMethod; // 'caldav' | 'google'
  final String targetCalendarId;
  final String? targetCalendarName;
  final List<int>? alertMinutes;
  final bool active;

  String get methodLabel => targetMethod == 'google' ? 'Google' : 'iCloud / CalDAV';

  factory MemberCalendarConfig.fromJson(Map<String, dynamic> j) => MemberCalendarConfig(
        id: j['id'] as String,
        familyMemberId: j['familyMemberId'] as String,
        targetExternalAccountId: j['targetExternalAccountId'] as String?,
        targetMethod: j['targetMethod'] as String,
        targetCalendarId: j['targetCalendarId'] as String,
        targetCalendarName: j['targetCalendarName'] as String?,
        alertMinutes: (j['alertMinutes'] as List?)?.cast<int>(),
        active: j['active'] as bool? ?? true,
      );
}

/// A raw event from a calendar feed (shown in feed-oversight views).
class SourceEventItem {
  SourceEventItem({
    required this.id,
    required this.feedId,
    required this.start,
    required this.allDay,
    required this.dismissed,
    this.summary,
    this.location,
  });

  final String id;
  final String feedId;
  final DateTime start;

  /// True for all-day events: render as a bare date, not a clock time.
  final bool allDay;
  final bool dismissed;
  final String? summary;
  final String? location;

  factory SourceEventItem.fromJson(Map<String, dynamic> j) {
    final allDay = j['allDay'] as bool? ?? false;
    return SourceEventItem(
      id: j['id'] as String,
      feedId: j['feedId'] as String,
      allDay: allDay,
      start: allDay ? parseAllDayDate(j['dtstart']) : parseTimestamp(j['dtstart']),
      dismissed: j['dismissedAt'] != null,
      summary: j['summary'] as String?,
      location: j['location'] as String?,
    );
  }
}
