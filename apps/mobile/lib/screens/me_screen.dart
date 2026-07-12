import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../state/nav.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import '../widgets/slide_to_confirm.dart';
import 'connect_account_wizard.dart';
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
    final families = ref.watch(familiesListProvider).valueOrNull ?? const <({String id, String name})>[];
    final defaultFamilyId = ref.watch(defaultFamilyIdProvider).valueOrNull;
    final accounts = ref.watch(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
    final identities =
        ref.watch(loginIdentitiesProvider).valueOrNull ?? const <LoginIdentity>[];
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
                onTap: () async {
                  await Navigator.of(context).push<void>(
                    MaterialPageRoute(builder: (_) => const ConnectAccountWizard()),
                  );
                  ref.invalidate(accountsProvider);
                },
              ),
            ],
          ),
        ),
        const SizedBox(height: 24),
        const SectionEyebrow('Login methods', color: AppColors.purple),
        const SizedBox(height: 8),
        Text(
          'Sign in with any of these and land on this same account — link a new '
          'one on each device you use.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 12),
        AppCard(
          child: Column(
            children: [
              if (identities.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text('No login methods yet', style: AppText.subtitle),
                )
              else
                for (final id in identities) ...[
                  SettingRow(
                    icon: _identityIcon(id.provider),
                    iconColor: _identityColor(id.provider),
                    title: id.kindLabel,
                    subtitle: id.label,
                    // The last method can't be removed (it would lock you out).
                    trailing: identities.length > 1
                        ? const Icon(Icons.close_rounded, color: AppColors.textMuted, size: 20)
                        : null,
                    onTap: identities.length > 1
                        ? () => _unlinkIdentity(context, ref, id)
                        : null,
                  ),
                  const Divider(height: 20),
                ],
              SettingRow(
                icon: Icons.alternate_email_rounded,
                iconColor: AppColors.indigo,
                title: 'Add an email login',
                onTap: () => showAddLoginMethodDialog(context, ref),
              ),
              // Offer Apple until one is linked (web redirects; native uses the
              // OS sheet).
              if (!identities.any((i) => i.provider == 'apple')) ...[
                const Divider(height: 20),
                SettingRow(
                  icon: Icons.apple,
                  iconColor: AppColors.textPrimary,
                  title: 'Link Sign in with Apple',
                  onTap: () => _linkApple(context, ref),
                ),
              ],
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
              if (families.length > 1) ...[
                const Divider(height: 20),
                SettingRow(
                  icon: Icons.home_filled,
                  iconColor: AppColors.indigo,
                  title: 'Default family',
                  subtitle:
                      '${families.where((f) => f.id == defaultFamilyId).map((f) => f.name).firstOrNull ?? "Account default"} '
                      '· only affects this device',
                  onTap: () => _openDefaultFamilyPicker(context, ref, families, defaultFamilyId),
                ),
              ],
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
        if (me?.isAdmin ?? false) ...[
          const SizedBox(height: 24),
          const SectionEyebrow('Family logistics', color: AppColors.coral),
          const SizedBox(height: 12),
          _ThreadingCard(),
        ],
        const SizedBox(height: 28),
        _SignOutButton(onTap: () => _signOut(context, ref)),
        const SizedBox(height: 14),
        Center(
          child: TextButton(
            onPressed: () => _confirmDeleteAccount(context, ref),
            child: Text('Delete account',
                style: font(kBodyFont, 13, 700, color: AppColors.coral.withValues(alpha: 0.75))),
          ),
        ),
      ],
    );
  }

  void _openDefaultFamilyPicker(BuildContext context, WidgetRef ref,
      List<({String id, String name})> families, String? current) {
    showModalBottomSheet<void>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      // `sheetCtx`, not the outer `context`: `context` here is the Me screen's
      // own build context, which lives on the *inner* content Navigator
      // (`rootNavigatorKey`, AppShell's only route — see `_AuthedRoot` in
      // main.dart). This sheet was raised with `useRootNavigator: true`, i.e.
      // on MaterialApp's outer Navigator, so popping via `Navigator.of(context)`
      // would instead pop AppShell off the inner Navigator — leaving it empty
      // (a blank screen) while the sheet itself never closes.
      builder: (sheetCtx) => Padding(
        padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Default family', style: AppText.subPageTitle),
            const SizedBox(height: 6),
            Text(
              'Which family this app opens to by default. This only affects this '
              'device — other devices and family members are unaffected.',
              style: AppText.subtitle,
            ),
            const SizedBox(height: 12),
            SettingRow(
              icon: Icons.auto_awesome_rounded,
              iconColor: current == null ? AppColors.indigo : AppColors.textMuted,
              title: 'Account default',
              subtitle: 'Whichever family is first on your account',
              trailing:
                  current == null ? const Icon(Icons.check_rounded, color: AppColors.indigo) : null,
              onTap: () {
                ref.read(defaultFamilyIdProvider.notifier).set(null);
                Navigator.of(sheetCtx).pop();
              },
            ),
            for (final f in families) ...[
              const Divider(height: 20),
              SettingRow(
                icon: Icons.home_rounded,
                iconColor: f.id == current ? AppColors.indigo : AppColors.textMuted,
                title: f.name,
                trailing:
                    f.id == current ? const Icon(Icons.check_rounded, color: AppColors.indigo) : null,
                onTap: () {
                  ref.read(defaultFamilyIdProvider.notifier).set(f.id);
                  Navigator.of(sheetCtx).pop();
                },
              ),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _disconnect(BuildContext context, WidgetRef ref, ExternalAccount a) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Disconnect account?'),
        content: Text('Remove ${a.kindLabel} (${a.username ?? a.name})? Feeds and '
            'delivery methods using it will stop working.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel')),
          PillButton(
            label: 'Disconnect',
            variant: PillVariant.white,
            onPressed: () => Navigator.of(dialogContext).pop(true),
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

  Future<void> _unlinkIdentity(
      BuildContext context, WidgetRef ref, LoginIdentity id) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Remove login method?'),
        content: Text("You'll no longer be able to sign in with ${id.kindLabel} "
            '(${id.label}). Your other methods keep working.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel')),
          PillButton(
            label: 'Remove',
            variant: PillVariant.white,
            onPressed: () => Navigator.of(dialogContext).pop(true),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(apiClientProvider).unlinkIdentity(id.id);
      ref.invalidate(loginIdentitiesProvider);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  Future<void> _linkApple(BuildContext context, WidgetRef ref) async {
    final auth = ref.read(authControllerProvider.notifier);
    // Web can't get a token in-page — a full-page redirect links Apple and the
    // reload refreshes the list. Native drives the OS sheet inline.
    if (kIsWeb) {
      auth.linkWithApple();
      return;
    }
    try {
      await auth.linkWithAppleNative();
      ref.invalidate(loginIdentitiesProvider);
    } on DioException catch (e) {
      final code = (e.response?.data as Map<String, dynamic>?)?['error'];
      final msg = code == 'identity_linked_to_other_user'
          ? 'That Apple ID is already linked to a different account.'
          : 'Failed: $e';
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  IconData _identityIcon(String provider) =>
      provider == 'apple' ? Icons.apple : Icons.alternate_email_rounded;

  Color _identityColor(String provider) =>
      provider == 'apple' ? AppColors.textPrimary : AppColors.indigo;

  Future<void> _showAbout(BuildContext context) async {
    final info = await PackageInfo.fromPlatform();
    if (!context.mounted) return;
    showAboutDialog(
      context: context,
      applicationName: 'I Got That',
      applicationVersion: '${info.version} (${info.buildNumber})',
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
      builder: (dialogContext) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text("You'll need to sign in again to manage your families."),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Cancel')),
          PillButton(
            label: 'Sign out',
            variant: PillVariant.white,
            onPressed: () => Navigator.of(dialogContext).pop(true),
          ),
        ],
      ),
    );
    if (ok == true) {
      ref.read(navIndexProvider.notifier).state = 0;
      ref.read(authControllerProvider.notifier).logout();
    }
  }

  Future<void> _confirmDeleteAccount(BuildContext context, WidgetRef ref) {
    return showSlideToConfirmSheet(
      context,
      title: 'Delete account?',
      description: "This permanently deletes your login and connected "
          "calendar accounts. Families you belong to keep their data — "
          "you're just removed as a member with login access. This can't be "
          'undone.',
      slideLabel: 'Slide to delete account',
      onConfirmed: () => ref.read(authControllerProvider.notifier).deleteAccount(),
      errorMessage: (e) {
        final data = e is DioException ? e.response?.data : null;
        final code = (data as Map<String, dynamic>?)?['error'];
        return code == 'last_admin'
            ? "You're the only admin of a family with other members — "
                'promote a co-admin or delete the family first.'
            : 'Failed: $e';
      },
    );
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

/// The family task-threading window (moved here from the removed Family
/// settings). Tasks within this gap render as one threaded trip on Home/Plan.
class _ThreadingCard extends ConsumerStatefulWidget {
  @override
  ConsumerState<_ThreadingCard> createState() => _ThreadingCardState();
}

class _ThreadingCardState extends ConsumerState<_ThreadingCard> {
  double? _value;

  @override
  Widget build(BuildContext context) {
    final threshold = ref.watch(threadingThresholdProvider).valueOrNull ?? 30;
    final value = (_value ?? threshold.toDouble()).clamp(0, 120).toDouble();
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SettingRow(
            icon: Icons.linear_scale_rounded,
            iconColor: AppColors.coral,
            title: 'Stitch tasks into a trip',
            subtitle: 'Tasks within ${value.round()} min render as one chain',
          ),
          Slider(
            value: value,
            min: 0,
            max: 120,
            divisions: 24,
            label: '${value.round()} min',
            onChanged: (v) => setState(() => _value = v),
            onChangeEnd: (v) => _save(v.round()),
          ),
          Text(
            'A pickup followed by an appointment within this window shows as one '
            'threaded trip — each leg stays independently claimable.',
            style: AppText.subtitle,
          ),
        ],
      ),
    );
  }

  Future<void> _save(int minutes) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).updateFamily(familyId, threadingThresholdMinutes: minutes);
    ref.invalidate(threadingThresholdProvider);
  }
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
