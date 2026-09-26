import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

/// "Email invites" on member detail — calendar invites for a filtered slice of
/// the member's unified calendar, mailed to any address that confirms it wants
/// them (a grandparent, a nanny, a work inbox). Shown only to whoever manages
/// the member's outputs: the addresses are other people's.
class EmailOutputsSection extends ConsumerWidget {
  const EmailOutputsSection({super.key, required this.member});
  final Member member;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(emailOutputsProvider(member.id)).valueOrNull;
    final outputs = state?.outputs ?? const <EmailOutput>[];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SectionEyebrow(
          'Email invites',
          color: AppColors.coral,
          trailing: outputs.isEmpty
              ? null
              : TintBadge('${outputs.length}', color: AppColors.coral),
        ),
        const SizedBox(height: 8),
        Text(
          'Send calendar invites for some of ${member.relationName}\'s events to '
          'an email address — only the kinds you pick.',
          style: AppText.subtitle,
        ),
        if (state != null && !state.emailEnabled) ...[
          const SizedBox(height: 10),
          Text(
            'Outbound email isn\'t switched on for this server yet, so nothing '
            'is sent for now.',
            style: AppText.subtitle.copyWith(color: AppColors.amber),
          ),
        ],
        const SizedBox(height: 12),
        for (final o in outputs) ...[
          AppCard(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: SettingRow(
              icon: Icons.mail_outline_rounded,
              iconColor: AppColors.coral,
              title: o.label ?? o.email,
              subtitle: [
                if (o.label != null) o.email,
                o.filters.summary,
              ].join('\n'),
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (!o.verified)
                    const TintBadge('Unconfirmed', color: AppColors.amber)
                  else if (!o.active)
                    const TintBadge('Paused', color: AppColors.textMuted),
                  const SizedBox(width: 6),
                  const Icon(
                    Icons.chevron_right_rounded,
                    color: AppColors.textMuted,
                  ),
                ],
              ),
              onTap: () => showEmailOutputSheet(context, member, existing: o),
            ),
          ),
          const SizedBox(height: 10),
        ],
        PillButton(
          label: outputs.isEmpty ? 'Add email invites' : 'Add another address',
          icon: Icons.add_rounded,
          variant: PillVariant.ghost,
          onPressed: () => showEmailOutputSheet(context, member),
        ),
      ],
    );
  }
}

/// Create ([existing] null) or edit an email output. `useRootNavigator` layers
/// it over the floating nav pill (see [showMemberOverridesSheet]).
Future<void> showEmailOutputSheet(
  BuildContext context,
  Member member, {
  EmailOutput? existing,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => EmailOutputSheet(member: member, existing: existing),
  );
}

/// The member's own linked calendars, in priority order — what a source
/// filter can name.
List<(FeedItem, FeedLink)> _linkedCalendars(WidgetRef ref, String memberId) {
  final feeds = ref.watch(feedsProvider).valueOrNull ?? const <FeedItem>[];
  final linked = <(FeedItem, FeedLink)>[];
  for (final feed in feeds) {
    final links =
        ref.watch(feedLinksProvider(feed.id)).valueOrNull ?? const <FeedLink>[];
    final link = links.where((l) => l.familyMemberId == memberId).firstOrNull;
    if (link != null) linked.add((feed, link));
  }
  linked.sort((a, b) => a.$2.position.compareTo(b.$2.position));
  return linked;
}

class EmailOutputSheet extends ConsumerStatefulWidget {
  const EmailOutputSheet({super.key, required this.member, this.existing});
  final Member member;
  final EmailOutput? existing;

  @override
  ConsumerState<EmailOutputSheet> createState() => _EmailOutputSheetState();
}

class _EmailOutputSheetState extends ConsumerState<EmailOutputSheet> {
  late final _email = TextEditingController(text: widget.existing?.email);
  late final _label = TextEditingController(text: widget.existing?.label);
  late Set<String> _include = {
    ...(widget.existing?.filters ?? EmailOutputFilters.claimedOnly).include,
  };
  late Set<String>? _taskTypes = widget.existing?.filters.taskTypes?.toSet();
  late Set<String>? _links = widget.existing?.filters.sourceLinkIds?.toSet();
  late bool _active = widget.existing?.active ?? true;
  bool _busy = false;
  String? _error;

  bool get _isNew => widget.existing == null;

  @override
  void dispose() {
    _email.dispose();
    _label.dispose();
    super.dispose();
  }

  EmailOutputFilters get _filters => EmailOutputFilters(
    include: _include,
    taskTypes: _include.contains('claimed_task') ? _taskTypes : null,
    sourceLinkIds: _links,
  );

  String _describe(Object e) {
    if (e is DioException) {
      final body = e.response?.data;
      final code = body is Map ? body['error'] : null;
      return switch (code) {
        'invalid' => 'Enter a valid email address.',
        'duplicate_email' =>
          'That address already gets invites for this person.',
        'too_many_outputs' => 'That\'s the most addresses one person can have.',
        'too_many_requests' =>
          'You\'ve sent today\'s limit of confirmation emails. Try again tomorrow.',
        'email_disabled' => 'Email isn\'t switched on for this server yet.',
        'already_verified' => 'That address has already confirmed.',
        'recipient_unsubscribed' =>
          'That address has unsubscribed from calendar invites. They can undo '
              'it from the unsubscribe link in any earlier email.',
        _ => 'Failed: ${e.response?.statusCode ?? e.message}',
      };
    }
    return 'Failed: $e';
  }

  Future<void> _run(Future<String?> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final message = await action();
      ref.invalidate(emailOutputsProvider(widget.member.id));
      if (!mounted) return;
      Navigator.of(context).pop();
      if (message != null) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(message)));
      }
    } catch (e) {
      if (mounted) setState(() => _error = _describe(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _save() async {
    if (_include.isEmpty) {
      setState(() => _error = 'Pick at least one kind of event to send.');
      return;
    }
    final api = ref.read(apiClientProvider);
    final familyId = await ref.read(familyProvider.future);
    final label = _label.text.trim();
    await _run(() async {
      if (_isNew) {
        final email = _email.text.trim();
        final res = await api.createEmailOutput(
          familyId,
          widget.member.id,
          email: email,
          label: label,
          filters: _filters.toJson(),
        );
        return res['verificationSent'] == true
            ? 'Confirmation sent to $email — nothing is sent until they confirm.'
            : 'Invites to $email will start shortly.';
      }
      await api.updateEmailOutput(
        familyId,
        widget.member.id,
        widget.existing!.id,
        label: label.isEmpty ? null : label,
        clearLabel: label.isEmpty,
        filters: _filters.toJson(),
        active: _active,
      );
      return null;
    });
  }

  Future<void> _resend() async {
    final api = ref.read(apiClientProvider);
    final familyId = await ref.read(familyProvider.future);
    await _run(() async {
      await api.resendEmailOutputVerification(
        familyId,
        widget.member.id,
        widget.existing!.id,
      );
      return 'Confirmation re-sent to ${widget.existing!.email}.';
    });
  }

  Future<void> _remove() async {
    final api = ref.read(apiClientProvider);
    final familyId = await ref.read(familyProvider.future);
    await _run(() async {
      await api.deleteEmailOutput(
        familyId,
        widget.member.id,
        widget.existing!.id,
      );
      return 'Removed — upcoming invites to ${widget.existing!.email} are cancelled.';
    });
  }

  void _toggleKind(String kind, bool on) => setState(() {
    _include = {..._include};
    on ? _include.add(kind) : _include.remove(kind);
  });

  /// Tap a chip in a "narrow by" row: null (everything) → just this one;
  /// otherwise toggle it, falling back to null when the last is removed.
  Set<String>? _toggleIn(Set<String>? current, String id) {
    if (current == null) return {id};
    final next = {...current};
    next.contains(id) ? next.remove(id) : next.add(id);
    return next.isEmpty ? null : next;
  }

  @override
  Widget build(BuildContext context) {
    final linked = _linkedCalendars(ref, widget.member.id);
    final existing = widget.existing;
    const taskTypes = {
      'dropoff': 'Drop-offs',
      'pickup': 'Pickups',
      'attendance': 'Attendance',
    };

    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          22,
          4,
          22,
          28 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              _isNew ? 'Add email invites' : 'Email invites',
              style: AppText.subPageTitle,
            ),
            const SizedBox(height: 6),
            Text(
              _isNew
                  ? 'We\'ll email this address a link to confirm first. Nothing '
                        'else is sent until it\'s confirmed.'
                  : existing!.verified
                  ? 'Invites for ${widget.member.relationName}\'s events that '
                        'match below go to ${existing.email}.'
                  : '${existing.email} hasn\'t confirmed yet, so nothing is '
                        'being sent.',
              style: AppText.subtitle,
            ),
            const SizedBox(height: 16),
            if (_isNew)
              TextField(
                controller: _email,
                autofocus: true,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                decoration: const InputDecoration(labelText: 'Email address'),
              ),
            TextField(
              controller: _label,
              decoration: const InputDecoration(
                labelText: 'Label (optional)',
                hintText: 'e.g. Grandma',
              ),
            ),
            const SizedBox(height: 20),
            Text('SEND INVITES FOR', style: AppText.eyebrow()),
            const SizedBox(height: 6),
            SwitchRow(
              icon: Icons.task_alt_rounded,
              iconColor: AppColors.amber,
              title: 'Claimed tasks',
              subtitle: 'Drop-offs, pickups and events they\'ve taken on',
              value: _include.contains('claimed_task'),
              onChanged: (v) => _toggleKind('claimed_task', v),
            ),
            if (_include.contains('claimed_task'))
              Padding(
                padding: const EdgeInsets.only(left: 58, top: 2, bottom: 8),
                child: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    TaskFilterChip(
                      label: 'All',
                      selected: _taskTypes == null,
                      onTap: () => setState(() => _taskTypes = null),
                    ),
                    for (final e in taskTypes.entries)
                      TaskFilterChip(
                        label: e.value,
                        selected: _taskTypes?.contains(e.key) ?? false,
                        onTap: () => setState(
                          () => _taskTypes = _toggleIn(_taskTypes, e.key),
                        ),
                      ),
                  ],
                ),
              ),
            SwitchRow(
              icon: Icons.event_rounded,
              iconColor: AppColors.feedBlue,
              title: 'Schedule',
              subtitle: 'Events from their source calendars',
              value: _include.contains('schedule'),
              onChanged: (v) => _toggleKind('schedule', v),
            ),
            SwitchRow(
              icon: Icons.block_rounded,
              iconColor: AppColors.textMuted,
              title: 'Busy blocks',
              subtitle: 'Opaque free/busy time from a work calendar',
              value: _include.contains('busy'),
              onChanged: (v) => _toggleKind('busy', v),
            ),
            if (linked.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text('FROM CALENDARS', style: AppText.eyebrow()),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  TaskFilterChip(
                    label: 'All calendars',
                    selected: _links == null,
                    onTap: () => setState(() => _links = null),
                  ),
                  for (final (feed, link) in linked)
                    TaskFilterChip(
                      label: feed.displayName,
                      selected: _links?.contains(link.id) ?? false,
                      onTap: () =>
                          setState(() => _links = _toggleIn(_links, link.id)),
                    ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'A claimed task counts as coming from the calendar of the event '
                'it was generated from.',
                style: AppText.micro(),
              ),
            ],
            if (!_isNew) ...[
              const SizedBox(height: 16),
              SwitchRow(
                icon: Icons.pause_circle_outline_rounded,
                iconColor: AppColors.coral,
                title: 'Sending',
                subtitle: 'Turning this off cancels the invites already sent',
                value: _active,
                onChanged: (v) => setState(() => _active = v),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: const TextStyle(color: AppColors.coral)),
            ],
            const SizedBox(height: 20),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                PillButton(
                  label: _busy
                      ? 'Saving…'
                      : (_isNew ? 'Send confirmation' : 'Save'),
                  variant: PillVariant.amber,
                  onPressed: _busy ? null : _save,
                ),
                if (existing != null && !existing.verified)
                  PillButton(
                    label: 'Resend confirmation',
                    variant: PillVariant.ghost,
                    onPressed: _busy ? null : _resend,
                  ),
                if (existing != null)
                  PillButton(
                    label: 'Remove',
                    icon: Icons.delete_outline_rounded,
                    variant: PillVariant.ghost,
                    onPressed: _busy ? null : _remove,
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
