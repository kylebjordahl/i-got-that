import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import 'dialogs.dart';
import 'member_sections.dart';

/// Per-child settings: member color + the feed→child links that generate this
/// child's tasks (the link lives on the child, not the feed).
class ChildDetailScreen extends ConsumerWidget {
  const ChildDetailScreen({super.key, required this.memberId});
  final String memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final child = members.where((m) => m.id == memberId).firstOrNull;
    if (child == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final color = personColor(child);
    final canEdit = (me?.isAdmin ?? false) || me?.id == child.id;

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 40),
          children: [
            const SubPageHeader(title: 'Child'),
            const SizedBox(height: 20),
            DetailProfileCard(
              avatar: PersonAvatar(initial: initialFor(child.relationName), color: color, size: 54),
              name: child.relationName,
              subtitle: 'Child',
              onEdit: () => showEditNameDialog(context, ref, child),
            ),
            const SizedBox(height: 24),
            MemberColorSection(member: child, others: members, enabled: canEdit),
            const SizedBox(height: 24),
            _LinkedFeeds(child: child, canEdit: me?.isAdmin ?? false),
          ],
        ),
      ),
    );
  }
}

class _LinkedFeeds extends ConsumerWidget {
  const _LinkedFeeds({required this.child, required this.canEdit});
  final Member child;
  final bool canEdit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final feeds = ref.watch(feedsProvider).valueOrNull ?? const <Map<String, dynamic>>[];

    // Resolve each feed's link for this child.
    final linked = <(Map<String, dynamic>, String)>[]; // (feed, linkId)
    final unlinked = <Map<String, dynamic>>[];
    for (final feed in feeds) {
      final links = ref.watch(feedLinksProvider(feed['id'] as String)).valueOrNull ?? const [];
      final link = links
          .cast<Map<String, dynamic>>()
          .where((l) => l['familyMemberId'] == child.id)
          .firstOrNull;
      if (link != null) {
        linked.add((feed, link['id'] as String));
      } else {
        unlinked.add(feed);
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SectionEyebrow(
          'Linked feeds',
          color: AppColors.blue,
          trailing: TintBadge('${linked.length} linked', color: AppColors.blue),
        ),
        const SizedBox(height: 8),
        Text(
          "Feeds that generate ${child.relationName}'s tasks — linked here, on the "
          'child, not on the feed.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 12),
        AppCard(
          child: Column(
            children: [
              if (linked.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text('No feeds linked yet', style: AppText.subtitle),
                )
              else
                for (final (feed, linkId) in linked) ...[
                  SettingRow(
                    icon: _feedIcon(feed),
                    iconColor: _feedColor(feed),
                    title: _feedName(feed),
                    subtitle: _feedSubtitle(feed),
                    trailing: canEdit
                        ? GestureDetector(
                            onTap: () => _unlink(ref, feed['id'] as String, linkId),
                            child: const TintBadge('Linked', color: AppColors.green),
                          )
                        : const TintBadge('Linked', color: AppColors.green),
                  ),
                  const Divider(height: 20),
                ],
              if (canEdit)
                SettingRow(
                  icon: Icons.add_rounded,
                  iconColor: AppColors.blue,
                  title: 'Link a feed',
                  onTap: unlinked.isEmpty
                      ? null
                      : () => _openLinkSheet(context, ref, unlinked),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _unlink(WidgetRef ref, String feedId, String linkId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).deleteMemberLink(familyId, feedId, linkId);
    ref.invalidate(feedLinksProvider(feedId));
  }

  Future<void> _link(WidgetRef ref, String feedId) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).createMemberLink(familyId, feedId, familyMemberId: child.id);
    ref.invalidate(feedLinksProvider(feedId));
  }

  void _openLinkSheet(BuildContext context, WidgetRef ref, List<Map<String, dynamic>> unlinked) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => Padding(
        padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Link a feed', style: AppText.subPageTitle),
            const SizedBox(height: 16),
            for (final feed in unlinked)
              SettingRow(
                icon: _feedIcon(feed),
                iconColor: _feedColor(feed),
                title: _feedName(feed),
                subtitle: _feedSubtitle(feed),
                onTap: () {
                  _link(ref, feed['id'] as String);
                  Navigator.of(context).pop();
                },
              ),
          ],
        ),
      ),
    );
  }

  String _feedName(Map<String, dynamic> f) =>
      (f['sourceCalendarName'] as String?) ??
      (f['url'] as String?) ??
      (f['sourceCalendarId'] as String?) ??
      'Calendar feed';

  String _feedSubtitle(Map<String, dynamic> f) {
    final kind = f['kind'] as String? ?? 'ics';
    return switch (kind) {
      'google' => 'Family calendar · Google',
      'caldav' => 'Calendar · CalDAV',
      _ => 'School calendar · ICS',
    };
  }

  IconData _feedIcon(Map<String, dynamic> f) =>
      (f['kind'] as String? ?? 'ics') == 'ics' ? Icons.rss_feed_rounded : Icons.calendar_month_rounded;

  Color _feedColor(Map<String, dynamic> f) =>
      (f['kind'] as String? ?? 'ics') == 'ics' ? AppColors.feedBlue : AppColors.purple;
}
