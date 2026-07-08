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
import 'feed_baseline_screen.dart';
import 'member_sections.dart';

/// One detail screen for every family member — child and caretaker alike (the
/// Child/Caretaker tag is only a grouping). Configures the member's unified
/// calendar: source calendars (feed links), the target calendar the synthesis
/// mirrors to, task-claiming permissions, and the member color.
class MemberDetailScreen extends ConsumerWidget {
  const MemberDetailScreen({super.key, required this.memberId});
  final String memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final member = members.where((m) => m.id == memberId).firstOrNull;
    if (member == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final color = personColor(member);
    final isAdmin = me?.isAdmin ?? false;
    final isSelf = me?.id == member.id;
    final canEditColor = isAdmin || isSelf;
    // Target config is credential-bound: the member themselves, or an admin for
    // members without their own login (children, helpers).
    final canEditTarget = isSelf || (isAdmin && !member.hasLogin);
    final grouping = member.requiresCaretaker ? 'Child' : 'Caretaker';

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 40),
          children: [
            const SubPageHeader(title: 'Family member'),
            const SizedBox(height: 20),
            DetailProfileCard(
              avatar: PersonAvatar(
                  initial: initialFor(member.relationName), color: color, size: 54),
              name: member.relationName,
              subtitle:
                  '$grouping${member.isCaretaker ? ' · can claim tasks' : ''}',
              onEdit: () => showEditNameDialog(context, ref, member),
            ),
            const SizedBox(height: 24),
            MemberColorSection(member: member, others: members, enabled: canEditColor),
            const SizedBox(height: 24),
            _SourceCalendarsSection(member: member, canEdit: isAdmin),
            const SizedBox(height: 24),
            _UnifiedCalendarSection(member: member, canEdit: canEditTarget),
            const SizedBox(height: 24),
            const SectionEyebrow('Task claiming', color: AppColors.indigo),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                children: [
                  SwitchRow(
                    icon: Icons.person_outline_rounded,
                    iconColor: AppColors.indigo,
                    title: 'Can claim tasks',
                    subtitle: 'Appears as an owner option when claiming',
                    value: member.isCaretaker,
                    onChanged:
                        isAdmin ? (v) => _setFlag(ref, member, isCaretaker: v) : null,
                  ),
                  const Divider(height: 20),
                  SwitchRow(
                    icon: Icons.shield_outlined,
                    iconColor: AppColors.amber,
                    title: 'Admin access',
                    subtitle: 'Can manage the whole family',
                    value: member.isAdmin,
                    onChanged:
                        isAdmin ? (v) => _setFlag(ref, member, isAdmin: v) : null,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            const SectionEyebrow('Family logistics', color: AppColors.amber),
            const SizedBox(height: 8),
            Text(
              'What each event generates (drop-off, pickup, attendance) lives on '
              'the calendar link — tap a source calendar above to configure it.',
              style: AppText.subtitle,
            ),
            const SizedBox(height: 28),
            if (isAdmin && !isSelf)
              _RemoveButton(
                label: 'Remove from family',
                onTap: () => _confirmRemove(context, ref, member),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _setFlag(WidgetRef ref, Member m,
      {bool? isAdmin, bool? isCaretaker}) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).updateMember(
          familyId,
          m.id,
          isAdmin: isAdmin,
          isCaretaker: isCaretaker,
        );
    ref.invalidate(membersProvider);
    ref.invalidate(currentMemberProvider);
  }

  Future<void> _confirmRemove(BuildContext context, WidgetRef ref, Member m) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Remove from family?'),
        content: Text('Remove ${m.relationName}? Their unified calendar, feed '
            'links, and claimed tasks are deleted. This cannot be undone.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel')),
          PillButton(
            label: 'Remove',
            variant: PillVariant.white,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).deleteMember(familyId, m.id);
      ref.invalidate(membersProvider);
      ref.invalidate(calendarEventsProvider);
      if (context.mounted) Navigator.of(context).pop();
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Remove failed: $e')));
      }
    }
  }
}

/// "Source calendars" — the feeds linked to this member, each transformed by
/// its override pipeline then merged into the target below.
class _SourceCalendarsSection extends ConsumerWidget {
  const _SourceCalendarsSection({required this.member, required this.canEdit});
  final Member member;
  final bool canEdit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final feeds = ref.watch(feedsProvider).valueOrNull ?? const <FeedItem>[];
    final linked = <(FeedItem, FeedLink)>[];
    var anyUnlinked = false;
    for (final feed in feeds) {
      final links = ref.watch(feedLinksProvider(feed.id)).valueOrNull ?? const <FeedLink>[];
      final link = links.where((l) => l.familyMemberId == member.id).firstOrNull;
      if (link != null) {
        linked.add((feed, link));
      } else {
        anyUnlinked = true;
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SectionEyebrow(
          'Source calendars',
          color: AppColors.feedBlue,
          trailing: TintBadge('${linked.length}', color: AppColors.green),
        ),
        const SizedBox(height: 8),
        Text(
          'Calendars & feeds that get transformed, then merged into the target below.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 12),
        AppCard(
          child: Column(
            children: [
              if (linked.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text('No source calendars yet', style: AppText.subtitle),
                )
              else
                for (final (feed, link) in linked) ...[
                  SettingRow(
                    icon: feed.kind == 'ics'
                        ? Icons.rss_feed_rounded
                        : Icons.calendar_month_rounded,
                    iconColor:
                        feed.isException ? AppColors.amber : AppColors.feedBlue,
                    title: feed.displayName,
                    subtitle: feed.isException
                        ? 'Exception-only · transformed'
                        : 'Standard · ${feed.kind.toUpperCase()}',
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (!link.active)
                          const TintBadge('off', color: AppColors.coral)
                        else
                          const TintBadge('on', color: AppColors.green),
                        const SizedBox(width: 6),
                        const Icon(Icons.chevron_right_rounded,
                            color: AppColors.textMuted),
                      ],
                    ),
                    onTap: () => _openLink(context, feed, link),
                  ),
                  const Divider(height: 20),
                ],
              if (canEdit)
                SettingRow(
                  icon: Icons.add_rounded,
                  iconColor: AppColors.feedBlue,
                  title: 'Add another calendar',
                  onTap: anyUnlinked || feeds.isEmpty
                      ? () => _openLink(context, null, null)
                      : null,
                ),
            ],
          ),
        ),
      ],
    );
  }

  void _openLink(BuildContext context, FeedItem? feed, FeedLink? link) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) =>
          FeedBaselineScreen(member: member, feed: feed, existingLink: link),
    ));
  }
}

/// "Unified calendar" — the one writable target calendar synthesized events are
/// mirrored to (and human events read back from). Optional: without one, the
/// unified calendar lives only in the app and still shows in Plan.
class _UnifiedCalendarSection extends ConsumerWidget {
  const _UnifiedCalendarSection({required this.member, required this.canEdit});
  final Member member;
  final bool canEdit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final target = ref.watch(memberCalendarProvider(member.id)).valueOrNull;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionEyebrow('Unified calendar', color: AppColors.green),
        const SizedBox(height: 8),
        Text(
          'Pick one writable calendar as the target. Sources are merged into it; '
          'the result shows in Plan.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 12),
        AppCard(
          padding: EdgeInsets.zero,
          child: SettingRow(
            icon: Icons.event_available_rounded,
            iconColor: AppColors.green,
            title: target == null
                ? 'No target calendar'
                : '${target.methodLabel} · '
                    '${target.targetCalendarName ?? target.targetCalendarId}',
            subtitle: target == null
                ? 'Agenda lives in the app only — tap to pick one'
                : 'shared, writable · synced both ways',
            trailing: canEdit
                ? const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted)
                : null,
            onTap: canEdit ? () => _pickTarget(context, ref, target) : null,
          ),
        ),
      ],
    );
  }

  Future<void> _pickTarget(
      BuildContext context, WidgetRef ref, MemberCalendarConfig? current) async {
    final accounts = ref.read(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
    if (accounts.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Connect a calendar account on the Me tab first')));
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetCtx) =>
          _TargetPickerSheet(member: member, accounts: accounts, current: current),
    );
  }
}

/// Two-step picker: choose an account, then one of its writable calendars.
class _TargetPickerSheet extends ConsumerStatefulWidget {
  const _TargetPickerSheet({
    required this.member,
    required this.accounts,
    required this.current,
  });
  final Member member;
  final List<ExternalAccount> accounts;
  final MemberCalendarConfig? current;

  @override
  ConsumerState<_TargetPickerSheet> createState() => _TargetPickerSheetState();
}

class _TargetPickerSheetState extends ConsumerState<_TargetPickerSheet> {
  ExternalAccount? _account;
  List<Map<String, dynamic>> _calendars = const [];
  bool _loading = false;
  bool _busy = false;
  String? _error;

  Future<void> _loadCalendars(ExternalAccount account) async {
    setState(() {
      _account = account;
      _loading = true;
      _error = null;
      _calendars = const [];
    });
    try {
      final cals =
          await ref.read(apiClientProvider).listAccountCalendars(account.id);
      setState(() => _calendars = cals.cast<Map<String, dynamic>>());
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _choose(Map<String, dynamic> cal) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).setMemberCalendarTarget(
            familyId,
            widget.member.id,
            externalAccountId: _account!.id,
            targetCalendarId: cal['id'] as String,
            targetCalendarName: cal['name'] as String?,
          );
      ref.invalidate(memberCalendarProvider(widget.member.id));
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = '$e';
      });
    }
  }

  Future<void> _remove() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref
          .read(apiClientProvider)
          .clearMemberCalendarTarget(familyId, widget.member.id);
      ref.invalidate(memberCalendarProvider(widget.member.id));
      ref.invalidate(calendarEventsProvider);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
            22, 4, 22, 28 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Target calendar', style: AppText.subPageTitle),
            const SizedBox(height: 6),
            Text(
              _account == null
                  ? 'Choose the account that holds '
                      "${widget.member.relationName}'s calendar."
                  : 'Pick the writable calendar to merge into.',
              style: AppText.subtitle,
            ),
            const SizedBox(height: 14),
            if (_account == null) ...[
              for (final a in widget.accounts)
                SettingRow(
                  icon: a.kind == 'google'
                      ? Icons.calendar_month_rounded
                      : Icons.cloud_outlined,
                  iconColor:
                      a.kind == 'google' ? AppColors.blue : AppColors.indigo,
                  title: a.name,
                  subtitle: a.kindLabel,
                  onTap: () => _loadCalendars(a),
                ),
            ] else if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else ...[
              for (final cal in _calendars)
                SettingRow(
                  icon: Icons.event_note_rounded,
                  iconColor: AppColors.green,
                  title: (cal['name'] as String?) ?? (cal['id'] as String),
                  onTap: _busy ? null : () => _choose(cal),
                ),
            ],
            if (widget.current != null) ...[
              const SizedBox(height: 10),
              SettingRow(
                icon: Icons.link_off_rounded,
                iconColor: AppColors.coral,
                title: 'Remove target calendar',
                subtitle: 'Mirrored events are cancelled remotely',
                onTap: _busy ? null : _remove,
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
            ],
          ],
        ),
      ),
    );
  }
}

class _RemoveButton extends StatelessWidget {
  const _RemoveButton({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.tint(AppColors.coral, 0.10),
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          height: 52,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.coral.withValues(alpha: 0.5)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.close_rounded, color: AppColors.coral, size: 19),
              const SizedBox(width: 8),
              Text(label, style: font(kBodyFont, 14, 700, color: AppColors.coral)),
            ],
          ),
        ),
      ),
    );
  }
}
