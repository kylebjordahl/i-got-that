import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../models.dart';
import '../../state/family.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../../theme/person_colors.dart';
import '../member_strip.dart';
import '../onboarding_scaffold.dart';
import '../unified_calendar_picker.dart';

/// 1f — per child, designate the unified calendar. One source becomes the
/// child's single source of truth; the others synthesize onto it. The bail-out
/// point: once every child has a unified calendar, exiting still leaves a
/// working calendar for each of them.
class ChildUnifiedStep extends ConsumerStatefulWidget {
  const ChildUnifiedStep({
    super.key,
    required this.child,
    required this.children,
    required this.childIndex,
    required this.nextChildName,
    required this.onNext,
    required this.onBack,
    required this.onExit,
  });

  final Member child;
  final List<Member> children;
  final int childIndex;
  final String? nextChildName;
  final VoidCallback onNext;
  final VoidCallback onBack;
  final VoidCallback onExit;

  @override
  ConsumerState<ChildUnifiedStep> createState() => _ChildUnifiedStepState();
}

class _ChildUnifiedStepState extends ConsumerState<ChildUnifiedStep> {
  UnifiedTargetChoice? _choice;
  bool _busy = false;
  String? _error;

  Future<void> _continue() async {
    if (_choice == null) {
      setState(() => _error = 'Pick a calendar to continue');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await commitUnifiedTarget(ref, memberId: widget.child.id, choice: _choice!);
      if (mounted) widget.onNext();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final name = widget.child.relationName;
    final feeds = ref.watch(memberFeedsProvider(widget.child.id)).valueOrNull ?? const <FeedItem>[];
    final locked = [for (final f in feeds) if (f.isException) f.displayName];
    return OnboardingScaffold(
      progress: 0.75,
      onBack: widget.onBack,
      trailingLabel: 'Finish later',
      onTrailing: widget.onExit,
      header: MemberStrip(
          members: widget.children, currentIndex: widget.childIndex, noun: 'Child'),
      title: "$name's unified calendar",
      subtitle: 'Pick the one writable calendar everything else syncs onto — '
          "$name's single source of truth.",
      body: [
        UnifiedCalendarPicker(
          selected: _choice,
          accent: personColor(widget.child),
          lockedFeeds: locked,
          onChanged: (c) => setState(() => _choice = c),
        ),
        const SizedBox(height: 18),
        _SynthNote(),
        if (_error != null) ...[
          const SizedBox(height: 14),
          Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
        ],
      ],
      bottom: OnboardingButton(
        label: widget.nextChildName == null
            ? 'Continue'
            : 'Continue · next is ${widget.nextChildName}',
        busy: _busy,
        onPressed: _continue,
      ),
    );
  }
}

class _SynthNote extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      decoration: BoxDecoration(
        color: AppColors.tint(AppColors.green, 0.07),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.green.withValues(alpha: 0.2)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.arrow_upward_rounded, size: 15, color: AppColors.green),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
                'School events and other sources will synthesize onto this '
                'calendar automatically.',
                style: font(kBodyFont, 12, 500, color: const Color(0xFF9FD8C2), height: 1.5)),
          ),
        ],
      ),
    );
  }
}
