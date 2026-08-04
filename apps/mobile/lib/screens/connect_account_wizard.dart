import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import '../env.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

/// The 3-step connect-account wizard (5m/n/o), launched from Me. Choose a
/// provider, sign in / grant access, then pick calendars. Wired to the external-
/// account API: iCloud/Outlook use CalDAV basic auth, Google uses OAuth.
class ConnectAccountWizard extends ConsumerStatefulWidget {
  const ConnectAccountWizard({
    super.key,
    this.onConnected,
    this.skipCalendarStep = false,
  });

  /// Called with the freshly-connected account id once a connection succeeds.
  /// The onboarding wizard uses this to pop straight back into its own flow.
  final void Function(String accountId)? onConnected;

  /// When true, the "choose calendars" step (3) is omitted — calendar selection
  /// happens in context later (per-child / per-parent unified-calendar picks).
  /// The wizard pops as soon as the account connects.
  final bool skipCalendarStep;

  @override
  ConsumerState<ConnectAccountWizard> createState() =>
      _ConnectAccountWizardState();
}

class _ConnectAccountWizardState extends ConsumerState<ConnectAccountWizard> {
  int _step = 1;
  String _provider = 'apple'; // apple | google | outlook | ics

  // Step-2 credentials (CalDAV providers only — Google uses a system-browser
  // OAuth handoff on both web and native, with no fields of its own).
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _serverUrl = TextEditingController();

  // Step 3.
  String? _accountId;
  List<Map<String, dynamic>> _calendars = const [];
  final Set<String> _selectedCals = {};

  bool _busy = false;
  String? _error;

  static const _providers = <(String, String, String, IconData)>[
    ('apple', 'Apple iCloud', 'Calendar & Reminders', Icons.cloud_rounded),
    (
      'google',
      'Google Calendar',
      'Calendar & Tasks',
      Icons.calendar_month_rounded,
    ),
    ('outlook', 'Microsoft Outlook', 'Calendar', Icons.event_note_rounded),
    (
      'ics',
      'ICS / subscription URL',
      'Read-only calendar feed',
      Icons.rss_feed_rounded,
    ),
  ];

  String get _kind => switch (_provider) {
    'google' => 'google',
    'apple' => 'icloud',
    _ => 'caldav', // outlook / generic
  };

  String get _providerLabel =>
      _providers.firstWhere((p) => p.$1 == _provider).$2;

  bool get _isGoogle => _provider == 'google';
  bool get _isIcs => _provider == 'ics';

  @override
  void dispose() {
    for (final c in [_username, _password, _serverUrl]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _connect() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final serverUrl = switch (_provider) {
        'apple' => 'https://caldav.icloud.com',
        'outlook' => _serverUrl.text.trim(),
        _ => _serverUrl.text.trim(),
      };
      if (_username.text.trim().isEmpty || _password.text.isEmpty) {
        setState(() => _error = 'Enter your username and password');
        return;
      }
      if (_provider == 'outlook' && serverUrl.isEmpty) {
        setState(() => _error = 'Enter the CalDAV server URL');
        return;
      }
      final res = await ref
          .read(apiClientProvider)
          .createExternalAccount(
            kind: _kind,
            name: _providerLabel,
            serverUrl: serverUrl,
            username: _username.text.trim(),
            password: _password.text,
          );
      await _finishConnected(res);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Native "connect a Google Calendar": opens Google's consent screen in the
  /// system browser (`ASWebAuthenticationSession` via `flutter_web_auth_2`).
  /// Google's Web-application client can't redirect straight to our custom
  /// scheme, so we point it at the API's `/auth/google/native-callback`
  /// instead, which immediately bounces to `googleOAuthCallbackScheme` — that
  /// hop is what `flutter_web_auth_2` intercepts, handing the `code` straight
  /// back here with no manual copy/paste. See docs/AUTH.md's Google section.
  Future<void> _connectGoogleNative() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      const redirectUri = '$apiBaseUrl/auth/google/native-callback';
      final authorizeUrl = await ref
          .read(apiClientProvider)
          .accountGoogleAuthorizeUrl(redirectUri);
      final callback = await FlutterWebAuth2.authenticate(
        url: authorizeUrl,
        callbackUrlScheme: googleOAuthCallbackScheme,
      );
      final code = Uri.parse(callback).queryParameters['code'];
      if (code == null) {
        setState(() => _error = 'Google did not return an authorization code.');
        return;
      }
      final res = await ref
          .read(apiClientProvider)
          .createExternalAccount(
            kind: 'google',
            name: _providerLabel,
            authCode: code,
            redirectUri: redirectUri,
          );
      await _finishConnected(res);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Shared post-connect step for both [_connect] (CalDAV) and
  /// [_connectGoogleNative]: registers the new account, then either hands it
  /// straight back to the caller (onboarding's skip-calendar-step reuse) or
  /// advances to the calendar-picker step.
  Future<void> _finishConnected(Map<String, dynamic> res) async {
    ref.invalidate(accountsProvider);
    _accountId =
        (res['account'] as Map<String, dynamic>?)?['id'] as String? ??
        (res['id'] as String?);
    if (widget.skipCalendarStep) {
      if (_accountId != null) widget.onConnected?.call(_accountId!);
      if (mounted) Navigator.of(context).maybePop();
      return;
    }
    await _loadCalendars();
    if (mounted) setState(() => _step = 3);
  }

  Future<void> _loadCalendars() async {
    if (_accountId == null) return;
    try {
      final cals = await ref
          .read(apiClientProvider)
          .listAccountCalendars(_accountId!);
      _calendars = cals.cast<Map<String, dynamic>>();
      _selectedCals
        ..clear()
        ..addAll(_calendars.map((c) => c['id'] as String));
    } catch (_) {
      _calendars = const [];
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 150),
          children: [
            Row(
              children: [
                RoundIconButton(
                  icon: Icons.close_rounded,
                  onTap: () => Navigator.of(context).maybePop(),
                ),
                const SizedBox(width: 14),
                Text('Connect account', style: AppText.subPageTitle),
              ],
            ),
            const SizedBox(height: 20),
            _ProgressBar(step: _step),
            const SizedBox(height: 10),
            Text(
              'Step $_step of 3 · ${_stepCaption()}',
              style: font(kBodyFont, 12.5, 600, color: AppColors.indigo),
            ),
            const SizedBox(height: 20),
            if (_step == 1)
              ..._chooseProvider()
            else if (_step == 2)
              ..._signIn()
            else
              ..._chooseCalendars(),
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(
                _error!,
                style: font(kBodyFont, 13, 500, color: AppColors.coral),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _stepCaption() => switch (_step) {
    1 => 'Choose a provider',
    2 => 'Sign in & grant access',
    _ => 'Choose calendars',
  };

  // --- Step 1 ------------------------------------------------------------
  List<Widget> _chooseProvider() {
    return [
      for (final (id, title, subtitle, icon) in _providers) ...[
        _ProviderTile(
          icon: icon,
          title: title,
          subtitle: subtitle,
          selected: _provider == id,
          onTap: () => setState(() => _provider = id),
        ),
        const SizedBox(height: 12),
      ],
      const SizedBox(height: 12),
      _PrimaryButton(
        label: 'Continue',
        busy: false,
        onPressed: () => setState(() => _step = 2),
      ),
    ];
  }

  // --- Step 2 ------------------------------------------------------------
  List<Widget> _signIn() {
    if (_isIcs) {
      return [
        _hero(
          Icons.rss_feed_rounded,
          'Add an ICS feed',
          'Subscription calendars are added as Input feeds, not accounts — they '
              'generate tasks per child.',
        ),
        const SizedBox(height: 20),
        _PrimaryButton(
          label: 'Go to Input feeds',
          busy: false,
          onPressed: () => Navigator.of(context).maybePop(),
        ),
      ];
    }
    // Web Google uses the server-hosted OAuth redirect (one tap, no pasting) —
    // the same `/auth/google/start?link=1` flow that threads Google onto this
    // account. It navigates the page away and returns to `#connected=google`, so
    // there's no in-page calendar step; the account shows up on reload.
    if (_isGoogle && kIsWeb) {
      return [
        _hero(
          Icons.calendar_month_rounded,
          'Sign in to $_providerLabel',
          'Authorize I Got That to read your Google calendars and manage handoffs.',
        ),
        const SizedBox(height: 20),
        const _PermissionsCard(),
        const SizedBox(height: 20),
        _PrimaryButton(
          label: 'Continue with $_providerLabel',
          busy: false,
          onPressed: () =>
              ref.read(authControllerProvider.notifier).connectGoogleCalendar(),
        ),
      ];
    }
    // Native Google: same one-tap shape as web, but via a system-browser OAuth
    // handoff (see _connectGoogleNative) instead of a page redirect.
    if (_isGoogle) {
      return [
        _hero(
          Icons.calendar_month_rounded,
          'Sign in to $_providerLabel',
          'Authorize I Got That to read your Google calendars and manage handoffs.',
        ),
        const SizedBox(height: 20),
        const _PermissionsCard(),
        const SizedBox(height: 20),
        _PrimaryButton(
          label: _busy ? 'Connecting…' : 'Continue with $_providerLabel',
          busy: _busy,
          onPressed: _busy ? null : _connectGoogleNative,
        ),
      ];
    }
    return [
      _hero(
        Icons.cloud_rounded,
        'Sign in to $_providerLabel',
        'Use an app-specific password — we never see your main password.',
      ),
      const SizedBox(height: 20),
      const _PermissionsCard(),
      const SizedBox(height: 20),
      ..._calDavFields(),
      const SizedBox(height: 20),
      _PrimaryButton(
        label: _busy ? 'Connecting…' : 'Continue with $_providerLabel',
        busy: _busy,
        onPressed: _busy ? null : _connect,
      ),
    ];
  }

  List<Widget> _calDavFields() => [
    if (_provider == 'outlook')
      Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: TextField(
          controller: _serverUrl,
          decoration: const InputDecoration(
            labelText: 'CalDAV server URL',
            hintText: 'https://…',
          ),
        ),
      ),
    TextField(
      controller: _username,
      decoration: const InputDecoration(labelText: 'Username / email'),
    ),
    const SizedBox(height: 14),
    TextField(
      controller: _password,
      obscureText: true,
      decoration: const InputDecoration(labelText: 'App-specific password'),
    ),
  ];

  // --- Step 3 ------------------------------------------------------------
  List<Widget> _chooseCalendars() {
    return [
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: AppColors.tint(AppColors.green, 0.10),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: AppColors.green.withValues(alpha: 0.4)),
        ),
        child: Row(
          children: [
            const Icon(
              Icons.check_circle_rounded,
              color: AppColors.green,
              size: 20,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                'Connected via $_providerLabel',
                style: font(kBodyFont, 14, 600, color: AppColors.green),
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 16),
      Text(
        'Pick the calendars Tasks should watch for events. You can change this '
        'anytime when adding feeds or delivery methods.',
        style: AppText.subtitle,
      ),
      const SizedBox(height: 12),
      if (_calendars.isNotEmpty)
        AppCard(
          child: Column(
            children: [
              for (var i = 0; i < _calendars.length; i++) ...[
                SwitchRow(
                  icon: Icons.calendar_today_rounded,
                  iconColor: AppColors.blue,
                  title: _calendars[i]['name'] as String? ?? 'Calendar',
                  value: _selectedCals.contains(_calendars[i]['id']),
                  onChanged: (v) => setState(() {
                    final id = _calendars[i]['id'] as String;
                    v ? _selectedCals.add(id) : _selectedCals.remove(id);
                  }),
                ),
                if (i < _calendars.length - 1) const Divider(height: 20),
              ],
            ],
          ),
        ),
      const SizedBox(height: 24),
      _PrimaryButton(
        label: 'Finish',
        busy: false,
        onPressed: () => Navigator.of(context).maybePop(),
      ),
    ];
  }

  Widget _hero(IconData icon, String title, String subtitle) {
    return Column(
      children: [
        Container(
          width: 64,
          height: 64,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: AppColors.tint(AppColors.indigo),
            borderRadius: BorderRadius.circular(18),
          ),
          child: Icon(icon, color: AppColors.indigo, size: 30),
        ),
        const SizedBox(height: 16),
        Text(title, style: AppText.subPageTitle),
        const SizedBox(height: 6),
        Text(subtitle, textAlign: TextAlign.center, style: AppText.subtitle),
      ],
    );
  }
}

class _ProgressBar extends StatelessWidget {
  const _ProgressBar({required this.step});
  final int step;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 1; i <= 3; i++) ...[
          Expanded(
            child: Container(
              height: 4,
              decoration: BoxDecoration(
                color: i <= step ? AppColors.indigo : AppColors.card,
                borderRadius: BorderRadius.circular(999),
              ),
            ),
          ),
          if (i < 3) const SizedBox(width: 6),
        ],
      ],
    );
  }
}

class _ProviderTile extends StatelessWidget {
  const _ProviderTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.onTap,
  });
  final IconData icon;
  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.card,
          borderRadius: BorderRadius.circular(18),
          border: Border.all(
            color: selected ? AppColors.indigo : AppColors.border,
            width: selected ? 1.5 : 1,
          ),
        ),
        child: Row(
          children: [
            IconTile(icon: icon, color: AppColors.indigo),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: AppText.sectionItemTitle),
                  const SizedBox(height: 2),
                  Text(subtitle, style: AppText.subtitle),
                ],
              ),
            ),
            Icon(
              selected ? Icons.check_circle_rounded : Icons.circle_outlined,
              color: selected ? AppColors.indigo : AppColors.textMuted,
            ),
          ],
        ),
      ),
    );
  }
}

class _PermissionsCard extends StatelessWidget {
  const _PermissionsCard();

  @override
  Widget build(BuildContext context) {
    Widget row(String text) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          const Icon(Icons.check_rounded, color: AppColors.green, size: 18),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: AppText.subtitle)),
        ],
      ),
    );
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('TASKS IS REQUESTING', style: AppText.eyebrow()),
          const SizedBox(height: 6),
          row('View your calendars & events'),
          row('Create & update reminders'),
          row('Read event times for handoffs'),
        ],
      ),
    );
  }
}

class _PrimaryButton extends StatelessWidget {
  const _PrimaryButton({
    required this.label,
    required this.busy,
    required this.onPressed,
  });
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
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Color(0xFF2A1E05),
                  ),
                )
              : Text(
                  label,
                  style: font(
                    kBodyFont,
                    14.5,
                    700,
                    color: const Color(0xFF2A1E05),
                  ),
                ),
        ),
      ),
    );
  }
}
