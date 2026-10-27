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
    this.homeLocation,
    this.homeLocationGeo,
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

  /// Where this person's day starts and ends, as displayed.
  final String? homeLocation;

  /// Home's coordinates. The backend measures travel time from here when a
  /// drop-off/pickup has no earlier event to leave from; free text alone can't.
  final GeoLocation? homeLocationGeo;

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
    homeLocation: j['homeLocation'] as String?,
    homeLocationGeo: j['homeLocationGeo'] == null
        ? null
        : GeoLocation.fromJson(
            (j['homeLocationGeo'] as Map).cast<String, dynamic>(),
          ),
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
    this.authFailedAt,
  });

  final String id;
  final String kind; // 'google' | 'icloud' | 'caldav'
  final String name;
  final String? serverUrl;
  final String? username;

  /// When a sync through this account started failing in a way only
  /// reconnecting fixes (an expired/revoked grant, a missing permission).
  /// Null while it's healthy.
  final DateTime? authFailedAt;

  /// The account needs its owner to sign in to it again.
  bool get needsReconnect => authFailedAt != null;

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
    authFailedAt: DateTime.tryParse(j['authFailedAt'] as String? ?? ''),
  );
}

/// One input feed still drawing from an account pending disconnect, and every
/// member it feeds — the audit shown before a forced disconnect turns it off.
class AccountUsageFeed {
  AccountUsageFeed({
    required this.id,
    required this.name,
    required this.members,
  });

  final String id;
  final String? name;
  final List<String> members;

  factory AccountUsageFeed.fromJson(Map<String, dynamic> j) => AccountUsageFeed(
    id: j['id'] as String,
    name: j['name'] as String?,
    members: (j['members'] as List).cast<String>(),
  );
}

/// One delivery target still drawing from an account pending disconnect.
class AccountUsageTarget {
  AccountUsageTarget({
    required this.id,
    required this.name,
    required this.member,
  });

  final String id;
  final String? name;
  final String member;

  factory AccountUsageTarget.fromJson(Map<String, dynamic> j) =>
      AccountUsageTarget(
        id: j['id'] as String,
        name: j['name'] as String?,
        member: j['member'] as String,
      );
}

/// Everything still linked to an account — the disconnect confirm sheet's
/// audit, and (via `force=true`) the exact set a disconnect turns off.
class AccountUsage {
  AccountUsage({required this.feeds, required this.targets});

  final List<AccountUsageFeed> feeds;
  final List<AccountUsageTarget> targets;

  bool get isEmpty => feeds.isEmpty && targets.isEmpty;
  int get itemCount => feeds.length + targets.length;

  factory AccountUsage.fromJson(Map<String, dynamic> j) => AccountUsage(
    feeds: (j['feeds'] as List)
        .map((e) => AccountUsageFeed.fromJson(e as Map<String, dynamic>))
        .toList(),
    targets: (j['targets'] as List)
        .map((e) => AccountUsageTarget.fromJson(e as Map<String, dynamic>))
        .toList(),
  );
}

/// A family named in an [AccountDeletionPlan]. [relationName] is the user's
/// own role there (only sent for families that survive).
class PlannedFamily {
  PlannedFamily({required this.id, required this.name, this.relationName});

  final String id;
  final String name;
  final String? relationName;

  factory PlannedFamily.fromJson(Map<String, dynamic> j) => PlannedFamily(
    id: j['id'] as String,
    name: j['name'] as String,
    relationName: j['relationName'] as String?,
  );
}

/// What deleting the signed-in account would do: whether it is allowed, which
/// families are deleted along with it (nobody else can log in to them), and
/// which survive with the user's member row kept but unlinked.
class AccountDeletionPlan {
  AccountDeletionPlan({
    required this.deletable,
    this.deletesFamilies = const [],
    this.keepsFamilies = const [],
  });

  final bool deletable;
  final List<PlannedFamily> deletesFamilies;
  final List<PlannedFamily> keepsFamilies;

  factory AccountDeletionPlan.fromJson(Map<String, dynamic> j) =>
      AccountDeletionPlan(
        deletable: j['deletable'] as bool,
        deletesFamilies: _plannedFamilies(j['deletesFamilies']),
        keepsFamilies: _plannedFamilies(j['keepsFamilies']),
      );

  static List<PlannedFamily> _plannedFamilies(Object? v) => (v as List? ?? [])
      .map((e) => PlannedFamily.fromJson(e as Map<String, dynamic>))
      .toList();
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
    this.ownerMemberIds = const [],
    this.calendarEventId,
    this.durationOverrideMin,
    this.autoAssignedRuleId,
  });

  final String id;

  /// The member the task is *about* (the event's calendar owner) — distinct
  /// from [ownerMemberIds], the caretakers covering it.
  final String familyMemberId;
  final String type;
  final DateTime start;
  final DateTime? end;
  final String? location;
  final String status;
  final String createdVia; // 'generated' | 'manual'

  /// The caretakers covering this task, oldest claim first. An attendance task
  /// can be several people's at once (both parents at the recital); a drop-off
  /// or pickup is one person's trip, so it never holds more than one.
  final List<String> ownerMemberIds;

  /// The unified-calendar event this task was generated from (null for
  /// fully-manual tasks).
  final String? calendarEventId;

  /// A user-set window length (minutes, signed) for a transition task, measured
  /// from its anchor — the event's start for a drop-off, its end for a pickup.
  /// Null ⇒ the window is the rule-derived default. See [signedDurationMin].
  final int? durationOverrideMin;

  /// The assignment rule that auto-claimed this task, when one did. Null ⇒ the
  /// owner (if any) is a human claim, so the UI can tell the two apart and name
  /// the responsible rule. Cleared the moment anyone claims/unassigns by hand.
  final String? autoAssignedRuleId;

  /// The first caretaker covering this task, for the places that show a single
  /// person — a transition's claimant, an accent colour, a day dot. Use
  /// [ownerMemberIds] wherever the whole set matters.
  String? get ownerMemberId =>
      ownerMemberIds.isEmpty ? null : ownerMemberIds.first;

  bool get isDismissed => status == 'dismissed';
  bool get isUnowned => status == 'unowned';
  bool get isTransition => type == 'pickup' || type == 'dropoff';

  /// Owned because a rule matched, rather than because someone claimed it.
  bool get isAutoAssigned => autoAssignedRuleId != null;

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
    ownerMemberIds: (j['ownerMemberIds'] as List<dynamic>? ?? const [])
        .cast<String>(),
    calendarEventId: j['calendarEventId'] as String?,
    durationOverrideMin: j['durationOverrideMin'] as int?,
    autoAssignedRuleId: j['autoAssignedRuleId'] as String?,
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
    this.routed = false,
    this.url,
    this.sourceCalendarName,
    this.timezone,
    this.status,
    this.accountKind,
  });

  final String id;
  final String kind; // 'ics' | 'caldav' | 'google'
  final String mode; // 'standard' | 'exception' | 'busy'

  /// Shared family calendar: one calendar carrying several members' events,
  /// split per member by each link's `keep` rules. A property of the feed —
  /// turning it on from any member's copy routes it for everyone linked.
  final bool routed;
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

  /// A routed shared family calendar (routing only applies to standard feeds).
  bool get isRouted => mode == 'standard' && routed;

  FeedItem copyWith({String? mode, bool? routed, String? sourceCalendarName}) =>
      FeedItem(
        id: id,
        kind: kind,
        mode: mode ?? this.mode,
        routed: routed ?? this.routed,
        url: url,
        sourceCalendarName: sourceCalendarName ?? this.sourceCalendarName,
        timezone: timezone,
        status: status,
        accountKind: accountKind,
      );

  String get displayName =>
      sourceCalendarName ??
      (url != null ? Uri.tryParse(url!)?.host ?? url! : 'Feed');

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
    routed: j['routed'] as bool? ?? false,
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

/// A dated change to an exception link's baseline hours: from [effectiveFrom]
/// on, the normal day runs [dayStart]–[dayEnd] until the next change. Weekday
/// mask and location stay on the link.
class BaselineChange {
  BaselineChange({
    required this.id,
    required this.effectiveFrom,
    required this.dayStart,
    required this.dayEnd,
  });

  final String id;

  /// `YYYY-MM-DD`, a calendar date in the feed's timezone.
  final String effectiveFrom;
  final String dayStart; // "HH:MM"
  final String dayEnd; // "HH:MM"

  /// [effectiveFrom] as a local date (midnight).
  DateTime get date => DateTime.parse(effectiveFrom);

  factory BaselineChange.fromJson(Map<String, dynamic> j) => BaselineChange(
    id: j['id'] as String,
    effectiveFrom: j['effectiveFrom'] as String,
    dayStart: j['dayStart'] as String,
    dayEnd: j['dayEnd'] as String,
  );
}

/// The `YYYY-MM-DD` wire form of a local date.
String formatLocalDate(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-'
    '${d.month.toString().padLeft(2, '0')}-'
    '${d.day.toString().padLeft(2, '0')}';

class FeedLink {
  FeedLink({
    required this.id,
    required this.familyMemberId,
    required this.active,
    this.position = 0,
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
  // Priority rank of this feed within the member's calendar (0 = highest);
  // breaks conflict ties. Manual events always outrank feeds.
  final int position;
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
    position: j['position'] as int? ?? 0,
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
  final String
  matchField; // summary|location|description|any_text|all_day|duration
  final String
  matchOp; // contains|starts_with|equals|regex|is_true|is_false|gte|lte
  final String? matchValue;
  final String outcome; // cancel_day|modify_day|ignore|add_event|keep
  final Map<String, dynamic>? params;

  String get outcomeLabel => switch (outcome) {
    'cancel_day' => 'Cancel day',
    'modify_day' => 'Modify day',
    'add_event' => 'Add event',
    'keep' => 'Route here',
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

/// What a task-rule result makes an event generate, as the rule editor says it.
String taskResultLabel(String resultType) => switch (resultType) {
  'transition' => 'Drop-off & pickup',
  'none' => 'No tasks',
  _ => 'Attendance',
};

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
  final String resultType; // 'transition' | 'attendance' | 'none'
  final int? dropoffWindowMin;
  final int? pickupWindowMin;

  bool get isTransition => resultType == 'transition';

  /// A rule that ignores the event: it stays on the calendar with no tasks.
  bool get isNone => resultType == 'none';
  String get resultLabel => taskResultLabel(resultType);
  String get scopeLabel =>
      scope == 'all_calendars' ? 'All calendars' : 'This calendar';

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

/// One event a task rule's matcher catches (its match list or an editor
/// preview), and how the member's pipeline resolves it.
class TaskRuleMatch {
  TaskRuleMatch({
    required this.eventId,
    required this.start,
    required this.allDay,
    required this.status,
    required this.resultType,
    required this.converted,
    this.end,
    this.summary,
    this.linkId,
    this.decidedByRuleId,
    this.tasks,
  });

  final String eventId;
  final DateTime start;
  final DateTime? end;
  final bool allDay;
  final String? summary;
  final String? linkId; // null = the member's unified/direct calendar

  /// 'applies' (this rule decides it), 'shadowed' (an earlier rule does) or
  /// 'omitted' (excepted from this rule, so it falls through).
  final String status;

  /// The rule that actually decides the event; null ⇒ its calendar's default.
  final String? decidedByRuleId;

  /// What the event generates: 'transition' | 'attendance' | 'none'.
  final String resultType;

  /// Its tasks were converted by hand, so no rule changes them.
  final bool converted;

  /// The event's current tasks (null in an editor preview).
  final List<TaskItem>? tasks;

  bool get applies => status == 'applies';
  bool get shadowed => status == 'shadowed';
  bool get omitted => status == 'omitted';
  String get displaySummary => summary ?? 'Event';

  factory TaskRuleMatch.fromJson(Map<String, dynamic> j) {
    final e = j['event'] as Map<String, dynamic>;
    final allDay = e['allDay'] as bool? ?? false;
    return TaskRuleMatch(
      eventId: e['id'] as String,
      allDay: allDay,
      start: allDay
          ? parseAllDayDate(e['dtstart'])
          : parseTimestamp(e['dtstart']),
      end: e['dtend'] == null
          ? null
          : (allDay ? parseAllDayDate(e['dtend']) : parseTimestamp(e['dtend'])),
      summary: e['summary'] as String?,
      linkId: e['linkId'] as String?,
      status: j['status'] as String,
      decidedByRuleId: j['decidedByRuleId'] as String?,
      resultType: j['resultType'] as String,
      converted: j['converted'] as bool? ?? false,
      tasks: (j['tasks'] as List?)
          ?.map((t) => TaskItem.fromJson(t as Map<String, dynamic>))
          .toList(),
    );
  }
}

/// A family auto-assignment rule (issue #24): when a generated task matches, it
/// is claimed for [ownerMemberId]. Targeting filters ([aboutMemberId], [linkId],
/// [taskType]) are ANDed and each is optional (null = "any"). The recurrence
/// pattern ([weekdayMask] + [cadenceWeeks]/[anchorDate]) is inline — a pattern is
/// never a resource the user manages separately.
class AssignmentRule {
  AssignmentRule({
    required this.id,
    required this.position,
    required this.ownerMemberId,
    required this.weekdayMask,
    required this.cadenceWeeks,
    this.aboutMemberId,
    this.linkId,
    this.taskType,
    this.anchorDate,
  });

  final String id;
  final int position;
  final String ownerMemberId;
  final String? aboutMemberId;
  final String? linkId;
  final String? taskType; // 'pickup' | 'dropoff' | 'attendance' | null (any)
  final int weekdayMask; // Mon=bit0…Sun=bit6; 0 = any day
  final int cadenceWeeks; // 1 = weekly, 2 = every other week
  final DateTime? anchorDate;

  bool get isBiweekly => cadenceWeeks > 1;

  /// Selected weekdays as 0..6 (Mon..Sun); empty ⇒ any day.
  Set<int> get weekdays => {
    for (var i = 0; i < 7; i++)
      if (weekdayMask & (1 << i) != 0) i,
  };

  factory AssignmentRule.fromJson(Map<String, dynamic> j) => AssignmentRule(
    id: j['id'] as String,
    position: j['position'] as int,
    ownerMemberId: j['ownerMemberId'] as String,
    aboutMemberId: j['aboutMemberId'] as String?,
    linkId: j['linkId'] as String?,
    taskType: j['taskType'] as String?,
    weekdayMask: j['weekdayMask'] as int? ?? 0,
    cadenceWeeks: j['cadenceWeeks'] as int? ?? 1,
    anchorDate: j['anchorDate'] == null
        ? null
        : parseTimestamp(j['anchorDate']),
  );
}

/// A feed↔member link, as returned by the assignment-rules endpoint so the
/// per-feed picker can label it (feed name + which member it feeds).
class AssignmentLink {
  AssignmentLink({
    required this.id,
    required this.feedId,
    required this.familyMemberId,
  });

  final String id;
  final String feedId;
  final String familyMemberId;

  factory AssignmentLink.fromJson(Map<String, dynamic> j) => AssignmentLink(
    id: j['id'] as String,
    feedId: j['feedId'] as String,
    familyMemberId: j['familyMemberId'] as String,
  );
}

/// The family's whole assignment pipeline + the links its per-feed picker needs.
class AssignmentRuleSet {
  AssignmentRuleSet({required this.rules, required this.links});

  final List<AssignmentRule> rules;
  final List<AssignmentLink> links;

  factory AssignmentRuleSet.fromJson(Map<String, dynamic> j) =>
      AssignmentRuleSet(
        rules: (((j['rules'] as List?) ?? const [])
            .map((r) => AssignmentRule.fromJson(r as Map<String, dynamic>))
            .toList()),
        links: (((j['links'] as List?) ?? const [])
            .map((l) => AssignmentLink.fromJson(l as Map<String, dynamic>))
            .toList()),
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
  TaskRuleSet({
    required this.rules,
    required this.unifiedDefault,
    required this.linkDefaults,
  });

  final List<TaskRule> rules;
  final TaskDefault unifiedDefault;
  final Map<String, TaskDefault> linkDefaults;

  /// Rules that govern one calendar (all_calendars ∪ this-calendar-for-it),
  /// in position order — mirrors the engine's `taskRulesForCalendar`.
  List<TaskRule> forCalendar(String? linkId) {
    final subset =
        rules
            .where(
              (r) =>
                  r.scope == 'all_calendars' ||
                  (r.scope == 'this_calendar' && r.linkId == linkId),
            )
            .toList()
          ..sort((a, b) => a.position.compareTo(b.position));
    return subset;
  }

  TaskDefault defaultFor(String? linkId) => linkId == null
      ? unifiedDefault
      : (linkDefaults[linkId] ?? unifiedDefault);

  factory TaskRuleSet.fromJson(Map<String, dynamic> j) {
    final defaults = j['defaults'] as Map<String, dynamic>;
    final links = (defaults['links'] as Map<String, dynamic>? ?? const {});
    return TaskRuleSet(
      rules: ((j['rules'] as List?) ?? const [])
          .map((e) => TaskRule.fromJson(e as Map<String, dynamic>))
          .toList(),
      unifiedDefault: TaskDefault.fromJson(
        defaults['unified'] as Map<String, dynamic>,
      ),
      linkDefaults: {
        for (final e in links.entries)
          e.key: TaskDefault.fromJson(e.value as Map<String, dynamic>),
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
    this.linkId,
    this.summary,
    this.description,
    this.location,
    this.travelTimeOverrideMin,
    this.taskId,
    this.taskIneligibleReason,
  });

  final String id;

  /// Whose unified calendar the event is on (the claimer, for claimed events).
  final String familyMemberId;
  final String provenance; // 'synthesized' | 'human' | 'claimed_task'
  final DateTime start;
  final DateTime? end;
  final bool allDay;

  /// The source calendar (feed link) the event came from; null ⇒ the member's
  /// own unified/direct calendar. Task rules are scoped by it.
  final String? linkId;
  final String? summary;
  final String? description;
  final String? location;

  /// A human's own answer for how long getting here takes (minutes), which
  /// overrides whatever the backend would estimate; 0 means no travel time at
  /// all. Null ⇒ estimated from where the caretaker is coming from.
  final int? travelTimeOverrideMin;

  /// For claimed_task events: the task this event reflects (the recursion).
  final String? taskId;

  /// Why this event can't carry claimable tasks at all — 'paused' (the member's
  /// task generation is off), 'busy_calendar' (a free/busy firewall block),
  /// 'claimed' (it *is* a claim) or 'skipped_by_rule' (a "No tasks" task rule
  /// matches it). Null ⇒ eligible, so having no tasks is a dismissal or a stale
  /// build, which [ApiClient.rebuildEventTasks] undoes.
  final String? taskIneligibleReason;

  bool get isClaimedTask => provenance == 'claimed_task';
  bool get isHuman => provenance == 'human';

  /// Whether this event is allowed to have claimable tasks at all.
  bool get canHaveTasks => taskIneligibleReason == null;

  String get displaySummary => summary ?? 'Event';

  /// The local midnight an all-day event runs *to*, exclusive — so a one-day
  /// holiday covers `[start, start + 1 day)`. A missing or degenerate `dtend`
  /// reads as the single start day.
  DateTime get allDayEnd {
    final startDay = DateTime(start.year, start.month, start.day);
    // Not `add(Duration(days: 1))`: across a DST boundary that lands at 23:00
    // or 01:00 rather than on the next midnight.
    final nextDay = DateTime(startDay.year, startDay.month, startDay.day + 1);
    final e = end;
    if (e == null) return nextDay;
    final endDay = DateTime(e.year, e.month, e.day);
    return endDay.isAfter(nextDay) ? endDay : nextDay;
  }

  /// Whether this all-day event covers [day] (a local midnight).
  bool coversDay(DateTime day) =>
      !day.isBefore(DateTime(start.year, start.month, start.day)) &&
      day.isBefore(allDayEnd);

  factory CalendarEventItem.fromJson(Map<String, dynamic> j) {
    final allDay = j['allDay'] as bool? ?? false;
    return CalendarEventItem(
      id: j['id'] as String,
      familyMemberId: j['familyMemberId'] as String,
      provenance: j['provenance'] as String,
      allDay: allDay,
      start: allDay
          ? parseAllDayDate(j['dtstart'])
          : parseTimestamp(j['dtstart']),
      // `dtend` is exclusive. For an all-day event it's a UTC-midnight *date*
      // like dtstart, so it has to be read the same way: as a timestamp it
      // landed hours before its own start day was over (west of UTC) or on the
      // day after (east of it) — which is what drew a one-day holiday as a
      // 17-hour block down the Plan grid.
      end: j['dtend'] == null
          ? null
          : (allDay ? parseAllDayDate(j['dtend']) : parseTimestamp(j['dtend'])),
      linkId: j['linkId'] as String?,
      summary: j['summary'] as String?,
      description: j['description'] as String?,
      location: j['location'] as String?,
      travelTimeOverrideMin: j['travelTimeOverrideMin'] as int?,
      taskId: j['taskId'] as String?,
      taskIneligibleReason: j['taskIneligibleReason'] as String?,
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
    this.kind = 'exception',
    this.sourceEventId,
    this.end,
    this.summary,
    this.location,
  });

  final String id;
  final String feedId;

  /// What's being asked. `exception` — an unmatched exception-feed event: what
  /// does it do to this member's day? `routing` — an event on a shared family
  /// calendar nobody's rules claimed: whose is it? A routing question comes as
  /// one row per member of the feed, all sharing a [sourceEventId], and is
  /// asked (and answered) as a single card — see [groupDecisions].
  final String kind;

  /// The feed event behind the decision; the grouping key for routing rows.
  final String? sourceEventId;

  /// The member-feed link whose pipeline the event fell through — where a new
  /// rule to resolve it would need to live.
  final String linkId;

  /// The member whose calendar the event would land on.
  final String familyMemberId;
  final DateTime start;
  final DateTime? end;
  final bool allDay;
  final String? summary;
  final String? location;

  bool get isRouting => kind == 'routing';

  factory PendingDecision.fromJson(Map<String, dynamic> j) {
    final allDay = j['allDay'] as bool? ?? false;
    return PendingDecision(
      id: j['id'] as String,
      feedId: j['feedId'] as String,
      kind: j['kind'] as String? ?? 'exception',
      sourceEventId: j['sourceEventId'] as String?,
      linkId: j['linkId'] as String,
      familyMemberId: j['familyMemberId'] as String,
      allDay: allDay,
      start: allDay
          ? parseAllDayDate(j['dtstart'])
          : parseTimestamp(j['dtstart']),
      end: j['dtend'] == null ? null : parseTimestamp(j['dtend']),
      summary: j['summary'] as String?,
      location: j['location'] as String?,
    );
  }
}

/// One card's worth of decision: an exception decision is its own card, while a
/// routing decision's per-member rows collapse into one — the API asks each
/// member of the shared calendar separately so each answer is its own row, but
/// the user is only ever asked "whose is this?" once.
class DecisionGroup {
  DecisionGroup(this.rows);

  final List<PendingDecision> rows;

  PendingDecision get first => rows.first;
  bool get isRouting => first.isRouting;

  /// The links (one per member of the shared calendar) the event can route to.
  List<String> get candidateLinkIds => [for (final r in rows) r.linkId];
}

/// Collapse a decision list into cards, preserving the API's ordering (by the
/// event's start). Routing rows for the same feed event group together.
List<DecisionGroup> groupDecisions(List<PendingDecision> decisions) {
  final groups = <DecisionGroup>[];
  final byKey = <String, DecisionGroup>{};
  for (final d in decisions) {
    final key = d.isRouting ? '${d.feedId}:${d.sourceEventId}' : d.id;
    final existing = byKey[key];
    if (existing != null) {
      existing.rows.add(d);
      continue;
    }
    final group = DecisionGroup([d]);
    byKey[key] = group;
    groups.add(group);
  }
  return groups;
}

/// One of the two overlapping events in a [Conflict] (for the card copy).
class ConflictEventRef {
  ConflictEventRef({
    required this.start,
    required this.allDay,
    this.end,
    this.summary,
    this.location,
  });

  final DateTime start;
  final DateTime? end;
  final bool allDay;
  final String? summary;
  final String? location;

  factory ConflictEventRef.fromJson(Map<String, dynamic> j) {
    final allDay = j['allDay'] as bool? ?? false;
    return ConflictEventRef(
      allDay: allDay,
      start: allDay
          ? parseAllDayDate(j['dtstart'])
          : parseTimestamp(j['dtstart']),
      end: j['dtend'] == null ? null : parseTimestamp(j['dtend']),
      summary: j['summary'] as String?,
      location: j['location'] as String?,
    );
  }
}

/// An agenda overlap on one member's unified calendar — they can't be in two
/// places at once. The lower-priority [loser] is the one that would be split or
/// trimmed around the higher-priority [winner] if resolved.
class Conflict {
  Conflict({
    required this.id,
    required this.familyMemberId,
    required this.loser,
    required this.winner,
    this.status = 'pending',
    this.suggestedTravelMin,
  });

  final String id;
  final String familyMemberId;

  /// How the conflict has been handled: `pending` (awaiting a decision),
  /// `resolved` (the loser was split around the winner) or `dismissed` (both
  /// events kept as scheduled).
  final String status;
  final ConflictEventRef loser;
  final ConflictEventRef winner;

  /// Minutes between the two places, estimated server-side from their
  /// coordinates — the resolution sheet's starting travel buffer. Null when
  /// either end isn't geocoded, in which case the handles start at zero.
  final int? suggestedTravelMin;

  factory Conflict.fromJson(Map<String, dynamic> j) => Conflict(
    id: j['id'] as String,
    familyMemberId: j['familyMemberId'] as String,
    loser: ConflictEventRef.fromJson(j['loser'] as Map<String, dynamic>),
    winner: ConflictEventRef.fromJson(j['winner'] as Map<String, dynamic>),
    status: j['status'] as String? ?? 'pending',
    suggestedTravelMin: j['suggestedTravelMin'] as int?,
  );
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

  String get methodLabel =>
      targetMethod == 'google' ? 'Google' : 'iCloud / CalDAV';

  factory MemberCalendarConfig.fromJson(Map<String, dynamic> j) =>
      MemberCalendarConfig(
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

/// Which of a member's events an email invite output sends. Mirrors
/// `EmailOutputFilters` in libs/domain: `include` picks the kinds
/// ('claimed_task' | 'schedule' | 'busy'); `taskTypes` narrows claimed tasks;
/// `sourceLinkIds` narrows by source calendar. Null ⇒ no narrowing.
class EmailOutputFilters {
  const EmailOutputFilters({
    required this.include,
    this.taskTypes,
    this.sourceLinkIds,
  });

  final Set<String> include;
  final Set<String>? taskTypes;
  final Set<String>? sourceLinkIds;

  static const claimedOnly = EmailOutputFilters(include: {'claimed_task'});

  factory EmailOutputFilters.fromJson(Map<String, dynamic> j) =>
      EmailOutputFilters(
        include: {...(j['include'] as List).cast<String>()},
        taskTypes: (j['taskTypes'] as List?)?.cast<String>().toSet(),
        sourceLinkIds: (j['sourceLinkIds'] as List?)?.cast<String>().toSet(),
      );

  Map<String, dynamic> toJson() => {
    'include': include.toList(),
    'taskTypes': taskTypes?.toList(),
    'sourceLinkIds': sourceLinkIds?.toList(),
  };

  /// One line for a list row, e.g. "Claimed pickups · Schedule".
  String get summary {
    final parts = <String>[];
    if (include.contains('claimed_task')) {
      final types = taskTypes;
      parts.add(
        types == null
            ? 'Claimed tasks'
            : 'Claimed ${types.map(_taskTypePlural).join(' & ')}',
      );
    }
    if (include.contains('schedule')) parts.add('Schedule');
    if (include.contains('busy')) parts.add('Busy blocks');
    final links = sourceLinkIds;
    final base = parts.join(' · ');
    if (links == null) return base;
    return '$base · ${links.length} calendar${links.length == 1 ? '' : 's'}';
  }

  static String _taskTypePlural(String t) => switch (t) {
    'dropoff' => 'drop-offs',
    'pickup' => 'pickups',
    _ => 'attendance',
  };
}

/// An email invite output: calendar invites for a filtered slice of a
/// member's unified calendar, mailed to an address once it confirms.
class EmailOutput {
  EmailOutput({
    required this.id,
    required this.email,
    required this.filters,
    required this.active,
    required this.verified,
    this.unsubscribed = false,
    this.padTravelTime = false,
    this.maskTitle,
    this.label,
  });

  final String id;
  final String email;
  final String? label;
  final EmailOutputFilters filters;
  final bool active;
  final bool verified;

  /// The recipient opted out via the link in one of our emails. Nothing is
  /// sent while this holds, and only they can undo it.
  final bool unsubscribed;

  /// Trips are sent starting earlier by the estimated drive, marked 🚗.
  final bool padTravelTime;

  /// When set, every invite is titled this and carries no other non-time
  /// details (description, location).
  final String? maskTitle;

  factory EmailOutput.fromJson(Map<String, dynamic> j) => EmailOutput(
    id: j['id'] as String,
    email: j['email'] as String,
    label: j['label'] as String?,
    filters: EmailOutputFilters.fromJson(j['filters'] as Map<String, dynamic>),
    active: j['active'] as bool? ?? true,
    verified: j['verified'] as bool? ?? false,
    unsubscribed: j['unsubscribed'] as bool? ?? false,
    padTravelTime: j['padTravelTime'] as bool? ?? false,
    maskTitle: j['maskTitle'] as String?,
  );
}

/// A member's email outputs, plus whether this server can send mail at all.
class EmailOutputList {
  const EmailOutputList({required this.outputs, required this.emailEnabled});
  final List<EmailOutput> outputs;
  final bool emailEnabled;
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
      start: allDay
          ? parseAllDayDate(j['dtstart'])
          : parseTimestamp(j['dtstart']),
      dismissed: j['dismissedAt'] != null,
      summary: j['summary'] as String?,
      location: j['location'] as String?,
    );
  }
}

/// A bucket of outstanding work a notification schedule reports on. Mirrors the
/// server's `NotificationCategory` and Home's own sections.
enum NotificationCategory {
  conflicts('conflicts', 'Double-bookings', 'double-bookings'),
  pendingDecisions(
    'pending_decisions',
    'Events to sort out',
    'events to sort out',
  ),
  absenceNotices(
    'absence_notices',
    'Absence emails to school',
    'absence emails',
  ),
  unclaimedTasks('unclaimed_tasks', 'Unclaimed tasks', 'unclaimed tasks'),
  myTasks('my_tasks', "Tasks I'm covering", 'what I’m covering');

  const NotificationCategory(this.wire, this.label, this.shortLabel);

  /// The value the API uses.
  final String wire;
  final String label;

  /// Mid-sentence form, for the one-line schedule summary. Not just a
  /// lowercased [label] — "tasks i'm covering" reads wrong.
  final String shortLabel;

  static NotificationCategory? fromWire(String wire) =>
      NotificationCategory.values.where((c) => c.wire == wire).firstOrNull;
}

/// A recurring digest of outstanding items, delivered as one push per firing
/// and aggregated across every family the user belongs to.
class NotificationSchedule {
  NotificationSchedule({
    required this.id,
    required this.label,
    required this.enabled,
    required this.sendAt,
    required this.timezone,
    required this.weekdayMask,
    required this.startOffsetDays,
    required this.horizonDays,
    required this.categories,
    required this.skipWhenEmpty,
    this.lastSentAt,
  });

  final String id;
  final String label;
  final bool enabled;

  /// `HH:MM` wall clock, read in [timezone].
  final String sendAt;
  final String timezone;

  /// Mon=bit0 … Sun=bit6 — the same convention as assignment rules, so the day
  /// chips are shared with the assignment-rule editor.
  final int weekdayMask;

  /// 0 = the window opens today, 1 = tomorrow.
  final int startOffsetDays;

  /// How many local days the window spans.
  final int horizonDays;
  final List<NotificationCategory> categories;
  final bool skipWhenEmpty;
  final DateTime? lastSentAt;

  /// Selected weekdays as bit indices (Mon=0), for the day chips.
  List<int> get weekdays => [
    for (var i = 0; i < 7; i++)
      if (weekdayMask & (1 << i) != 0) i,
  ];

  bool get isEveryDay => weekdayMask == 127;
  bool get isWeekdaysOnly => weekdayMask == 31;

  factory NotificationSchedule.fromJson(Map<String, dynamic> j) =>
      NotificationSchedule(
        id: j['id'] as String,
        label: j['label'] as String? ?? 'Daily brief',
        enabled: j['enabled'] as bool? ?? true,
        sendAt: j['sendAt'] as String,
        timezone: j['timezone'] as String,
        weekdayMask: j['weekdayMask'] as int? ?? 127,
        startOffsetDays: j['startOffsetDays'] as int? ?? 1,
        horizonDays: j['horizonDays'] as int? ?? 1,
        categories: [
          for (final c in (j['categories'] as List<dynamic>? ?? const []))
            if (NotificationCategory.fromWire(c as String) case final cat?) cat,
        ],
        skipWhenEmpty: j['skipWhenEmpty'] as bool? ?? true,
        lastSentAt: j['lastSentAt'] == null
            ? null
            : parseTimestamp(j['lastSentAt']),
      );
}

/// The "Email school" notice for one child + school calendar + school day: who
/// it goes to, the composed subject and body, and whether somebody has sent it.
/// Nothing is sent by the server — the phone's mail app does it.
class AbsenceNotice {
  AbsenceNotice({
    required this.familyMemberId,
    required this.linkId,
    required this.date,
    required this.to,
    required this.cc,
    required this.subject,
    required this.body,
    required this.state,
    required this.gapStamp,
    required this.child,
    required this.schedule,
    required this.eventId,
    this.sentBy,
    this.sentAt,
  });

  final String familyMemberId;
  final String linkId;

  /// School date, `YYYY-MM-DD`.
  final String date;
  final List<String> to;
  final List<String> cc;
  final String subject;
  final String body;

  /// `outstanding` (never sent), `sent`, or `needs_update` (sent, but the times
  /// have changed since).
  final String state;

  /// Snapshot of the times this composition describes; echoed to `/sent`.
  final String gapStamp;
  final String child;

  /// "leaving at 10:00 AM and returning at 11:30 AM".
  final String schedule;

  /// An event (the appointment) the notice can be opened from.
  final String eventId;
  final String? sentBy;
  final DateTime? sentAt;

  bool get isSent => state == 'sent';
  bool get needsUpdate => state == 'needs_update';

  factory AbsenceNotice.fromJson(Map<String, dynamic> j) => AbsenceNotice(
    familyMemberId: j['familyMemberId'] as String,
    linkId: j['linkId'] as String,
    date: j['date'] as String,
    to: [for (final a in j['to'] as List<dynamic>) a as String],
    cc: [for (final a in j['cc'] as List<dynamic>) a as String],
    subject: j['subject'] as String,
    body: j['body'] as String,
    state: j['state'] as String,
    gapStamp: j['gapStamp'] as String,
    child: j['child'] as String? ?? '',
    schedule: j['schedule'] as String? ?? '',
    eventId: j['eventId'] as String? ?? '',
    sentBy: j['sentBy'] as String?,
    sentAt: j['sentAt'] == null ? null : parseTimestamp(j['sentAt']),
  );
}

/// A child↔school-calendar link's "Email school" settings (admin-only).
class AbsenceNoticeSettings {
  AbsenceNoticeSettings({
    required this.to,
    required this.cc,
    required this.subjectTemplate,
    required this.bodyTemplate,
    required this.includeReason,
    required this.defaultSubject,
    required this.defaultBody,
  });

  final List<String> to;
  final List<String> cc;
  final String subjectTemplate;
  final String bodyTemplate;
  final bool includeReason;

  /// The server's stock wording — what "Reset wording" goes back to.
  final String defaultSubject;
  final String defaultBody;

  /// No recipient ⇒ the feature is off for this link.
  bool get enabled => to.isNotEmpty || cc.isNotEmpty;

  factory AbsenceNoticeSettings.fromJson(Map<String, dynamic> j) =>
      AbsenceNoticeSettings(
        to: [for (final a in j['to'] as List<dynamic>) a as String],
        cc: [for (final a in j['cc'] as List<dynamic>) a as String],
        subjectTemplate: j['subjectTemplate'] as String,
        bodyTemplate: j['bodyTemplate'] as String,
        includeReason: j['includeReason'] as bool? ?? false,
        defaultSubject:
            (j['defaults'] as Map<String, dynamic>)['subjectTemplate']
                as String,
        defaultBody:
            (j['defaults'] as Map<String, dynamic>)['bodyTemplate'] as String,
      );
}
