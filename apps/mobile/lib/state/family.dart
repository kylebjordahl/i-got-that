import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import 'auth.dart';

/// The current family id — the user's first family, or a freshly created one.
final familyProvider = FutureProvider<String>((ref) async {
  final api = ref.watch(apiClientProvider);
  final me = await api.me();
  final families = me['families'] as List<dynamic>;
  if (families.isNotEmpty) {
    final first = families.first as Map<String, dynamic>;
    return (first['family'] as Map<String, dynamic>)['id'] as String;
  }
  final created = await api.createFamily('My Family');
  return (created['family'] as Map<String, dynamic>)['id'] as String;
});

/// The caller's own member record in the current family (for permission gating).
final currentMemberProvider = FutureProvider<Member?>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final me = await api.me();
  for (final f in me['families'] as List<dynamic>) {
    final fm = f as Map<String, dynamic>;
    if ((fm['family'] as Map<String, dynamic>)['id'] == familyId) {
      return Member.fromJson(fm['member'] as Map<String, dynamic>);
    }
  }
  return null;
});

final membersProvider = FutureProvider<List<Member>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final rows = await api.listMembers(familyId);
  return rows.map((e) => Member.fromJson(e as Map<String, dynamic>)).toList();
});

/// Caretakers only — used to populate target/owner pickers.
final caretakersProvider = FutureProvider<List<Member>>((ref) async {
  final members = await ref.watch(membersProvider.future);
  return members.where((m) => m.isCaretaker).toList();
});

/// Dependents (children) — used to link feeds + label tasks.
final dependentsProvider = FutureProvider<List<Member>>((ref) async {
  final members = await ref.watch(membersProvider.future);
  return members.where((m) => m.requiresCaretaker).toList();
});

final unownedTasksProvider = FutureProvider<List<TaskItem>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final rows = await api.listTasks(familyId, status: 'unowned');
  return rows.map((e) => TaskItem.fromJson(e as Map<String, dynamic>)).toList();
});

/// Every task (owned + unowned + dismissed) — the oversight view.
final allTasksProvider = FutureProvider<List<TaskItem>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final rows = await api.listTasks(familyId);
  return rows.map((e) => TaskItem.fromJson(e as Map<String, dynamic>)).toList();
});

/// Raw feed events behind the tasks — for the oversight view's event grouping.
final sourceEventsProvider = FutureProvider<List<SourceEventItem>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final rows = await api.listSourceEvents(familyId);
  return rows.map((e) => SourceEventItem.fromJson(e as Map<String, dynamic>)).toList();
});

final feedsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  return (await api.listFeeds(familyId)).cast<Map<String, dynamic>>();
});

/// All classification rules for the family (global + feed-scoped combined).
/// Group client-side by [ClassificationRule.feedId] for display.
final classificationRulesProvider = FutureProvider<List<ClassificationRule>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final rows = await api.listClassificationRules(familyId);
  return rows.map((e) => ClassificationRule.fromJson(e as Map<String, dynamic>)).toList();
});

/// Member links (with baselines) for a specific feed.
final feedLinksProvider =
    FutureProvider.family<List<Map<String, dynamic>>, String>((ref, feedId) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  return (await api.listMemberLinks(familyId, feedId)).cast<Map<String, dynamic>>();
});

final targetsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  return (await api.listCalendarTargets(familyId)).cast<Map<String, dynamic>>();
});
