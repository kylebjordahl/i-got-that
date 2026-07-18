import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../state/auth.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../onboarding_scaffold.dart';

/// 1a — the pre-configuration welcome / sign-in. The app's unauthed entry
/// (replaces the old bare login screen). One-tap Apple / magic-link sign-in;
/// no wizard chrome yet — the progress line and "Finish later" only appear once
/// real configuration begins (1b onward). On success the auth state flips and
/// `main.dart` re-renders straight into the wizard.
class WelcomeStep extends ConsumerStatefulWidget {
  const WelcomeStep({super.key});

  @override
  ConsumerState<WelcomeStep> createState() => _WelcomeStepState();
}

class _WelcomeStepState extends ConsumerState<WelcomeStep> {
  bool _busy = false;
  String? _error;

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

  void _apple() => _run(() => kIsWeb
      ? Future.sync(() => ref.read(authControllerProvider.notifier).loginWithApple())
      : ref.read(authControllerProvider.notifier).loginWithAppleNative());

  void _google() => _run(() => kIsWeb
      // Web redirect flow: the same consent grants calendar access, so signing
      // in with Google also connects the user's Google Calendar automatically.
      ? Future.sync(() => ref.read(authControllerProvider.notifier).loginWithGoogle())
      : ref.read(authControllerProvider.notifier).loginWithGoogleNative());

  Future<void> _magicLink() async {
    final email = await _promptEmail();
    if (email == null || email.trim().isEmpty) return;
    await _run(() =>
        ref.read(authControllerProvider.notifier).loginWithEmail(email.trim()));
  }

  Future<String?> _promptEmail() async {
    final controller = TextEditingController();
    try {
      // A dialog (not a bottom sheet) so its route re-centers above the
      // keyboard: the manual viewInsets padding a sheet needs pushes the
      // autofocused field clean out of view on web.
      return await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          backgroundColor: AppColors.card,
          title: Text('Email me a magic link', style: AppText.subPageTitle),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: controller,
                autofocus: true,
                keyboardType: TextInputType.emailAddress,
                decoration: const InputDecoration(
                    labelText: 'Email', hintText: 'you@example.com'),
                onSubmitted: (v) => Navigator.of(ctx).pop(v),
              ),
              const SizedBox(height: 16),
              OnboardingButton(
                label: 'Send link',
                onPressed: () => Navigator.of(ctx).pop(controller.text),
              ),
            ],
          ),
        ),
      );
    } finally {
      controller.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final redirectError = ref.watch(authControllerProvider).error;
    final error = _error ?? redirectError;
    return Scaffold(
      backgroundColor: AppColors.bg,
      body: Container(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment(-0.6, -0.85),
            radius: 1.1,
            colors: [Color(0xFF221A2E), AppColors.bg],
            stops: [0.0, 0.6],
          ),
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 28),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Spacer(),
                const _LogoMark(),
                const SizedBox(height: 24),
                Text('I Got That',
                    style: font(kDisplayFont, 38, 700, letterSpacing: -0.8)),
                const SizedBox(height: 12),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 280),
                  child: Text(
                    'One shared calendar for the whole family — every handoff '
                    'owned, nothing dropped.',
                    style: font(kBodyFont, 16, 500,
                        color: const Color(0xFFA79FB5), height: 1.55),
                  ),
                ),
                const Spacer(),
                if (error != null) ...[
                  Text(error,
                      style: font(kBodyFont, 12.5, 500, color: AppColors.coral)),
                  const SizedBox(height: 12),
                ],
                OnboardingButton(
                  label: 'Continue with Apple',
                  variant: OnbButtonVariant.white,
                  icon: Icons.apple,
                  busy: _busy,
                  onPressed: _apple,
                ),
                const SizedBox(height: 11),
                OnboardingButton(
                  label: 'Continue with Google',
                  variant: OnbButtonVariant.ghost,
                  icon: Icons.g_mobiledata_rounded,
                  onPressed: _busy ? null : _google,
                ),
                const SizedBox(height: 11),
                OnboardingButton(
                  label: 'Email me a magic link',
                  variant: OnbButtonVariant.ghost,
                  icon: Icons.mail_outline_rounded,
                  onPressed: _busy ? null : _magicLink,
                ),
                const SizedBox(height: 18),
                Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 300),
                    child: Text.rich(
                      TextSpan(
                        text: 'By continuing you agree to our ',
                        style: font(kBodyFont, 11.5, 500,
                            color: AppColors.textMuted, height: 1.5),
                        children: [
                          TextSpan(
                              text: 'Terms',
                              style: font(kBodyFont, 11.5, 600,
                                  color: AppColors.textSecondary)),
                          const TextSpan(text: ' & '),
                          TextSpan(
                              text: 'Privacy Policy',
                              style: font(kBodyFont, 11.5, 600,
                                  color: AppColors.textSecondary)),
                          const TextSpan(text: '.'),
                        ],
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ),
                ),
                const SizedBox(height: 28),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The app mark: a gradient rounded square with two overlapping rings.
class _LogoMark extends StatelessWidget {
  const _LogoMark();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 58,
      height: 58,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(18),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [AppColors.indigo, AppColors.purple],
        ),
        boxShadow: [
          BoxShadow(
            color: AppColors.indigo.withValues(alpha: 0.5),
            blurRadius: 34,
            offset: const Offset(0, 16),
          ),
        ],
      ),
      child: const SizedBox(
        width: 30,
        height: 18,
        child: Stack(
          alignment: Alignment.center,
          children: [
            Positioned(left: 0, child: _Ring()),
            Positioned(right: 0, child: _Ring()),
          ],
        ),
      ),
    );
  }
}

class _Ring extends StatelessWidget {
  const _Ring();
  @override
  Widget build(BuildContext context) {
    return Container(
      width: 18,
      height: 18,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: const Color(0xFF15121B), width: 2.1),
      ),
    );
  }
}
