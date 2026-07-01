import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'calendars_screen.dart';
import 'dashboard_screen.dart';
import 'feeds_screen.dart';
import 'members_screen.dart';
import 'rules_screen.dart';

/// Bottom-nav shell. Each tab is a full screen (its own AppBar); this provides
/// the persistent NavigationBar.
class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  int _index = 0;

  static const _pages = [
    DashboardScreen(),
    MembersScreen(),
    FeedsScreen(),
    RulesScreen(),
    CalendarsScreen(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(index: _index, children: _pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.checklist), label: 'Tasks'),
          NavigationDestination(icon: Icon(Icons.child_care), label: 'Family'),
          NavigationDestination(icon: Icon(Icons.rss_feed), label: 'Feeds'),
          NavigationDestination(icon: Icon(Icons.rule), label: 'Rules'),
          NavigationDestination(icon: Icon(Icons.event), label: 'Calendars'),
        ],
      ),
    );
  }
}
