import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

// Keep in step with DEFAULT_ABSENCE_SUBJECT / DEFAULT_ABSENCE_BODY in
// libs/domain — the server fills these in for a link that has never saved any.
const kDefaultAbsenceSubject = 'Absence notice for {child} on {date}';
const kDefaultAbsenceBody =
    'Hello,\n\n'
    'Please note that {child} will be {schedule} on {date} because of '
    '{reason}.\n\n'
    'Thank you,\n'
    '{parent}';

/// The placeholders a template may use, with what each becomes.
const kAbsencePlaceholders = <(String, String)>[
  ('{child}', 'the child’s name'),
  ('{date}', 'the school day'),
  (
    '{schedule}',
    'the whole plan in words, e.g. “leaving at 10:00 AM and returning at 11:30 AM”',
  ),
  ('{leaveTime}', 'when they leave'),
  ('{returnTime}', 'when they’re back'),
  (
    '{reason}',
    'the appointment’s title (only if turned on below), else “an appointment”',
  ),
  ('{parent}', 'your name'),
];

/// A template filled with example values — what the settings screen previews.
String previewAbsenceTemplate(
  String template, {
  required String child,
  required String parent,
  required bool includeReason,
}) {
  final values = <String, String>{
    'child': child,
    'parent': parent,
    'date': 'Tuesday, March 3',
    'leaveTime': '10:00 AM',
    'returnTime': '11:30 AM',
    'schedule': 'leaving at 10:00 AM and returning at 11:30 AM',
    'reason': includeReason ? 'Dentist appointment' : 'an appointment',
  };
  return template.replaceAllMapped(
    RegExp(r'\{(\w+)\}'),
    (m) => values[m[1]] ?? m[0]!,
  );
}

final _emailPattern = RegExp(r'^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$');

/// "Email school about absences" on a school calendar's setup screen. Admin
/// only (the server refuses everyone else); no recipient means the feature is
/// off for this child and calendar.
class AbsenceNoticeSettingsCard extends ConsumerWidget {
  const AbsenceNoticeSettingsCard({
    super.key,
    required this.feed,
    required this.link,
    required this.member,
  });

  final FeedItem feed;
  final FeedLink link;
  final Member member;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(currentMemberProvider).valueOrNull;
    if (me == null || !me.isAdmin) return const SizedBox.shrink();
    final key = (feedId: feed.id, linkId: link.id);
    final settings = ref.watch(absenceNoticeSettingsProvider(key));
    final subtitle = settings.when(
      data: (s) => s.enabled
          ? 'On · to ${[...s.to, ...s.cc].join(', ')}'
          : 'Off — add an address to turn it on',
      loading: () => 'Loading…',
      error: (_, __) => 'Couldn’t load',
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 24),
        const SectionEyebrow('Email school', color: AppColors.indigo),
        const SizedBox(height: 8),
        Text(
          'When ${member.relationName} leaves the school day for an '
          'appointment, you can email the school what time they leave and '
          'return. Your phone’s Mail app sends it — nothing is sent from here. '
          'Add an address to turn this on; with none, there’s no button and no '
          'reminder.',
          style: AppText.subtitle,
        ),
        const SizedBox(height: 12),
        AppCard(
          child: SettingRow(
            icon: Icons.mail_outline_rounded,
            iconColor: AppColors.indigo,
            title: 'Absence emails',
            subtitle: subtitle,
            trailing: const Icon(
              Icons.edit_rounded,
              size: 18,
              color: AppColors.textMuted,
            ),
            onTap: settings.hasValue
                ? () => showAbsenceNoticeSettingsSheet(
                    context,
                    feed: feed,
                    link: link,
                    member: member,
                    initial: settings.requireValue,
                  )
                : null,
          ),
        ),
      ],
    );
  }
}

Future<void> showAbsenceNoticeSettingsSheet(
  BuildContext context, {
  required FeedItem feed,
  required FeedLink link,
  required Member member,
  required AbsenceNoticeSettings initial,
}) {
  return showModalBottomSheet<void>(
    context: context,
    useSafeArea: true,
    useRootNavigator: true,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (_) => AbsenceNoticeSettingsSheet(
      feed: feed,
      link: link,
      member: member,
      initial: initial,
    ),
  );
}

class AbsenceNoticeSettingsSheet extends ConsumerStatefulWidget {
  const AbsenceNoticeSettingsSheet({
    super.key,
    required this.feed,
    required this.link,
    required this.member,
    required this.initial,
  });

  final FeedItem feed;
  final FeedLink link;
  final Member member;
  final AbsenceNoticeSettings initial;

  @override
  ConsumerState<AbsenceNoticeSettingsSheet> createState() =>
      _AbsenceNoticeSettingsSheetState();
}

class _AbsenceNoticeSettingsSheetState
    extends ConsumerState<AbsenceNoticeSettingsSheet> {
  late final List<String> _to = [...widget.initial.to];
  late final List<String> _cc = [...widget.initial.cc];
  late final _toField = TextEditingController();
  late final _ccField = TextEditingController();
  late final _subject = TextEditingController(
    text: widget.initial.subjectTemplate,
  );
  late final _body = TextEditingController(text: widget.initial.bodyTemplate);
  late bool _includeReason = widget.initial.includeReason;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _subject.addListener(() => setState(() {}));
    _body.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _toField.dispose();
    _ccField.dispose();
    _subject.dispose();
    _body.dispose();
    super.dispose();
  }

  /// Move whatever is typed in [field] into [list]. Returns false (and says
  /// why) when it isn't an address.
  bool _commit(TextEditingController field, List<String> list) {
    final raw = field.text.trim();
    if (raw.isEmpty) return true;
    final parts = raw.split(RegExp(r'[,;\s]+')).where((p) => p.isNotEmpty);
    for (final p in parts) {
      if (!_emailPattern.hasMatch(p)) {
        setState(() => _error = '“$p” doesn’t look like an email address.');
        return false;
      }
    }
    setState(() {
      for (final p in parts) {
        final a = p.toLowerCase();
        if (!list.contains(a)) list.add(a);
      }
      field.clear();
      _error = null;
    });
    return true;
  }

  Future<void> _save() async {
    if (!_commit(_toField, _to) || !_commit(_ccField, _cc)) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref
          .read(apiClientProvider)
          .saveAbsenceNoticeSettings(
            familyId,
            widget.feed.id,
            widget.link.id,
            to: _to,
            cc: _cc,
            subjectTemplate: _subject.text,
            bodyTemplate: _body.text,
            includeReason: _includeReason,
          );
      ref.invalidate(
        absenceNoticeSettingsProvider((
          feedId: widget.feed.id,
          linkId: widget.link.id,
        )),
      );
      ref.invalidate(absenceNoticesProvider);
      ref.invalidate(absenceNoticeProvider);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _error = 'Couldn’t save: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _addresses(
    String label,
    List<String> list,
    TextEditingController field,
    Key fieldKey,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: AppText.eyebrow()),
        const SizedBox(height: 8),
        if (list.isNotEmpty)
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              for (final a in list)
                InputChip(
                  label: Text(a),
                  onDeleted: () => setState(() => list.remove(a)),
                ),
            ],
          ),
        Row(
          children: [
            Expanded(
              child: TextField(
                key: fieldKey,
                controller: field,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                decoration: const InputDecoration(hintText: 'name@school.org'),
                onSubmitted: (_) => _commit(field, list),
              ),
            ),
            IconButton(
              tooltip: 'Add address',
              onPressed: () => _commit(field, list),
              icon: const Icon(Icons.add_circle_outline_rounded),
            ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final child = widget.member.relationName;
    final parent = me?.relationName ?? 'Parent';
    final enabled = _to.isNotEmpty || _cc.isNotEmpty;
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          22,
          4,
          22,
          28 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Email school', style: AppText.subPageTitle),
            const SizedBox(height: 4),
            Text(
              enabled
                  ? 'On for $child. The email opens in your Mail app, prefilled.'
                  : 'Off for $child. Add an address to turn it on — then an '
                        '“Email school” button and a reminder appear when an '
                        'appointment takes them out of the school day.',
              key: const Key('absence-enabled-note'),
              style: AppText.subtitle,
            ),
            const SizedBox(height: 18),
            _addresses('TO', _to, _toField, const Key('absence-to-field')),
            const SizedBox(height: 14),
            _addresses('CC', _cc, _ccField, const Key('absence-cc-field')),
            const SizedBox(height: 18),
            AppCard(
              child: SwitchRow(
                icon: Icons.sticky_note_2_outlined,
                iconColor: AppColors.indigo,
                title: 'Say what it’s for',
                subtitle:
                    'Use the appointment’s title as the reason. Off, the '
                    'email just says “an appointment”.',
                value: _includeReason,
                onChanged: (v) => setState(() => _includeReason = v),
              ),
            ),
            const SizedBox(height: 18),
            Text('SUBJECT', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            TextField(
              key: const Key('absence-subject-field'),
              controller: _subject,
            ),
            const SizedBox(height: 14),
            Text('MESSAGE', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            TextField(
              key: const Key('absence-body-field'),
              controller: _body,
              minLines: 5,
              maxLines: 10,
            ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  onPressed: () => setState(() {
                    _subject.text = kDefaultAbsenceSubject;
                    _body.text = kDefaultAbsenceBody;
                  }),
                  child: const Text('Reset wording'),
                ),
              ],
            ),
            Text(
              [
                for (final (token, meaning) in kAbsencePlaceholders)
                  '$token  $meaning',
              ].join('\n'),
              style: AppText.micro(),
            ),
            const SizedBox(height: 18),
            Text('PREVIEW', style: AppText.eyebrow()),
            const SizedBox(height: 8),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    previewAbsenceTemplate(
                      _subject.text,
                      child: child,
                      parent: parent,
                      includeReason: _includeReason,
                    ),
                    key: const Key('absence-preview-subject'),
                    style: AppText.listItemTitle,
                  ),
                  const Divider(height: 20),
                  Text(
                    previewAbsenceTemplate(
                      _body.text,
                      child: child,
                      parent: parent,
                      includeReason: _includeReason,
                    ),
                    key: const Key('absence-preview-body'),
                    style: AppText.subtitle,
                  ),
                ],
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                style: const TextStyle(color: AppColors.coral, fontSize: 13),
              ),
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
      ),
    );
  }
}
