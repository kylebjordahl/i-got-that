import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../models.dart';
import '../../screens/connect_account_wizard.dart';
import '../../state/family.dart';
import '../../theme/app_colors.dart';
import '../../widgets/primitives.dart';
import '../onboarding_scaffold.dart';

/// 1b — connect calendar accounts. User-level credentials, reusable as sources
/// and delivery targets in every later step. Skippable. Reuses the round-5
/// connect-account wizard, with its "choose calendars" step omitted (that
/// happens in context per child / per parent).
class ConnectAccountsStep extends ConsumerWidget {
  const ConnectAccountsStep({super.key, required this.onNext});
  final VoidCallback onNext;

  ({IconData icon, Color color}) _visual(String kind) => switch (kind) {
        'google' => (icon: Icons.calendar_month_rounded, color: AppColors.feedBlue),
        'icloud' => (icon: Icons.cloud_rounded, color: AppColors.indigo),
        _ => (icon: Icons.event_note_rounded, color: AppColors.indigo),
      };

  Future<void> _connectMore(BuildContext context, WidgetRef ref) async {
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ConnectAccountWizard(skipCalendarStep: true, onConnected: (_) {}),
    ));
    ref.invalidate(accountsProvider);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accounts = ref.watch(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
    return OnboardingScaffold(
      progress: 0.16,
      trailingLabel: 'Skip for now',
      onTrailing: onNext,
      title: 'Connect your calendars',
      subtitle: 'Sign in to the accounts you already use. They become available '
          'as sources and delivery targets everywhere in the app.',
      body: [
        GroupedCard(children: [
          for (final a in accounts)
            GroupRow(
              leading: IconTile(icon: _visual(a.kind).icon, color: _visual(a.kind).color),
              title: a.kindLabel,
              subtitle: a.username ?? a.name,
              trailing: const MiniPill('Connected', color: AppColors.green, dot: true),
            ),
          GroupAddRow(
            title: 'Connect another account',
            subtitle: 'iCloud · Google · Outlook · CalDAV / ICS',
            onTap: () => _connectMore(context, ref),
          ),
        ]),
        const InfoHint('Add or remove accounts anytime from Me.'),
      ],
      bottom: OnboardingButton(label: 'Continue', onPressed: onNext),
    );
  }
}
