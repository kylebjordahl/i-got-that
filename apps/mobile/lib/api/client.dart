import 'package:dio/dio.dart';

/// Thin typed wrapper over the backend HTTP API. Phase 5 hand-writes this; once
/// the OpenAPI spec is emitted from libs/domain (see /tools) it is replaced by a
/// generated client.
///
/// NOTE: authored without a local Flutter SDK — not yet compiled/analyzed.
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

  /// Returns the dev magic-link token outside production (null in prod, where
  /// the link is emailed instead).
  Future<String?> requestMagicLink(String email) async {
    final res = await _dio.post('/auth/magic-link/request', data: {'email': email});
    return (res.data as Map<String, dynamic>)['devToken'] as String?;
  }

  Future<Map<String, dynamic>> verifyMagicLink(String token) async {
    final res = await _dio.post('/auth/magic-link/verify', data: {'token': token});
    final data = res.data as Map<String, dynamic>;
    _sessionToken = data['sessionToken'] as String;
    return data;
  }

  Future<Map<String, dynamic>> me() async {
    final res = await _dio.get('/me', options: _auth);
    return res.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> createFamily(String name) async {
    final res = await _dio.post('/families', data: {'name': name}, options: _auth);
    return res.data as Map<String, dynamic>;
  }

  Future<List<dynamic>> listTasks(String familyId, {String? status}) async {
    final res = await _dio.get(
      '/families/$familyId/tasks',
      queryParameters: status != null ? {'status': status} : null,
      options: _auth,
    );
    return (res.data as Map<String, dynamic>)['tasks'] as List<dynamic>;
  }

  Future<void> assignTask(String familyId, String taskId) async {
    await _dio.post(
      '/families/$familyId/tasks/$taskId/assign',
      data: <String, dynamic>{},
      options: _auth,
    );
  }

  Future<void> unassignTask(String familyId, String taskId) async {
    await _dio.post(
      '/families/$familyId/tasks/$taskId/unassign',
      data: <String, dynamic>{},
      options: _auth,
    );
  }

  Future<void> refreshAllFeeds(String familyId) async {
    await _dio.post(
      '/families/$familyId/feeds/refresh-all',
      data: <String, dynamic>{},
      options: _auth,
    );
  }
}
