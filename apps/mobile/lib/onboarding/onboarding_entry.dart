import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import 'onboarding_flow.dart';

/// Whether the first-run wizard is active for this signed-in session:
/// - `null`  ⇒ undetermined; [OnboardingGate] decides once from [hasFamilyProvider].
/// - `true`  ⇒ show [OnboardingFlow] and *stay* there (so creating the family in
///   step 1c doesn't bounce the user into the app mid-wizard).
/// - `false` ⇒ show the normal app.
/// Reset to `null` on sign-out so the next session re-determines.
final onboardingActiveProvider = StateProvider<bool?>((ref) => null);

/// The invite token driving the second-parent join flow, read once from the URL
/// (web). While non-null, the app shows the join flow; the flow clears it on exit.
final activeInviteTokenProvider =
    StateProvider<String?>((ref) => inviteTokenFromUrl());

/// Pull an `invite` token from the web launch URL (`…/app/?invite=TOKEN` or
/// `…/app/#invite=TOKEN`). Null on native (no meaningful [Uri.base]) — native
/// invite links arrive asynchronously via `app_links` (see [inviteTokenFromUri]
/// and the bootstrap in main.dart).
String? inviteTokenFromUrl() {
  try {
    return inviteTokenFromUri(Uri.base);
  } catch (_) {
    return null;
  }
}

/// Extract an `invite` token from a URI, accepting both the query form
/// (`…?invite=TOKEN`) and the fragment form (`…#invite=TOKEN` or
/// `…#/path?invite=TOKEN`). Returns null when absent. Shared by the web launch
/// parser and the native `app_links` handler so the two stay in lockstep.
String? inviteTokenFromUri(Uri uri) {
  final q = uri.queryParameters['invite'];
  if (q != null && q.isNotEmpty) return q;
  final frag = uri.fragment;
  if (frag.contains('invite=')) {
    final params = Uri.splitQueryString(frag.contains('?') ? frag.split('?').last : frag);
    final f = params['invite'];
    if (f != null && f.isNotEmpty) return f;
  }
  return null;
}

/// Decides, for an authed user, between the first-run wizard and the app. The
/// decision is latched into [onboardingActiveProvider] the first time so a
/// mid-wizard family-creation (which flips [hasFamilyProvider]) doesn't swap the
/// screen out from under the user.
class OnboardingGate extends ConsumerWidget {
  const OnboardingGate({super.key, required this.appBuilder});

  /// Builds the normal signed-in app (kept in main.dart to preserve the
  /// nested-navigator + floating-nav setup).
  final WidgetBuilder appBuilder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final active = ref.watch(onboardingActiveProvider);
    if (active == true) return const OnboardingFlow();
    if (active == false) return appBuilder(context);

    // Undetermined — decide from whether the user already belongs to a family.
    final hasFamily = ref.watch(hasFamilyProvider);
    return hasFamily.when(
      loading: () => const Scaffold(backgroundColor: AppColors.bg),
      error: (_, __) {
        _latch(ref, true);
        return const OnboardingFlow();
      },
      data: (has) {
        _latch(ref, !has);
        return has ? appBuilder(context) : const OnboardingFlow();
      },
    );
  }

  void _latch(WidgetRef ref, bool value) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final notifier = ref.read(onboardingActiveProvider.notifier);
      if (notifier.state == null) notifier.state = value;
    });
  }
}
