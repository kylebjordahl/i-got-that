import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../screens/connect_account_wizard.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import 'onboarding_scaffold.dart';

/// A concrete unified-calendar choice: one writable calendar drawn from one of
/// the user's connected accounts. Commit with [ApiClient.setMemberCalendarTarget].
class UnifiedTargetChoice {
  const UnifiedTargetChoice({
    required this.accountId,
    required this.calendarId,
    required this.calendarName,
    required this.accountLabel,
  });

  final String accountId;
  final String calendarId;
  final String calendarName;

  /// Account context for the row subtitle (e.g. "iCloud · dad@icloud.com").
  final String accountLabel;
}

/// The reusable "which calendar" designation picker — the single component the
/// per-child (1f), per-parent (1g) and join (2c) steps all share. Loads every
/// writable calendar across the user's connected accounts, single-selects one,
/// and reports the choice up via [onChanged]. Auto-selects when exactly one
/// calendar exists (the design's "only one connected? we pick it" behaviour).
class UnifiedCalendarPicker extends ConsumerStatefulWidget {
  const UnifiedCalendarPicker({
    super.key,
    required this.selected,
    required this.onChanged,
    this.accent = AppColors.indigo,
    this.lockedFeeds = const [],
  });

  final UnifiedTargetChoice? selected;
  final ValueChanged<UnifiedTargetChoice?> onChanged;
  final Color accent;

  /// Read-only feeds (e.g. a school ICS) shown as informational locked rows —
  /// they can't be a unified-calendar destination.
  final List<String> lockedFeeds;

  @override
  ConsumerState<UnifiedCalendarPicker> createState() => _UnifiedCalendarPickerState();
}

class _UnifiedCalendarPickerState extends ConsumerState<UnifiedCalendarPicker> {
  bool _loading = true;
  String? _error;
  List<UnifiedTargetChoice> _candidates = const [];

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
      final accounts = await ref.read(accountsProvider.future);
      final out = <UnifiedTargetChoice>[];
      for (final acct in accounts) {
        List<dynamic> cals;
        try {
          cals = await api.listAccountCalendars(acct.id);
        } catch (_) {
          cals = const [];
        }
        for (final c in cals.cast<Map<String, dynamic>>()) {
          out.add(UnifiedTargetChoice(
            accountId: acct.id,
            calendarId: c['id'] as String,
            calendarName: (c['name'] as String?) ?? 'Calendar',
            accountLabel: '${acct.kindLabel} · ${acct.username ?? acct.name}',
          ));
        }
      }
      if (!mounted) return;
      setState(() {
        _candidates = out;
        _loading = false;
      });
      // Auto-select when exactly one calendar is connected and nothing's chosen.
      if (widget.selected == null && out.length == 1) {
        widget.onChanged(out.first);
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = '$e';
        _loading = false;
      });
    }
  }

  bool _isSelected(UnifiedTargetChoice c) {
    final s = widget.selected;
    return s != null && s.accountId == c.accountId && s.calendarId == c.calendarId;
  }

  Future<void> _connectMore() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ConnectAccountWizard(skipCalendarStep: true, onConnected: (_) {}),
      ),
    );
    ref.invalidate(accountsProvider);
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 40),
        child: Center(
            child: SizedBox(
                width: 26,
                height: 26,
                child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.indigo))),
      );
    }
    if (_error != null) {
      return Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final c in _candidates) ...[
          SelectRow(
            icon: Icons.calendar_month_rounded,
            iconColor: widget.accent,
            title: c.calendarName,
            subtitle: c.accountLabel,
            selected: _isSelected(c),
            accent: widget.accent,
            trailing: _isSelected(c) ? RowTrailing.check : RowTrailing.radio,
            onTap: () => widget.onChanged(c),
          ),
          const SizedBox(height: 10),
        ],
        for (final feed in widget.lockedFeeds) ...[
          SelectRow(
            icon: Icons.rss_feed_rounded,
            iconColor: AppColors.feedBlue,
            title: feed,
            subtitle: "Read-only feed — can't be unified",
            trailing: RowTrailing.lock,
            dimmed: true,
          ),
          const SizedBox(height: 10),
        ],
        AddRow(
          title: 'Connect another calendar',
          accent: widget.accent,
          boxed: true,
          onTap: _connectMore,
        ),
        if (_candidates.isEmpty)
          const InfoHint('Connect a calendar account to choose your unified calendar.'),
      ],
    );
  }
}

/// Commit a chosen target for [memberId] (self or a child). Returns nothing;
/// throws on failure so the caller can surface it.
Future<void> commitUnifiedTarget(
  WidgetRef ref, {
  required String memberId,
  required UnifiedTargetChoice choice,
}) async {
  final api = ref.read(apiClientProvider);
  final familyId = await ref.read(familyProvider.future);
  await api.setMemberCalendarTarget(
    familyId,
    memberId,
    externalAccountId: choice.accountId,
    targetCalendarId: choice.calendarId,
    targetCalendarName: choice.calendarName,
  );
  ref.invalidate(memberCalendarProvider(memberId));
}
