import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../models.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../../theme/person_colors.dart';
import '../../widgets/primitives.dart';
import '../member_strip.dart';
import '../onboarding_scaffold.dart';
import '../unified_calendar_picker.dart';

/// 1g — per caretaker, designate a unified calendar: the destination for the
/// tasks they claim. Caretakers get no task-generation rules — this is purely
/// their delivery target.
///
/// Iterates every caretaker in the family, not just the signed-in user, so the
/// parent doing setup can point the whole household at its calendars in one
/// pass. Only the accounts *this* user has connected are offerable (credentials
/// are user-level), so a co-parent's step is skippable — they can pick their own
/// when they join, which is exactly what the join flow's 2c step is for.
class ParentUnifiedStep extends ConsumerStatefulWidget {
  const ParentUnifiedStep({
    super.key,
    required this.adult,
    required this.adults,
    required this.adultIndex,
    required this.isSelf,
    required this.nextAdultName,
    required this.onNext,
    required this.onBack,
    required this.onExit,
  });

  final Member adult;
  final List<Member> adults;
  final int adultIndex;

  /// Whether [adult] is the signed-in user — changes the voice from "Mom's" to
  /// "Your", and drops the skip affordance (this one is theirs to answer).
  final bool isSelf;
  final String? nextAdultName;

  /// Reports whether a calendar was actually committed for this caretaker, so
  /// the summary (1h) can receipt it honestly.
  final ValueChanged<bool> onNext;
  final VoidCallback onBack;
  final VoidCallback onExit;

  @override
  ConsumerState<ParentUnifiedStep> createState() => _ParentUnifiedStepState();
}

class _ParentUnifiedStepState extends ConsumerState<ParentUnifiedStep> {
  UnifiedTargetChoice? _choice;
  bool _busy = false;
  String? _error;

  bool get _isLast => widget.nextAdultName == null;

  /// Spread the caretaker loop across the tail of the bar, landing on ~0.95 for
  /// the last one. A lone caretaker keeps the original single-step position.
  double get _progress => widget.adults.length == 1
      ? 0.90
      : 0.80 + 0.15 * (widget.adultIndex / (widget.adults.length - 1));

  @override
  void didUpdateWidget(ParentUnifiedStep old) {
    super.didUpdateWidget(old);
    // The same widget instance is reused across the loop; drop the previous
    // caretaker's selection so it can't be committed twice.
    if (old.adult.id != widget.adult.id) {
      _choice = null;
      _error = null;
    }
  }

  Future<void> _continue() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_choice != null) {
        await commitUnifiedTarget(ref, memberId: widget.adult.id, choice: _choice!);
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
    final name = widget.adult.relationName;
    final role = widget.adult.isAdmin ? 'Admin' : 'Caretaker';

    return OnboardingScaffold(
      progress: _progress,
      onBack: widget.onBack,
      trailingLabel: 'Finish later',
      onTrailing: _busy ? null : widget.onExit,
      header: widget.adults.length > 1
          ? MemberStrip(
              members: widget.adults, currentIndex: widget.adultIndex, noun: 'Caretaker')
          : null,
      title: widget.isSelf ? 'Your unified calendar' : "$name's unified calendar",
      subtitle: widget.isSelf
          ? 'Choose where the tasks you claim will land — your own single calendar.'
          : "Choose where $name's claimed tasks land. You can only offer calendars "
              "from your own connected accounts — skip and $name picks their own on join.",
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
                  initial: initialFor(name), color: personColor(widget.adult), size: 40),
              const SizedBox(width: 11),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(name, style: font(kBodyFont, 15, 600)),
                  const SizedBox(height: 1),
                  Text(
                      widget.isSelf
                          ? '$role · this is just for you'
                          : '$role · setting this up on their behalf',
                      style: font(kBodyFont, 12, 500, color: AppColors.textTertiary)),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        UnifiedCalendarPicker(
          selected: _choice,
          accent: personColor(widget.adult),
          onChanged: (c) => setState(() => _choice = c),
        ),
        if (widget.isSelf)
          const InfoHint('Only one connected? We pick it automatically and skip this step.')
        else
          Align(
            child: Padding(
              padding: const EdgeInsets.only(top: 16),
              child: TextButton(
                onPressed: _busy ? null : () => widget.onNext(false),
                child: Text('Skip — $name picks their own on join',
                    style: font(kBodyFont, 13, 600, color: AppColors.textTertiary)),
              ),
            ),
          ),
        if (_error != null) ...[
          const SizedBox(height: 14),
          Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
        ],
      ],
      bottom: OnboardingButton(
        label: _isLast ? 'Finish setup' : 'Continue · next is ${widget.nextAdultName}',
        variant: _isLast ? OnbButtonVariant.green : OnbButtonVariant.indigo,
        busy: _busy,
        onPressed: _continue,
      ),
    );
  }
}
