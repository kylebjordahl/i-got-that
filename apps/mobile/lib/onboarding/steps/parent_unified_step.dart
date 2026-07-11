import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../models.dart';
import '../../state/family.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../../theme/person_colors.dart';
import '../../widgets/primitives.dart';
import '../onboarding_scaffold.dart';
import '../unified_calendar_picker.dart';

/// 1g — per parent, designate your unified calendar: the destination for tasks
/// you claim. Caretakers get no task-generation rules — this is purely their
/// delivery target. The last MVP step (green "Finish setup").
class ParentUnifiedStep extends ConsumerStatefulWidget {
  const ParentUnifiedStep({
    super.key,
    required this.onNext,
    required this.onBack,
  });

  final VoidCallback onNext;
  final VoidCallback onBack;

  @override
  ConsumerState<ParentUnifiedStep> createState() => _ParentUnifiedStepState();
}

class _ParentUnifiedStepState extends ConsumerState<ParentUnifiedStep> {
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
      if (mounted) widget.onNext();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final self = ref.watch(currentMemberProvider).valueOrNull;
    if (self == null) {
      return const OnboardingScaffold(
        progress: 0.90,
        body: [
          Padding(
            padding: EdgeInsets.symmetric(vertical: 40),
            child: Center(
                child: SizedBox(
                    width: 26,
                    height: 26,
                    child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.indigo))),
          ),
        ],
      );
    }
    return OnboardingScaffold(
      progress: 0.90,
      onBack: widget.onBack,
      trailingLabel: 'Finish later',
      onTrailing: _busy ? null : () => _finish(self),
      title: 'Your unified calendar',
      subtitle: 'Last step. Choose where the tasks you claim will land — your '
          'own single calendar.',
      body: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            gradient: AppColors.profileGradient,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            children: [
              PersonAvatar(
                  initial: initialFor(self.relationName), color: personColor(self), size: 40),
              const SizedBox(width: 11),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(self.relationName, style: font(kBodyFont, 15, 600)),
                  const SizedBox(height: 1),
                  Text('${self.isAdmin ? 'Admin' : 'Caretaker'} · this is just for you',
                      style: font(kBodyFont, 12, 500, color: AppColors.textTertiary)),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        UnifiedCalendarPicker(
          selected: _choice,
          onChanged: (c) => setState(() => _choice = c),
        ),
        const InfoHint('Only one connected? We pick it automatically and skip this step.'),
        if (_error != null) ...[
          const SizedBox(height: 14),
          Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
        ],
      ],
      bottom: OnboardingButton(
        label: 'Finish setup',
        variant: OnbButtonVariant.green,
        busy: _busy,
        onPressed: () => _finish(self),
      ),
    );
  }
}
