import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/color_swatch_picker.dart';
import '../widgets/primitives.dart';
import 'onboarding_scaffold.dart';

/// 1i — the add-caretaker / add-child sheet raised from 1d. Name + color + role,
/// and (for a caretaker) how they get their tasks: email delivery (zero app
/// effort) or an app invite (kicks off the second-parent join). Add-a-child is
/// the same sheet with the child fields instead.
Future<bool> showOnboardingAddMemberSheet(
  BuildContext context,
  WidgetRef ref, {
  required bool isChild,
}) async {
  final ok = await showModalBottomSheet<bool>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _AddMemberSheet(isChild: isChild),
  );
  if (ok == true) ref.invalidate(membersProvider);
  return ok == true;
}

class _AddMemberSheet extends ConsumerStatefulWidget {
  const _AddMemberSheet({required this.isChild});
  final bool isChild;

  @override
  ConsumerState<_AddMemberSheet> createState() => _AddMemberSheetState();
}

class _AddMemberSheetState extends ConsumerState<_AddMemberSheet> {
  final _name = TextEditingController();
  late Color _color;
  bool _isAdmin = false;
  bool _inviteToApp = false; // false = email delivery
  bool _busy = false;
  String? _error;

  Color get _accent => widget.isChild ? AppColors.green : AppColors.indigo;

  @override
  void initState() {
    super.initState();
    _color = _firstFreeColor();
    _name.addListener(() => setState(() {}));
  }

  Color _firstFreeColor() {
    final taken = _takenHexes();
    for (final c in AppColors.palette) {
      if (!taken.contains(hexFromColor(c))) return c;
    }
    return _accent;
  }

  Set<String> _takenHexes() {
    final members = ref.read(membersProvider).valueOrNull ?? const <Member>[];
    return {
      for (final m in members)
        if (m.color != null && m.color!.isNotEmpty) hexFromColor(colorFromHex(m.color!)),
    };
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'A name is required');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final familyId = await ref.read(familyProvider.future);
      final res = await api.createMember(
        familyId,
        relationName: name,
        isCaretaker: !widget.isChild,
        requiresCaretaker: widget.isChild,
        isAdmin: !widget.isChild && _isAdmin,
      );
      final memberId = (res['member'] as Map<String, dynamic>)['id'] as String;
      await api.updateMember(familyId, memberId, color: hexFromColor(_color));

      // Caretaker + "invite to app" → issue an invite and copy the link so the
      // second parent can join with ~one login.
      if (!widget.isChild && _inviteToApp) {
        try {
          final invite = await api.issueMemberInvite(familyId, memberId);
          final token = invite['token'] as String?;
          if (token != null) {
            await Clipboard.setData(ClipboardData(text: token));
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text('Invite code for $name copied to clipboard')),
              );
            }
          }
        } catch (_) {
          // The member is created regardless; the invite can be re-issued later.
        }
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final name = _name.text.trim();
    return Container(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.9),
      decoration: const BoxDecoration(
        color: Color(0xFF1B1622),
        borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
        border: Border(top: BorderSide(color: AppColors.border)),
      ),
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 10),
            Container(
              width: 38,
              height: 4,
              decoration: BoxDecoration(
                  color: const Color(0x33FFFFFF), borderRadius: BorderRadius.circular(2)),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 2),
              child: Row(
                children: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(false),
                    child: Text('Cancel',
                        style: font(kBodyFont, 14, 600, color: AppColors.textTertiary)),
                  ),
                  const Spacer(),
                  Text(widget.isChild ? 'New child' : 'New caretaker',
                      style: font(kBodyFont, 15, 700)),
                  const Spacer(),
                  TextButton(
                    onPressed: _busy ? null : _save,
                    child: Text('Save',
                        style: font(kBodyFont, 14, 700, color: _accent)),
                  ),
                ],
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.fromLTRB(22, 12, 22, 4),
                children: [
                  Center(
                    child: Column(
                      children: [
                        PersonAvatar(
                            initial: name.isEmpty ? '?' : name.substring(0, 1).toUpperCase(),
                            color: _color,
                            size: 72),
                        const SizedBox(height: 14),
                        ColorSwatchPicker(
                          selected: _color,
                          onSelected: (c) => setState(() => _color = c),
                          takenHex: _takenHexes(),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  _eyebrow('Name'),
                  const SizedBox(height: 8),
                  _field(hint: widget.isChild ? 'Theo' : 'Aunt Ray', autofocus: true),
                  if (!widget.isChild) ...[
                    const SizedBox(height: 18),
                    _eyebrow('Role'),
                    const SizedBox(height: 10),
                    _RoleToggle(
                      isAdmin: _isAdmin,
                      accent: _accent,
                      onChanged: (v) => setState(() => _isAdmin = v),
                    ),
                    const SizedBox(height: 8),
                    Text('Caretakers can claim and complete handoffs. Admins can '
                        'also edit the family and members.',
                        style: font(kBodyFont, 12, 500,
                            color: AppColors.textTertiary, height: 1.5)),
                    const SizedBox(height: 18),
                    _eyebrow('How they get tasks'),
                    const SizedBox(height: 10),
                    _DeliveryOption(
                      icon: Icons.mail_outline_rounded,
                      title: 'Email delivery',
                      subtitle: 'No app needed',
                      selected: !_inviteToApp,
                      accent: _accent,
                      onTap: () => setState(() => _inviteToApp = false),
                    ),
                    const SizedBox(height: 9),
                    _DeliveryOption(
                      icon: Icons.link_rounded,
                      title: 'Invite to the app',
                      subtitle: 'They connect their own calendar',
                      selected: _inviteToApp,
                      accent: _accent,
                      onTap: () => setState(() => _inviteToApp = true),
                    ),
                  ],
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 12, 22, 24),
              child: OnboardingButton(
                label: name.isEmpty
                    ? (widget.isChild ? 'Add child' : 'Add caretaker')
                    : 'Add $name',
                variant: widget.isChild ? OnbButtonVariant.green : OnbButtonVariant.indigo,
                busy: _busy,
                onPressed: _save,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _eyebrow(String s) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2),
        child: Text(s.toUpperCase(), style: AppText.eyebrow()),
      );

  Widget _field({required String hint, bool autofocus = false}) {
    return TextField(
      controller: _name,
      autofocus: autofocus,
      style: font(kBodyFont, 16, 600),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: font(kBodyFont, 16, 600, color: AppColors.textMuted),
        filled: true,
        fillColor: AppColors.card,
        contentPadding: const EdgeInsets.symmetric(horizontal: 15, vertical: 14),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: const BorderSide(color: AppColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: _accent, width: 1.5),
        ),
      ),
    );
  }
}

class _RoleToggle extends StatelessWidget {
  const _RoleToggle({required this.isAdmin, required this.accent, required this.onChanged});
  final bool isAdmin;
  final Color accent;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    Widget seg(String label, bool selected, VoidCallback onTap) => Expanded(
          child: GestureDetector(
            onTap: onTap,
            child: Container(
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(vertical: 11),
              decoration: BoxDecoration(
                color: AppColors.card,
                borderRadius: BorderRadius.circular(13),
                border: Border.all(
                    color: selected ? accent : AppColors.border, width: selected ? 1.5 : 1),
              ),
              child: Text(label,
                  style: font(kBodyFont, 13, selected ? 700 : 600,
                      color: selected ? AppColors.textPrimary : AppColors.textTertiary)),
            ),
          ),
        );
    return Row(children: [
      seg('Caretaker', !isAdmin, () => onChanged(false)),
      const SizedBox(width: 9),
      seg('Admin', isAdmin, () => onChanged(true)),
    ]);
  }
}

class _DeliveryOption extends StatelessWidget {
  const _DeliveryOption({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.accent,
    required this.onTap,
  });
  final IconData icon;
  final String title;
  final String subtitle;
  final bool selected;
  final Color accent;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: AppColors.card,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
              color: selected ? accent : AppColors.borderSubtle, width: selected ? 1.5 : 1),
        ),
        child: Row(
          children: [
            Container(
              width: 26,
              height: 26,
              alignment: Alignment.center,
              decoration: BoxDecoration(color: AppColors.tint(accent), shape: BoxShape.circle),
              child: Icon(icon, size: 15, color: accent),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title, style: font(kBodyFont, 14, 600)),
                  const SizedBox(height: 1),
                  Text(subtitle,
                      style: font(kBodyFont, 12, 500, color: AppColors.textTertiary)),
                ],
              ),
            ),
            if (selected)
              Container(
                width: 22,
                height: 22,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
                child: const Icon(Icons.check_rounded, size: 13, color: Color(0xFF15121B)),
              )
            else
              Container(
                width: 22,
                height: 22,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(color: const Color(0x33FFFFFF), width: 2),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
