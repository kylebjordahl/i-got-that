import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../screens/connect_account_wizard.dart';
import '../../state/family.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../onboarding_entry.dart';
import '../onboarding_scaffold.dart';
import 'invite_landing_step.dart';
import 'joined_step.dart';
import 'pick_unified_step.dart';

/// The second-parent join flow: 2a invite landing → 2b connect one account →
/// 2c pick your unified calendar → 2d joined. Never the full first-run wizard —
/// the required effort approaches just one login. Accent is blue (Mom).
class JoinFlow extends ConsumerStatefulWidget {
  const JoinFlow({super.key, required this.token});
  final String token;

  @override
  ConsumerState<JoinFlow> createState() => _JoinFlowState();
}

enum _Phase { landing, connect, pick, joined }

class _JoinFlowState extends ConsumerState<JoinFlow> {
  _Phase _phase = _Phase.landing;

  /// Both join steps are skippable ("I'll connect later" / Finish without a
  /// pick), so 2d receipts what actually happened rather than assuming.
  bool _calendarPicked = false;

  void _go(_Phase p) => setState(() => _phase = p);

  void _onAccepted() {
    // The user is now linked to the invited member — refresh the family context
    // so the connect/pick steps resolve "self" and the family correctly.
    ref.invalidate(hasFamilyProvider);
    ref.invalidate(familyProvider);
    ref.invalidate(familiesListProvider);
    ref.invalidate(currentMemberProvider);
    ref.invalidate(membersProvider);
    _go(_Phase.connect);
  }

  void _exit() {
    // Clear the invite token so the app stops rendering the join flow, and
    // refresh the family gate so the user lands in the working app.
    ref.read(activeInviteTokenProvider.notifier).state = null;
    ref.read(onboardingActiveProvider.notifier).state = false;
    ref.invalidate(hasFamilyProvider);
  }

  @override
  Widget build(BuildContext context) {
    switch (_phase) {
      case _Phase.landing:
        return InviteLandingStep(token: widget.token, onAccepted: _onAccepted);
      case _Phase.connect:
        return _ConnectOneStep(
          onNext: () => _go(_Phase.pick),
          onBack: () => _go(_Phase.landing),
        );
      case _Phase.pick:
        return PickUnifiedStep(
          onNext: (picked) => setState(() {
            _calendarPicked = picked;
            _phase = _Phase.joined;
          }),
          onBack: () => _go(_Phase.connect),
        );
      case _Phase.joined:
        return JoinedStep(calendarPicked: _calendarPicked, onGoHome: _exit);
    }
  }
}

/// 2b — connect your calendar: the only setup a second parent needs. Reuses the
/// connect-account chunk, scoped to one login ("Step 1 of 2").
class _ConnectOneStep extends ConsumerStatefulWidget {
  const _ConnectOneStep({required this.onNext, required this.onBack});
  final VoidCallback onNext;
  final VoidCallback onBack;

  @override
  ConsumerState<_ConnectOneStep> createState() => _ConnectOneStepState();
}

class _ConnectOneStepState extends ConsumerState<_ConnectOneStep> {
  static const _providers = <(String, IconData, String)>[
    ('Apple iCloud', Icons.cloud_rounded, 'Calendar & Reminders'),
    ('Google Calendar', Icons.calendar_month_rounded, 'Calendar & Tasks'),
    ('Microsoft Outlook', Icons.event_note_rounded, 'Calendar'),
  ];
  int _selected = 0;

  Future<void> _connect() async {
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ConnectAccountWizard(skipCalendarStep: true, onConnected: (_) {}),
    ));
    ref.invalidate(accountsProvider);
    final accounts = await ref.read(accountsProvider.future);
    if (accounts.isNotEmpty && mounted) widget.onNext();
  }

  @override
  Widget build(BuildContext context) {
    return OnboardingScaffold(
      progress: 0.5,
      progressColor: AppColors.blue,
      onBack: widget.onBack,
      trailingLabel: 'Step 1 of 2',
      title: 'Connect your calendar',
      subtitle: 'This is the only setup you need. Sign in to the account where '
          'you keep your schedule.',
      body: [
        for (var i = 0; i < _providers.length; i++) ...[
          SelectRow(
            icon: _providers[i].$2,
            iconColor: AppColors.blue,
            title: _providers[i].$1,
            subtitle: _providers[i].$3,
            accent: AppColors.blue,
            selected: _selected == i,
            trailing: _selected == i ? RowTrailing.check : RowTrailing.radio,
            onTap: () => setState(() => _selected = i),
          ),
          const SizedBox(height: 11),
        ],
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
          child: Row(
            children: [
              const Icon(Icons.shield_outlined, size: 15, color: AppColors.blue),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                    "We open the provider's secure sign-in. We never see your password.",
                    style: font(kBodyFont, 12, 500, color: AppColors.textTertiary, height: 1.5)),
              ),
            ],
          ),
        ),
        Align(
          alignment: Alignment.center,
          child: Padding(
            padding: const EdgeInsets.only(top: 16),
            child: TextButton(
              onPressed: widget.onNext,
              child: Text("I'll connect later",
                  style: font(kBodyFont, 13, 600, color: AppColors.textTertiary)),
            ),
          ),
        ),
      ],
      bottom: OnboardingButton(
        label: 'Connect ${_shortLabel(_providers[_selected].$1)}',
        variant: OnbButtonVariant.blue,
        onPressed: _connect,
      ),
    );
  }

  String _shortLabel(String full) => switch (full) {
        'Apple iCloud' => 'iCloud',
        'Google Calendar' => 'Google',
        _ => 'Outlook',
      };
}
