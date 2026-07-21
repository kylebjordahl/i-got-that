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
    this.generatesFamilyTasks = true,
    this.userId,
    this.color,
  });

  final String id;
  final String relationName;
  final bool isCaretaker;
  final bool isAdmin;
  final bool requiresCaretaker;

  /// When false, this member's events don't spawn claimable family tasks.
  final bool generatesFamilyTasks;

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
        generatesFamilyTasks: j['generatesFamilyTasks'] as bool? ?? true,
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

/// A login method threaded to the current user (Sign in with Apple, or a
/// magic-link email). Multiple identities resolve to one account — see
/// docs/AUTH.md.
class LoginIdentity {
  LoginIdentity({
    required this.id,
    required this.provider,
    required this.providerRef,
  });

  final String id;
  final String provider; // 'apple' | 'magic_link' | 'google'
  // Apple/Google's opaque subject, or the magic-link email (shown for email).
  final String providerRef;

  String get label => switch (provider) {
        'apple' => 'Sign in with Apple',
        'google' => 'Sign in with Google',
        _ => providerRef,
      };

  String get kindLabel => switch (provider) {
        'apple' => 'Apple',
        'google' => 'Google',
        _ => 'Magic link',
      };

  factory LoginIdentity.fromJson(Map<String, dynamic> j) => LoginIdentity(
        id: j['id'] as String,
        provider: j['provider'] as String,
        providerRef: j['providerRef'] as String,
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
    this.durationOverrideMin,
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

  /// A user-set window length (minutes, signed) for a transition task, measured
  /// from its anchor — the event's start for a drop-off, its end for a pickup.
  /// Null ⇒ the window is the rule-derived default. See [signedDurationMin].
  final int? durationOverrideMin;

  bool get isDismissed => status == 'dismissed';
  bool get isUnowned => status == 'unowned';
  bool get isTransition => type == 'pickup' || type == 'dropoff';

  /// The task's window length in signed minutes from its anchor: the explicit
  /// override when set, otherwise derived from the stored span (a generated
  /// transition always extends forward from its anchor, so it reads positive).
  int get signedDurationMin =>
      durationOverrideMin ??
      (end == null ? 0 : end!.difference(start).inMinutes);

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
        durationOverrideMin: j['durationOverrideMin'] as int?,
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
    this.accountKind,
  });

  final String id;
  final String kind; // 'ics' | 'caldav' | 'google'
  final String mode; // 'standard' | 'exception' | 'busy'
  final String? url;
  final String? sourceCalendarName;
  final String? timezone;
  final String? status;
  // Account-backed feeds only: the linked account's kind ('google' | 'icloud'
  // | 'caldav'), needed to tell an iCloud calendar apart from a generic CalDAV
  // one — both share feed kind 'caldav'. Null for 'ics' feeds.
  final String? accountKind;

  bool get isException => mode == 'exception';

  /// Free/busy firewall feed: opaque availability blocks, google-kind only.
  bool get isBusy => mode == 'busy';

  String get displayName =>
      sourceCalendarName ?? (url != null ? Uri.tryParse(url!)?.host ?? url! : 'Feed');

  /// Human-readable feed source, e.g. "Google Calendar" / "iCloud Calendar" /
  /// "CalDAV Calendar", instead of the raw kind.
  String get sourceLabel => switch (kind) {
        'google' => 'Google Calendar',
        'caldav' => accountKind == 'icloud' ? 'iCloud Calendar' : 'CalDAV Calendar',
        _ => kind.toUpperCase(),
      };

  factory FeedItem.fromJson(Map<String, dynamic> j) => FeedItem(
        id: j['id'] as String,
        kind: j['kind'] as String? ?? 'ics',
        mode: j['mode'] as String,
        url: j['url'] as String?,
        sourceCalendarName: j['sourceCalendarName'] as String?,
        timezone: j['timezone'] as String?,
        status: j['status'] as String?,
        accountKind: j['accountKind'] as String?,
      );
}

/// A feed↔member link. Carries the exception-feed baseline plus the task-gen
/// config synthesis stamps onto the events it produces.
/// A validated/geocoded location. `lat`/`lon` are what let calendar clients
/// (notably Apple Calendar) compute travel time. Mirrors the `GeoLocation`
/// domain schema on the API. Filled by the platform geocoder (MapKit on iOS);
/// null when the user only typed free text.
class GeoLocation {
  const GeoLocation({
    required this.lat,
    required this.lon,
    this.title,
    this.address,
    this.radius,
  });

  final double lat;
  final double lon;
  final String? title;
  final String? address;
  final double? radius;

  factory GeoLocation.fromJson(Map<String, dynamic> j) => GeoLocation(
        lat: (j['lat'] as num).toDouble(),
        lon: (j['lon'] as num).toDouble(),
        title: j['title'] as String?,
        address: j['address'] as String?,
        radius: (j['radius'] as num?)?.toDouble(),
      );

  Map<String, dynamic> toJson() => {
        'lat': lat,
        'lon': lon,
        if (title != null) 'title': title,
        if (address != null) 'address': address,
        if (radius != null) 'radius': radius,
      };
}

class FeedLink {
  FeedLink({
    required this.id,
    required this.familyMemberId,
    required this.active,
    this.memberRelation,
    this.weekdayMask,
    this.dayStart,
    this.dayEnd,
    this.location,
    this.locationGeo,
    this.defaultTaskType = 'transition',
    this.defaultDropoffWindowMin = 15,
    this.defaultPickupWindowMin = 15,
  });

  final String id;
  final String familyMemberId;
  final String? memberRelation;
  final bool active;
  final int? weekdayMask;
  final String? dayStart; // "HH:MM"
  final String? dayEnd;
  final String? location;
  final GeoLocation? locationGeo;

  /// This calendar's task-rule terminal default.
  final String defaultTaskType; // 'transition' | 'attendance'
  final int defaultDropoffWindowMin;
  final int defaultPickupWindowMin;

  factory FeedLink.fromJson(Map<String, dynamic> j) => FeedLink(
        id: j['id'] as String,
        familyMemberId: j['familyMemberId'] as String,
        memberRelation: j['memberRelation'] as String?,
        active: j['active'] as bool? ?? true,
        weekdayMask: j['weekdayMask'] as int?,
        dayStart: j['dayStart'] as String?,
        dayEnd: j['dayEnd'] as String?,
        location: j['location'] as String?,
        locationGeo: j['locationGeo'] == null
            ? null
            : GeoLocation.fromJson(j['locationGeo'] as Map<String, dynamic>),
        defaultTaskType: j['defaultTaskType'] as String? ?? 'transition',
        defaultDropoffWindowMin: j['defaultDropoffWindowMin'] as int? ?? 15,
        defaultPickupWindowMin: j['defaultPickupWindowMin'] as int? ?? 15,
      );
}

/// One rule of a feed's override pipeline (schedule only; first match wins).
class OverrideRule {
  OverrideRule({
    required this.id,
    required this.position,
    required this.matchField,
    required this.matchOp,
    required this.outcome,
    this.matchValue,
    this.params,
  });

  final String id;
  final int position;
  final String matchField; // summary|location|description|any_text|all_day|duration
  final String matchOp; // contains|starts_with|equals|regex|is_true|is_false|gte|lte
  final String? matchValue;
  final String outcome; // cancel_day|modify_day|ignore
  final Map<String, dynamic>? params;

  String get outcomeLabel => switch (outcome) {
        'cancel_day' => 'Cancel day',
        'modify_day' => 'Modify day',
        _ => 'Ignore',
      };

  /// A compact matcher summary, e.g. `Title matches /no school/i`.
  String get matcher => matcherSummary(matchField, matchOp, matchValue);

  factory OverrideRule.fromJson(Map<String, dynamic> j) => OverrideRule(
        id: j['id'] as String,
        position: j['position'] as int,
        matchField: j['matchField'] as String,
        matchOp: j['matchOp'] as String,
        matchValue: j['matchValue'] as String?,
        outcome: j['outcome'] as String,
        params: j['params'] as Map<String, dynamic>?,
      );
}

/// A shared matcher summary for override + task rules.
String matcherSummary(String matchField, String matchOp, String? matchValue) {
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

/// One rule of a member's task-rule pipeline (6k/6n): what tasks an event makes.
class TaskRule {
  TaskRule({
    required this.id,
    required this.position,
    required this.scope,
    required this.matchField,
    required this.matchOp,
    required this.resultType,
    this.linkId,
    this.matchValue,
    this.dropoffWindowMin,
    this.pickupWindowMin,
  });

  final String id;
  final int position;
  final String scope; // 'this_calendar' | 'all_calendars'
  final String? linkId; // null = the member's unified/direct calendar
  final String matchField;
  final String matchOp;
  final String? matchValue;
  final String resultType; // 'transition' | 'attendance'
  final int? dropoffWindowMin;
  final int? pickupWindowMin;

  bool get isTransition => resultType == 'transition';
  String get resultLabel => isTransition ? 'Drop-off & pickup' : 'Attendance';
  String get scopeLabel => scope == 'all_calendars' ? 'All calendars' : 'This calendar';

  String get matcher => matcherSummary(matchField, matchOp, matchValue);

  factory TaskRule.fromJson(Map<String, dynamic> j) => TaskRule(
        id: j['id'] as String,
        position: j['position'] as int,
        scope: j['scope'] as String,
        linkId: j['linkId'] as String?,
        matchField: j['matchField'] as String,
        matchOp: j['matchOp'] as String,
        matchValue: j['matchValue'] as String?,
        resultType: j['resultType'] as String,
        dropoffWindowMin: j['dropoffWindowMin'] as int?,
        pickupWindowMin: j['pickupWindowMin'] as int?,
      );
}

/// A calendar's terminal default in the task-rule pipeline.
class TaskDefault {
  TaskDefault({
    required this.resultType,
    required this.dropoffWindowMin,
    required this.pickupWindowMin,
  });

  final String resultType;
  final int dropoffWindowMin;
  final int pickupWindowMin;

  factory TaskDefault.fromJson(Map<String, dynamic> j) => TaskDefault(
        resultType: j['defaultResultType'] as String,
        dropoffWindowMin: j['dropoffWindowMin'] as int? ?? 15,
        pickupWindowMin: j['pickupWindowMin'] as int? ?? 15,
      );
}

/// The whole task-rule pipeline for a member + every calendar's default.
class TaskRuleSet {
  TaskRuleSet({required this.rules, required this.unifiedDefault, required this.linkDefaults});

  final List<TaskRule> rules;
  final TaskDefault unifiedDefault;
  final Map<String, TaskDefault> linkDefaults;

  /// Rules that govern one calendar (all_calendars ∪ this-calendar-for-it),
  /// in position order — mirrors the engine's `taskRulesForCalendar`.
  List<TaskRule> forCalendar(String? linkId) {
    final subset = rules
        .where((r) => r.scope == 'all_calendars' || (r.scope == 'this_calendar' && r.linkId == linkId))
        .toList()
      ..sort((a, b) => a.position.compareTo(b.position));
    return subset;
  }

  TaskDefault defaultFor(String? linkId) =>
      linkId == null ? unifiedDefault : (linkDefaults[linkId] ?? unifiedDefault);

  factory TaskRuleSet.fromJson(Map<String, dynamic> j) {
    final defaults = j['defaults'] as Map<String, dynamic>;
    final links = (defaults['links'] as Map<String, dynamic>? ?? const {});
    return TaskRuleSet(
      rules: ((j['rules'] as List?) ?? const [])
          .map((e) => TaskRule.fromJson(e as Map<String, dynamic>))
          .toList(),
      unifiedDefault: TaskDefault.fromJson(defaults['unified'] as Map<String, dynamic>),
      linkDefaults: {
        for (final e in links.entries) e.key: TaskDefault.fromJson(e.value as Map<String, dynamic>),
      },
    );
  }
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
    this.description,
    this.location,
    this.taskId,
  });

  final String id;

  /// Whose unified calendar the event is on (the claimer, for claimed events).
  final String familyMemberId;
  final String provenance; // 'synthesized' | 'human' | 'claimed_task'
  final DateTime start;
  final DateTime? end;
  final bool allDay;
  final String? summary;
  final String? description;
  final String? location;

  /// For claimed_task events: the task this event reflects (the recursion).
  final String? taskId;

  bool get isClaimedTask => provenance == 'claimed_task';
  bool get isHuman => provenance == 'human';

  String get displaySummary => summary ?? 'Event';

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
      description: j['description'] as String?,
      location: j['location'] as String?,
      taskId: j['taskId'] as String?,
    );
  }
}

/// An unmatched exception-feed event awaiting a human decision.
class PendingDecision {
  PendingDecision({
    required this.id,
    required this.feedId,
    required this.linkId,
    required this.familyMemberId,
    required this.start,
    required this.allDay,
    this.end,
    this.summary,
    this.location,
  });

  final String id;
  final String feedId;

  /// The member-feed link whose override pipeline the event fell through —
  /// where a new rule to resolve it would need to live.
  final String linkId;

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
      linkId: j['linkId'] as String,
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
