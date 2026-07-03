import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../widgets/settings.dart';
import 'accounts_screen.dart';
import 'dialogs.dart';
import 'feeds_screen.dart';

/// The nav "+" quick-add sheet — the family's common create actions in one place.
void showQuickAddSheet(BuildContext context, WidgetRef ref) {
  final isAdmin = ref.read(currentMemberProvider).valueOrNull?.isAdmin ?? false;
  showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheetContext) => Padding(
      padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Quick add', style: AppText.subPageTitle),
          const SizedBox(height: 12),
          if (isAdmin)
            SettingRow(
              icon: Icons.person_add_alt_1_rounded,
              iconColor: AppColors.indigo,
              title: 'Add family member',
              subtitle: 'A caretaker or a child',
              onTap: () {
                Navigator.of(sheetContext).pop();
                showAddMemberDialog(context, ref);
              },
            ),
          if (isAdmin) const Divider(height: 22),
          if (isAdmin)
            SettingRow(
              icon: Icons.rss_feed_rounded,
              iconColor: AppColors.feedBlue,
              title: 'Add input feed',
              subtitle: 'Link a calendar to generate tasks',
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const FeedsScreen()),
                );
              },
            ),
          if (isAdmin) const Divider(height: 22),
          SettingRow(
            icon: Icons.link_rounded,
            iconColor: AppColors.blue,
            title: 'Connect an account',
            subtitle: 'Google / iCloud / CalDAV',
            onTap: () {
              Navigator.of(sheetContext).pop();
              Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const AccountsScreen()),
              );
            },
          ),
          const Divider(height: 22),
          SettingRow(
            icon: Icons.vpn_key_outlined,
            iconColor: AppColors.green,
            title: 'Redeem invite code',
            subtitle: 'Join a family as a caretaker',
            onTap: () {
              Navigator.of(sheetContext).pop();
              showRedeemInviteDialog(context, ref);
            },
          ),
        ],
      ),
    ),
  );
}
