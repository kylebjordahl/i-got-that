import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

/// Add / edit a caretaker's delivery method — where their claimed tasks land.
/// Backed by the family's calendar-targets; the underlying account is connected
/// on Me. The account + target calendar are immutable once created (recreate to
/// change), so edit mode only tweaks the label, reminder, and active state.
class DeliveryMethodScreen extends ConsumerStatefulWidget {
  const DeliveryMethodScreen({super.key, required this.caretaker, this.existing});

  final Member caretaker;
  final Map<String, dynamic>? existing;

  @override
  ConsumerState<DeliveryMethodScreen> createState() => _DeliveryMethodScreenState();
}

class _DeliveryMethodScreenState extends ConsumerState<DeliveryMethodScreen> {
  // Create-mode selections.
  String? _accountId; // null ⇒ email invite
  String _deliverAs = 'calendar'; // calendar | reminders | tasks (cosmetic)
  List<Map<String, dynamic>> _calendars = const [];
  String? _calId;
  String? _calName;
  bool _loadingCals = false;
  final _email = TextEditingController();
  final _label = TextEditingController();

  int? _reminder = 30; // minutes; null ⇒ none
  bool _active = true;
  bool _includeChildType = true;
  bool _alarmOnTransitions = true;

  bool _busy = false;
  String? _error;

  bool get _editing => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final ex = widget.existing;
    if (ex != null) {
      _label.text = ex['name'] as String? ?? '';
      _active = ex['active'] as bool? ?? true;
      final alerts = (ex['alertMinutes'] as List?)?.cast<num>() ?? const [];
      _reminder = alerts.isEmpty ? null : alerts.first.toInt();
    }
  }

  @override
  void dispose() {
    _email.dispose();
    _label.dispose();
    super.dispose();
  }

  Future<void> _loadCalendars(String accountId) async {
    setState(() {
      _loadingCals = true;
      _error = null;
      _calendars = const [];
      _calId = null;
      _calName = null;
    });
    try {
      final cals = await ref.read(apiClientProvider).listAccountCalendars(accountId);
      setState(() => _calendars = cals.cast<Map<String, dynamic>>());
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _loadingCals = false);
    }
  }

  List<int> get _alertMinutes => _reminder == null ? const [] : [_reminder!];

  Future<void> _save(List<ExternalAccount> accounts) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      if (_editing) {
        await api.updateCalendarTarget(
          familyId,
          widget.existing!['id'] as String,
          name: _label.text.trim().isEmpty ? null : _label.text.trim(),
          active: _active,
          alertMinutes: _alertMinutes,
        );
        if (mounted) Navigator.of(context).pop(true);
        return;
      }

      final name = _label.text.trim();
      if (_accountId == null) {
        if (!_email.text.trim().contains('@')) {
          setState(() => _error = 'Enter a delivery email');
          return;
        }
        await api.createCalendarTarget(
          familyId,
          memberId: widget.caretaker.id,
          name: name.isEmpty ? 'Email' : name,
          method: 'email',
          addressOrUrl: _email.text.trim(),
          alertMinutes: _alertMinutes,
        );
      } else {
        if (_calId == null) {
          setState(() => _error = 'Pick a target calendar');
          return;
        }
        final account = accounts.firstWhere((a) => a.id == _accountId);
        await api.createCalendarTarget(
          familyId,
          memberId: widget.caretaker.id,
          name: name.isEmpty ? (_calName ?? account.kindLabel) : name,
          method: account.method,
          externalAccountId: account.id,
          addressOrUrl: _calId!,
          externalCalendarId: account.method == 'google' ? _calId : null,
          alertMinutes: _alertMinutes,
        );
      }
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
        title: const Text('Remove delivery method?'),
        content: Text('${widget.caretaker.relationName}\'s claimed tasks will no '
            'longer be delivered here.'),
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
      await ref.read(apiClientProvider).deleteCalendarTarget(familyId, widget.existing!['id'] as String);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Remove failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final accounts = ref.watch(accountsProvider).valueOrNull ?? const <ExternalAccount>[];
    final account = _accountId == null ? null : accounts.where((a) => a.id == _accountId).firstOrNull;
    final accountValue = _editing
        ? _existingAccountLabel()
        : (account == null ? 'Email invite' : '${account.kindLabel} · ${account.username ?? account.name}');
    final targetValue = _editing
        ? (widget.existing!['addressOrUrl'] as String? ?? '—')
        : (_accountId == null ? (_email.text.trim().isEmpty ? 'Set an email' : _email.text.trim()) : (_calName ?? 'Choose a calendar'));

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 40),
          children: [
            const SubPageHeader(title: 'Delivery method'),
            const SizedBox(height: 18),
            Text(
              "Where ${widget.caretaker.relationName}'s claimed tasks are delivered. "
              'Uses an account connected on Me.',
              style: AppText.subtitle,
            ),
            const SizedBox(height: 22),
            const SectionEyebrow('Account'),
            const SizedBox(height: 12),
            AppCard(
              padding: EdgeInsets.zero,
              child: _PickerRow(
                label: 'Account',
                value: accountValue,
                enabled: !_editing,
                onTap: () => _pickAccount(accounts),
              ),
            ),
            const SizedBox(height: 24),
            const SectionEyebrow('Deliver as'),
            const SizedBox(height: 12),
            _Segmented(
              options: const [('calendar', 'Calendar'), ('reminders', 'Reminders'), ('tasks', 'Tasks')],
              value: _deliverAs,
              onChanged: _editing ? null : (v) => setState(() => _deliverAs = v),
            ),
            const SizedBox(height: 24),
            SectionEyebrow(_accountId == null && !_editing ? 'Delivery email' : 'Target calendar'),
            const SizedBox(height: 12),
            if (!_editing && _accountId == null)
              TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(labelText: 'Email', hintText: 'you@example.com'),
              )
            else if (_loadingCals)
              const Padding(padding: EdgeInsets.all(8), child: LinearProgressIndicator())
            else
              AppCard(
                padding: EdgeInsets.zero,
                child: _PickerRow(
                  label: targetValue,
                  value: '',
                  enabled: !_editing && _accountId != null,
                  onTap: () => _pickCalendar(),
                ),
              ),
            const SizedBox(height: 24),
            const SectionEyebrow('Reminder lead time'),
            const SizedBox(height: 12),
            AppCard(
              padding: EdgeInsets.zero,
              child: _PickerRow(
                label: 'Remind',
                value: _reminder == null ? 'None' : '$_reminder minutes',
                onTap: _pickReminder,
              ),
            ),
            const SizedBox(height: 20),
            AppCard(
              child: Column(
                children: [
                  SwitchRow(
                    icon: Icons.badge_outlined,
                    iconColor: AppColors.indigo,
                    title: 'Include child & type',
                    subtitle: 'Prefix events with e.g. "Theo · Drop-off"',
                    value: _includeChildType,
                    onChanged: (v) => setState(() => _includeChildType = v),
                  ),
                  const Divider(height: 20),
                  SwitchRow(
                    icon: Icons.alarm_rounded,
                    iconColor: AppColors.amber,
                    title: 'Alarm on transitions',
                    subtitle: 'Buzz for drop-offs & pickups',
                    value: _alarmOnTransitions,
                    onChanged: (v) => setState(() => _alarmOnTransitions = v),
                  ),
                  if (_editing) ...[
                    const Divider(height: 20),
                    SwitchRow(
                      icon: Icons.power_settings_new_rounded,
                      iconColor: AppColors.green,
                      title: 'Active',
                      subtitle: 'Deliver tasks to this method',
                      value: _active,
                      onChanged: (v) => setState(() => _active = v),
                    ),
                  ],
                ],
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(_error!, style: font(kBodyFont, 13, 500, color: AppColors.coral)),
            ],
            const SizedBox(height: 28),
            _PrimaryButton(
              label: _editing ? 'Save delivery method' : 'Add delivery method',
              busy: _busy,
              onPressed: _busy ? null : () => _save(accounts),
            ),
            if (_editing) ...[
              const SizedBox(height: 12),
              _RemoveButton(label: 'Remove this method', onTap: _remove),
            ],
          ],
        ),
      ),
    );
  }

  String _existingAccountLabel() {
    final ex = widget.existing!;
    final method = ex['method'] as String? ?? 'caldav';
    final hint = ex['providerHint'];
    final label = hint == 'icloud'
        ? 'iCloud'
        : (method == 'google' ? 'Google' : (method == 'email' ? 'Email' : 'CalDAV'));
    return label;
  }

  Future<void> _pickAccount(List<ExternalAccount> accounts) async {
    if (_editing) return;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetCtx) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Account', style: AppText.subPageTitle),
            const SizedBox(height: 12),
            for (final a in accounts)
              SettingRow(
                icon: Icons.event_rounded,
                iconColor: AppColors.blue,
                title: a.kindLabel,
                subtitle: a.username ?? a.name,
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  setState(() {
                    _accountId = a.id;
                    _calName = null;
                    _calId = null;
                  });
                  _loadCalendars(a.id);
                },
              ),
            SettingRow(
              icon: Icons.mail_outline_rounded,
              iconColor: AppColors.coral,
              title: 'Email invite',
              subtitle: 'Send iCal invites to an address',
              onTap: () {
                Navigator.of(sheetCtx).pop();
                setState(() => _accountId = null);
              },
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _pickCalendar() async {
    if (_editing || _accountId == null || _calendars.isEmpty) return;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetCtx) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Target calendar', style: AppText.subPageTitle),
            const SizedBox(height: 12),
            for (final c in _calendars)
              SettingRow(
                icon: Icons.calendar_month_rounded,
                iconColor: AppColors.purple,
                title: c['name'] as String? ?? 'Calendar',
                onTap: () {
                  Navigator.of(sheetCtx).pop();
                  setState(() {
                    _calId = c['id'] as String;
                    _calName = c['name'] as String?;
                  });
                },
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _pickReminder() async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetCtx) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(22, 4, 22, 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Reminder lead time', style: AppText.subPageTitle),
            const SizedBox(height: 12),
            for (final m in const [null, 5, 10, 15, 30, 60])
              SettingRow(
                icon: Icons.notifications_none_rounded,
                iconColor: AppColors.blue,
                title: m == null ? 'None' : '$m minutes before',
                trailing: _reminder == m
                    ? const Icon(Icons.check_rounded, color: AppColors.indigo)
                    : null,
                onTap: () {
                  setState(() => _reminder = m);
                  Navigator.of(sheetCtx).pop();
                },
              ),
          ],
        ),
      ),
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
            Expanded(child: Text(label, style: AppText.sectionItemTitle)),
            if (value.isNotEmpty)
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

class _Segmented extends StatelessWidget {
  const _Segmented({required this.options, required this.value, required this.onChanged});
  final List<(String, String)> options;
  final String value;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: AppColors.card,
        borderRadius: BorderRadius.circular(15),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          for (final (id, label) in options)
            Expanded(
              child: GestureDetector(
                onTap: onChanged == null ? null : () => onChanged!(id),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 11),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: id == value ? AppColors.indigo : Colors.transparent,
                    borderRadius: BorderRadius.circular(11),
                  ),
                  child: Text(label,
                      style: font(kBodyFont, 13.5, 600,
                          color: id == value ? const Color(0xFF17162B) : AppColors.textSecondary)),
                ),
              ),
            ),
        ],
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
