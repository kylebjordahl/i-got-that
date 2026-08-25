import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../theme/person_colors.dart';
import '../util/format.dart';
import '../widgets/primitives.dart';

/// "Whose is this?" — resolving a routing decision from a shared family
/// calendar. The event goes to whoever is ticked (one person or several), and
/// the same answer closes the question for everyone else on the calendar.
///
/// Two ways to answer: just this event, or every time — which leaves a routing
/// rule behind on each person picked, so events like it route themselves from
/// then on. Writing a rule is a change to the family's feed setup, so it's
/// offered to admins only; the one-off routing is open to anyone.
///
/// Returns true when the decision was resolved.
Future<bool?> showRouteEventSheet(
  BuildContext context, {
  required DecisionGroup group,
}) {
  return showModalBottomSheet<bool>(
    context: context,
    useSafeArea: true,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => _RouteEventSheet(group: group),
  );
}

class _RouteEventSheet extends ConsumerStatefulWidget {
  const _RouteEventSheet({required this.group});
  final DecisionGroup group;

  @override
  ConsumerState<_RouteEventSheet> createState() => _RouteEventSheetState();
}

class _RouteEventSheetState extends ConsumerState<_RouteEventSheet> {
  final Set<String> _linkIds = {};
  bool _recurring = false;
  late String _matchOp = 'contains';
  late final TextEditingController _value = TextEditingController(
    text: widget.group.first.summary ?? '',
  );
  bool _busy = false;
  String? _error;

  PendingDecision get _event => widget.group.first;

  @override
  void dispose() {
    _value.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final pattern = _value.text.trim();
      await ref
          .read(apiClientProvider)
          .resolvePendingDecision(
            familyId,
            _event.id,
            routeToLinkIds: _linkIds.toList(),
            ruleMatchOp: _recurring ? _matchOp : null,
            ruleMatchValue: _recurring && pattern.isNotEmpty ? pattern : null,
          );
      ref.invalidate(pendingDecisionsProvider);
      ref.invalidate(calendarEventsProvider);
      ref.invalidate(unownedTasksProvider);
      ref.invalidate(allTasksProvider);
      ref.invalidate(linkRulesProvider);
      if (mounted) Navigator.of(context).pop(true);
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
    final byId = {for (final m in members) m.id: m};
    final isAdmin =
        ref.watch(currentMemberProvider).valueOrNull?.isAdmin ?? false;
    final when = _event.allDay
        ? dayHeading(dayKey(_event.start), DateTime.now())
        : '${dayHeading(dayKey(_event.start), DateTime.now())} · ${friendlyTime(_event.start)}';

    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          22,
          4,
          22,
          28 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Who is this for?', style: AppText.subPageTitle),
            const SizedBox(height: 6),
            Text(
              'Nobody’s routing rules matched this event on the shared calendar, '
              'so it isn’t on anyone’s agenda yet.',
              style: AppText.subtitle,
            ),
            const SizedBox(height: 14),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _event.summary ?? 'Untitled event',
                    style: AppText.sectionItemTitle,
                  ),
                  const SizedBox(height: 3),
                  Text(
                    _event.location == null
                        ? when
                        : '$when · ${_event.location}',
                    style: AppText.subtitle,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
            Text('ROUTE TO', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            for (final row in widget.group.rows)
              _MemberCheck(
                member: byId[row.familyMemberId],
                checked: _linkIds.contains(row.linkId),
                onTap: () => setState(
                  () => _linkIds.contains(row.linkId)
                      ? _linkIds.remove(row.linkId)
                      : _linkIds.add(row.linkId),
                ),
              ),
            if (isAdmin) ...[
              const SizedBox(height: 20),
              Text('HOW OFTEN', style: AppText.eyebrow()),
              const SizedBox(height: 8),
              _Segmented(
                options: const [
                  (false, 'Just this event'),
                  (true, 'Every time'),
                ],
                value: _recurring,
                onChanged: (v) => setState(() => _recurring = v),
              ),
              if (_recurring) ...[
                const SizedBox(height: 12),
                Text(
                  'Adds a routing rule to everyone picked above, so events like '
                  'this one route themselves from now on. It has to match this '
                  'event — you can edit it later in Feed setup.',
                  style: AppText.subtitle,
                ),
                const SizedBox(height: 12),
                _Segmented(
                  options: const [('contains', 'Contains'), ('regex', 'Regex')],
                  value: _matchOp,
                  onChanged: (v) => setState(() => _matchOp = v),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _value,
                  decoration: InputDecoration(
                    labelText:
                        'Title ${_matchOp == 'regex' ? 'pattern' : 'value'}',
                    hintText: _matchOp == 'regex'
                        ? '/^swim/i'
                        : 'Swim practice',
                  ),
                ),
              ],
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                style: font(kBodyFont, 13, 500, color: AppColors.coral),
              ),
            ],
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              child: PillButton(
                label: 'Route event',
                variant: PillVariant.indigo,
                onPressed: _busy || _linkIds.isEmpty ? null : _save,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One candidate on the shared calendar, ticked or not.
class _MemberCheck extends StatelessWidget {
  const _MemberCheck({
    required this.member,
    required this.checked,
    required this.onTap,
  });
  final Member? member;
  final bool checked;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = member != null
        ? personColor(member!)
        : AppColors.textSecondary;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: checked ? AppColors.tint(color, 0.12) : AppColors.bg,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(14),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                color: checked ? color : AppColors.border,
                width: checked ? 1.5 : 1,
              ),
            ),
            child: Row(
              children: [
                Icon(
                  checked
                      ? Icons.check_circle_rounded
                      : Icons.radio_button_unchecked_rounded,
                  color: checked ? color : AppColors.textMuted,
                  size: 20,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    member?.relationName ?? 'member',
                    style: font(
                      kBodyFont,
                      14,
                      700,
                      color: checked ? color : AppColors.textSecondary,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A two-up segmented control over an arbitrary value (the sheet needs both a
/// bool one and a string one).
class _Segmented<T> extends StatelessWidget {
  const _Segmented({
    required this.options,
    required this.value,
    required this.onChanged,
  });
  final List<(T, String)> options;
  final T value;
  final ValueChanged<T> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppColors.bg,
        borderRadius: BorderRadius.circular(13),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          for (final (v, label) in options)
            Expanded(
              child: GestureDetector(
                onTap: () => onChanged(v),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: v == value ? AppColors.indigo : Colors.transparent,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: font(
                      kBodyFont,
                      12,
                      700,
                      color: v == value
                          ? const Color(0xFF17162B)
                          : AppColors.textSecondary,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
