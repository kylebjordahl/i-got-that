import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../state/nav.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import 'accounts_screen.dart';
import 'dialogs.dart';

/// Me — the signed-in user's own account (a 4th nav tab). Account-level calendar
/// connections live here and are reused as delivery targets by every family.
class MeScreen extends ConsumerWidget {
  const MeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final user = ref.watch(authControllerProvider).user;
    final email = user?['email'] as String? ?? 'you@example.com';
    final familyCount = ref.watch(familyInfoProvider).valueOrNull?.count ?? 1;
    final accounts = ref.watch(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
    final name = me?.relationName ?? 'Me';
    final color = me == null ? AppColors.indigo : personColor(me);
    final pushOn = ref.watch(pushNotificationsProvider);

    return ListView(
      padding: const EdgeInsets.fromLTRB(22, 14, 22, 130),
      children: [
        Text('Me', style: AppText.screenTitle),
        const SizedBox(height: 18),
        DetailProfileCard(
          avatar: PersonAvatar(initial: initialFor(name), color: color, size: 54),
          name: name,
          subtitle: email,
          onEdit: me == null ? null : () => showEditNameDialog(context, ref, me),
          extra: Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Text('Member of $familyCount famil${familyCount == 1 ? 'y' : 'ies'}',
                style: font(kBodyFont, 13, 600, color: AppColors.indigo)),
          ),
        ),
        const SizedBox(height: 24),
        const SectionEyebrow('Calendar accounts', color: AppColors.green),
        const SizedBox(height: 8),
        Text(
          'Connect once here; every family reuses them as delivery targets — not '
          'configured on Family itself.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 12),
        AppCard(
          child: Column(
            children: [
              if (accounts.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text('No accounts connected yet', style: AppText.subtitle),
                )
              else
                for (final a in accounts) ...[
                  SettingRow(
                    icon: _accountIcon(a.kind),
                    iconColor: _accountColor(a.kind),
                    title: a.kindLabel,
                    subtitle: a.username ?? a.name,
                    trailing: const _ConnectedPill(),
                    onTap: () => _disconnect(context, ref, a),
                  ),
                  const Divider(height: 20),
                ],
              SettingRow(
                icon: Icons.add_rounded,
                iconColor: AppColors.indigo,
                title: 'Connect an account',
                onTap: () => showConnectAccountDialog(context, ref),
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),
        const SectionEyebrow('Preferences'),
        const SizedBox(height: 12),
        AppCard(
          child: Column(
            children: [
              SettingRow(
                icon: Icons.vpn_key_outlined,
                iconColor: AppColors.purple,
                title: 'Redeem invite code',
                onTap: () => showRedeemInviteDialog(context, ref),
              ),
              const Divider(height: 20),
              SwitchRow(
                icon: Icons.notifications_none_rounded,
                iconColor: AppColors.blue,
                title: 'Push notifications',
                value: pushOn,
                onChanged: (v) => ref.read(pushNotificationsProvider.notifier).state = v,
              ),
              const Divider(height: 20),
              SettingRow(
                icon: Icons.help_outline_rounded,
                iconColor: AppColors.textMuted,
                title: 'Help & about',
                onTap: () => _showAbout(context),
              ),
            ],
          ),
        ),
        const SizedBox(height: 28),
        _SignOutButton(onTap: () => _signOut(context, ref)),
      ],
    );
  }

  Future<void> _disconnect(BuildContext context, WidgetRef ref, ExternalAccount a) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Disconnect account?'),
        content: Text('Remove ${a.kindLabel} (${a.username ?? a.name})? Feeds and '
            'delivery methods using it will stop working.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          PillButton(
            label: 'Disconnect',
            variant: PillVariant.white,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(apiClientProvider).deleteAccount(a.id);
      ref.invalidate(accountsProvider);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  void _showAbout(BuildContext context) {
    showAboutDialog(
      context: context,
      applicationName: 'I Got That',
      applicationVersion: '0.1.0',
      children: const [
        Padding(
          padding: EdgeInsets.only(top: 8),
          child: Text('Share the family handoffs — claim what you can.'),
        ),
      ],
    );
  }

  Future<void> _signOut(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text("You'll need to sign in again to manage your families."),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          PillButton(
            label: 'Sign out',
            variant: PillVariant.white,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
    if (ok == true) {
      ref.read(navIndexProvider.notifier).state = 0;
      ref.read(authControllerProvider.notifier).logout();
    }
  }

  IconData _accountIcon(String kind) => switch (kind) {
        'google' => Icons.calendar_month_rounded,
        'icloud' => Icons.cloud_rounded,
        _ => Icons.dns_rounded,
      };

  Color _accountColor(String kind) => switch (kind) {
        'google' => AppColors.blue,
        'icloud' => AppColors.indigo,
        _ => AppColors.purple,
      };
}

class _ConnectedPill extends StatelessWidget {
  const _ConnectedPill();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.tint(AppColors.green, 0.16),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: const BoxDecoration(color: AppColors.green, shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          Text('Connected', style: font(kBodyFont, 11, 700, color: AppColors.green)),
        ],
      ),
    );
  }
}

class _SignOutButton extends StatelessWidget {
  const _SignOutButton({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.tint(AppColors.coral, 0.10),
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          height: 52,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.coral.withValues(alpha: 0.5)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.logout_rounded, color: AppColors.coral, size: 19),
              const SizedBox(width: 8),
              Text('Sign out', style: font(kBodyFont, 14, 700, color: AppColors.coral)),
            ],
          ),
        ),
      ),
    );
  }
}
