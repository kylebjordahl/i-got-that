import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../models.dart';
import '../../state/auth.dart';
import '../../state/family.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../onboarding_scaffold.dart';

/// 1h — first-run complete: the bail-out contract made visible. Each committed
/// chunk is receipted, and the amber card leads into the second-parent join.
class CompleteStep extends ConsumerWidget {
  const CompleteStep({super.key, required this.onGoHome});
  final VoidCallback onGoHome;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accounts = ref.watch(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
    final info = ref.watch(familyInfoProvider).valueOrNull;
    final children = ref.watch(dependentsProvider).valueOrNull ?? const <Member>[];
    final caretakers = ref.watch(caretakersProvider).valueOrNull ?? const <Member>[];
    final invitable =
        caretakers.where((m) => !m.hasLogin).where((m) => m.isCaretaker).toList();

    final childNames = _joinNames(children.map((c) => c.relationName).toList());

    return Scaffold(
      backgroundColor: AppColors.bg,
      body: Container(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment(0, -1),
            radius: 1.0,
            colors: [Color(0xFF16261F), AppColors.bg],
            stops: [0.0, 0.55],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              Container(height: 3, color: AppColors.green),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(24, 34, 24, 8),
                  children: [
                    _CheckHero(),
                    const SizedBox(height: 22),
                    Text("You're all set", style: font(kDisplayFont, 28, 600, letterSpacing: -0.3)),
                    const SizedBox(height: 8),
                    Text(
                        'The app is watching the ${info?.name ?? 'family'} calendars and '
                        "generating tasks. Here's what's live:",
                        style: font(kBodyFont, 14.5, 500,
                            color: AppColors.textSecondary, height: 1.55)),
                    const SizedBox(height: 22),
                    GroupedCard(children: [
                      _receipt('${accounts.length} calendar account${accounts.length == 1 ? '' : 's'} connected'),
                      _receipt('${info?.name ?? 'Family'} created · ${info?.count ?? 1} member${(info?.count ?? 1) == 1 ? '' : 's'}'),
                      if (childNames.isNotEmpty)
                        _receipt('Unified calendar for $childNames'),
                      _receipt('Your calendar ready to claim onto'),
                    ]),
                    if (invitable.isNotEmpty) ...[
                      const SizedBox(height: 16),
                      _InviteCard(
                        names: _joinNames(invitable.map((m) => m.relationName).toList()),
                        member: invitable.first,
                      ),
                    ],
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 12, 22, 20),
                child: OnboardingButton(label: 'Go to Home', onPressed: onGoHome),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _receipt(String text) => GroupRow(
        leading: Container(
          width: 24,
          height: 24,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: AppColors.tint(AppColors.green, 0.18), shape: BoxShape.circle),
          child: const Icon(Icons.check_rounded, size: 13, color: AppColors.green),
        ),
        title: text,
      );

  static String _joinNames(List<String> names) {
    if (names.isEmpty) return '';
    if (names.length == 1) return names.first;
    if (names.length == 2) return '${names[0]} & ${names[1]}';
    return '${names.sublist(0, names.length - 1).join(', ')} & ${names.last}';
  }
}

class _CheckHero extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      width: 64,
      height: 64,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: AppColors.tint(AppColors.green, 0.15),
        shape: BoxShape.circle,
        border: Border.all(color: AppColors.green.withValues(alpha: 0.4)),
      ),
      child: const Icon(Icons.check_rounded, size: 32, color: AppColors.green),
    );
  }
}

class _InviteCard extends ConsumerStatefulWidget {
  const _InviteCard({required this.names, required this.member});
  final String names;
  final Member member;

  @override
  ConsumerState<_InviteCard> createState() => _InviteCardState();
}

class _InviteCardState extends ConsumerState<_InviteCard> {
  bool _busy = false;

  Future<void> _copy() async {
    setState(() => _busy = true);
    try {
      final api = ref.read(apiClientProvider);
      final familyId = await ref.read(familyProvider.future);
      final res = await api.issueMemberInvite(familyId, widget.member.id);
      final token = res['token'] as String?;
      if (token != null) {
        await Clipboard.setData(ClipboardData(text: token));
        if (mounted) {
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text('Invite code copied to clipboard')));
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Could not create invite: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF2A2318), Color(0xFF1C1723)],
        ),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.amber.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('ONE MORE THING', style: AppText.eyebrow(AppColors.amber)),
          const SizedBox(height: 6),
          Text('Invite ${widget.names}', style: font(kBodyFont, 15, 600, height: 1.4)),
          const SizedBox(height: 4),
          Text("They'll only need to log in once — you did the heavy setup.",
              style: font(kBodyFont, 12.5, 500, color: AppColors.textSecondary, height: 1.5)),
          const SizedBox(height: 12),
          OnboardingButton(
            label: _busy ? 'Creating…' : 'Copy invite link',
            variant: OnbButtonVariant.ghost,
            icon: Icons.link_rounded,
            busy: _busy,
            onPressed: _copy,
          ),
        ],
      ),
    );
  }
}
