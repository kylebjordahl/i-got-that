import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../state/auth.dart';
import '../state/family.dart';

/// Calendar connections (delivery destinations) with a guided per-provider
/// connect flow: email invite, iCloud (CalDAV), generic CalDAV, or Google.
class CalendarsScreen extends ConsumerWidget {
  const CalendarsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final targetsAsync = ref.watch(targetsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Calendars')),
      floatingActionButton: FloatingActionButton.extended(
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
                        '${_methodLabel(t)} · ${t['memberRelation']} · ${t['addressOrUrl']}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
              ),
      ),
    );
  }

  IconData _iconFor(String method) => switch (method) {
        'email' => Icons.mail_outline,
        'google' => Icons.calendar_month,
        _ => Icons.cloud_outlined, // caldav
      };

  String _methodLabel(Map<String, dynamic> t) {
    final hint = t['providerHint'];
    if (hint == 'icloud') return 'iCloud';
    if (hint == 'google' || t['method'] == 'google') return 'Google';
    if (hint == 'generic_caldav') return 'CalDAV';
    return t['method'] as String;
  }
}

/// Full-page guided connect form.
class ConnectCalendarPage extends ConsumerStatefulWidget {
  const ConnectCalendarPage({super.key});

  @override
  ConsumerState<ConnectCalendarPage> createState() => _ConnectCalendarPageState();
}

enum _Provider { email, icloud, genericCaldav, google }

class _ConnectCalendarPageState extends ConsumerState<ConnectCalendarPage> {
  _Provider _provider = _Provider.email;
  String? _memberId;
  final _name = TextEditingController();
  final _address = TextEditingController(); // email / CalDAV URL
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _calendarId = TextEditingController(text: 'primary');
  final _accessToken = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (_provider == _Provider.icloud) _address.text = 'https://caldav.icloud.com';
  }

  @override
  void dispose() {
    for (final c in [_name, _address, _username, _password, _calendarId, _accessToken]) {
      c.dispose();
    }
    super.dispose();
  }

  void _onProviderChanged(_Provider p) {
    setState(() {
      _provider = p;
      if (p == _Provider.icloud && !_address.text.startsWith('http')) {
        _address.text = 'https://caldav.icloud.com';
      }
    });
  }

  Future<void> _save() async {
    if (_memberId == null) {
      setState(() => _error = 'Pick a caretaker');
      return;
    }
    if (_name.text.trim().isEmpty) {
      setState(() => _error = 'Give the connection a name');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      final api = ref.read(apiClientProvider);

      late String method;
      String? providerHint;
      String addressOrUrl;
      String? externalCalendarId;
      Map<String, String>? credential;

      switch (_provider) {
        case _Provider.email:
          method = 'email';
          addressOrUrl = _address.text.trim();
        case _Provider.icloud:
          method = 'caldav';
          providerHint = 'icloud';
          addressOrUrl = _address.text.trim();
          credential = {'username': _username.text.trim(), 'password': _password.text};
        case _Provider.genericCaldav:
          method = 'caldav';
          providerHint = 'generic_caldav';
          addressOrUrl = _address.text.trim();
          credential = {'username': _username.text.trim(), 'password': _password.text};
        case _Provider.google:
          method = 'google';
          providerHint = 'google';
          externalCalendarId = _calendarId.text.trim();
          addressOrUrl = _calendarId.text.trim();
          credential = {'accessToken': _accessToken.text.trim()};
      }

      await api.createCalendarTarget(
        familyId,
        memberId: _memberId!,
        name: _name.text.trim(),
        method: method,
        providerHint: providerHint,
        addressOrUrl: addressOrUrl,
        externalCalendarId: externalCalendarId,
        credential: credential,
      );
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
      appBar: AppBar(title: const Text('Connect a calendar')),
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
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              DropdownButtonFormField<String>(
                initialValue: _memberId,
                decoration: const InputDecoration(labelText: 'Caretaker'),
                items: [
                  for (final c in people)
                    DropdownMenuItem(value: c.id, child: Text(c.relationName)),
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
              const SizedBox(height: 16),
              TextField(
                controller: _name,
                decoration: const InputDecoration(
                  labelText: 'Connection name',
                  hintText: 'e.g. Work calendar',
                ),
              ),
              const SizedBox(height: 16),
              ..._providerFields(),
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
                    : const Text('Connect'),
              ),
            ],
          );
        },
      ),
    );
  }

  List<Widget> _providerFields() {
    switch (_provider) {
      case _Provider.email:
        return [
          TextField(
            controller: _address,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(
              labelText: 'Delivery email',
              hintText: 'you@example.com',
            ),
          ),
          const _Hint('A full-detail invite is emailed here (accept/decline supported). '
              'Note: outbound email is currently disabled until a paid plan is enabled.'),
        ];
      case _Provider.icloud:
        return [
          TextField(
            controller: _address,
            decoration: const InputDecoration(labelText: 'CalDAV URL'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _username,
            decoration: const InputDecoration(labelText: 'Apple ID email'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _password,
            obscureText: true,
            decoration: const InputDecoration(labelText: 'App-specific password'),
          ),
          const _Hint('Create an app-specific password at appleid.apple.com → Sign-In '
              'and Security → App-Specific Passwords.'),
        ];
      case _Provider.genericCaldav:
        return [
          TextField(
            controller: _address,
            decoration: const InputDecoration(
              labelText: 'CalDAV collection URL',
              hintText: 'https://…/calendars/home/',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _username,
            decoration: const InputDecoration(labelText: 'Username'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _password,
            obscureText: true,
            decoration: const InputDecoration(labelText: 'Password'),
          ),
        ];
      case _Provider.google:
        return [
          TextField(
            controller: _calendarId,
            decoration: const InputDecoration(
              labelText: 'Google calendar ID',
              hintText: 'primary or …@group.calendar.google.com',
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _accessToken,
            decoration: const InputDecoration(labelText: 'OAuth access token'),
          ),
          const _Hint('A proper Google sign-in flow is coming; for now paste an OAuth '
              'access token with the calendar.events scope.'),
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
