import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';
import 'calendars_screen.dart';
import 'dialogs.dart';
import 'member_sections.dart';

/// Per-caretaker settings: member color, role permissions, delivery methods,
/// and the destructive "remove from family".
class CaretakerDetailScreen extends ConsumerWidget {
  const CaretakerDetailScreen({super.key, required this.memberId});
  final String memberId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final members = ref.watch(membersProvider).valueOrNull ?? const <Member>[];
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final member = members.where((m) => m.id == memberId).firstOrNull;
    if (member == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final color = personColor(member);
    final isAdmin = me?.isAdmin ?? false;
    final canEditColor = isAdmin || me?.id == member.id;

    final targets = [
      for (final t in ref.watch(targetsProvider).valueOrNull ?? const [])
        if ((t as Map<String, dynamic>)['memberId'] == member.id) t
    ];
    final activeCount = targets.where((t) => (t['active'] as bool?) ?? true).length;

    Future<void> setActive(Map<String, dynamic> t, bool v) async {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).updateCalendarTarget(familyId, t['id'] as String, active: v);
      ref.invalidate(targetsProvider);
    }

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 40),
          children: [
            const SubPageHeader(title: 'Caretaker'),
            const SizedBox(height: 20),
            DetailProfileCard(
              avatar: PersonAvatar(initial: initialFor(member.relationName), color: color, size: 54),
              name: member.relationName,
              subtitle: 'Caretaker · ${member.isCaretaker ? 'can claim tasks' : 'view only'}',
              onEdit: () => showEditNameDialog(context, ref, member),
            ),
            const SizedBox(height: 24),
            MemberColorSection(member: member, others: members, enabled: canEditColor),
            const SizedBox(height: 24),
            const SectionEyebrow('Role'),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                children: [
                  SwitchRow(
                    icon: Icons.shield_outlined,
                    iconColor: AppColors.amber,
                    title: 'Family admin',
                    subtitle: 'Manage people, feeds, and rules',
                    value: member.isAdmin,
                    onChanged: isAdmin ? (v) => _setFlag(ref, member, isAdmin: v) : null,
                  ),
                  const Divider(height: 20),
                  SwitchRow(
                    icon: Icons.person_outline_rounded,
                    iconColor: AppColors.indigo,
                    title: 'Can claim tasks',
                    subtitle: 'Show up as a caretaker for handoffs',
                    value: member.isCaretaker,
                    onChanged: isAdmin ? (v) => _setFlag(ref, member, isCaretaker: v) : null,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            SectionEyebrow(
              'Delivery methods',
              color: AppColors.green,
              trailing: TintBadge('$activeCount active', color: AppColors.green),
            ),
            const SizedBox(height: 8),
            Text(
              "Where ${member.relationName}'s claimed tasks land. Route to more than one.",
              style: AppText.subtitle,
            ),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                children: [
                  if (targets.isEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Text('No delivery methods yet', style: AppText.subtitle),
                    )
                  else
                    for (final t in targets) ...[
                      SwitchRow(
                        icon: _methodIcon(t['method'] as String),
                        iconColor: _methodColor(t['method'] as String),
                        title: t['name'] as String,
                        subtitle: _deliverySubtitle(t),
                        value: (t['active'] as bool?) ?? true,
                        onChanged: (v) => setActive(t, v),
                      ),
                      const Divider(height: 20),
                    ],
                  SettingRow(
                    icon: Icons.add_rounded,
                    iconColor: AppColors.indigo,
                    title: 'Add delivery method',
                    onTap: () async {
                      final added = await Navigator.of(context).push<bool>(
                        MaterialPageRoute(builder: (_) => const OutputFeedPage()),
                      );
                      if (added == true) ref.invalidate(targetsProvider);
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 28),
            if (isAdmin && me?.id != member.id)
              _RemoveButton(
                label: 'Remove from family',
                onTap: () => _confirmRemove(context, ref, member),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _setFlag(WidgetRef ref, Member m, {bool? isAdmin, bool? isCaretaker}) async {
    final familyId = await ref.read(familyProvider.future);
    await ref.read(apiClientProvider).updateMember(
          familyId,
          m.id,
          isAdmin: isAdmin,
          isCaretaker: isCaretaker,
        );
    ref.invalidate(membersProvider);
    ref.invalidate(currentMemberProvider);
  }

  Future<void> _confirmRemove(BuildContext context, WidgetRef ref, Member m) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Remove from family?'),
        content: Text('Remove ${m.relationName}? Their claimed tasks and delivery '
            'methods are deleted. This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          PillButton(
            label: 'Remove',
            variant: PillVariant.white,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).deleteMember(familyId, m.id);
      ref.invalidate(membersProvider);
      ref.invalidate(targetsProvider);
      if (context.mounted) Navigator.of(context).pop();
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Remove failed: $e')));
      }
    }
  }

  String _deliverySubtitle(Map<String, dynamic> t) {
    final method = t['method'] as String;
    final label = switch (t['providerHint']) {
      'icloud' => 'iCloud',
      'generic_caldav' => 'CalDAV',
      _ => method == 'google' ? 'Calendar' : (method == 'email' ? 'Email invite' : 'CalDAV'),
    };
    final alerts = (t['alertMinutes'] as List?)?.cast<num>() ?? const [];
    final reminder = alerts.isEmpty ? '' : ' · ${alerts.first.toInt()}m reminder';
    return '$label$reminder';
  }

  IconData _methodIcon(String method) => switch (method) {
        'email' => Icons.mail_outline_rounded,
        'google' => Icons.calendar_month_rounded,
        _ => Icons.event_note_rounded,
      };

  Color _methodColor(String method) => switch (method) {
        'email' => AppColors.coral,
        'google' => AppColors.blue,
        _ => AppColors.purple,
      };
}

class _RemoveButton extends StatelessWidget {
  const _RemoveButton({required this.label, required this.onTap});
  final String label;
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
              const Icon(Icons.close_rounded, color: AppColors.coral, size: 19),
              const SizedBox(width: 8),
              Text(label, style: font(kBodyFont, 14, 700, color: AppColors.coral)),
            ],
          ),
        ),
      ),
    );
  }
}
