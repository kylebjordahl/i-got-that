import 'package:flutter/material.dart';
import '../models.dart';

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

/// The row title for a task: drop-off/pickup keep their generic type label,
/// but attendance tasks read as the source event's own title (e.g. "Soccer
/// practice") instead of the generic "Attendance", when that event is known.
String taskTitle(TaskItem task, CalendarEventItem? sourceEvent) {
  if (task.type == 'attendance' && sourceEvent != null) {
    return sourceEvent.displaySummary;
  }
  return taskTypeLabel(task.type);
}
