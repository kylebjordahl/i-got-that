import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The selected bottom-nav tab (0=Home, 1=Plan, 2=Family, 3=Me). Held in a
/// provider so pushed sub-screens (the Family list screens) can switch tabs and
/// pop back to the shell.
final navIndexProvider = StateProvider<int>((_) => 0);

/// App-wide push-notification preference (Me screen). UI-only for now — no
/// backend permission is wired yet.
final pushNotificationsProvider = StateProvider<bool>((_) => true);
