import 'package:dio/dio.dart';

/// Sentinel that distinguishes "omit this PATCH field" from "set to null".
/// Used by [ApiClient.updateClassificationRule] for clearable nullable columns.
const Object _unset = Object();

/// Thin typed wrapper over the backend HTTP API. Replaced by an OpenAPI-
/// generated client once the spec is emitted from libs/domain (see /tools).
class ApiClient {
  ApiClient({required this.baseUrl}) : _dio = Dio(BaseOptions(baseUrl: baseUrl));

  final String baseUrl;
  final Dio _dio;
  String? _sessionToken;

  void setSession(String? token) => _sessionToken = token;

  Options get _auth => Options(
        headers: _sessionToken != null
            ? {'Authorization': 'Bearer $_sessionToken'}
            : null,
      );

  Map<String, dynamic> _obj(Response res) => res.data as Map<String, dynamic>;
  List<dynamic> _list(Response res, String key) =>
      (res.data as Map<String, dynamic>)[key] as List<dynamic>;

  // --- Auth --------------------------------------------------------------

  Future<String?> requestMagicLink(String email) async {
    final res = await _dio.post('/auth/magic-link/request', data: {'email': email});
    return _obj(res)['devToken'] as String?;
  }

  Future<Map<String, dynamic>> verifyMagicLink(String token) async {
    final res = await _dio.post('/auth/magic-link/verify', data: {'token': token});
    final data = _obj(res);
    _sessionToken = data['sessionToken'] as String;
    return data;
  }

  Future<Map<String, dynamic>> me() async => _obj(await _dio.get('/me', options: _auth));

  Future<Map<String, dynamic>> createFamily(String name) async =>
      _obj(await _dio.post('/families', data: {'name': name}, options: _auth));

  // --- Family members ----------------------------------------------------

  Future<List<dynamic>> listMembers(String familyId) async =>
      _list(await _dio.get('/families/$familyId/members', options: _auth), 'members');

  Future<Map<String, dynamic>> createMember(
    String familyId, {
    required String relationName,
    bool isCaretaker = false,
    bool isAdmin = false,
    bool requiresCaretaker = false,
  }) async {
    final res = await _dio.post(
      '/families/$familyId/members',
      data: {
        'relationName': relationName,
        'isCaretaker': isCaretaker,
        'isAdmin': isAdmin,
        'requiresCaretaker': requiresCaretaker,
      },
      options: _auth,
    );
    return _obj(res);
  }

  Future<void> updateMember(
    String familyId,
    String memberId, {
    String? relationName,
    bool? isCaretaker,
    bool? isAdmin,
    bool? requiresCaretaker,
  }) async {
    await _dio.patch(
      '/families/$familyId/members/$memberId',
      data: {
        if (relationName != null) 'relationName': relationName,
        if (isCaretaker != null) 'isCaretaker': isCaretaker,
        if (isAdmin != null) 'isAdmin': isAdmin,
        if (requiresCaretaker != null) 'requiresCaretaker': requiresCaretaker,
      },
      options: _auth,
    );
  }

  /// Issue a member-claim invite (admin). Returns `{ token, expiresAt }`.
  Future<Map<String, dynamic>> issueMemberInvite(String familyId, String memberId) async =>
      _obj(await _dio.post('/families/$familyId/members/$memberId/invite',
          data: <String, dynamic>{}, options: _auth));

  /// Public preview of an invite token: `{ familyName, relationName, status }`.
  Future<Map<String, dynamic>> previewInvite(String token) async {
    final res = await _dio.get('/invites/$token');
    return (res.data as Map<String, dynamic>)['invite'] as Map<String, dynamic>;
  }

  /// Accept an invite (must be logged in) — links the current user to the member.
  Future<Map<String, dynamic>> acceptInvite(String token) async =>
      _obj(await _dio.post('/invites/$token/accept', data: <String, dynamic>{}, options: _auth));

  // --- External accounts (user-owned, reusable across families) ----------

  Future<List<dynamic>> listAccounts() async =>
      _list(await _dio.get('/accounts', options: _auth), 'accounts');

  /// Connect an external account. Google: `authCode` + `redirectUri`.
  /// iCloud/CalDAV: `username` + `password` (+ `serverUrl` for generic CalDAV).
  Future<Map<String, dynamic>> createExternalAccount({
    required String kind, // 'google' | 'icloud' | 'caldav'
    required String name,
    String? serverUrl,
    String? username,
    String? password,
    String? authCode,
    String? redirectUri,
  }) async {
    final res = await _dio.post(
      '/accounts',
      data: {
        'kind': kind,
        'name': name,
        if (serverUrl != null) 'serverUrl': serverUrl,
        if (username != null) 'username': username,
        if (password != null) 'password': password,
        if (authCode != null) 'authCode': authCode,
        if (redirectUri != null) 'redirectUri': redirectUri,
      },
      options: _auth,
    );
    return _obj(res);
  }

  Future<void> deleteAccount(String accountId) async {
    await _dio.delete('/accounts/$accountId', options: _auth);
  }

  /// The calendars available in a connected account: a list of `{ id, name }`.
  Future<List<dynamic>> listAccountCalendars(String accountId) async => _list(
      await _dio.post('/accounts/$accountId/calendars',
          data: <String, dynamic>{}, options: _auth),
      'calendars');

  /// Google OAuth consent URL for connecting a new account.
  Future<String> accountGoogleAuthorizeUrl(String redirectUri) async {
    final res = await _dio.post('/accounts/google/authorize-url',
        data: {'redirectUri': redirectUri}, options: _auth);
    return (res.data as Map<String, dynamic>)['url'] as String;
  }

  // --- Feeds -------------------------------------------------------------

  Future<List<dynamic>> listFeeds(String familyId) async =>
      _list(await _dio.get('/families/$familyId/feeds', options: _auth), 'feeds');

  /// Create an input feed: a public ICS URL (`kind: 'ics'`, pass `url`) or a
  /// calendar from a connected account (`kind: 'caldav' | 'google'`, pass
  /// `externalAccountId` + `sourceCalendarId`).
  Future<Map<String, dynamic>> createFeed(
    String familyId, {
    required String mode, // 'explicit' | 'exception'
    String kind = 'ics',
    String? url,
    String? externalAccountId,
    String? sourceCalendarId,
    String? sourceCalendarName,
    int refreshMinutes = 360,
  }) async {
    final res = await _dio.post(
      '/families/$familyId/feeds',
      data: {
        'kind': kind,
        'mode': mode,
        'refreshMinutes': refreshMinutes,
        if (url != null) 'url': url,
        if (externalAccountId != null) 'externalAccountId': externalAccountId,
        if (sourceCalendarId != null) 'sourceCalendarId': sourceCalendarId,
        if (sourceCalendarName != null) 'sourceCalendarName': sourceCalendarName,
      },
      options: _auth,
    );
    return _obj(res);
  }

  Future<Map<String, dynamic>> createMemberLink(
    String familyId,
    String feedId, {
    required String familyMemberId,
    int? weekdayMask,
    String? dayStart,
    String? dayEnd,
    int? durationMinutes,
    String? location,
    List<String>? generatesTypes,
    String? defaultAttendance,
  }) async {
    final res = await _dio.post(
      '/families/$familyId/feeds/$feedId/member-links',
      data: {
        'familyMemberId': familyMemberId,
        if (weekdayMask != null) 'weekdayMask': weekdayMask,
        if (dayStart != null) 'dayStart': dayStart,
        if (dayEnd != null) 'dayEnd': dayEnd,
        if (durationMinutes != null) 'durationMinutes': durationMinutes,
        if (location != null) 'location': location,
        if (generatesTypes != null) 'generatesTypes': generatesTypes,
        if (defaultAttendance != null) 'defaultAttendance': defaultAttendance,
      },
      options: _auth,
    );
    return _obj(res);
  }

  Future<List<dynamic>> listMemberLinks(String familyId, String feedId) async => _list(
      await _dio.get('/families/$familyId/feeds/$feedId/member-links', options: _auth),
      'links');

  Future<void> updateMemberLink(
    String familyId,
    String feedId,
    String linkId, {
    int? weekdayMask,
    String? dayStart,
    String? dayEnd,
    int? durationMinutes,
    String? location,
    List<String>? generatesTypes,
    String? defaultAttendance,
    bool? active,
  }) async {
    await _dio.patch(
      '/families/$familyId/feeds/$feedId/member-links/$linkId',
      data: {
        if (weekdayMask != null) 'weekdayMask': weekdayMask,
        if (dayStart != null) 'dayStart': dayStart,
        if (dayEnd != null) 'dayEnd': dayEnd,
        if (durationMinutes != null) 'durationMinutes': durationMinutes,
        if (location != null) 'location': location,
        if (generatesTypes != null) 'generatesTypes': generatesTypes,
        if (defaultAttendance != null) 'defaultAttendance': defaultAttendance,
        if (active != null) 'active': active,
      },
      options: _auth,
    );
  }

  Future<void> deleteMemberLink(String familyId, String feedId, String linkId) async {
    await _dio.delete('/families/$familyId/feeds/$feedId/member-links/$linkId', options: _auth);
  }

  Future<Map<String, dynamic>> refreshFeed(String familyId, String feedId) async =>
      _obj(await _dio.post('/families/$familyId/feeds/$feedId/refresh',
          data: <String, dynamic>{}, options: _auth));

  Future<Map<String, dynamic>> refreshAllFeeds(String familyId) async =>
      _obj(await _dio.post('/families/$familyId/feeds/refresh-all',
          data: <String, dynamic>{}, options: _auth));

  // --- Tasks -------------------------------------------------------------

  Future<List<dynamic>> listTasks(String familyId, {String? status}) async {
    final res = await _dio.get(
      '/families/$familyId/tasks',
      queryParameters: status != null ? {'status': status} : null,
      options: _auth,
    );
    return _list(res, 'tasks');
  }

  Future<void> assignTask(String familyId, String taskId, {String? memberId}) async {
    await _dio.post(
      '/families/$familyId/tasks/$taskId/assign',
      data: memberId != null ? {'memberId': memberId} : <String, dynamic>{},
      options: _auth,
    );
  }

  Future<void> unassignTask(String familyId, String taskId) async {
    await _dio.post('/families/$familyId/tasks/$taskId/unassign',
        data: <String, dynamic>{}, options: _auth);
  }

  /// Mark a task unneeded (drops it from the queue + the owner's calendar).
  Future<void> dismissTask(String familyId, String taskId) async {
    await _dio.post('/families/$familyId/tasks/$taskId/dismiss',
        data: <String, dynamic>{}, options: _auth);
  }

  /// Restore a dismissed task back to the unowned pool.
  Future<void> restoreTask(String familyId, String taskId) async {
    await _dio.post('/families/$familyId/tasks/$taskId/restore',
        data: <String, dynamic>{}, options: _auth);
  }

  /// The raw feed events behind the tasks (for the oversight view).
  Future<List<dynamic>> listSourceEvents(String familyId) async =>
      _list(await _dio.get('/families/$familyId/source-events', options: _auth), 'events');

  /// Mark a feed event unneeded (admin) — e.g. an erroneous closure.
  Future<void> dismissEvent(String familyId, String feedId, String eventId) async {
    await _dio.post('/families/$familyId/feeds/$feedId/events/$eventId/dismiss',
        data: <String, dynamic>{}, options: _auth);
  }

  /// Restore a previously-dismissed feed event (admin).
  Future<void> restoreEvent(String familyId, String feedId, String eventId) async {
    await _dio.post('/families/$familyId/feeds/$feedId/events/$eventId/restore',
        data: <String, dynamic>{}, options: _auth);
  }

  /// Re-deliver all owned tasks to their owners' calendars. Returns
  /// `{ ownedTasks, delivered, errors }`.
  Future<Map<String, dynamic>> resyncDeliveries(String familyId) async => _obj(
      await _dio.post('/families/$familyId/tasks/resync-deliveries',
          data: <String, dynamic>{}, options: _auth));

  // --- Calendar targets (delivery destinations) --------------------------

  Future<List<dynamic>> listCalendarTargets(String familyId) async => _list(
      await _dio.get('/families/$familyId/calendar-targets', options: _auth), 'targets');

  /// Create an output feed. `email` targets stand alone (pass the address as
  /// `addressOrUrl`). `caldav`/`google` targets draw their credential from a
  /// connected `externalAccountId`; `addressOrUrl` (CalDAV collection URL /
  /// Google calendar id) + `externalCalendarId` name the target calendar.
  Future<Map<String, dynamic>> createCalendarTarget(
    String familyId, {
    required String memberId,
    required String name,
    required String method, // 'email' | 'caldav' | 'google'
    String? externalAccountId,
    required String addressOrUrl,
    String? externalCalendarId,
    List<int>? alertMinutes,
  }) async {
    final res = await _dio.post(
      '/families/$familyId/calendar-targets',
      data: {
        'memberId': memberId,
        'name': name,
        'method': method,
        if (externalAccountId != null) 'externalAccountId': externalAccountId,
        'addressOrUrl': addressOrUrl,
        if (externalCalendarId != null) 'externalCalendarId': externalCalendarId,
        if (alertMinutes != null) 'alertMinutes': alertMinutes,
      },
      options: _auth,
    );
    return _obj(res);
  }

  /// Update an output feed's config. Only name / active / alerts are editable;
  /// the method, account, and target calendar are immutable (recreate to change).
  Future<void> updateCalendarTarget(
    String familyId,
    String targetId, {
    String? name,
    bool? active,
    List<int>? alertMinutes,
  }) async {
    await _dio.patch(
      '/families/$familyId/calendar-targets/$targetId',
      data: {
        if (name != null) 'name': name,
        if (active != null) 'active': active,
        if (alertMinutes != null) 'alertMinutes': alertMinutes,
      },
      options: _auth,
    );
  }

  Future<void> deleteCalendarTarget(String familyId, String targetId) async {
    await _dio.delete('/families/$familyId/calendar-targets/$targetId', options: _auth);
  }

  // --- Classification rules -----------------------------------------------

  Future<List<dynamic>> listClassificationRules(String familyId) async => _list(
      await _dio.get('/families/$familyId/classification-rules', options: _auth), 'rules');

  Future<Map<String, dynamic>> createClassificationRule(
    String familyId, {
    String? feedId,
    int priority = 100,
    required String matchField,
    required String matchOp,
    required String matchValue,
    required String effect,
    List<String>? producesTypes,
    String? defaultAttendance,
    String? shiftToTime,
    String? defaultOwnerMemberId,
  }) async {
    final res = await _dio.post(
      '/families/$familyId/classification-rules',
      data: {
        if (feedId != null) 'feedId': feedId,
        'priority': priority,
        'matchField': matchField,
        'matchOp': matchOp,
        'matchValue': matchValue,
        'effect': effect,
        if (producesTypes != null) 'producesTypes': producesTypes,
        if (defaultAttendance != null) 'defaultAttendance': defaultAttendance,
        if (shiftToTime != null) 'shiftToTime': shiftToTime,
        if (defaultOwnerMemberId != null) 'defaultOwnerMemberId': defaultOwnerMemberId,
      },
      options: _auth,
    );
    return _obj(res);
  }

  /// Update a classification rule. Clearable params (`feedId`, `producesTypes`,
  /// `defaultAttendance`, `shiftToTime`, `defaultOwnerMemberId`) accept an
  /// explicit `null` to clear the DB column (e.g. on effect change). Omitting a
  /// param entirely leaves the column unchanged. Non-clearable params use the
  /// standard `if (x != null)` pattern and cannot be cleared.
  Future<void> updateClassificationRule(
    String familyId,
    String ruleId, {
    Object? feedId = _unset,
    int? priority,
    String? matchField,
    String? matchOp,
    String? matchValue,
    String? effect,
    Object? producesTypes = _unset,
    Object? defaultAttendance = _unset,
    Object? shiftToTime = _unset,
    Object? defaultOwnerMemberId = _unset,
  }) async {
    await _dio.patch(
      '/families/$familyId/classification-rules/$ruleId',
      data: {
        if (feedId != _unset) 'feedId': feedId,
        if (priority != null) 'priority': priority,
        if (matchField != null) 'matchField': matchField,
        if (matchOp != null) 'matchOp': matchOp,
        if (matchValue != null) 'matchValue': matchValue,
        if (effect != null) 'effect': effect,
        if (producesTypes != _unset) 'producesTypes': producesTypes,
        if (defaultAttendance != _unset) 'defaultAttendance': defaultAttendance,
        if (shiftToTime != _unset) 'shiftToTime': shiftToTime,
        if (defaultOwnerMemberId != _unset) 'defaultOwnerMemberId': defaultOwnerMemberId,
      },
      options: _auth,
    );
  }

  Future<void> deleteClassificationRule(String familyId, String ruleId) async {
    await _dio.delete('/families/$familyId/classification-rules/$ruleId', options: _auth);
  }
}
