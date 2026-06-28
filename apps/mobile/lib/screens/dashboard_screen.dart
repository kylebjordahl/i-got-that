import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/auth.dart';

/// Loads the caller's first family, then shows its unowned tasks with a "Claim"
/// action — the core daily-driver screen. (Family switching, per-child grouping,
/// and create-family onboarding are follow-ups.)
class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  bool _loading = true;
  String? _familyId;
  List<dynamic> _tasks = const [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final me = await api.me();
      final families = me['families'] as List<dynamic>;
      if (families.isEmpty) {
        final created = await api.createFamily('My Family');
        _familyId = (created['family'] as Map<String, dynamic>)['id'] as String;
      } else {
        final first = families.first as Map<String, dynamic>;
        _familyId = (first['family'] as Map<String, dynamic>)['id'] as String;
      }
      await _reloadTasks();
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _reloadTasks() async {
    final api = ref.read(apiClientProvider);
    final tasks = await api.listTasks(_familyId!, status: 'unowned');
    if (mounted) setState(() => _tasks = tasks);
  }

  Future<void> _claim(String taskId) async {
    final api = ref.read(apiClientProvider);
    await api.assignTask(_familyId!, taskId);
    await _reloadTasks();
  }

  Future<void> _refreshFeeds() async {
    final api = ref.read(apiClientProvider);
    await api.refreshAllFeeds(_familyId!);
    await _reloadTasks();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Unowned tasks'),
        actions: [
          IconButton(
            tooltip: 'Refresh feeds',
            onPressed: _loading ? null : _refreshFeeds,
            icon: const Icon(Icons.sync),
          ),
          IconButton(
            tooltip: 'Sign out',
            onPressed: () => ref.read(authControllerProvider.notifier).logout(),
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!));
    if (_tasks.isEmpty) {
      return const Center(child: Text('Nothing unowned — all covered 🎉'));
    }
    return RefreshIndicator(
      onRefresh: _reloadTasks,
      child: ListView.separated(
        itemCount: _tasks.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final t = _tasks[i] as Map<String, dynamic>;
          final type = t['type'] as String;
          final start = DateTime.fromMillisecondsSinceEpoch(t['dtstart'] as int);
          return ListTile(
            title: Text(_label(type)),
            subtitle: Text(start.toLocal().toString()),
            trailing: FilledButton(
              onPressed: () => _claim(t['id'] as String),
              child: const Text('Claim'),
            ),
          );
        },
      ),
    );
  }

  String _label(String type) => switch (type) {
        'pickup' => 'Pickup',
        'dropoff' => 'Drop-off',
        _ => 'Attendance',
      };
}
