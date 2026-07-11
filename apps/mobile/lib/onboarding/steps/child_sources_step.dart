import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../models.dart';
import '../../state/auth.dart';
import '../../state/family.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../../theme/person_colors.dart';
import '../../widgets/primitives.dart';
import '../child_strip.dart';
import '../onboarding_scaffold.dart';

/// 1e — per child, connect calendar sources. Add the child's feeds (school ICS,
/// family calendar) drawing on the connected accounts plus any new ones. The
/// feed→child link lives on the child; a feed can serve several kids.
class ChildSourcesStep extends ConsumerWidget {
  const ChildSourcesStep({
    super.key,
    required this.child,
    required this.children,
    required this.childIndex,
    required this.onNext,
    required this.onBack,
    required this.onExit,
  });

  final Member child;
  final List<Member> children;
  final int childIndex;
  final VoidCallback onNext;
  final VoidCallback onBack;
  final VoidCallback onExit;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accent = personColor(child);
    final feeds = ref.watch(memberFeedsProvider(child.id)).valueOrNull ?? const <FeedItem>[];
    final name = child.relationName;
    return OnboardingScaffold(
      progress: 0.66,
      onBack: onBack,
      trailingLabel: 'Finish later',
      onTrailing: onExit,
      header: ChildStrip(children: children, currentIndex: childIndex),
      title: "$name's calendars",
      body: [
        Text.rich(
          TextSpan(
            text: 'Add the calendars that feed ',
            style: font(kBodyFont, 14, 500, color: AppColors.textSecondary, height: 1.5),
            children: [
              TextSpan(text: "$name's", style: font(kBodyFont, 14, 600, color: accent)),
              const TextSpan(text: ' schedule. Pull from your connected accounts, '
                  'or add a new source.'),
            ],
          ),
        ),
        const SizedBox(height: 22),
        GroupedCard(children: [
          for (final f in feeds)
            GroupRow(
              leading: IconTile(
                icon: f.isException ? Icons.rss_feed_rounded : Icons.calendar_month_rounded,
                color: f.isException ? AppColors.feedBlue : AppColors.purple,
              ),
              title: f.displayName,
              subtitle: f.isException ? 'School calendar · ICS' : 'Calendar source',
              trailing: Container(
                width: 26,
                height: 26,
                alignment: Alignment.center,
                decoration: const BoxDecoration(color: AppColors.green, shape: BoxShape.circle),
                child: const Icon(Icons.check_rounded, size: 14, color: Color(0xFF0F2A20)),
              ),
            ),
          GroupAddRow(
            title: 'Add a source',
            subtitle: 'From a connected account or a new feed URL',
            onTap: () => _showAddSourceSheet(context, ref, child),
          ),
        ]),
        const InfoHint('A feed can serve several kids — link it here for each '
            'child it applies to.'),
      ],
      bottom: OnboardingButton(label: 'Continue', onPressed: onNext),
    );
  }
}

Future<void> _showAddSourceSheet(BuildContext context, WidgetRef ref, Member child) async {
  await showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _AddSourceSheet(child: child),
  );
  ref.invalidate(memberFeedsProvider(child.id));
  ref.invalidate(feedsProvider);
}

class _AddSourceSheet extends ConsumerStatefulWidget {
  const _AddSourceSheet({required this.child});
  final Member child;

  @override
  ConsumerState<_AddSourceSheet> createState() => _AddSourceSheetState();
}

class _CalCandidate {
  _CalCandidate(this.accountId, this.method, this.calId, this.calName, this.accountLabel);
  final String accountId;
  final String method; // 'google' | 'caldav'
  final String calId;
  final String calName;
  final String accountLabel;
}

class _AddSourceSheetState extends ConsumerState<_AddSourceSheet> {
  bool _loading = true;
  List<_CalCandidate> _cals = const [];
  final _url = TextEditingController();
  bool _exception = false;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final api = ref.read(apiClientProvider);
      final accounts = await ref.read(accountsProvider.future);
      final out = <_CalCandidate>[];
      for (final a in accounts) {
        List<dynamic> cals;
        try {
          cals = await api.listAccountCalendars(a.id);
        } catch (_) {
          cals = const [];
        }
        for (final c in cals.cast<Map<String, dynamic>>()) {
          out.add(_CalCandidate(a.id, a.method, c['id'] as String,
              (c['name'] as String?) ?? 'Calendar', '${a.kindLabel} · ${a.username ?? a.name}'));
        }
      }
      if (mounted) {
        setState(() {
          _cals = out;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = '$e';
          _loading = false;
        });
      }
    }
  }

  Future<void> _addAccountCalendar(_CalCandidate c) async {
    await _run(() async {
      final api = ref.read(apiClientProvider);
      final familyId = await ref.read(familyProvider.future);
      final res = await api.createFeed(familyId,
          mode: 'standard',
          kind: c.method,
          externalAccountId: c.accountId,
          sourceCalendarId: c.calId,
          sourceCalendarName: c.calName);
      final feedId = (res['feed'] as Map<String, dynamic>?)?['id'] as String? ??
          (res['id'] as String);
      await api.createMemberLink(familyId, feedId, familyMemberId: widget.child.id);
    });
  }

  Future<void> _addIcs() async {
    if (_url.text.trim().isEmpty) {
      setState(() => _error = 'Enter a feed URL');
      return;
    }
    await _run(() async {
      final api = ref.read(apiClientProvider);
      final familyId = await ref.read(familyProvider.future);
      final res = await api.createFeed(familyId,
          mode: _exception ? 'exception' : 'standard', kind: 'ics', url: _url.text.trim());
      final feedId = (res['feed'] as Map<String, dynamic>?)?['id'] as String? ??
          (res['id'] as String);
      await api.createMemberLink(familyId, feedId, familyMemberId: widget.child.id);
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.85),
      decoration: const BoxDecoration(
        color: Color(0xFF1B1622),
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
        border: Border(top: BorderSide(color: AppColors.border)),
      ),
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 10),
            Container(
                width: 38,
                height: 4,
                decoration: BoxDecoration(
                    color: const Color(0x33FFFFFF), borderRadius: BorderRadius.circular(2))),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 12, 22, 4),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text("Add a source for ${widget.child.relationName}",
                    style: AppText.subPageTitle),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(22, 8, 22, 4),
                children: [
                  if (_loading)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 26),
                      child: Center(
                          child: SizedBox(
                              width: 24,
                              height: 24,
                              child: CircularProgressIndicator(
                                  strokeWidth: 2, color: AppColors.indigo))),
                    )
                  else if (_cals.isNotEmpty) ...[
                    Text('FROM A CONNECTED ACCOUNT', style: AppText.eyebrow()),
                    const SizedBox(height: 10),
                    for (final c in _cals) ...[
                      SelectRow(
                        icon: c.method == 'google'
                            ? Icons.calendar_month_rounded
                            : Icons.cloud_rounded,
                        iconColor: c.method == 'google' ? AppColors.feedBlue : AppColors.indigo,
                        title: c.calName,
                        subtitle: c.accountLabel,
                        trailing: RowTrailing.chevron,
                        onTap: _busy ? null : () => _addAccountCalendar(c),
                      ),
                      const SizedBox(height: 9),
                    ],
                    const SizedBox(height: 8),
                  ],
                  Text('OR ADD A FEED URL', style: AppText.eyebrow()),
                  const SizedBox(height: 10),
                  TextField(
                    controller: _url,
                    style: font(kBodyFont, 14, 500),
                    decoration: InputDecoration(
                      hintText: 'https://…/calendar.ics',
                      hintStyle: font(kBodyFont, 14, 500, color: AppColors.textMuted),
                      filled: true,
                      fillColor: AppColors.card,
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(14),
                        borderSide: const BorderSide(color: AppColors.border),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(14),
                        borderSide: const BorderSide(color: AppColors.indigo, width: 1.5),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  GestureDetector(
                    onTap: () => setState(() => _exception = !_exception),
                    child: Row(
                      children: [
                        Icon(
                            _exception
                                ? Icons.check_box_rounded
                                : Icons.check_box_outline_blank_rounded,
                            size: 20,
                            color: _exception ? AppColors.amber : AppColors.textMuted),
                        const SizedBox(width: 9),
                        Expanded(
                          child: Text(
                              'This is a school / exception calendar (closures, early '
                              'dismissals)',
                              style: font(kBodyFont, 12.5, 500,
                                  color: AppColors.textSecondary, height: 1.4)),
                        ),
                      ],
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 12, 22, 24),
              child: OnboardingButton(label: 'Add feed', busy: _busy, onPressed: _addIcs),
            ),
          ],
        ),
      ),
    );
  }
}
