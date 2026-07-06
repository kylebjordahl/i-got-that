import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

const _weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/// Add / edit a child's feed link (5q). The feed stays shared; this link scopes
/// it to the child. Covers the source, a per-child label, which task types it
/// generates, and — for exception feeds — the schedule baseline. Wired to the
/// family's member-links.
class FeedBaselineScreen extends ConsumerStatefulWidget {
  const FeedBaselineScreen({
    super.key,
    required this.child,
    this.feed,
    this.existingLink,
  });

  final Member child;

  /// The feed being linked. Null in "Link a feed" mode — pick it in the screen.
  final Map<String, dynamic>? feed;

  /// The current member-link (with baseline), or null to create a new link.
  final Map<String, dynamic>? existingLink;

  @override
  ConsumerState<FeedBaselineScreen> createState() => _FeedBaselineScreenState();
}

class _FeedBaselineScreenState extends ConsumerState<FeedBaselineScreen> {
  Map<String, dynamic>? _feed;
  final Set<int> _weekdays = {0, 1, 2, 3, 4};
  final _label = TextEditingController();
  final _dayStart = TextEditingController(text: '08:00');
  final _dayEnd = TextEditingController(text: '15:00');
  final _duration = TextEditingController();
  bool _genTransition = true;
  bool _genAttendance = false;
  bool _busy = false;
  String? _error;

  bool get _linked => widget.existingLink != null;
  bool get _isException => _feed?['mode'] == 'exception';

  @override
  void initState() {
    super.initState();
    _feed = widget.feed;
    final ex = widget.existingLink;
    if (ex != null) {
      final mask = ex['weekdayMask'] as int? ?? 31;
      _weekdays
        ..clear()
        ..addAll([for (var i = 0; i < 7; i++) if ((mask & (1 << i)) != 0) i]);
      final types = (ex['generatesTypes'] as List?)?.cast<String>() ?? const [];
      _genTransition = types.contains('dropoff') || types.contains('pickup') || types.isEmpty;
      _genAttendance = types.contains('attendance');
      _label.text = ex['location'] as String? ?? '';
      _dayStart.text = ex['dayStart'] as String? ?? '08:00';
      _dayEnd.text = ex['dayEnd'] as String? ?? '15:00';
      final dur = ex['durationMinutes'] as int?;
      _duration.text = dur != null ? '$dur' : '';
    }
  }

  @override
  void dispose() {
    for (final c in [_label, _dayStart, _dayEnd, _duration]) {
      c.dispose();
    }
    super.dispose();
  }

  int get _weekdayMask => _weekdays.fold(0, (m, b) => m | (1 << b));

  List<String> get _generatesTypes => [
        if (_genTransition) ...['dropoff', 'pickup'],
        if (_genAttendance) 'attendance',
      ];

  void _refresh(String feedId) {
    ref.invalidate(feedLinksProvider(feedId));
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
  }

  Future<void> _save() async {
    final feed = _feed;
    if (feed == null) {
      setState(() => _error = 'Pick a feed source');
      return;
    }
    if (!_genTransition && !_genAttendance) {
      setState(() => _error = 'Pick at least one task type to generate');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      final feedId = feed['id'] as String;
      final location = _label.text.trim().isEmpty ? null : _label.text.trim();
      final duration = _isException ? int.tryParse(_duration.text.trim()) : null;
      if (_linked) {
        await api.updateMemberLink(
          familyId,
          feedId,
          widget.existingLink!['id'] as String,
          weekdayMask: _isException ? _weekdayMask : null,
          dayStart: _isException ? _dayStart.text.trim() : null,
          dayEnd: _isException ? _dayEnd.text.trim() : null,
          durationMinutes: duration,
          location: location,
          generatesTypes: _generatesTypes,
        );
      } else {
        await api.createMemberLink(
          familyId,
          feedId,
          familyMemberId: widget.child.id,
          weekdayMask: _isException ? _weekdayMask : null,
          dayStart: _isException ? _dayStart.text.trim() : null,
          dayEnd: _isException ? _dayEnd.text.trim() : null,
          durationMinutes: duration,
          location: location,
          generatesTypes: _generatesTypes,
          defaultAttendance: _genAttendance ? 'any' : null,
        );
      }
      _refresh(feedId);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _unlink() async {
    final feedId = _feed!['id'] as String;
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Unlink feed?'),
        content: Text('Stop generating ${widget.child.relationName}\'s tasks from '
            'this feed? The baseline is removed.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          PillButton(
            label: 'Unlink',
            variant: PillVariant.white,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref
          .read(apiClientProvider)
          .deleteMemberLink(familyId, feedId, widget.existingLink!['id'] as String);
      _refresh(feedId);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Unlink failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 40),
          children: [
            const SubPageHeader(title: 'Linked feed'),
            const SizedBox(height: 18),
            Text(
              'Connect a shared calendar source to ${widget.child.relationName}. The '
              'feed stays shared; this link says "these events are '
              '${widget.child.relationName}\'s."',
              style: AppText.subtitle,
            ),
            const SizedBox(height: 22),
            const SectionEyebrow('Feed source'),
            const SizedBox(height: 12),
            AppCard(
              padding: EdgeInsets.zero,
              child: _PickerRow(
                label: 'Source',
                value: _feed == null ? 'Choose a feed' : _feedName(_feed!),
                enabled: !_linked,
                onTap: _pickSource,
              ),
            ),
            const SizedBox(height: 24),
            const SectionEyebrow('Label for this child'),
            const SizedBox(height: 12),
            TextField(
              controller: _label,
              decoration: const InputDecoration(labelText: 'Label', hintText: 'e.g. School calendar'),
            ),
            const SizedBox(height: 24),
            const SectionEyebrow('Generates'),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                children: [
                  SwitchRow(
                    icon: Icons.login_rounded,
                    iconColor: AppColors.green,
                    title: 'Transition tasks',
                    subtitle: 'Drop-off & pickup points',
                    value: _genTransition,
                    onChanged: (v) => setState(() => _genTransition = v),
                  ),
                  const Divider(height: 20),
                  SwitchRow(
                    icon: Icons.groups_rounded,
                    iconColor: AppColors.purple,
                    title: 'Attendance tasks',
                    subtitle: 'Someone stays for the duration',
                    value: _genAttendance,
                    onChanged: (v) => setState(() => _genAttendance = v),
                  ),
                ],
              ),
            ),
            if (_isException && _genTransition) ...[
              const SizedBox(height: 24),
              const SectionEyebrow('Schedule'),
              const SizedBox(height: 8),
              Text('Exception feeds deviate from this weekly baseline.',
                  style: AppText.subtitle),
              const SizedBox(height: 12),
              AppCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('School days', style: AppText.eyebrow()),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (var i = 0; i < 7; i++)
                          _DayChip(
                            label: _weekdayLabels[i],
                            selected: _weekdays.contains(i),
                            onTap: () => setState(() =>
                                _weekdays.contains(i) ? _weekdays.remove(i) : _weekdays.add(i)),
                          ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        Expanded(child: _field(_dayStart, 'Drop-off', 'HH:MM')),
                        const SizedBox(width: 12),
                        Expanded(child: _field(_dayEnd, 'Pickup', 'HH:MM')),
                      ],
                    ),
                    const SizedBox(height: 14),
                    _field(_duration, 'Block length (min)', 'blank = 1h', number: true),
                  ],
                ),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
            ],
            const SizedBox(height: 28),
            _PrimaryButton(
              label: _linked ? 'Save linked feed' : 'Link feed',
              busy: _busy,
              onPressed: _busy ? null : _save,
            ),
            if (_linked) ...[
              const SizedBox(height: 12),
              _RemoveButton(label: 'Unlink feed', onTap: _unlink),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _pickSource() async {
    if (_linked) return;
    final feeds = ref.read(feedsProvider).valueOrNull ?? const <Map<String, dynamic>>[];
    // Offer feeds not already linked to this child.
    final unlinked = <Map<String, dynamic>>[];
    for (final f in feeds) {
      final links = ref.read(feedLinksProvider(f['id'] as String)).valueOrNull ?? const [];
      final linked = links.cast<Map<String, dynamic>>().any((l) => l['familyMemberId'] == widget.child.id);
      if (!linked) unlinked.add(f);
    }
    if (unlinked.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('No more feeds to link — add one in Input feeds')));
      return;
    }
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetCtx) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Feed source', style: AppText.subPageTitle),
            const SizedBox(height: 12),
            for (final f in unlinked)
              SettingRow(
                icon: (f['kind'] as String? ?? 'ics') == 'ics'
                    ? Icons.rss_feed_rounded
                    : Icons.calendar_month_rounded,
                iconColor: (f['kind'] as String? ?? 'ics') == 'ics'
                    ? AppColors.feedBlue
                    : AppColors.purple,
                title: _feedName(f),
                subtitle: (f['kind'] as String? ?? 'ics') == 'ics' ? 'ICS' : 'Google',
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  setState(() => _feed = f);
                },
              ),
          ],
        ),
      ),
    );
  }

  String _feedName(Map<String, dynamic> f) =>
      (f['sourceCalendarName'] as String?) ??
      (f['url'] as String?) ??
      (f['sourceCalendarId'] as String?) ??
      'Calendar feed';

  Widget _field(TextEditingController c, String label, String hint, {bool number = false}) {
    return TextField(
      controller: c,
      keyboardType: number ? TextInputType.number : TextInputType.text,
      decoration: InputDecoration(labelText: label, hintText: hint),
    );
  }
}

class _PickerRow extends StatelessWidget {
  const _PickerRow({
    required this.label,
    required this.value,
    required this.onTap,
    this.enabled = true,
  });
  final String label;
  final String value;
  final VoidCallback onTap;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: enabled ? onTap : null,
      borderRadius: BorderRadius.circular(20),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        child: Row(
          children: [
            Text(label, style: AppText.sectionItemTitle),
            const Spacer(),
            Flexible(
              child: Text(value,
                  textAlign: TextAlign.right,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppText.subtitle),
            ),
            if (enabled) ...[
              const SizedBox(width: 8),
              const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
            ],
          ],
        ),
      ),
    );
  }
}

class _DayChip extends StatelessWidget {
  const _DayChip({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 9),
        decoration: BoxDecoration(
          color: selected ? AppColors.indigo : AppColors.bg,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: selected ? AppColors.indigo : AppColors.border),
        ),
        child: Text(
          label,
          style: font(kBodyFont, 13, 600,
              color: selected ? const Color(0xFF17162B) : AppColors.textSecondary),
        ),
      ),
    );
  }
}

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({required this.label, required this.busy, required this.onPressed});
  final String label;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.amberHero,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(999),
        child: Container(
          height: 50,
          alignment: Alignment.center,
          child: busy
              ? const SizedBox(
                  height: 20,
                  width: 20,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Color(0xFF2A1E05)),
                )
              : Text(label, style: font(kBodyFont, 14.5, 700, color: const Color(0xFF2A1E05))),
        ),
      ),
    );
  }
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
          height: 50,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.coral.withValues(alpha: 0.5)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.link_off_rounded, color: AppColors.coral, size: 19),
              const SizedBox(width: 8),
              Text(label, style: font(kBodyFont, 14, 700, color: AppColors.coral)),
            ],
          ),
        ),
      ),
    );
  }
}
