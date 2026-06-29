import 'package:dio/dio.dart';

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

  // --- Feeds -------------------------------------------------------------

  Future<List<dynamic>> listFeeds(String familyId) async =>
      _list(await _dio.get('/families/$familyId/feeds', options: _auth), 'feeds');

  Future<Map<String, dynamic>> createFeed(
    String familyId, {
    required String url,
    required String mode, // 'explicit' | 'exception'
    int refreshMinutes = 360,
  }) async {
    final res = await _dio.post(
      '/families/$familyId/feeds',
      data: {'url': url, 'mode': mode, 'refreshMinutes': refreshMinutes},
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
        if (generatesTypes != null) 'generatesTypes': generatesTypes,
        if (defaultAttendance != null) 'defaultAttendance': defaultAttendance,
      },
      options: _auth,
    );
    return _obj(res);
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

  // --- Calendar targets (delivery destinations) --------------------------

  Future<List<dynamic>> listCalendarTargets(String familyId) async => _list(
      await _dio.get('/families/$familyId/calendar-targets', options: _auth), 'targets');

  Future<Map<String, dynamic>> createCalendarTarget(
    String familyId, {
    required String memberId,
    required String name,
    required String method, // 'email' | 'caldav' | 'google'
    String? providerHint,
    required String addressOrUrl,
    String? externalCalendarId,
    Map<String, String>? credential,
  }) async {
    final res = await _dio.post(
      '/families/$familyId/calendar-targets',
      data: {
        'memberId': memberId,
        'name': name,
        'method': method,
        if (providerHint != null) 'providerHint': providerHint,
        'addressOrUrl': addressOrUrl,
        if (externalCalendarId != null) 'externalCalendarId': externalCalendarId,
        if (credential != null) 'credential': credential,
      },
      options: _auth,
    );
    return _obj(res);
  }
}
