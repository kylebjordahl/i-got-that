import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../models.dart';
import '../../state/family.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../onboarding_scaffold.dart';
import '../unified_calendar_picker.dart';

/// 2c — which calendar is yours: the designation step from 1g, scoped to just
/// the joining parent. Auto-selected when only one account is connected.
class PickUnifiedStep extends ConsumerStatefulWidget {
  const PickUnifiedStep({super.key, required this.onNext, required this.onBack});

  /// Reports whether a calendar was actually committed — "Finish" is reachable
  /// without a pick, and 2d receipts what happened.
  final ValueChanged<bool> onNext;
  final VoidCallback onBack;

  @override
  ConsumerState<PickUnifiedStep> createState() => _PickUnifiedStepState();
}

class _PickUnifiedStepState extends ConsumerState<PickUnifiedStep> {
  UnifiedTargetChoice? _choice;
  bool _busy = false;
  String? _error;

  Future<void> _finish(Member self) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_choice != null) {
        await commitUnifiedTarget(ref, memberId: self.id, choice: _choice!);
      }
      if (mounted) widget.onNext(_choice != null);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final self = ref.watch(currentMemberProvider).valueOrNull;
    final accounts = ref.watch(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
    final connectedAs = accounts.isNotEmpty ? (accounts.first.username ?? accounts.first.name) : null;

    return OnboardingScaffold(
      progress: 1.0,
      progressColor: AppColors.blue,
      onBack: widget.onBack,
      trailingLabel: 'Step 2 of 2',
      title: 'Which calendar is yours?',
      subtitle: "Pick where your claimed tasks land. That's it — you're done "
          'right after this.',
      body: [
        if (connectedAs != null) ...[
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: AppColors.tint(AppColors.blue, 0.09),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.blue.withValues(alpha: 0.25)),
            ),
            child: Row(
              children: [
                Container(
                  width: 26,
                  height: 26,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                      color: AppColors.tint(AppColors.green, 0.2), shape: BoxShape.circle),
                  child: const Icon(Icons.check_rounded, size: 14, color: AppColors.green),
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Text.rich(TextSpan(
                    text: 'Connected as ',
                    style: font(kBodyFont, 13, 600, color: const Color(0xFFBFE0FF)),
                    children: [
                      TextSpan(text: connectedAs, style: font(kBodyFont, 13, 700)),
                    ],
                  )),
                ),
              ],
            ),
          ),
          const SizedBox(height: 20),
        ],
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Text('YOUR UNIFIED CALENDAR', style: AppText.eyebrow()),
        ),
        const SizedBox(height: 12),
        UnifiedCalendarPicker(
          selected: _choice,
          accent: AppColors.blue,
          onChanged: (c) => setState(() => _choice = c),
        ),
        Container(
          margin: const EdgeInsets.only(top: 18),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
          decoration: BoxDecoration(
            color: AppColors.tint(AppColors.blue, 0.06),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppColors.blue.withValues(alpha: 0.2)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.info_outline_rounded, size: 15, color: AppColors.blue),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                    'With just one account connected, we pre-select it — tap Finish '
                    "and you're set. Reminders, tasks & email can wait until first use.",
                    style: font(kBodyFont, 12, 500, color: const Color(0xFF9FC4EE), height: 1.5)),
              ),
            ],
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
        ],
      ],
      bottom: OnboardingButton(
        label: 'Finish',
        variant: OnbButtonVariant.green,
        busy: _busy,
        onPressed: self == null ? null : () => _finish(self),
      ),
    );
  }
}
