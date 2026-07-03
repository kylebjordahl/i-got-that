import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../widgets/primitives.dart';

/// External calendar accounts (Google / iCloud / CalDAV) owned by the signed-in
/// user and reusable across their families. Connect once here, then draw their
/// calendars into input/output feeds. Credentials never leave the server.
class AccountsScreen extends ConsumerWidget {
  const AccountsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accountsAsync = ref.watch(accountsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Accounts')),
      floatingActionButton: FloatingActionButton.extended(
        heroTag: 'fab-accounts',
        onPressed: () async {
          final added = await showDialog<bool>(
            context: context,
            builder: (_) => const _AddAccountDialog(),
          );
          if (added == true) ref.invalidate(accountsProvider);
        },
        icon: const Icon(Icons.add_link),
        label: const Text('Connect'),
      ),
      body: accountsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (accounts) => accounts.isEmpty
            ? const Center(
                child: Padding(
                  padding: EdgeInsets.all(24),
                  child: Text(
                    'No accounts connected yet.\nConnect Google, iCloud, or a CalDAV server '
                    'to use its calendars as input or output feeds.',
                    textAlign: TextAlign.center,
                  ),
                ),
              )
            : ListView(
                children: [
                  for (final a in accounts)
                    ListTile(
                      leading: IconTile(icon: _iconFor(a.kind), color: _colorFor(a.kind)),
                      title: Text(a.name),
                      subtitle: Text([
                        a.kindLabel,
                        if (a.username != null && a.username!.isNotEmpty) a.username!,
                        if (a.serverUrl != null && a.serverUrl!.isNotEmpty) a.serverUrl!,
                      ].join(' · ')),
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline),
                        onPressed: () => _delete(context, ref, a),
                      ),
                    ),
                ],
              ),
      ),
    );
  }

  IconData _iconFor(String kind) => switch (kind) {
        'google' => Icons.calendar_month,
        'icloud' => Icons.cloud_outlined,
        _ => Icons.dns_outlined,
      };

  Color _colorFor(String kind) => switch (kind) {
        'google' => AppColors.blue,
        'icloud' => AppColors.indigo,
        _ => AppColors.purple,
      };

  Future<void> _delete(BuildContext context, WidgetRef ref, ExternalAccount account) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Disconnect account?'),
        content: Text(
          'Remove "${account.name}"? Feeds still using it must be deleted first.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Disconnect')),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await ref.read(apiClientProvider).deleteAccount(account.id);
      ref.invalidate(accountsProvider);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not disconnect: $e')),
        );
      }
    }
  }
}

class _AddAccountDialog extends ConsumerStatefulWidget {
  const _AddAccountDialog();

  @override
  ConsumerState<_AddAccountDialog> createState() => _AddAccountDialogState();
}

class _AddAccountDialogState extends ConsumerState<_AddAccountDialog> {
  String _kind = 'icloud';
  final _name = TextEditingController();
  final _serverUrl = TextEditingController(text: 'https://caldav.icloud.com');
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _redirectUri = TextEditingController();
  final _authCode = TextEditingController();
  String? _googleAuthUrl;
  bool _busy = false;
  String? _error;

  bool get _isGoogle => _kind == 'google';
  bool get _isCalDav => !_isGoogle;

  @override
  void dispose() {
    for (final c in [_name, _serverUrl, _username, _password, _redirectUri, _authCode]) {
      c.dispose();
    }
    super.dispose();
  }

  void _onKind(String kind) {
    setState(() {
      _kind = kind;
      if (kind == 'icloud' && _serverUrl.text.trim().isEmpty) {
        _serverUrl.text = 'https://caldav.icloud.com';
      } else if (kind == 'caldav' && _serverUrl.text == 'https://caldav.icloud.com') {
        _serverUrl.clear();
      }
    });
  }

  Future<void> _getGoogleAuthUrl() async {
    if (_redirectUri.text.trim().isEmpty) {
      setState(() => _error = 'Enter your OAuth redirect URI first');
      return;
    }
    setState(() => _error = null);
    try {
      final url = await ref
          .read(apiClientProvider)
          .accountGoogleAuthorizeUrl(_redirectUri.text.trim());
      setState(() => _googleAuthUrl = url);
    } catch (e) {
      setState(() => _error = '$e');
    }
  }

  Future<void> _save() async {
    if (_name.text.trim().isEmpty) {
      setState(() => _error = 'Give the account a name');
      return;
    }
    if (_isGoogle && (_authCode.text.trim().isEmpty || _redirectUri.text.trim().isEmpty)) {
      setState(() => _error = 'Authorize with Google and paste the code');
      return;
    }
    if (_isCalDav && (_username.text.trim().isEmpty || _password.text.isEmpty)) {
      setState(() => _error = 'Enter the username and password');
      return;
    }
    if (_kind == 'caldav' && _serverUrl.text.trim().isEmpty) {
      setState(() => _error = 'Enter the CalDAV server URL');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(apiClientProvider).createExternalAccount(
            kind: _kind,
            name: _name.text.trim(),
            serverUrl: _isCalDav ? _serverUrl.text.trim() : null,
            username: _isCalDav ? _username.text.trim() : null,
            password: _isCalDav ? _password.text : null,
            authCode: _isGoogle ? _authCode.text.trim() : null,
            redirectUri: _isGoogle ? _redirectUri.text.trim() : null,
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
    return AlertDialog(
      title: const Text('Connect an account'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            DropdownButtonFormField<String>(
              initialValue: _kind,
              decoration: const InputDecoration(labelText: 'Type'),
              items: const [
                DropdownMenuItem(value: 'icloud', child: Text('iCloud (CalDAV)')),
                DropdownMenuItem(value: 'caldav', child: Text('Other CalDAV')),
                DropdownMenuItem(value: 'google', child: Text('Google Calendar')),
              ],
              onChanged: (v) => v == null ? null : _onKind(v),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'Account name', hintText: 'e.g. My iCloud'),
            ),
            const SizedBox(height: 12),
            if (_isCalDav) ..._calDavFields() else ..._googleFields(),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Connect'),
        ),
      ],
    );
  }

  List<Widget> _calDavFields() => [
        TextField(
          controller: _serverUrl,
          decoration: const InputDecoration(
            labelText: 'CalDAV server URL',
            hintText: 'https://caldav.icloud.com',
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _username,
          decoration: InputDecoration(
            labelText: _kind == 'icloud' ? 'Apple ID email' : 'Username',
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _password,
          obscureText: true,
          decoration: InputDecoration(
            labelText: _kind == 'icloud' ? 'App-specific password' : 'Password',
          ),
        ),
        if (_kind == 'icloud')
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text(
              'Create an app-specific password at appleid.apple.com → Sign-In and '
              'Security → App-Specific Passwords.',
              style: TextStyle(fontSize: 12),
            ),
          ),
      ];

  List<Widget> _googleFields() => [
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
          const Text(
            'Open this link, approve access, then copy the "code" value from the '
            'redirect URL into the field below.',
            style: TextStyle(fontSize: 12),
          ),
          SelectableText(_googleAuthUrl!, style: Theme.of(context).textTheme.bodySmall),
        ],
        const SizedBox(height: 12),
        TextField(
          controller: _authCode,
          decoration: const InputDecoration(labelText: 'Authorization code'),
        ),
      ];
}
