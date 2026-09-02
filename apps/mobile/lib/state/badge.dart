import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'auth.dart';
import 'family.dart';
import 'notifications.dart';

/// Keeps the app-icon badge honest.
///
/// A digest push stamps the badge with what was outstanding *when it was sent*,
/// and nothing about that number expires on its own: claim the pickup it was
/// counting and iOS still shows the 3. So the badge is treated as a view of
/// live state rather than an unread count — whenever the app can plausibly know
/// better (it came to the foreground, or something that could have cleared work
/// just happened), it asks the server what's still outstanding and rewrites the
/// badge with the answer, zero included.
///
/// The count is server-computed (`GET /notifications/badge`) so it spans every
/// family the user is in — the badge does, too — and so it can't disagree with
/// the digest that set it. Everything here is best-effort: a badge that fails
/// to update is cosmetic, and never worth surfacing an error for.
class BadgeSync {
  BadgeSync(this._ref) {
    _ref.onDispose(() => _pending?.cancel());
  }

  final Ref _ref;
  Timer? _pending;

  /// How long to wait for a burst to settle. One claim invalidates several
  /// providers at once, and the count that matters is the one *after* they've
  /// all landed — so the trailing edge, not the leading one.
  static const _debounce = Duration(milliseconds: 250);

  /// Ask the server what's outstanding and rewrite the badge with it.
  /// Fire-and-forget: callers are UI paths that must not wait on it.
  void refresh() {
    _pending?.cancel();
    _pending = Timer(_debounce, _refresh);
  }

  Future<void> _refresh() async {
    final push = _ref.read(pushServiceProvider);
    if (!push.isSupported) return;
    try {
      await push.setBadgeCount(
        await _ref.read(apiClientProvider).fetchBadgeCount(),
      );
    } catch (_) {
      // Offline, or a session that just went away — leave the badge as it is
      // rather than guessing at zero. [BadgeSyncScope] only ever runs while
      // signed in, so there's no unauthenticated case to special-case here.
    }
  }

  /// Drop the badge without asking. Sign-out only: the count belongs to the
  /// account that just left, and the server would refuse to tell us anyway.
  Future<void> clear() {
    _pending?.cancel();
    return _ref.read(pushServiceProvider).setBadgeCount(0);
  }
}

final badgeSyncProvider = Provider<BadgeSync>(BadgeSync.new);

/// Drives [BadgeSync] from the two things that can make the badge wrong:
/// coming back to the app (someone else claimed it, or an old digest is still
/// showing), and this device changing something that could have been the last
/// outstanding item.
///
/// The second is wired to the providers every claim / decision / conflict path
/// already invalidates, rather than to the call sites — there are a dozen of
/// those spread over five screens, and a new one would silently not update the
/// badge.
class BadgeSyncScope extends ConsumerStatefulWidget {
  const BadgeSyncScope({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<BadgeSyncScope> createState() => _BadgeSyncScopeState();
}

class _BadgeSyncScopeState extends ConsumerState<BadgeSyncScope>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // A cold start is the most common way a stale badge is seen at all: the
    // user tapped the icon *because* of it.
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => ref.read(badgeSyncProvider).refresh(),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.read(badgeSyncProvider).refresh();
    }
  }

  /// Re-sync once [provider] has finished refetching. Called from `build`, so
  /// unconditionally and in a fixed order, as `ref.listen` requires.
  void _onSettled<T>(ProviderListenable<AsyncValue<T>> provider) {
    ref.listen(provider, (_, next) {
      if (next.isLoading) return;
      ref.read(badgeSyncProvider).refresh();
    });
  }

  @override
  Widget build(BuildContext context) {
    // Each of these refetches after any claim, dismissal, decision or conflict
    // resolution — whoever triggered it — so they double as "something that
    // could have emptied the queue just happened". All three are ones Home
    // already watches, so listening in costs no extra round trips.
    _onSettled(allTasksProvider);
    _onSettled(pendingDecisionsProvider);
    _onSettled(conflictsProvider);
    return widget.child;
  }
}
