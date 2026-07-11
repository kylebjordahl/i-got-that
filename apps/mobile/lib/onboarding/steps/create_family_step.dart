import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../state/auth.dart';
import '../../state/family.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../../theme/person_colors.dart';
import '../../widgets/color_swatch_picker.dart';
import '../onboarding_scaffold.dart';

/// 1c — create the family and name yourself. One step, two records: the family
/// row and the caller's (admin) member, created together (the route makes the
/// member; we then stamp the chosen color). The color is the accent used
/// everywhere you appear.
class CreateFamilyStep extends ConsumerStatefulWidget {
  const CreateFamilyStep({
    super.key,
    required this.onNext,
    required this.onBack,
    required this.onExit,
  });

  final VoidCallback onNext;
  final VoidCallback onBack;
  final VoidCallback onExit;

  @override
  ConsumerState<CreateFamilyStep> createState() => _CreateFamilyStepState();
}

class _CreateFamilyStepState extends ConsumerState<CreateFamilyStep> {
  final _family = TextEditingController();
  final _name = TextEditingController();
  Color _color = AppColors.indigo;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _family.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _submit({required bool exit}) async {
    if (_family.text.trim().isEmpty) {
      setState(() => _error = 'Give your family a name');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final res = await api.createFamily(
        _family.text.trim(),
        relationName: _name.text.trim().isEmpty ? 'Me' : _name.text.trim(),
      );
      final family = res['family'] as Map<String, dynamic>;
      final member = res['member'] as Map<String, dynamic>;
      await api.updateMember(
        family['id'] as String,
        member['id'] as String,
        color: hexFromColor(_color),
      );
      ref.invalidate(hasFamilyProvider);
      ref.invalidate(familyProvider);
      ref.invalidate(familiesListProvider);
      ref.invalidate(membersProvider);
      ref.invalidate(currentMemberProvider);
      await ref.read(familyProvider.future);
      if (!mounted) return;
      exit ? widget.onExit() : widget.onNext();
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return OnboardingScaffold(
      progress: 0.33,
      onBack: widget.onBack,
      trailingLabel: 'Finish later',
      onTrailing: _busy ? null : () => _submit(exit: true),
      title: 'Create your family',
      subtitle: 'The shared space everyone coordinates in. You can rename it later.',
      body: [
        const _Label('Family name'),
        const SizedBox(height: 9),
        _Field(controller: _family, hint: 'Rivera Family', accent: AppColors.indigo, autofocus: true),
        const SizedBox(height: 20),
        const _Label('What should we call you?'),
        const SizedBox(height: 9),
        _Field(controller: _name, hint: 'Dad'),
        const SizedBox(height: 9),
        Text("This is how you'll show up to everyone in the family.",
            style: font(kBodyFont, 12, 500, color: AppColors.textTertiary, height: 1.5)),
        const SizedBox(height: 22),
        const _Label('Your color'),
        const SizedBox(height: 12),
        ColorSwatchPicker(
          selected: _color,
          onSelected: (c) => setState(() => _color = c),
        ),
        if (_error != null) ...[
          const SizedBox(height: 16),
          Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
        ],
      ],
      bottom: OnboardingButton(
        label: 'Create family',
        busy: _busy,
        onPressed: () => _submit(exit: false),
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: Text(text.toUpperCase(), style: AppText.eyebrow()),
      );
}

class _Field extends StatelessWidget {
  const _Field({
    required this.controller,
    required this.hint,
    this.accent,
    this.autofocus = false,
  });
  final TextEditingController controller;
  final String hint;
  final Color? accent;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      autofocus: autofocus,
      style: font(kBodyFont, 16, 600),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: font(kBodyFont, 16, 600, color: AppColors.textMuted),
        filled: true,
        fillColor: AppColors.card,
        contentPadding: const EdgeInsets.symmetric(horizontal: 15, vertical: 15),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: AppColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: accent ?? AppColors.indigo, width: 1.5),
        ),
      ),
    );
  }
}
