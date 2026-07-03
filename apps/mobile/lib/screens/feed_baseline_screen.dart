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

const _weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/// Full-screen baseline configuration for a single feed↔child link. This is the
/// one place that manages the baseline — reached by linking a feed to a child or
/// tapping an existing linked feed from the child's detail screen.
///
/// For **exception** feeds the baseline (school days, drop-off/pickup times,
/// block length, generated task types) drives task generation. For **explicit**
/// feeds no baseline is needed — the screen just links/unlinks.
class FeedBaselineScreen extends ConsumerStatefulWidget {
  const FeedBaselineScreen({
    super.key,
    required this.child,
    required this.feed,
    this.existingLink,
  });

  final Member child;
  final Map<String, dynamic> feed;

  /// The current member-link (with baseline), or null to create a new link.
  final Map<String, dynamic>? existingLink;

  @override
  ConsumerState<FeedBaselineScreen> createState() => _FeedBaselineScreenState();
}

class _FeedBaselineScreenState extends ConsumerState<FeedBaselineScreen> {
  final Set<int> _weekdays = {0, 1, 2, 3, 4};
  final Set<String> _types = {'dropoff', 'pickup'};
  final _dayStart = TextEditingController(text: '08:00');
  final _dayEnd = TextEditingController(text: '15:00');
  final _duration = TextEditingController();
  final _location = TextEditingController();
  bool _busy = false;
  String? _error;

  String get _feedId => widget.feed['id'] as String;
  bool get _isException => widget.feed['mode'] == 'exception';
  bool get _linked => widget.existingLink != null;

  @override
  void initState() {
    super.initState();
    final ex = widget.existingLink;
    if (ex != null) {
      final mask = ex['weekdayMask'] as int? ?? 31;
      _weekdays
        ..clear()
        ..addAll([for (var i = 0; i < 7; i++) if ((mask & (1 << i)) != 0) i]);
      final types = (ex['generatesTypes'] as List?)?.cast<String>();
      if (types != null && types.isNotEmpty) {
        _types
          ..clear()
          ..addAll(types);
      }
      _dayStart.text = ex['dayStart'] as String? ?? '08:00';
      _dayEnd.text = ex['dayEnd'] as String? ?? '15:00';
      final dur = ex['durationMinutes'] as int?;
      _duration.text = dur != null ? '$dur' : '';
      _location.text = ex['location'] as String? ?? '';
    }
  }

  @override
  void dispose() {
    _dayStart.dispose();
    _dayEnd.dispose();
    _duration.dispose();
    _location.dispose();
    super.dispose();
  }

  int get _weekdayMask => _weekdays.fold(0, (m, b) => m | (1 << b));

  void _refreshTasks() {
    ref.invalidate(feedLinksProvider(_feedId));
    ref.invalidate(unownedTasksProvider);
    ref.invalidate(allTasksProvider);
  }

  Future<void> _save() async {
    if (_isException && _weekdays.isEmpty) {
      setState(() => _error = 'Pick at least one school day');
      return;
    }
    if (_isException && _types.isEmpty) {
      setState(() => _error = 'Pick at least one task to generate');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      final duration = _isException ? int.tryParse(_duration.text.trim()) : null;
      final location = _isException ? _location.text.trim() : null;
      if (_linked) {
        await api.updateMemberLink(
          familyId,
          _feedId,
          widget.existingLink!['id'] as String,
          weekdayMask: _isException ? _weekdayMask : null,
          dayStart: _isException ? _dayStart.text.trim() : null,
          dayEnd: _isException ? _dayEnd.text.trim() : null,
          durationMinutes: duration,
          location: location,
          generatesTypes: _isException ? _types.toList() : null,
        );
      } else {
        await api.createMemberLink(
          familyId,
          _feedId,
          familyMemberId: widget.child.id,
          weekdayMask: _isException ? _weekdayMask : null,
          dayStart: _isException ? _dayStart.text.trim() : null,
          dayEnd: _isException ? _dayEnd.text.trim() : null,
          durationMinutes: duration,
          location: location,
          generatesTypes: _isException ? _types.toList() : null,
          defaultAttendance: _isException ? 'any' : null,
        );
      }
      _refreshTasks();
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _remove() async {
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
          .deleteMemberLink(familyId, _feedId, widget.existingLink!['id'] as String);
      _refreshTasks();
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Unlink failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final feedName = (widget.feed['sourceCalendarName'] as String?) ??
        (widget.feed['url'] as String?) ??
        (widget.feed['sourceCalendarId'] as String?) ??
        'Calendar feed';
    final childColor = personColor(widget.child);

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 40),
          children: [
            SubPageHeader(title: _linked ? 'Feed baseline' : 'Link feed'),
            const SizedBox(height: 20),
            AppCard(
              gradient: AppColors.profileGradient,
              child: Row(
                children: [
                  IconTile(
                    icon: (widget.feed['kind'] as String? ?? 'ics') == 'ics'
                        ? Icons.rss_feed_rounded
                        : Icons.calendar_month_rounded,
                    color: (widget.feed['kind'] as String? ?? 'ics') == 'ics'
                        ? AppColors.feedBlue
                        : AppColors.purple,
                    size: 46,
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(feedName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppText.profileName),
                        const SizedBox(height: 2),
                        Row(
                          children: [
                            Text('for ', style: AppText.subtitle),
                            PersonAvatar(
                                initial: initialFor(widget.child.relationName),
                                color: childColor,
                                size: 18),
                            const SizedBox(width: 5),
                            Text(widget.child.relationName,
                                style: font(kBodyFont, 13, 600, color: childColor)),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            if (_isException) ..._baselineForm() else _explicitNote(),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
            ],
            const SizedBox(height: 28),
            _PrimaryButton(
              label: _linked ? 'Save baseline' : 'Link feed',
              busy: _busy,
              onPressed: _busy ? null : _save,
            ),
            if (_linked) ...[
              const SizedBox(height: 12),
              _RemoveButton(label: 'Unlink feed', onTap: _remove),
            ],
          ],
        ),
      ),
    );
  }

  Widget _explicitNote() {
    return AppCard(
      child: Row(
        children: [
          const IconTile(icon: Icons.bolt_rounded, color: AppColors.amber),
          const SizedBox(width: 14),
          Expanded(
            child: Text(
              'This is an explicit feed — its events become tasks directly, so no '
              'baseline is needed. Linking just attaches this feed to '
              '${widget.child.relationName}.',
              style: AppText.subtitle,
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _baselineForm() {
    return [
      const SectionEyebrow('School days'),
      const SizedBox(height: 12),
      AppCard(
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (var i = 0; i < 7; i++)
              _SelectChip(
                label: _weekdayLabels[i],
                selected: _weekdays.contains(i),
                onTap: () => setState(
                    () => _weekdays.contains(i) ? _weekdays.remove(i) : _weekdays.add(i)),
              ),
          ],
        ),
      ),
      const SizedBox(height: 24),
      const SectionEyebrow('Times'),
      const SizedBox(height: 12),
      AppCard(
        child: Column(
          children: [
            Row(
              children: [
                Expanded(child: _field(_dayStart, 'Drop-off', 'HH:MM')),
                const SizedBox(width: 12),
                Expanded(child: _field(_dayEnd, 'Pickup', 'HH:MM')),
              ],
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                    child: _field(_duration, 'Block length (min)', 'blank = 1h',
                        number: true)),
                const SizedBox(width: 12),
                Expanded(flex: 2, child: _field(_location, 'Location', 'e.g. school')),
              ],
            ),
          ],
        ),
      ),
      const SizedBox(height: 24),
      const SectionEyebrow('Generates'),
      const SizedBox(height: 12),
      AppCard(
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final t in const ['dropoff', 'pickup'])
              _SelectChip(
                label: t == 'dropoff' ? 'Drop-off' : 'Pickup',
                selected: _types.contains(t),
                onTap: () =>
                    setState(() => _types.contains(t) ? _types.remove(t) : _types.add(t)),
              ),
          ],
        ),
      ),
    ];
  }

  Widget _field(TextEditingController c, String label, String hint, {bool number = false}) {
    return TextField(
      controller: c,
      keyboardType: number ? TextInputType.number : TextInputType.text,
      decoration: InputDecoration(labelText: label, hintText: hint),
    );
  }
}

class _SelectChip extends StatelessWidget {
  const _SelectChip({required this.label, required this.selected, required this.onTap});
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
