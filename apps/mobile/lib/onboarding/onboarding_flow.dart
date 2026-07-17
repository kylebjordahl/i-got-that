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
import 'wizard_outcomes.dart';

/// The first-run wizard orchestrator (post-auth, pre-family-through-complete).
/// Holds the step position, the per-child and per-caretaker cursors, and the
/// record of what the user actually did ([WizardOutcomes]); each step is a
/// self-wired widget that commits real configuration and calls back to advance.
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

/// The caretakers step 1g visits, in order: the signed-in user first, then every
/// other caretaker in family order — the wizard opens on the calendar the user
/// can actually answer for before asking them to stand in for their co-parents.
///
/// Self is prepended rather than filtered in from [caretakersProvider], so the
/// user always gets their own step even if their member row isn't flagged as a
/// caretaker.
final wizardAdultsProvider = FutureProvider<List<Member>>((ref) async {
  final self = await ref.watch(currentMemberProvider.future);
  if (self == null) return const <Member>[];
  final all = await ref.watch(caretakersProvider.future);
  return [self, ...all.where((m) => m.id != self.id)];
});

enum _Step { connect, family, addMembers, childSources, childUnified, parentUnified, complete }

class _OnboardingFlowState extends ConsumerState<OnboardingFlow> {
  _Step _step = _Step.connect;
  int _childIndex = 0;
  int _adultIndex = 0;
  WizardOutcomes _outcomes = const WizardOutcomes();

  void _go(_Step s) => setState(() => _step = s);

  List<Member> get _children =>
      ref.read(dependentsProvider).valueOrNull ?? const <Member>[];

  List<Member> get _adults =>
      ref.read(wizardAdultsProvider).valueOrNull ?? const <Member>[];

  void _exit() {
    // Latch out of the wizard: [OnboardingGate] shows the app once this is
    // false, regardless of the (already-created) family state.
    ref.read(onboardingActiveProvider.notifier).state = false;
    ref.invalidate(hasFamilyProvider);
  }

  /// Leaving 1b: the step is skippable and "Continue" is reachable with nothing
  /// linked, so receipt what's actually connected rather than that they passed.
  void _afterConnect() {
    final accounts = ref.read(accountsProvider).valueOrNull ?? const [];
    setState(() {
      _outcomes = _outcomes.copyWith(accountsConnected: accounts.isNotEmpty);
      _step = _Step.family;
    });
  }

  void _afterMembers() {
    if (_children.isEmpty) {
      _startAdults();
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
      _startAdults();
    }
  }

  void _startAdults() {
    setState(() {
      _adultIndex = 0;
      _step = _Step.parentUnified;
    });
  }

  void _afterAdultUnified(bool done) {
    final adults = _adults;
    final outcomes = _outcomes.withAdultCalendar(adults[_adultIndex].id, done: done);
    if (_adultIndex + 1 < adults.length) {
      setState(() {
        _outcomes = outcomes;
        _adultIndex++;
      });
    } else {
      setState(() {
        _outcomes = outcomes;
        _step = _Step.complete;
      });
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

  /// Back out of 1g: rewind the caretaker loop first, then fall back to the last
  /// child's step (or straight to 1d when the family has no children).
  void _backFromParent() {
    if (_adultIndex > 0) {
      setState(() => _adultIndex--);
    } else if (_children.isEmpty) {
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
        return ConnectAccountsStep(onNext: _afterConnect);
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
        return _adultGuarded((adults, adult, isSelf) => ParentUnifiedStep(
              adult: adult,
              adults: adults,
              adultIndex: _adultIndex,
              isSelf: isSelf,
              nextAdultName: _adultIndex + 1 < adults.length
                  ? adults[_adultIndex + 1].relationName
                  : null,
              onNext: _afterAdultUnified,
              onBack: _backFromParent,
              onExit: _exit,
            ));
      case _Step.complete:
        return CompleteStep(outcomes: _outcomes, onGoHome: _exit);
    }
  }

  /// Resolve the current child before rendering a per-child step; show a brief
  /// spinner while the members list (re)loads.
  Widget _childGuarded(Widget Function(List<Member> children, Member child) build) {
    final children = ref.watch(dependentsProvider).valueOrNull;
    if (children == null || _childIndex >= children.length) return _loading(0.66);
    return build(children, children[_childIndex]);
  }

  /// The 1g counterpart: resolve the caretaker whose turn it is.
  /// [wizardAdultsProvider] puts self first, so index 0 is the user's own step.
  Widget _adultGuarded(
      Widget Function(List<Member> adults, Member adult, bool isSelf) build) {
    final adults = ref.watch(wizardAdultsProvider).valueOrNull;
    if (adults == null || adults.isEmpty || _adultIndex >= adults.length) {
      return _loading(0.90);
    }
    return build(adults, adults[_adultIndex], _adultIndex == 0);
  }

  Widget _loading(double progress) => OnboardingScaffold(
        progress: progress,
        body: const [
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
