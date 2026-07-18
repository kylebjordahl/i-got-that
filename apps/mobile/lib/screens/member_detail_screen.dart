import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../state/nav.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/app_bottom_nav.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import 'add_calendar_sheet.dart';
import 'feed_baseline_screen.dart';
import 'member_editor_screen.dart';
import 'task_rules_screen.dart';

/// One detail screen for every family member — child and caretaker alike (6e).
/// Three sections, each with a full-height accent bar: Source calendars, the
/// Unified (target) calendar, and Family logistics (task generation + claiming
/// merged). Identity — name / color / role / admin — is edited in the ✎ modal.
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
    // Target config is credential-bound: the member themselves, or an admin for
    // members without their own login (children, helpers).
    final canEditTarget = isSelf || (isAdmin && !member.hasLogin);
    final grouping = member.requiresCaretaker ? 'Child' : 'Caretaker';

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(22, 12, 22, 20),
              child: SubPageHeader(title: 'Family member'),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 150),
                children: [
                  DetailProfileCard(
                    avatar: PersonAvatar(
                        initial: initialFor(member.relationName), color: color, size: 54),
                    name: member.relationName,
                    subtitle: '$grouping · ● ${_colorName(color)}',
                    onEdit: (isAdmin || isSelf)
                        ? () => showMemberEditor(context, ref, member)
                        : null,
                  ),
                  const SizedBox(height: 24),
                  if (isAdmin && !member.hasLogin) ...[
                    _AccentSection(
                      color: AppColors.indigo,
                      child: _InviteSection(member: member),
                    ),
                    const SizedBox(height: 24),
                  ],
                  _AccentSection(
                    color: AppColors.feedBlue,
                    child: _SourceCalendarsSection(member: member, canEdit: isAdmin),
                  ),
                  const SizedBox(height: 24),
                  _AccentSection(
                    color: AppColors.green,
                    child: _UnifiedCalendarSection(member: member, canEdit: canEditTarget),
                  ),
                  const SizedBox(height: 24),
                  _AccentSection(
                    color: AppColors.amber,
                    child: _FamilyLogisticsSection(member: member, canEdit: isAdmin),
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
          ],
        ),
      ),
    );
  }

  String _colorName(Color c) {
    final hex = hexFromColor(c).toUpperCase();
    return switch (hex) {
      '#8E9BFF' => 'Indigo',
      '#66B4FF' => 'Blue',
      '#4FD9A8' => 'Green',
      '#C08CFF' => 'Purple',
      '#FF7A6B' => 'Coral',
      '#E8A44D' => 'Amber',
      _ => 'Custom',
    };
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
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Remove failed: $e'),
          margin: snackBarMarginAboveNav(context),
        ));
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
    for (final feed in feeds) {
      final links = ref.watch(feedLinksProvider(feed.id)).valueOrNull ?? const <FeedLink>[];
      final link = links.where((l) => l.familyMemberId == member.id).firstOrNull;
      if (link != null) linked.add((feed, link));
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
                    icon: feed.isBusy
                        ? Icons.lock_clock_rounded
                        : feed.kind == 'ics'
                            ? Icons.rss_feed_rounded
                            : Icons.calendar_month_rounded,
                    iconColor: feed.isException
                        ? AppColors.amber
                        : feed.isBusy
                            ? AppColors.purple
                            : AppColors.feedBlue,
                    title: feed.displayName,
                    subtitle: feed.isException
                        ? 'Exception-only · transformed'
                        : feed.isBusy
                            ? 'Busy-only · free/busy'
                            : 'Standard · ${feed.sourceLabel}',
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
                  onTap: () => showAddCalendarSheet(context, ref, member),
                ),
            ],
          ),
        ),
      ],
    );
  }

  void _openLink(BuildContext context, FeedItem feed, FeedLink link) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) =>
          FeedBaselineScreen(member: member, feed: feed, existingLink: link),
    ));
  }
}

/// "Invite link" — for a member with no login yet (a pre-created caretaker
/// slot), an admin can issue a one-time code that links a real account to this
/// member. Shown only while the slot is unclaimed; once linked this section
/// disappears (gated by `!member.hasLogin` in the parent build).
class _InviteSection extends ConsumerStatefulWidget {
  const _InviteSection({required this.member});
  final Member member;

  @override
  ConsumerState<_InviteSection> createState() => _InviteSectionState();
}

class _InviteSectionState extends ConsumerState<_InviteSection> {
  String? _token;
  String? _url;
  DateTime? _expiresAt;
  bool _busy = false;
  String? _error;

  /// The thing we share: the full deep-link URL when the server composed one
  /// (deployed envs with PUBLIC_ORIGIN), else the raw token (local dev).
  String? get _shareable => _url ?? _token;

  Future<void> _generate() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final res =
          await ref.read(apiClientProvider).issueMemberInvite(familyId, widget.member.id);
      final expires = res['expiresAt'];
      setState(() {
        _token = res['token'] as String;
        _url = res['url'] as String?;
        _expiresAt = expires is String ? DateTime.tryParse(expires) : null;
      });
    } catch (e) {
      setState(() => _error = 'Could not generate an invite: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _share() async {
    final link = _shareable;
    if (link == null) return;
    await Share.share(
      link,
      subject: 'Join ${widget.member.relationName} on I Got That',
    );
  }

  void _copy() {
    final link = _shareable;
    if (link == null) return;
    Clipboard.setData(ClipboardData(text: link));
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: const Text('Invite link copied'),
      margin: snackBarMarginAboveNav(context),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionEyebrow('Invite link', color: AppColors.indigo),
        const SizedBox(height: 8),
        Text(
          '${widget.member.relationName} has no login yet. Generate a link so '
          'they can sign in and claim this profile.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 12),
        if (_token == null)
          AppCard(
            child: Row(
              children: [
                const IconTile(icon: Icons.link_rounded, color: AppColors.indigo),
                const SizedBox(width: 14),
                Expanded(
                  child: Text('No active invite yet', style: AppText.sectionItemTitle),
                ),
                PillButton(
                  label: _busy ? 'Generating…' : 'Generate',
                  variant: PillVariant.indigo,
                  onPressed: _busy ? null : _generate,
                ),
              ],
            ),
          )
        else
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: SelectableText(
                        _shareable!,
                        maxLines: 2,
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 13),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Copy',
                      icon: const Icon(Icons.copy_rounded, color: AppColors.textMuted),
                      onPressed: _copy,
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    PillButton(
                      label: 'Share link',
                      variant: PillVariant.indigo,
                      onPressed: _share,
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  _shareCopy(),
                  style: AppText.subtitle,
                ),
                const SizedBox(height: 10),
                SettingRow(
                  icon: Icons.refresh_rounded,
                  iconColor: AppColors.indigo,
                  title: 'Generate a new link',
                  onTap: _busy ? null : _generate,
                ),
              ],
            ),
          ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
        ],
      ],
    );
  }

  /// Helper text under the invite link. When the server composed a URL, the
  /// recipient just taps it (opens the app, or web). Without one (local dev), we
  /// fall back to the paste-the-code instructions.
  String _shareCopy() {
    final name = widget.member.relationName;
    final expiry = _expiresAt != null ? ' It expires ${_formatExpiry(_expiresAt!)}.' : '';
    if (_url != null) {
      return 'Send this to $name — tapping it opens the app (or the web) and '
          'walks them through joining in one step.$expiry';
    }
    return 'Share this code with $name. Once they sign in, they can paste it '
        'under "Redeem invite code" on the Me tab.$expiry';
  }

  String _formatExpiry(DateTime expiresAt) {
    final days = expiresAt.toLocal().difference(DateTime.now()).inDays;
    if (days <= 0) return 'soon';
    if (days == 1) return 'in 1 day';
    return 'in $days days';
  }
}

/// A section wrapped by a full-height 3px accent bar on its left (6e).
class _AccentSection extends StatelessWidget {
  const _AccentSection({required this.color, required this.child});
  final Color color;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: 3,
            margin: const EdgeInsets.only(right: 14, top: 2, bottom: 2),
            decoration: BoxDecoration(
              color: color,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          Expanded(child: child),
        ],
      ),
    );
  }
}

/// "Family logistics" (6e) — task generation + claiming are one feature, so
/// they live together. Admin access moved to the member editor (6h).
class _FamilyLogisticsSection extends ConsumerWidget {
  const _FamilyLogisticsSection({required this.member, required this.canEdit});
  final Member member;
  final bool canEdit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final generates = member.generatesFamilyTasks;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionEyebrow('Family logistics', color: AppColors.amber),
        const SizedBox(height: 8),
        Text(
          "Turn this person's events into tasks the family can claim — and "
          'whether this person can claim others’ tasks.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 12),
        AppCard(
          child: Column(
            children: [
              SwitchRow(
                icon: Icons.auto_awesome_rounded,
                iconColor: AppColors.amber,
                title: 'Generate family tasks',
                subtitle:
                    "${member.relationName}'s unified-calendar events become claimable tasks",
                value: generates,
                onChanged: canEdit
                    ? (v) => _setFlag(ref, generatesFamilyTasks: v)
                    : null,
              ),
              if (generates) ...[
                const Divider(height: 20),
                SettingRow(
                  icon: Icons.rule_rounded,
                  iconColor: AppColors.purple,
                  title: 'Task rules',
                  subtitle: 'What each event generates, per calendar',
                  trailing:
                      const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
                  onTap: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => TaskRulesScreen(member: member),
                  )),
                ),
              ],
              const Divider(height: 20),
              SwitchRow(
                icon: Icons.person_outline_rounded,
                iconColor: AppColors.indigo,
                title: 'Can claim tasks',
                subtitle: 'Appears as an owner option when claiming',
                value: member.isCaretaker,
                onChanged: canEdit ? (v) => _setFlag(ref, isCaretaker: v) : null,
              ),
            ],
          ),
        ),
        if (generates) ...[
          const SizedBox(height: 8),
          Text(
            'Which events become tasks is set per source calendar — open one '
            'under Source calendars above to edit its schedule rules.',
            style: AppText.subtitle,
          ),
        ],
      ],
    );
  }

  Future<void> _setFlag(WidgetRef ref,
      {bool? isCaretaker, bool? generatesFamilyTasks}) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).updateMember(
          familyId,
          member.id,
          isCaretaker: isCaretaker,
          generatesFamilyTasks: generatesFamilyTasks,
        );
    ref.invalidate(membersProvider);
    ref.invalidate(currentMemberProvider);
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
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
    final accounts = ref.watch(accountsProvider).valueOrNull ?? const <ExternalAccount>[];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionEyebrow('Unified calendar', color: AppColors.green),
        const SizedBox(height: 8),
        Text(
          'Pick one writable calendar as the target. Sources are merged into it; '
          'events you add by hand are kept — synthesis only manages what it brought in.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 12),
        if (target != null)
          AppCard(
            onTap: canEdit ? () => _pickTarget(context, ref, target) : null,
            child: Row(
              children: [
                const IconTile(
                    icon: Icons.event_available_rounded, color: AppColors.green, size: 40),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('TARGET CALENDAR', style: AppText.eyebrow(AppColors.green)),
                      const SizedBox(height: 4),
                      Text(
                          '${target.methodLabel} · ${target.targetCalendarName ?? target.targetCalendarId}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppText.sectionItemTitle),
                      const SizedBox(height: 2),
                      Text('shared, writable · synced both ways', style: AppText.subtitle),
                    ],
                  ),
                ),
                if (canEdit)
                  const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
              ],
            ),
          )
        else if (accounts.isEmpty)
          _UnconfiguredCard(
            accent: AppColors.amber,
            icon: Icons.link_off_rounded,
            title: 'No calendar accounts',
            body: 'The calendar runs in-app. To mirror it out to a real calendar, '
                'connect an account first.',
            cta: 'Set up an account →',
            enabled: canEdit,
            onTap: () => Navigator.of(context).push<void>(
              MaterialPageRoute(builder: (_) => const _MeShortcut()),
            ),
          )
        else
          _UnconfiguredCard(
            accent: AppColors.green,
            icon: Icons.cloud_off_rounded,
            title: 'Kept in-app only',
            body: 'No writable target picked, so it stays server-side: synthesis '
                'still runs and feeds Plan & tasks. Pick a target to also mirror it out.',
            cta: 'Choose a target calendar',
            enabled: canEdit,
            onTap: () => _pickTarget(context, ref, null),
          ),
      ],
    );
  }

  Future<void> _pickTarget(
      BuildContext context, WidgetRef ref, MemberCalendarConfig? current) async {
    final accounts = ref.read(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
    if (accounts.isEmpty) return;
    await showModalBottomSheet<void>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetCtx) =>
          _TargetPickerSheet(member: member, accounts: accounts, current: current),
    );
  }
}

/// A dashed "unconfigured" resting-state card (6j) — not an error.
class _UnconfiguredCard extends StatelessWidget {
  const _UnconfiguredCard({
    required this.accent,
    required this.icon,
    required this.title,
    required this.body,
    required this.cta,
    required this.enabled,
    required this.onTap,
  });
  final Color accent;
  final IconData icon;
  final String title;
  final String body;
  final String cta;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.tint(accent, 0.07),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: accent.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, color: accent, size: 20),
              const SizedBox(width: 10),
              Text(title, style: AppText.sectionItemTitle),
            ],
          ),
          const SizedBox(height: 8),
          Text(body, style: AppText.subtitle),
          if (enabled) ...[
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: Material(
                color: accent,
                borderRadius: BorderRadius.circular(999),
                child: InkWell(
                  onTap: onTap,
                  borderRadius: BorderRadius.circular(999),
                  child: Container(
                    height: 46,
                    alignment: Alignment.center,
                    child: Text(cta,
                        style: font(kBodyFont, 14, 700, color: const Color(0xFF14231A))),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Routes to the Me tab (for the "set up an account" CTA on 6j).
class _MeShortcut extends ConsumerWidget {
  const _MeShortcut();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(navIndexProvider.notifier).state = 3; // Me tab
      Navigator.of(context).popUntil((r) => r.isFirst);
    });
    return const Scaffold(body: Center(child: CircularProgressIndicator()));
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
