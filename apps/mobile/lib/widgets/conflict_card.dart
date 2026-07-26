import 'package:flutter/material.dart';

import '../models.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../util/format.dart';
import 'primitives.dart';

/// The shared anatomy of a conflict card: who and when across the top, then
/// both colliding events, higher priority first.
///
/// Home's "Double-booked" card and member detail's "Overrides in effect" cards
/// are the same object at two stages — still unresolved (coral, "Review &
/// resolve") and already split (green, "Revert") — so they share this header
/// and these event rows, and differ only in accent colour and action.

/// Top line of a conflict card: the day on the left, the member it belongs to
/// on the right. [icon] is optional — Home leads with a status tile, the
/// overrides list lets the date take the corner.
class ConflictCardHeader extends StatelessWidget {
  const ConflictCardHeader({
    super.key,
    required this.day,
    required this.member,
    this.icon,
    this.iconColor = AppColors.coral,
  });

  final String day;
  final Member? member;
  final IconData? icon;
  final Color iconColor;

  @override
  Widget build(BuildContext context) {
    final memberColor =
        member != null ? personColor(member!) : AppColors.textSecondary;
    final name = member?.relationName;
    return Row(
      children: [
        if (icon != null) ...[
          IconTile(icon: icon!, color: iconColor, size: 30),
          const SizedBox(width: 9),
        ],
        // The date takes the slack (rather than a Spacer) so the member cluster
        // stays flush right whatever its name is.
        Expanded(
          child: Text(day,
              style: font(kBodyFont, 12.5, 600, color: AppColors.textSecondary)),
        ),
        const SizedBox(width: 9),
        PersonAvatar(
          initial: initialFor(name ?? '?'),
          color: memberColor,
          size: 26,
        ),
        const SizedBox(width: 7),
        Text(name ?? 'Member',
            style: font(kBodyFont, 13, 700, color: memberColor),
            maxLines: 1,
            overflow: TextOverflow.ellipsis),
      ],
    );
  }
}

/// One of the two colliding events: title on the left, time on the right. Both
/// events get this exact treatment — only their order carries the priority,
/// except for the optional [leadingIcon] a resolved card uses to mark which of
/// the two was the one trimmed.
class ConflictEventRow extends StatelessWidget {
  const ConflictEventRow({
    super.key,
    required this.event,
    this.accent = AppColors.coral,
    this.leadingIcon,
  });

  final ConflictEventRef event;
  final Color accent;
  final IconData? leadingIcon;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: AppColors.bg.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: accent.withValues(alpha: 0.22)),
      ),
      child: Row(
        children: [
          if (leadingIcon != null) ...[
            Icon(leadingIcon, size: 14, color: accent),
            const SizedBox(width: 7),
          ],
          Expanded(
            child: Text(
              event.summary ?? 'An event',
              style: font(kBodyFont, 13, 600),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: 8),
          Text(conflictEventTime(event),
              style: font(kBodyFont, 11.5, 600, color: AppColors.textSecondary)),
        ],
      ),
    );
  }
}

/// "All day" / "10:00 – 11:00 AM" / "10:00 AM" — a conflicting event's clock
/// label, matching the resolution sheet's.
String conflictEventTime(ConflictEventRef e) {
  if (e.allDay) return 'All day';
  final end = e.end;
  if (end != null && end.isAfter(e.start)) return friendlyRange(e.start, end);
  return friendlyTime(e.start);
}
