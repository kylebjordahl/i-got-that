import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'nav.dart';
import 'notifications.dart';

/// The calendar account the Me screen should bring into view, set by a tapped
/// "reconnect your account" push and cleared once its row has scrolled in.
final focusedAccountIdProvider = StateProvider<String?>((_) => null);

/// The Me tab's index in the bottom nav (see [navIndexProvider]).
const _meTab = 3;

/// Routes tapped notifications to where they point. Mounted with the signed-in
/// shell, beside [BadgeSyncScope]: it handles both a tap while the app is
/// running and the one that cold-started it (held natively until asked for).
///
/// Only the reauth alert deep-links today; a digest tap just opens the app.
class PushTapScope extends ConsumerStatefulWidget {
  const PushTapScope({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<PushTapScope> createState() => _PushTapScopeState();
}

class _PushTapScopeState extends ConsumerState<PushTapScope> {
  @override
  void initState() {
    super.initState();
    final push = ref.read(pushServiceProvider);
    push.onTap(_handle);
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final initial = await push.takeInitialTap();
      if (initial != null) _handle(initial);
    });
  }

  void _handle(Map<String, dynamic> payload) {
    if (!mounted) return;
    if (payload['type'] == 'reauth') {
      // Back to the tab shell (a sub-screen may be pushed over it), then Me,
      // with the account the alert named scrolled into view.
      rootNavigatorKey.currentState?.popUntil((route) => route.isFirst);
      ref.read(navIndexProvider.notifier).state = _meTab;
      ref.read(focusedAccountIdProvider.notifier).state =
          payload['accountId'] as String?;
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
