import 'package:flutter/material.dart';

/// Shared task-type glyphs + labels (Home rows, Plan blocks).

/// The line icon for a task type (drop-off = into door, pickup = out, attendance = group).
IconData taskIcon(String type) => switch (type) {
      'dropoff' => Icons.login_rounded,
      'pickup' => Icons.logout_rounded,
      _ => Icons.groups_rounded,
    };

/// "Transition" for point-in-time pickups/drop-offs; "Attendance" for durations.
String taskCategory(String type) => type == 'attendance' ? 'Attendance' : 'Transition';

/// The human type label ("Drop-off" / "Pickup" / "Attendance").
String taskTypeLabel(String type) => switch (type) {
      'pickup' => 'Pickup',
      'dropoff' => 'Drop-off',
      _ => 'Attendance',
    };
