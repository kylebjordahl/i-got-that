import 'package:flutter/foundation.dart';

/// What the user *actually did* while walking the first-run wizard, as opposed
/// to what the wizard offered them. The summary (1h) receipts each chunk from
/// this, so a step the user skipped reads as skipped instead of collecting an
/// unearned checkmark.
///
/// Only the skippable chunks are tracked. Creating the family (1c) is required
/// to reach the summary at all, and 1f blocks Continue until a calendar is
/// picked, so every child the loop visited necessarily has one.
///
/// Tracked as the user advances rather than re-derived from the API on the
/// summary: the question 1h answers is "what did you just do", and a member
/// could already have had a calendar target from an earlier session.
@immutable
class WizardOutcomes {
  const WizardOutcomes({
    this.accountsConnected = false,
    this.adultCalendars = const {},
  });

  /// Whether the user left step 1b with at least one calendar account linked.
  final bool accountsConnected;

  /// Caretaker member id → whether 1g committed a unified calendar for them.
  /// Absent ids were never reached (the user bailed out before their turn).
  final Map<String, bool> adultCalendars;

  WizardOutcomes copyWith({
    bool? accountsConnected,
    Map<String, bool>? adultCalendars,
  }) =>
      WizardOutcomes(
        accountsConnected: accountsConnected ?? this.accountsConnected,
        adultCalendars: adultCalendars ?? this.adultCalendars,
      );

  /// Record the outcome of one caretaker's unified-calendar step (1g).
  WizardOutcomes withAdultCalendar(String memberId, {required bool done}) =>
      copyWith(adultCalendars: {...adultCalendars, memberId: done});
}
