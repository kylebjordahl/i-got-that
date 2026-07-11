import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import 'onboarding_entry.dart';
import 'onboarding_scaffold.dart';
import 'steps/add_members_step.dart';
import 'steps/child_sources_step.dart';
import 'steps/child_unified_step.dart';
import 'steps/complete_step.dart';
import 'steps/connect_accounts_step.dart';
import 'steps/create_family_step.dart';
import 'steps/parent_unified_step.dart';

/// The first-run wizard orchestrator (post-auth, pre-family-through-complete).
/// Holds the step position and the per-child cursor; each step is a self-wired
/// widget that commits real configuration and calls back to advance.
///
/// Important: family-scoped providers ([membersProvider]/[dependentsProvider]/…)
/// are only read from the branches that run *after* the family is created in
/// [CreateFamilyStep] — reading them earlier would trip [familyProvider]'s
/// silent "My Family" auto-create and defeat the create-family step.
class OnboardingFlow extends ConsumerStatefulWidget {
  const OnboardingFlow({super.key});

  @override
  ConsumerState<OnboardingFlow> createState() => _OnboardingFlowState();
}

enum _Step { connect, family, addMembers, childSources, childUnified, parentUnified, complete }

class _OnboardingFlowState extends ConsumerState<OnboardingFlow> {
  _Step _step = _Step.connect;
  int _childIndex = 0;

  void _go(_Step s) => setState(() => _step = s);

  List<Member> get _children =>
      ref.read(dependentsProvider).valueOrNull ?? const <Member>[];

  void _exit() {
    // Latch out of the wizard: [OnboardingGate] shows the app once this is
    // false, regardless of the (already-created) family state.
    ref.read(onboardingActiveProvider.notifier).state = false;
    ref.invalidate(hasFamilyProvider);
  }

  void _afterMembers() {
    if (_children.isEmpty) {
      _go(_Step.parentUnified);
    } else {
      setState(() {
        _childIndex = 0;
        _step = _Step.childSources;
      });
    }
  }

  void _afterChildUnified() {
    if (_childIndex + 1 < _children.length) {
      setState(() {
        _childIndex++;
        _step = _Step.childSources;
      });
    } else {
      _go(_Step.parentUnified);
    }
  }

  void _backFromChildSources() {
    if (_childIndex == 0) {
      _go(_Step.addMembers);
    } else {
      setState(() {
        _childIndex--;
        _step = _Step.childUnified;
      });
    }
  }

  void _backFromParent() {
    if (_children.isEmpty) {
      _go(_Step.addMembers);
    } else {
      setState(() {
        _childIndex = _children.length - 1;
        _step = _Step.childUnified;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    switch (_step) {
      case _Step.connect:
        return ConnectAccountsStep(onNext: () => _go(_Step.family));
      case _Step.family:
        return CreateFamilyStep(
          onNext: () => _go(_Step.addMembers),
          onBack: () => _go(_Step.connect),
          onExit: _exit,
        );
      case _Step.addMembers:
        return AddMembersStep(
          onNext: _afterMembers,
          onBack: () => _go(_Step.family),
          onExit: _exit,
        );
      case _Step.childSources:
        return _childGuarded((children, child) => ChildSourcesStep(
              child: child,
              children: children,
              childIndex: _childIndex,
              onNext: () => _go(_Step.childUnified),
              onBack: _backFromChildSources,
              onExit: _exit,
            ));
      case _Step.childUnified:
        return _childGuarded((children, child) => ChildUnifiedStep(
              child: child,
              children: children,
              childIndex: _childIndex,
              nextChildName: _childIndex + 1 < children.length
                  ? children[_childIndex + 1].relationName
                  : null,
              onNext: _afterChildUnified,
              onBack: () => _go(_Step.childSources),
              onExit: _exit,
            ));
      case _Step.parentUnified:
        return ParentUnifiedStep(
          onNext: () => _go(_Step.complete),
          onBack: _backFromParent,
        );
      case _Step.complete:
        return CompleteStep(onGoHome: _exit);
    }
  }

  /// Resolve the current child before rendering a per-child step; show a brief
  /// spinner while the members list (re)loads.
  Widget _childGuarded(Widget Function(List<Member> children, Member child) build) {
    final children = ref.watch(dependentsProvider).valueOrNull;
    if (children == null || _childIndex >= children.length) {
      return const OnboardingScaffold(
        progress: 0.66,
        body: [
          Padding(
            padding: EdgeInsets.symmetric(vertical: 60),
            child: Center(
                child: SizedBox(
                    width: 26,
                    height: 26,
                    child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.indigo))),
          ),
        ],
      );
    }
    return build(children, children[_childIndex]);
  }
}
