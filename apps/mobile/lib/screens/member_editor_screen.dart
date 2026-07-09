import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/color_swatch_picker.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

/// Family-member editor (6h) — name, color, family-view role label, and the
/// admin permission. Opened by the ✎ on the 6e profile card. Identity editing
/// lives entirely here; the detail screen has none.
Future<void> showMemberEditor(BuildContext context, WidgetRef ref, Member member) {
  return showDialog<void>(
    context: context,
    builder: (_) => Dialog(
      backgroundColor: AppColors.card,
      insetPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 48),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(30)),
      child: _MemberEditor(member: member),
    ),
  );
}

class _MemberEditor extends ConsumerStatefulWidget {
  const _MemberEditor({required this.member});
  final Member member;

  @override
  ConsumerState<_MemberEditor> createState() => _MemberEditorState();
}

class _MemberEditorState extends ConsumerState<_MemberEditor> {
  late final TextEditingController _name =
      TextEditingController(text: widget.member.relationName);
  late Color _color = personColor(widget.member);
  late bool _isChild = widget.member.requiresCaretaker;
  late bool _isAdmin = widget.member.isAdmin;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final canAdmin = ref.read(currentMemberProvider).valueOrNull?.isAdmin ?? false;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).updateMember(
            familyId,
            widget.member.id,
            relationName: _name.text.trim().isEmpty ? null : _name.text.trim(),
            color: hexFromColor(_color),
            // Role label maps onto the two grouping booleans.
            requiresCaretaker: canAdmin ? _isChild : null,
            isCaretaker: canAdmin ? !_isChild : null,
            isAdmin: canAdmin ? _isAdmin : null,
          );
      ref.invalidate(membersProvider);
      ref.invalidate(currentMemberProvider);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      setState(() {
        _busy = false;
        _error = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final isAdmin = ref.watch(currentMemberProvider).valueOrNull?.isAdmin ?? false;
    final taken = <String>{
      for (final m in members)
        if (m.id != widget.member.id && m.color != null && m.color!.isNotEmpty)
          hexFromColor(colorFromHex(m.color!)),
    };

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(22, 18, 22, 22),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('Edit member', style: AppText.subPageTitle),
              const Spacer(),
              IconButton(
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(Icons.close_rounded, color: AppColors.textMuted),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Center(
            child: PersonAvatar(
                initial: initialFor(_name.text.isEmpty ? '?' : _name.text),
                color: _color,
                size: 72),
          ),
          const SizedBox(height: 20),
          Text('NAME', style: AppText.eyebrow()),
          const SizedBox(height: 8),
          TextField(
            controller: _name,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(hintText: 'Name / relation'),
          ),
          const SizedBox(height: 20),
          Text('COLOR', style: AppText.eyebrow()),
          const SizedBox(height: 10),
          ColorSwatchPicker(
            selected: _color,
            takenHex: taken,
            onSelected: (c) => setState(() => _color = c),
          ),
          if (isAdmin) ...[
            const SizedBox(height: 20),
            Text('ROLE IN FAMILY VIEW', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            _RoleSegmented(
              isChild: _isChild,
              onChanged: (v) => setState(() => _isChild = v),
            ),
            const SizedBox(height: 6),
            Text("Only groups them in the family list — it doesn't change what they can do.",
                style: AppText.subtitle),
            const SizedBox(height: 20),
            Text('PERMISSIONS', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            AppCard(
              child: SwitchRow(
                icon: Icons.shield_outlined,
                iconColor: AppColors.amber,
                title: 'Admin access',
                subtitle: 'Can manage the whole family',
                value: _isAdmin,
                onChanged: (v) => setState(() => _isAdmin = v),
              ),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
          ],
          const SizedBox(height: 20),
          SizedBox(
            width: double.infinity,
            child: PillButton(
              label: 'Save',
              variant: PillVariant.indigo,
              onPressed: _busy ? null : _save,
            ),
          ),
        ],
      ),
    );
  }
}

class _RoleSegmented extends StatelessWidget {
  const _RoleSegmented({required this.isChild, required this.onChanged});
  final bool isChild;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    Widget seg(String label, bool childValue) {
      final selected = isChild == childValue;
      return Expanded(
        child: GestureDetector(
          onTap: () => onChanged(childValue),
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 11),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: selected ? AppColors.indigo : Colors.transparent,
              borderRadius: BorderRadius.circular(11),
            ),
            child: Text(label,
                style: font(kBodyFont, 13, 700,
                    color: selected ? const Color(0xFF17162B) : AppColors.textSecondary)),
          ),
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppColors.bg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(children: [seg('Child', true), seg('Caretaker', false)]),
    );
  }
}
