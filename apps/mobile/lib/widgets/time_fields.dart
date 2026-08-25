import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_text.dart';

/// Tap-to-pick inputs for the two kinds of time the user ever enters: a clock
/// time ("day starts at 08:30") and a length ("15 minutes of drop-off window").
/// Both hand off to the platform's own picker rather than a text field — the
/// Cupertino wheel (Flutter's UIDatePicker) on iOS/macOS, Material's time
/// picker on web/Android — so a value can't arrive malformed and nobody has to
/// know the wire format.
///
/// The wire formats stay what the API expects: a clock time is the `"HH:MM"`
/// 24-hour string on `feed_links`, a length is whole minutes.

/// Parses the API's `"HH:MM"` clock string. Null for null/empty/malformed input
/// (an out-of-range hour or minute included), so callers can fall back.
TimeOfDay? parseClockTime(String? raw) {
  final text = raw?.trim() ?? '';
  final match = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(text);
  if (match == null) return null;
  final hour = int.parse(match.group(1)!);
  final minute = int.parse(match.group(2)!);
  if (hour > 23 || minute > 59) return null;
  return TimeOfDay(hour: hour, minute: minute);
}

/// Formats back to the API's `"HH:MM"` 24-hour string.
String formatClockTime(TimeOfDay time) =>
    '${time.hour.toString().padLeft(2, '0')}:'
    '${time.minute.toString().padLeft(2, '0')}';

/// The clock time as the *reader's* locale writes it ("8:30 AM" / "08:30"),
/// which is what the field shows — the 24-hour wire format is an API detail.
String formatClockTimeForDisplay(BuildContext context, TimeOfDay time) =>
    MaterialLocalizations.of(context).formatTimeOfDay(
      time,
      alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context),
    );

/// A length in minutes, in words: `45 min`, `1 hr`, `1 hr 30 min`. Negative
/// values format by magnitude — direction is carried by the field's own label,
/// not by a minus sign the user would have to interpret.
String formatMinutes(int minutes) {
  final total = minutes.abs();
  final hours = total ~/ 60;
  final mins = total % 60;
  if (hours == 0) return '$mins min';
  if (mins == 0) return '$hours hr';
  return '$hours hr $mins min';
}

/// The two directions a signed window can run from its anchor, in words (e.g.
/// `(forward: 'After start', backward: 'Before start')`). Passing this to a
/// [DurationPickerField] is what makes negative values reachable.
typedef WindowDirections = ({String forward, String backward});

/// Cupertino platforms get the wheel; everything else (web included) gets
/// Material's picker. Read off the [Theme] rather than [defaultTargetPlatform]
/// so a test — or a future platform override — can steer it.
bool _usesCupertino(BuildContext context) =>
    !kIsWeb &&
    switch (Theme.of(context).platform) {
      TargetPlatform.iOS || TargetPlatform.macOS => true,
      _ => false,
    };

/// Opens the platform's clock-time picker. Returns null if it was dismissed.
Future<TimeOfDay?> showClockTimePicker(
  BuildContext context, {
  required TimeOfDay initial,
  required String title,
}) {
  if (!_usesCupertino(context)) {
    return showTimePicker(
      context: context,
      initialTime: initial,
      helpText: title.toUpperCase(),
      useRootNavigator: true,
    );
  }
  // CupertinoDatePicker works in dates, so the wheel rides on an arbitrary day
  // — only the time half is shown and only the time half is read back.
  var picked = initial;
  return _showWheelSheet<TimeOfDay>(
    context,
    title: title,
    onDone: () => picked,
    child: CupertinoDatePicker(
      mode: CupertinoDatePickerMode.time,
      use24hFormat: MediaQuery.alwaysUse24HourFormatOf(context),
      initialDateTime: DateTime(2000, 1, 1, initial.hour, initial.minute),
      onDateTimeChanged: (d) => picked = TimeOfDay.fromDateTime(d),
    ),
  );
}

/// A field that shows a clock time and opens the picker when tapped. Styled as
/// an [InputDecorator] so it sits in a form beside the app's text fields.
///
/// [value] is null only where the time is genuinely optional (a `modify_day`
/// rule that overrides just one end of the day): [emptyLabel] then stands in
/// for it, [fallback] is where the picker opens, and [onCleared] — which is
/// what puts the clear affordance on the field — returns to it.
class ClockTimePickerField extends StatelessWidget {
  const ClockTimePickerField({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
    this.onCleared,
    this.emptyLabel,
    this.fallback = const TimeOfDay(hour: 8, minute: 0),
    this.helperText,
  });

  final String label;
  final TimeOfDay? value;
  final ValueChanged<TimeOfDay> onChanged;

  /// Clears the value back to unset; omit to make the time required.
  final VoidCallback? onCleared;

  /// Stand-in text for a null [value] (e.g. `'Unchanged'`).
  final String? emptyLabel;

  /// Where the picker opens when [value] is null.
  final TimeOfDay fallback;

  final String? helperText;

  @override
  Widget build(BuildContext context) {
    final time = value;
    return _PickerField(
      label: label,
      helperText: helperText,
      icon: Icons.schedule_rounded,
      text: time == null
          ? (emptyLabel ?? '—')
          : formatClockTimeForDisplay(context, time),
      muted: time == null,
      onCleared: time == null ? null : onCleared,
      clearTooltip: 'Clear',
      onTap: () async {
        final picked = await showClockTimePicker(
          context,
          initial: time ?? fallback,
          title: label,
        );
        if (picked != null) onChanged(picked);
      },
    );
  }
}

/// A field that shows a length in minutes and opens a wheel when tapped.
///
/// [minutes] is null only when the value is genuinely unset — the travel-time
/// override handed back to the server's estimate — in which case [emptyLabel]
/// stands in for it and [onCleared] returns to it. Passing [directions] admits
/// negative values: the sheet grows a direction toggle and the field suffixes
/// the matching word.
class DurationPickerField extends StatelessWidget {
  const DurationPickerField({
    super.key,
    required this.label,
    required this.minutes,
    required this.onChanged,
    this.fallbackMinutes = 15,
    this.emptyLabel,
    this.onCleared,
    this.clearTooltip = 'Clear',
    this.directions,
    this.helperText,
    this.dense = false,
  });

  final String label;

  /// The current length in whole minutes; null shows [emptyLabel].
  final int? minutes;

  /// Fired with the picked length, in whole minutes.
  final ValueChanged<int> onChanged;

  /// Where the wheel starts when [minutes] is null.
  final int fallbackMinutes;

  /// Stand-in text for a null [minutes] (e.g. `'Estimated'`).
  final String? emptyLabel;

  /// Clears the value back to unset; omit to make the value required.
  final VoidCallback? onCleared;

  /// What clearing means here, for the affordance's tooltip.
  final String clearTooltip;

  /// Direction words for a signed window; omit to keep the value non-negative.
  final WindowDirections? directions;

  final String? helperText;

  /// Compact form for the task sheet's inline rows (no floating label).
  final bool dense;

  String _display() {
    final value = minutes;
    if (value == null) return emptyLabel ?? '—';
    final words = formatMinutes(value);
    final directions = this.directions;
    if (directions == null) return words;
    return '$words ${value < 0 ? directions.backward : directions.forward}';
  }

  @override
  Widget build(BuildContext context) {
    return _PickerField(
      label: dense ? null : label,
      hint: dense ? label : null,
      helperText: helperText,
      icon: Icons.timelapse_rounded,
      text: _display(),
      muted: minutes == null,
      dense: dense,
      onCleared: minutes == null ? null : onCleared,
      clearTooltip: clearTooltip,
      onTap: () async {
        final picked = await showModalBottomSheet<({int minutes})>(
          context: context,
          useSafeArea: true,
          useRootNavigator: true,
          backgroundColor: AppColors.card,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
          ),
          builder: (_) => _DurationSheet(
            title: label,
            initialMinutes: minutes ?? fallbackMinutes,
            directions: directions,
          ),
        );
        if (picked != null) onChanged(picked.minutes);
      },
    );
  }
}

/// The duration wheel itself. [CupertinoTimerPicker] is a Flutter-drawn wheel
/// rather than a platform view, so it's the same control everywhere — Material
/// has no duration picker to be adaptive with — themed dark to match the app.
class _DurationSheet extends StatefulWidget {
  const _DurationSheet({
    required this.title,
    required this.initialMinutes,
    required this.directions,
  });

  final String title;
  final int initialMinutes;
  final WindowDirections? directions;

  @override
  State<_DurationSheet> createState() => _DurationSheetState();
}

class _DurationSheetState extends State<_DurationSheet> {
  late int _magnitude = widget.initialMinutes.abs().clamp(0, 23 * 60 + 59);
  late bool _backward = widget.initialMinutes < 0;

  int get _value => _backward ? -_magnitude : _magnitude;

  @override
  Widget build(BuildContext context) {
    final directions = widget.directions;
    return SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _SheetHeader(
            title: widget.title,
            onDone: () => Navigator.of(context).pop((minutes: _value)),
          ),
          if (directions != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
              child: _DirectionToggle(
                directions: directions,
                backward: _backward,
                onChanged: (v) => setState(() => _backward = v),
              ),
            ),
          SizedBox(
            height: 190,
            child: _wheelTheme(
              CupertinoTimerPicker(
                mode: CupertinoTimerPickerMode.hm,
                initialTimerDuration: Duration(minutes: _magnitude),
                onTimerDurationChanged: (d) => _magnitude = d.inMinutes,
              ),
            ),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

/// The modal the Cupertino wheels live in: a Cancel / title / Done header over
/// the wheel, sized and coloured like the app's other bottom sheets.
Future<T?> _showWheelSheet<T>(
  BuildContext context, {
  required String title,
  required T? Function() onDone,
  required Widget child,
}) {
  return showModalBottomSheet<T>(
    context: context,
    useSafeArea: true,
    useRootNavigator: true,
    backgroundColor: AppColors.card,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (sheetContext) => SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _SheetHeader(
            title: title,
            onDone: () => Navigator.of(sheetContext).pop(onDone()),
          ),
          SizedBox(height: 190, child: _wheelTheme(child)),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
}

/// Cupertino wheels read their text style off [CupertinoTheme], not the
/// Material one, so the app's font and dark palette have to be handed over.
Widget _wheelTheme(Widget child) => CupertinoTheme(
  data: CupertinoThemeData(
    brightness: Brightness.dark,
    primaryColor: AppColors.indigo,
    textTheme: CupertinoTextThemeData(
      dateTimePickerTextStyle: font(kBodyFont, 19, 600),
      pickerTextStyle: font(kBodyFont, 19, 600),
    ),
  ),
  child: child,
);

class _SheetHeader extends StatelessWidget {
  const _SheetHeader({required this.title, required this.onDone});

  final String title;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
      child: Row(
        children: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(
              'Cancel',
              style: font(kBodyFont, 14, 600, color: AppColors.textSecondary),
            ),
          ),
          Expanded(
            child: Text(
              title,
              textAlign: TextAlign.center,
              overflow: TextOverflow.ellipsis,
              style: AppText.listItemTitle,
            ),
          ),
          TextButton(onPressed: onDone, child: const Text('Done')),
        ],
      ),
    );
  }
}

/// Before/after the anchor, for a signed window.
class _DirectionToggle extends StatelessWidget {
  const _DirectionToggle({
    required this.directions,
    required this.backward,
    required this.onChanged,
  });

  final WindowDirections directions;
  final bool backward;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    Widget half(String label, bool isBackward) => Expanded(
      child: GestureDetector(
        onTap: () => onChanged(isBackward),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 9),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: backward == isBackward
                ? AppColors.tint(AppColors.indigo, 0.22)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(
            label,
            style: font(
              kBodyFont,
              12.5,
              700,
              color: backward == isBackward
                  ? AppColors.indigo
                  : AppColors.textSecondary,
            ),
          ),
        ),
      ),
    );

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: AppColors.bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppColors.border),
      ),
      child: Row(
        children: [
          half(directions.forward, false),
          half(directions.backward, true),
        ],
      ),
    );
  }
}

/// The shared look of both fields: a text-field-shaped tap target carrying the
/// formatted value and a picker icon.
class _PickerField extends StatelessWidget {
  const _PickerField({
    required this.text,
    required this.icon,
    required this.onTap,
    this.label,
    this.hint,
    this.helperText,
    this.muted = false,
    this.dense = false,
    this.onCleared,
    this.clearTooltip = 'Clear',
  });

  final String text;
  final IconData icon;
  final VoidCallback onTap;
  final String? label;
  final String? hint;
  final String? helperText;
  final bool muted;
  final bool dense;

  /// When set, the trailing icon becomes a button that unsets the value.
  final VoidCallback? onCleared;
  final String clearTooltip;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: InputDecorator(
        decoration: InputDecoration(
          labelText: label,
          helperText: helperText,
          isDense: dense,
          suffixIcon: onCleared == null
              ? Icon(icon, size: 18, color: AppColors.textMuted)
              : IconButton(
                  onPressed: onCleared,
                  tooltip: clearTooltip,
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(
                    Icons.close_rounded,
                    size: 18,
                    color: AppColors.textMuted,
                  ),
                ),
        ),
        child: Row(
          children: [
            if (hint != null) ...[
              Text(
                hint!,
                style: font(kBodyFont, 14, 500, color: AppColors.textSecondary),
              ),
              const SizedBox(width: 10),
            ],
            Expanded(
              child: Text(
                text,
                textAlign: hint == null ? TextAlign.start : TextAlign.end,
                style: font(
                  kBodyFont,
                  15,
                  600,
                  color: muted ? AppColors.textMuted : AppColors.textPrimary,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
