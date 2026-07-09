import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import 'auth.dart';

/// The active family, when the user has switched away from their default (first)
/// family via the Family-screen switcher. Null ⇒ use the default.
final selectedFamilyIdProvider = StateProvider<String?>((ref) => null);

/// The current family id — the selected family, else the user's first family, or
/// a freshly created one.
final familyProvider = FutureProvider<String>((ref) async {
  final override = ref.watch(selectedFamilyIdProvider);
  if (override != null) return override;
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

/// All families the user belongs to (id + name) — for the family switcher.
final familiesListProvider = FutureProvider<List<({String id, String name})>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final me = await api.me();
  return [
    for (final f in me['families'] as List<dynamic>)
      (
        id: ((f as Map<String, dynamic>)['family'] as Map<String, dynamic>)['id'] as String,
        name: (f['family'] as Map<String, dynamic>)['name'] as String,
      ),
  ];
});

/// The active family's display name + total family count (Family header).
final familyInfoProvider = FutureProvider<({String name, int count})>((ref) async {
  final familyId = await ref.watch(familyProvider.future);
  final families = await ref.watch(familiesListProvider.future);
  final name = families.where((f) => f.id == familyId).map((f) => f.name).firstOrNull ?? 'Family';
  return (name: name, count: families.length);
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

final feedsProvider = FutureProvider<List<FeedItem>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final rows = await api.listFeeds(familyId);
  return rows.map((e) => FeedItem.fromJson(e as Map<String, dynamic>)).toList();
});

/// Member links (with baselines) for a specific feed.
final feedLinksProvider =
    FutureProvider.family<List<FeedLink>, String>((ref, feedId) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final rows = await api.listMemberLinks(familyId, feedId);
  return rows.map((e) => FeedLink.fromJson(e as Map<String, dynamic>)).toList();
});

/// A link's override pipeline, in position order.
final linkRulesProvider = FutureProvider.family<List<OverrideRule>,
    ({String feedId, String linkId})>((ref, key) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final rows = await api.listLinkRules(familyId, key.feedId, key.linkId);
  return rows.map((e) => OverrideRule.fromJson(e as Map<String, dynamic>)).toList();
});

/// Open pending decisions — ranked above unclaimed tasks on Home.
final pendingDecisionsProvider = FutureProvider<List<PendingDecision>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final rows = await api.listPendingDecisions(familyId);
  return rows.map((e) => PendingDecision.fromJson(e as Map<String, dynamic>)).toList();
});

/// Every unified-calendar event in the family (Plan's data source).
final calendarEventsProvider = FutureProvider<List<CalendarEventItem>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final rows = await api.listCalendarEvents(familyId);
  return rows
      .map((e) => CalendarEventItem.fromJson(e as Map<String, dynamic>))
      .toList();
});

/// A member's task-rule pipeline + per-calendar defaults (6k).
final taskRulesProvider =
    FutureProvider.family<TaskRuleSet, String>((ref, memberId) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  return TaskRuleSet.fromJson(await api.getTaskRules(familyId, memberId));
});

/// A member's unified-calendar target config (null ⇒ DB-only calendar).
final memberCalendarProvider =
    FutureProvider.family<MemberCalendarConfig?, String>((ref, memberId) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final row = await api.getMemberCalendarTarget(familyId, memberId);
  return row == null ? null : MemberCalendarConfig.fromJson(row);
});

/// The family-level threading threshold (minutes) for stitching task chains.
final threadingThresholdProvider = FutureProvider<int>((ref) async {
  final api = ref.watch(apiClientProvider);
  final familyId = await ref.watch(familyProvider.future);
  final res = await api.getFamily(familyId);
  final family = res['family'] as Map<String, dynamic>;
  return family['threadingThresholdMinutes'] as int? ?? 30;
});

/// The current user's connected external calendar accounts (not family-scoped).
final accountsProvider = FutureProvider<List<ExternalAccount>>((ref) async {
  final api = ref.watch(apiClientProvider);
  final rows = await api.listAccounts();
  return rows.map((e) => ExternalAccount.fromJson(e as Map<String, dynamic>)).toList();
});
