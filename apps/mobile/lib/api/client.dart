import 'package:dio/dio.dart';

/// Sentinel that distinguishes "omit this PATCH field" from "set to null".
/// Used by [ApiClient.updateLinkRule] for clearable nullable columns.
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

  /// The family row (carries `threadingThresholdMinutes`).
  Future<Map<String, dynamic>> getFamily(String familyId) async =>
      _obj(await _dio.get('/families/$familyId', options: _auth));

  /// Update family settings (admin): name and/or threading threshold.
  Future<void> updateFamily(
    String familyId, {
    String? name,
    int? threadingThresholdMinutes,
  }) async {
    await _dio.patch(
      '/families/$familyId',
      data: {
        if (name != null) 'name': name,
        if (threadingThresholdMinutes != null)
          'threadingThresholdMinutes': threadingThresholdMinutes,
      },
      options: _auth,
    );
  }

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
    String? color,
  }) async {
    await _dio.patch(
      '/families/$familyId/members/$memberId',
      data: {
        if (relationName != null) 'relationName': relationName,
        if (isCaretaker != null) 'isCaretaker': isCaretaker,
        if (isAdmin != null) 'isAdmin': isAdmin,
        if (requiresCaretaker != null) 'requiresCaretaker': requiresCaretaker,
        if (color != null) 'color': color,
      },
      options: _auth,
    );
  }

  /// Remove a member from the family (admin). 204 on success.
  Future<void> deleteMember(String familyId, String memberId) async {
    await _dio.delete('/families/$familyId/members/$memberId', options: _auth);
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
    required String mode, // 'standard' | 'exception'
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

  /// Update a feed's mode ('standard' | 'exception'); a change resynthesizes.
  Future<void> updateFeed(String familyId, String feedId, {String? mode}) async {
    await _dio.patch(
      '/families/$familyId/feeds/$feedId',
      data: {if (mode != null) 'mode': mode},
      options: _auth,
    );
  }

  // --- Override rules (the link's event pipeline) --------------------------

  String _rulesBase(String familyId, String feedId, String linkId) =>
      '/families/$familyId/feeds/$feedId/member-links/$linkId/rules';

  Future<List<dynamic>> listLinkRules(
          String familyId, String feedId, String linkId) async =>
      _list(await _dio.get(_rulesBase(familyId, feedId, linkId), options: _auth),
          'rules');

  /// Insert a rule into the pipeline; omitted [position] appends.
  Future<Map<String, dynamic>> createLinkRule(
    String familyId,
    String feedId,
    String linkId, {
    required String matchField,
    required String matchOp,
    required String outcome,
    String? matchValue,
    int? position,
    Map<String, dynamic>? params,
    List<String>? generatesTypes,
    String? defaultAttendance,
  }) async {
    final res = await _dio.post(
      _rulesBase(familyId, feedId, linkId),
      data: {
        'matchField': matchField,
        'matchOp': matchOp,
        'outcome': outcome,
        if (matchValue != null) 'matchValue': matchValue,
        if (position != null) 'position': position,
        if (params != null) 'params': params,
        if (generatesTypes != null) 'generatesTypes': generatesTypes,
        if (defaultAttendance != null) 'defaultAttendance': defaultAttendance,
      },
      options: _auth,
    );
    return _obj(res);
  }

  /// Update a rule. Clearable params (`matchValue`, `params`, `generatesTypes`,
  /// `defaultAttendance`) accept an explicit `null` to clear the column;
  /// omitting them leaves the column unchanged.
  Future<void> updateLinkRule(
    String familyId,
    String feedId,
    String linkId,
    String ruleId, {
    String? matchField,
    String? matchOp,
    String? outcome,
    Object? matchValue = _unset,
    Object? params = _unset,
    Object? generatesTypes = _unset,
    Object? defaultAttendance = _unset,
  }) async {
    await _dio.patch(
      '${_rulesBase(familyId, feedId, linkId)}/$ruleId',
      data: {
        if (matchField != null) 'matchField': matchField,
        if (matchOp != null) 'matchOp': matchOp,
        if (outcome != null) 'outcome': outcome,
        if (matchValue != _unset) 'matchValue': matchValue,
        if (params != _unset) 'params': params,
        if (generatesTypes != _unset) 'generatesTypes': generatesTypes,
        if (defaultAttendance != _unset) 'defaultAttendance': defaultAttendance,
      },
      options: _auth,
    );
  }

  Future<void> deleteLinkRule(
      String familyId, String feedId, String linkId, String ruleId) async {
    await _dio.delete('${_rulesBase(familyId, feedId, linkId)}/$ruleId',
        options: _auth);
  }

  /// Reorder the whole pipeline: every rule id exactly once, new order.
  Future<void> reorderLinkRules(
      String familyId, String feedId, String linkId, List<String> ruleIds) async {
    await _dio.put('${_rulesBase(familyId, feedId, linkId)}/order',
        data: {'ruleIds': ruleIds}, options: _auth);
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

  /// Convert a feed-generated task into a chosen set of types (attendance /
  /// pickup / dropoff). The event's tasks for that dependent become exactly
  /// these types.
  Future<void> convertTask(String familyId, String taskId, List<String> types) async {
    await _dio.post('/families/$familyId/tasks/$taskId/convert',
        data: {'types': types}, options: _auth);
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

  /// Re-mirror every member's unified calendar to their target. Returns
  /// `{ targets, created, updated, removed, errors }`.
  Future<Map<String, dynamic>> resyncMirror(String familyId) async => _obj(
      await _dio.post('/families/$familyId/mirror/resync',
          data: <String, dynamic>{}, options: _auth));

  // --- Pending decisions ----------------------------------------------------

  Future<List<dynamic>> listPendingDecisions(String familyId) async => _list(
      await _dio.get('/families/$familyId/pending-decisions', options: _auth),
      'decisions');

  /// Resolve a pending decision: what the unmatched event should generate.
  Future<void> resolvePendingDecision(
    String familyId,
    String decisionId, {
    required List<String> types,
    String? defaultAttendance,
    String? startTime,
    int? durationMinutes,
  }) async {
    await _dio.post(
      '/families/$familyId/pending-decisions/$decisionId/resolve',
      data: {
        'types': types,
        if (defaultAttendance != null) 'defaultAttendance': defaultAttendance,
        if (startTime != null) 'startTime': startTime,
        if (durationMinutes != null) 'durationMinutes': durationMinutes,
      },
      options: _auth,
    );
  }

  Future<void> dismissPendingDecision(String familyId, String decisionId) async {
    await _dio.post('/families/$familyId/pending-decisions/$decisionId/dismiss',
        data: <String, dynamic>{}, options: _auth);
  }

  // --- Unified-calendar events -----------------------------------------------

  /// Events on unified calendars (family-wide, or one member's), optionally
  /// windowed by ISO timestamps.
  Future<List<dynamic>> listCalendarEvents(
    String familyId, {
    String? memberId,
    DateTime? from,
    DateTime? to,
  }) async {
    final res = await _dio.get(
      '/families/$familyId/calendar-events',
      queryParameters: {
        if (memberId != null) 'memberId': memberId,
        if (from != null) 'from': from.toUtc().toIso8601String(),
        if (to != null) 'to': to.toUtc().toIso8601String(),
      },
      options: _auth,
    );
    return _list(res, 'events');
  }

  // --- Member calendar target (the unified calendar's mirror) -----------------

  /// The member's target config, or null when none is designated.
  Future<Map<String, dynamic>?> getMemberCalendarTarget(
      String familyId, String memberId) async {
    final res = await _dio.get(
        '/families/$familyId/members/$memberId/calendar-target',
        options: _auth);
    return _obj(res)['target'] as Map<String, dynamic>?;
  }

  /// Designate (or replace) the member's target calendar, drawn from one of the
  /// caller's connected accounts.
  Future<Map<String, dynamic>> setMemberCalendarTarget(
    String familyId,
    String memberId, {
    required String externalAccountId,
    required String targetCalendarId,
    String? targetCalendarName,
    List<int>? alertMinutes,
  }) async {
    final res = await _dio.put(
      '/families/$familyId/members/$memberId/calendar-target',
      data: {
        'externalAccountId': externalAccountId,
        'targetCalendarId': targetCalendarId,
        if (targetCalendarName != null) 'targetCalendarName': targetCalendarName,
        if (alertMinutes != null) 'alertMinutes': alertMinutes,
      },
      options: _auth,
    );
    return _obj(res);
  }

  Future<void> clearMemberCalendarTarget(String familyId, String memberId) async {
    await _dio.delete('/families/$familyId/members/$memberId/calendar-target',
        options: _auth);
  }
}
