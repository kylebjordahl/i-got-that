import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../state/auth.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../onboarding_scaffold.dart';

/// 2a — invite landing. The join link carries the family context, so the second
/// parent lands on a warm, pre-populated welcome (not step 1 of a wizard).
/// One-tap sign-in, then the invite is accepted and the join continues.
class InviteLandingStep extends ConsumerStatefulWidget {
  const InviteLandingStep({super.key, required this.token, required this.onAccepted});

  final String token;
  final VoidCallback onAccepted;

  @override
  ConsumerState<InviteLandingStep> createState() => _InviteLandingStepState();
}

class _InviteLandingStepState extends ConsumerState<InviteLandingStep> {
  Map<String, dynamic>? _preview;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadPreview();
  }

  Future<void> _loadPreview() async {
    try {
      final p = await ref.read(apiClientProvider).previewInvite(widget.token);
      if (mounted) setState(() => _preview = p);
    } catch (_) {
      if (mounted) setState(() => _error = 'This invite link is invalid or expired.');
    }
  }

  Future<void> _accept() async {
    await ref.read(apiClientProvider).acceptInvite(widget.token);
    if (mounted) widget.onAccepted();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _joinApple() => _run(() async {
        final auth = ref.read(authControllerProvider.notifier);
        if (kIsWeb) {
          auth.loginWithApple();
          return; // redirects away; accept happens once authed on return
        }
        await auth.loginWithAppleNative();
        await _accept();
      });

  void _joinGoogle() {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
      content: Text('Google sign-in is coming soon — use Apple or email for now.'),
    ));
  }

  Future<void> _joinMagicLink() async {
    final email = await _promptEmail();
    if (email == null || email.trim().isEmpty) return;
    await _run(() async {
      await ref.read(authControllerProvider.notifier).loginWithEmail(email.trim());
      await _accept();
    });
  }

  Future<String?> _promptEmail() {
    final controller = TextEditingController();
    return showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppColors.card,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24))),
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(22, 18, 22, MediaQuery.of(ctx).viewInsets.bottom + 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Email me a magic link', style: AppText.subPageTitle),
            const SizedBox(height: 14),
            TextField(
              controller: controller,
              autofocus: true,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(labelText: 'Email', hintText: 'you@example.com'),
              onSubmitted: (v) => Navigator.of(ctx).pop(v),
            ),
            const SizedBox(height: 16),
            OnboardingButton(
                label: 'Send link',
                variant: OnbButtonVariant.blue,
                onPressed: () => Navigator.of(ctx).pop(controller.text)),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final authed = ref.watch(authControllerProvider).isAuthed;
    final familyName = _preview?['familyName'] as String? ?? 'the family';
    final relation = _preview?['relationName'] as String? ?? 'a caretaker';

    return Scaffold(
      backgroundColor: AppColors.bg,
      body: Container(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment(0.6, -0.9),
            radius: 1.1,
            colors: [Color(0xFF1A2230), AppColors.bg],
            stops: [0.0, 0.6],
          ),
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 26),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Spacer(),
                _Monogram(name: familyName),
                const SizedBox(height: 24),
                Text("You're invited to $familyName",
                    style: font(kDisplayFont, 30, 600, height: 1.15, letterSpacing: -0.3)),
                const SizedBox(height: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 300),
                  child: Text(
                    "You're joining as $relation. The heavy setup is already done — "
                    'you just connect your calendar and you\'re in.',
                    style: font(kBodyFont, 15, 500,
                        color: const Color(0xFFA79FB5), height: 1.55),
                  ),
                ),
                const SizedBox(height: 22),
                _points(),
                const Spacer(),
                if (_error != null) ...[
                  Text(_error!, style: font(kBodyFont, 12.5, 500, color: AppColors.coral)),
                  const SizedBox(height: 12),
                ],
                if (authed)
                  OnboardingButton(
                    label: 'Join $familyName',
                    variant: OnbButtonVariant.blue,
                    busy: _busy,
                    onPressed: () => _run(_accept),
                  )
                else ...[
                  OnboardingButton(
                    label: 'Join with Apple',
                    variant: OnbButtonVariant.white,
                    icon: Icons.apple,
                    busy: _busy,
                    onPressed: _joinApple,
                  ),
                  const SizedBox(height: 11),
                  OnboardingButton(
                    label: 'Join with Google',
                    variant: OnbButtonVariant.ghost,
                    icon: Icons.g_mobiledata_rounded,
                    onPressed: _busy ? null : _joinGoogle,
                  ),
                  const SizedBox(height: 11),
                  OnboardingButton(
                    label: 'Email me a magic link',
                    variant: OnbButtonVariant.ghost,
                    icon: Icons.mail_outline_rounded,
                    onPressed: _busy ? null : _joinMagicLink,
                  ),
                ],
                const SizedBox(height: 14),
                Center(
                  child: Text('Just one quick step after this.',
                      style: font(kBodyFont, 12, 500, color: AppColors.textMuted)),
                ),
                const SizedBox(height: 24),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _points() {
    Widget row(String text) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(
            children: [
              const Icon(Icons.check_rounded, size: 17, color: AppColors.green),
              const SizedBox(width: 10),
              Expanded(
                  child: Text(text,
                      style: font(kBodyFont, 13, 500, color: const Color(0xFFC9C2D6)))),
            ],
          ),
        );
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.card.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        children: [
          row('Kids & a shared calendar, already set up'),
          row("Claim any handoff the moment you're in"),
        ],
      ),
    );
  }
}

class _Monogram extends StatelessWidget {
  const _Monogram({required this.name});
  final String name;

  @override
  Widget build(BuildContext context) {
    final initial = name.trim().isEmpty ? '?' : name.trim().substring(0, 1).toUpperCase();
    return Container(
      width: 56,
      height: 56,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: AppColors.blue,
        borderRadius: BorderRadius.circular(18),
        boxShadow: [
          BoxShadow(
              color: AppColors.blue.withValues(alpha: 0.45),
              blurRadius: 30,
              offset: const Offset(0, 14)),
        ],
      ),
      child: Text(initial, style: font(kDisplayFont, 26, 700, color: const Color(0xFF06243F))),
    );
  }
}
