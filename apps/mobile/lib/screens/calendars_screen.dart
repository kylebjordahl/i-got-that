import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/auth.dart';
import '../state/family.dart';

/// Calendar connections (delivery destinations): guided per-provider connect
/// flow (incl. CalDAV calendar discovery), editable in place, deletable.
class CalendarsScreen extends ConsumerWidget {
  const CalendarsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final targetsAsync = ref.watch(targetsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Calendars')),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'fab-calendars',
        onPressed: () async {
          final added = await Navigator.of(context).push<bool>(
            MaterialPageRoute(builder: (_) => const ConnectCalendarPage()),
          );
          if (added == true) ref.invalidate(targetsProvider);
        },
        icon: const Icon(Icons.add_link),
        label: const Text('Connect'),
      ),
      body: targetsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (targets) => targets.isEmpty
            ? const Center(child: Text('No calendars connected yet'))
            : ListView(
                children: [
                  for (final t in targets)
                    ListTile(
                      leading: CircleAvatar(child: Icon(_iconFor(t['method'] as String))),
                      title: Text(t['name'] as String),
                      subtitle: Text(
                        '${_methodLabel(t)} · ${t['memberRelation']} · ${t['addressOrUrl']}'
                        '${_alertsLabel(t)}'
                        '${(t['active'] as bool? ?? true) ? '' : ' · paused'}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: PopupMenuButton<String>(
                        onSelected: (v) => _onAction(context, ref, v, t),
                        itemBuilder: (_) => const [
                          PopupMenuItem(value: 'edit', child: Text('Edit')),
                          PopupMenuItem(value: 'delete', child: Text('Delete')),
                        ],
                      ),
                    ),
                ],
              ),
      ),
    );
  }

  Future<void> _onAction(
    BuildContext context,
    WidgetRef ref,
    String action,
    Map<String, dynamic> target,
  ) async {
    if (action == 'edit') {
      final changed = await Navigator.of(context).push<bool>(
        MaterialPageRoute(builder: (_) => ConnectCalendarPage(existing: target)),
      );
      if (changed == true) ref.invalidate(targetsProvider);
    } else if (action == 'delete') {
      final confirm = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
          title: const Text('Delete connection?'),
          content: Text('Remove "${target['name']}"? This cannot be undone.'),
          actions: [
            TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
          ],
        ),
      );
      if (confirm == true) {
        final familyId = await ref.read(familyProvider.future);
        await ref.read(apiClientProvider).deleteCalendarTarget(familyId, target['id'] as String);
        ref.invalidate(targetsProvider);
      }
    }
  }

  String _alertsLabel(Map<String, dynamic> t) {
    final alerts = (t['alertMinutes'] as List?)?.cast<num>() ?? const [];
    if (alerts.isEmpty) return '';
    return ' · ⏰ ${alerts.map((m) => '${m.toInt()}m').join(', ')}';
  }

  IconData _iconFor(String method) => switch (method) {
        'email' => Icons.mail_outline,
        'google' => Icons.calendar_month,
        _ => Icons.cloud_outlined,
      };

  String _methodLabel(Map<String, dynamic> t) {
    final hint = t['providerHint'];
    if (hint == 'icloud') return 'iCloud';
    if (hint == 'google' || t['method'] == 'google') return 'Google';
    if (hint == 'generic_caldav') return 'CalDAV';
    return t['method'] as String;
  }
}

enum _Provider { email, icloud, genericCaldav, google }

_Provider _providerOf(Map<String, dynamic> target) {
  final method = target['method'];
  if (method == 'email') return _Provider.email;
  if (method == 'google') return _Provider.google;
  return target['providerHint'] == 'icloud' ? _Provider.icloud : _Provider.genericCaldav;
}

/// Connect a new calendar (a 3-step wizard: type → credentials → configure) or
/// edit an existing one (`existing` set → configuration options only).
class ConnectCalendarPage extends ConsumerStatefulWidget {
  const ConnectCalendarPage({super.key, this.existing});

  final Map<String, dynamic>? existing;

  @override
  ConsumerState<ConnectCalendarPage> createState() => _ConnectCalendarPageState();
}

class _ConnectCalendarPageState extends ConsumerState<ConnectCalendarPage> {
  _Provider _provider = _Provider.email;
  String? _memberId;
  bool _active = true;
  int _step = 0; // wizard step (new connection only)
  final _name = TextEditingController();
  final _address = TextEditingController(); // email, or CalDAV server URL
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _calendarId = TextEditingController(text: 'primary');
  final _accessToken = TextEditingController();
  // Google OAuth: redirect URI (must match the Google client) + the auth code.
  final _redirectUri = TextEditingController();
  final _authCode = TextEditingController();
  String? _googleAuthUrl;
  // Up to two default reminders, in minutes before the event start.
  final _alert1 = TextEditingController();
  final _alert2 = TextEditingController();

  // CalDAV discovery.
  List<Map<String, dynamic>> _discovered = const [];
  String? _selectedCalendarUrl;
  bool _discovering = false;
  // On edit, reveal the credential + re-fetch fields to switch the calendar.
  bool _changingCalendar = false;

  bool _busy = false;
  String? _error;

  bool get _editing => widget.existing != null;
  bool get _isCalDav =>
      _provider == _Provider.icloud || _provider == _Provider.genericCaldav;

  @override
  void initState() {
    super.initState();
    final ex = widget.existing;
    if (ex != null) {
      _provider = _providerOf(ex);
      _memberId = ex['memberId'] as String?;
      _name.text = ex['name'] as String? ?? '';
      _active = ex['active'] as bool? ?? true;
      final alerts = (ex['alertMinutes'] as List?)?.cast<num>() ?? const [];
      if (alerts.isNotEmpty) _alert1.text = '${alerts[0].toInt()}';
      if (alerts.length > 1) _alert2.text = '${alerts[1].toInt()}';
      switch (_provider) {
        case _Provider.email:
          _address.text = ex['addressOrUrl'] as String? ?? '';
        case _Provider.icloud:
        case _Provider.genericCaldav:
          _selectedCalendarUrl = ex['addressOrUrl'] as String?;
          _address.text = _serverRoot(_selectedCalendarUrl) ??
              (_provider == _Provider.icloud ? 'https://caldav.icloud.com' : '');
        case _Provider.google:
          _calendarId.text =
              (ex['externalCalendarId'] ?? ex['addressOrUrl'] ?? 'primary') as String;
      }
    } else if (_provider == _Provider.icloud) {
      _address.text = 'https://caldav.icloud.com';
    }
  }

  static String? _serverRoot(String? url) {
    if (url == null) return null;
    try {
      return Uri.parse(url).origin;
    } catch (_) {
      return null;
    }
  }

  @override
  void dispose() {
    for (final c in [
      _name,
      _address,
      _username,
      _password,
      _calendarId,
      _accessToken,
      _redirectUri,
      _authCode,
      _alert1,
      _alert2,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  void _onProviderChanged(_Provider p) {
    setState(() {
      _provider = p;
      _discovered = const [];
      _selectedCalendarUrl = null;
      if (p == _Provider.icloud) {
        _address.text = 'https://caldav.icloud.com';
      } else if (p == _Provider.genericCaldav && _address.text == 'https://caldav.icloud.com') {
        _address.clear();
      }
    });
  }

  Future<void> _fetchCalendars() async {
    setState(() {
      _discovering = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final cals = await ref.read(apiClientProvider).discoverCalDavCalendars(
            familyId,
            serverUrl: _address.text.trim(),
            username: _username.text.trim(),
            password: _password.text,
          );
      setState(() {
        _discovered = cals.cast<Map<String, dynamic>>();
        _selectedCalendarUrl =
            _discovered.isNotEmpty ? _discovered.first['url'] as String : _selectedCalendarUrl;
        if (_discovered.isEmpty) _error = 'No calendars found for those credentials';
      });
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _discovering = false);
    }
  }

  /// Validate the active wizard step; returns an error message or null.
  String? _validateStep(int step) {
    if (step == 0) return _memberId == null ? 'Pick a caretaker' : null;
    if (step == 1) {
      switch (_provider) {
        case _Provider.email:
          return _address.text.trim().contains('@') ? null : 'Enter a delivery email';
        case _Provider.icloud:
        case _Provider.genericCaldav:
          if (_address.text.trim().isEmpty ||
              _username.text.trim().isEmpty ||
              _password.text.isEmpty) {
            return 'Enter the server URL, username, and password';
          }
          return _discovered.isEmpty ? 'Tap "Fetch calendars" to continue' : null;
        case _Provider.google:
          final hasCode = _authCode.text.trim().isNotEmpty && _redirectUri.text.trim().isNotEmpty;
          return hasCode || _accessToken.text.trim().isNotEmpty
              ? null
              : 'Authorize with Google (or paste an access token)';
      }
    }
    return null; // step 2 validated in _save
  }

  Future<void> _getGoogleAuthUrl() async {
    if (_redirectUri.text.trim().isEmpty) {
      return setState(() => _error = 'Enter your OAuth redirect URI first');
    }
    setState(() => _error = null);
    try {
      final familyId = await ref.read(familyProvider.future);
      final url = await ref
          .read(apiClientProvider)
          .googleAuthorizeUrl(familyId, _redirectUri.text.trim());
      setState(() => _googleAuthUrl = url);
    } catch (e) {
      setState(() => _error = '$e');
    }
  }

  void _onContinue() {
    final err = _validateStep(_step);
    if (err != null) {
      setState(() => _error = err);
      return;
    }
    setState(() => _error = null);
    if (_step < 2) {
      setState(() => _step++);
    } else {
      _save();
    }
  }

  Future<void> _save() async {
    if (_memberId == null) return setState(() => _error = 'Pick a caretaker');
    if (_name.text.trim().isEmpty) return setState(() => _error = 'Give the connection a name');
    if (_isCalDav && _selectedCalendarUrl == null) {
      return setState(() => _error = 'Fetch and pick a calendar first');
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);
      final hasPassword = _password.text.isNotEmpty;
      final hasToken = _accessToken.text.trim().isNotEmpty;
      final alertMinutes = <int>[
        for (final c in [_alert1, _alert2])
          if (int.tryParse(c.text.trim()) != null) int.parse(c.text.trim()),
      ];

      String? providerHint;
      String addressOrUrl;
      String? externalCalendarId;
      Map<String, String>? credential;

      switch (_provider) {
        case _Provider.email:
          addressOrUrl = _address.text.trim();
        case _Provider.icloud:
        case _Provider.genericCaldav:
          providerHint = _provider == _Provider.icloud ? 'icloud' : 'generic_caldav';
          addressOrUrl = _selectedCalendarUrl!;
          if (!_editing || hasPassword) {
            credential = {'username': _username.text.trim(), 'password': _password.text};
          }
        case _Provider.google:
          providerHint = 'google';
          externalCalendarId = _calendarId.text.trim();
          addressOrUrl = _calendarId.text.trim();
          final code = _authCode.text.trim();
          final redirect = _redirectUri.text.trim();
          if (code.isNotEmpty && redirect.isNotEmpty) {
            credential = {'authCode': code, 'redirectUri': redirect};
          } else if (hasToken) {
            credential = {'accessToken': _accessToken.text.trim()};
          }
      }

      if (_editing) {
        await api.updateCalendarTarget(
          familyId,
          widget.existing!['id'] as String,
          name: _name.text.trim(),
          active: _active,
          addressOrUrl: addressOrUrl,
          externalCalendarId: externalCalendarId,
          alertMinutes: alertMinutes,
          credential: credential,
        );
      } else {
        await api.createCalendarTarget(
          familyId,
          memberId: _memberId!,
          name: _name.text.trim(),
          method: _provider == _Provider.email
              ? 'email'
              : _provider == _Provider.google
                  ? 'google'
                  : 'caldav',
          providerHint: providerHint,
          addressOrUrl: addressOrUrl,
          externalCalendarId: externalCalendarId,
          alertMinutes: alertMinutes,
          credential: credential,
        );
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final caretakers = ref.watch(caretakersProvider);
    return Scaffold(
      appBar: AppBar(title: Text(_editing ? 'Edit connection' : 'Connect a calendar')),
      body: caretakers.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (people) {
          if (people.isEmpty) {
            return const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text('Add a caretaker on the Family tab first.'),
              ),
            );
          }
          return _editing ? _editConfigBody() : _wizardBody(people);
        },
      ),
    );
  }

  // --- New connection: 3-step wizard ------------------------------------

  Widget _wizardBody(List<dynamic> people) {
    return Stepper(
      currentStep: _step,
      onStepContinue: _busy ? null : _onContinue,
      onStepCancel: _busy
          ? null
          : () => _step == 0 ? Navigator.of(context).pop(false) : setState(() => _step--),
      onStepTapped: (i) => i < _step ? setState(() => _step = i) : null,
      controlsBuilder: (context, details) => Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Row(
          children: [
            FilledButton(
              onPressed: details.onStepContinue,
              child: _busy && _step == 2
                  ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text(_step == 2 ? 'Connect' : 'Next'),
            ),
            const SizedBox(width: 8),
            TextButton(
              onPressed: details.onStepCancel,
              child: Text(_step == 0 ? 'Cancel' : 'Back'),
            ),
            if (_error != null)
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(left: 12),
                  child: Text(_error!,
                      style: TextStyle(color: Theme.of(context).colorScheme.error)),
                ),
              ),
          ],
        ),
      ),
      steps: [
        Step(
          title: const Text('Type'),
          isActive: _step >= 0,
          state: _step > 0 ? StepState.complete : StepState.indexed,
          content: _typeStep(people),
        ),
        Step(
          title: const Text('Credentials'),
          isActive: _step >= 1,
          state: _step > 1 ? StepState.complete : StepState.indexed,
          content: _credentialsStep(),
        ),
        Step(
          title: const Text('Configure'),
          isActive: _step >= 2,
          state: StepState.indexed,
          content: _configStep(),
        ),
      ],
    );
  }

  Widget _typeStep(List<dynamic> people) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DropdownButtonFormField<String>(
          initialValue: _memberId,
          decoration: const InputDecoration(labelText: 'Caretaker'),
          items: [
            for (final c in people)
              DropdownMenuItem(value: c.id as String, child: Text(c.relationName as String)),
          ],
          onChanged: (v) => setState(() => _memberId = v),
        ),
        const SizedBox(height: 16),
        DropdownButtonFormField<_Provider>(
          initialValue: _provider,
          decoration: const InputDecoration(labelText: 'Provider'),
          items: const [
            DropdownMenuItem(value: _Provider.email, child: Text('Email invite')),
            DropdownMenuItem(value: _Provider.icloud, child: Text('iCloud (CalDAV)')),
            DropdownMenuItem(value: _Provider.genericCaldav, child: Text('Other CalDAV')),
            DropdownMenuItem(value: _Provider.google, child: Text('Google Calendar')),
          ],
          onChanged: (p) => p == null ? null : _onProviderChanged(p),
        ),
      ],
    );
  }

  Widget _credentialsStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: _credentialFields(),
    );
  }

  Widget _configStep() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_isCalDav) ...[
          _calendarPicker(),
          const SizedBox(height: 16),
        ],
        if (_provider == _Provider.google) ...[
          _googleCalendarIdField(),
          const SizedBox(height: 16),
        ],
        TextField(
          controller: _name,
          decoration: const InputDecoration(
            labelText: 'Connection name',
            hintText: 'e.g. Work calendar',
          ),
        ),
        const SizedBox(height: 16),
        ..._alertsSection(),
      ],
    );
  }

  // --- Edit: configuration options only ---------------------------------

  Widget _editConfigBody() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const _Hint('Type, caretaker, and credentials are kept from setup. '
            'Leave credential fields blank to keep the current ones.'),
        const SizedBox(height: 12),
        TextField(
          controller: _name,
          decoration: const InputDecoration(labelText: 'Connection name'),
        ),
        SwitchListTile(
          value: _active,
          onChanged: (v) => setState(() => _active = v),
          title: const Text('Active'),
          subtitle: const Text('Deliver tasks to this calendar'),
          contentPadding: EdgeInsets.zero,
        ),
        const SizedBox(height: 8),
        ..._configFieldsForEdit(),
        const SizedBox(height: 16),
        ..._alertsSection(),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Save'),
        ),
      ],
    );
  }

  List<Widget> _configFieldsForEdit() {
    switch (_provider) {
      case _Provider.email:
        return [
          TextField(
            controller: _address,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(labelText: 'Delivery email'),
          ),
        ];
      case _Provider.google:
        return [
          _googleCalendarIdField(),
          const SizedBox(height: 12),
          ..._credentialFields(), // re-authorize (or leave blank to keep)
        ];
      case _Provider.icloud:
      case _Provider.genericCaldav:
        return [
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Calendar'),
            subtitle: Text(_selectedCalendarUrl ?? 'None', maxLines: 2, overflow: TextOverflow.ellipsis),
            trailing: TextButton(
              onPressed: () => setState(() => _changingCalendar = !_changingCalendar),
              child: Text(_changingCalendar ? 'Cancel' : 'Change'),
            ),
          ),
          if (_changingCalendar) ...[
            const _Hint('Re-enter the password to fetch and pick a different calendar.'),
            ..._credentialFields(),
          ],
        ];
    }
  }

  // --- Shared field builders --------------------------------------------

  List<Widget> _alertsSection() {
    return [
      Text('Default reminders', style: Theme.of(context).textTheme.labelLarge),
      const _Hint('Minutes before each event to alert (up to two). Leave blank for none.'),
      const SizedBox(height: 8),
      Row(
        children: [
          Expanded(
            child: TextField(
              controller: _alert1,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Alert 1 (min)', hintText: 'e.g. 30'),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: TextField(
              controller: _alert2,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Alert 2 (min)', hintText: 'e.g. 10'),
            ),
          ),
        ],
      ),
    ];
  }

  Widget _googleCalendarIdField() => TextField(
        controller: _calendarId,
        decoration: const InputDecoration(
          labelText: 'Google calendar ID',
          hintText: 'primary or …@group.calendar.google.com',
        ),
      );

  Widget _calendarPicker() {
    if (_discovered.isEmpty) {
      return const _Hint('Go back and fetch calendars to pick one.');
    }
    return DropdownButtonFormField<String>(
      initialValue: _selectedCalendarUrl,
      decoration: const InputDecoration(labelText: 'Calendar'),
      items: [
        for (final cal in _discovered)
          DropdownMenuItem(
            value: cal['url'] as String,
            child: Text(cal['displayName'] as String, maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
      ],
      onChanged: (v) => setState(() => _selectedCalendarUrl = v),
    );
  }

  /// Provider-specific credential inputs (+ CalDAV fetch). Shared by the wizard
  /// credentials step and the edit "change calendar" panel.
  List<Widget> _credentialFields() {
    switch (_provider) {
      case _Provider.email:
        return [
          TextField(
            controller: _address,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(labelText: 'Delivery email', hintText: 'you@example.com'),
          ),
          const _Hint('A full-detail invite is emailed here. Note: outbound email is '
              'currently disabled until a paid plan is enabled.'),
        ];
      case _Provider.icloud:
      case _Provider.genericCaldav:
        return [
          TextField(
            controller: _address,
            decoration: const InputDecoration(
              labelText: 'CalDAV server URL',
              hintText: 'https://caldav.icloud.com',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _username,
            decoration: InputDecoration(
              labelText: _provider == _Provider.icloud ? 'Apple ID email' : 'Username',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _password,
            obscureText: true,
            decoration: InputDecoration(
              labelText: _provider == _Provider.icloud ? 'App-specific password' : 'Password',
              hintText: _editing ? 'Leave blank to keep current' : null,
            ),
          ),
          if (_provider == _Provider.icloud)
            const _Hint('Create an app-specific password at appleid.apple.com → Sign-In '
                'and Security → App-Specific Passwords.'),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _discovering ? null : _fetchCalendars,
            icon: _discovering
                ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.search),
            label: const Text('Fetch calendars'),
          ),
          if (_discovered.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('${_discovered.length} calendar(s) found',
                style: Theme.of(context).textTheme.bodySmall),
            // On edit, the picker lives here so a re-fetch can switch calendars.
            if (_editing) ...[
              const SizedBox(height: 8),
              _calendarPicker(),
            ],
          ],
        ];
      case _Provider.google:
        return [
          TextField(
            controller: _redirectUri,
            decoration: const InputDecoration(
              labelText: 'OAuth redirect URI',
              hintText: 'must match a URI on your Google OAuth client',
            ),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _getGoogleAuthUrl,
            icon: const Icon(Icons.link),
            label: const Text('Get authorization link'),
          ),
          if (_googleAuthUrl != null) ...[
            const SizedBox(height: 8),
            const _Hint('Open this link, approve access, then copy the "code" value '
                'from the redirect URL into the field below.'),
            SelectableText(_googleAuthUrl!, style: Theme.of(context).textTheme.bodySmall),
          ],
          const SizedBox(height: 12),
          TextField(
            controller: _authCode,
            decoration: InputDecoration(
              labelText: 'Authorization code',
              hintText: _editing ? 'Leave blank to keep current' : null,
            ),
          ),
          const SizedBox(height: 8),
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: const Text('Advanced: paste an access token instead'),
            children: [
              TextField(
                controller: _accessToken,
                decoration: const InputDecoration(
                  labelText: 'OAuth access token (expires ~1h)',
                ),
              ),
              const _Hint('A short-lived token — prefer the authorization code above, '
                  'which is exchanged for a refresh token that keeps working.'),
            ],
          ),
        ];
    }
  }
}

class _Hint extends StatelessWidget {
  const _Hint(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Text(text, style: Theme.of(context).textTheme.bodySmall),
    );
  }
}
