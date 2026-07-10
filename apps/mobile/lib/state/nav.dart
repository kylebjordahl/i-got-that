import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The selected bottom-nav tab (0=Home, 1=Plan, 2=Family, 3=Me). Held in a
/// provider so pushed sub-screens (the Family list screens) can switch tabs and
/// pop back to the shell.
final navIndexProvider = StateProvider<int>((_) => 0);

/// App-wide push-notification preference (Me screen). UI-only for now — no
/// backend permission is wired yet.
final pushNotificationsProvider = StateProvider<bool>((_) => true);

/// The inner content Navigator hosting [AppShell] and everything pushed on
/// top of it (member detail, feed setup, etc.) — see `_AuthedRoot` in
/// main.dart. Keyed so [PersistentAppNav], which lives one Stack layer above
/// it rather than inside it (so it never re-animates with a pushed screen),
/// can pop it without a BuildContext descended from it. Bottom sheets/dialogs
/// intentionally skip this Navigator (`useRootNavigator: true`) for the outer
/// one MaterialApp owns, so they render above the nav rather than below it.
final rootNavigatorKey = GlobalKey<NavigatorState>();

/// How many routes are pushed on top of [AppShell] (0 = showing a root tab).
/// Kept up to date by [AppNavObserver]; lets the floating nav hide the
/// Family-tab "+" once a sub-screen (member detail, feed setup, etc.) is
/// pushed on top, matching the pre-persistent-nav behavior where it only ever
/// appeared on that root tab.
final routeDepthNotifier = ValueNotifier<int>(0);

class AppNavObserver extends NavigatorObserver {
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (previousRoute != null) routeDepthNotifier.value++;
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (previousRoute != null) routeDepthNotifier.value--;
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    if (previousRoute != null) routeDepthNotifier.value--;
  }
}
