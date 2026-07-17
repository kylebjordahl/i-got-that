import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../state/family.dart';
import '../../theme/app_colors.dart';
import '../../theme/app_text.dart';
import '../onboarding_scaffold.dart';

/// 2d — joined. Two taps of real input (one login, one pick) and the second
/// parent is coordinating. Lands straight in the working app. Both steps are
/// skippable, so each line is receipted from what actually happened.
class JoinedStep extends ConsumerWidget {
  const JoinedStep({super.key, required this.calendarPicked, required this.onGoHome});

  /// Whether 2c actually committed a unified calendar for the joining parent.
  final bool calendarPicked;
  final VoidCallback onGoHome;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final self = ref.watch(currentMemberProvider).valueOrNull;
    final info = ref.watch(familyInfoProvider).valueOrNull;
    final target = self == null ? null : ref.watch(memberCalendarProvider(self.id)).valueOrNull;
    final name = self?.relationName ?? 'there';
    final targetName = target?.targetCalendarName;

    return Scaffold(
      backgroundColor: AppColors.bg,
      body: Container(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment(0, -1),
            radius: 1.0,
            colors: [Color(0xFF16261F), AppColors.bg],
            stops: [0.0, 0.55],
          ),
        ),
        child: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 26),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Container(
                        width: 64,
                        height: 64,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: AppColors.tint(AppColors.green, 0.15),
                          shape: BoxShape.circle,
                          border: Border.all(color: AppColors.green.withValues(alpha: 0.4)),
                        ),
                        child: const Icon(Icons.check_rounded, size: 32, color: AppColors.green),
                      ),
                      const SizedBox(height: 22),
                      Text("You're in, $name",
                          style: font(kDisplayFont, 30, 600, letterSpacing: -0.3)),
                      const SizedBox(height: 10),
                      if (calendarPicked)
                        Text.rich(
                          TextSpan(
                            text: "That's all it took. The family setup was already "
                                'done — your claimed tasks will land on ',
                            style: font(kBodyFont, 15, 500,
                                color: const Color(0xFFA79FB5), height: 1.55),
                            children: [
                              TextSpan(
                                  text: targetName ?? 'your calendar',
                                  style: font(kBodyFont, 15, 600, color: const Color(0xFFBFE0FF))),
                              const TextSpan(text: '.'),
                            ],
                          ),
                        )
                      else
                        Text(
                            "That's all it took. The family setup was already done — "
                            'pick a calendar whenever you want your claimed tasks to '
                            'land somewhere of your own.',
                            style: font(kBodyFont, 15, 500,
                                color: const Color(0xFFA79FB5), height: 1.55)),
                      const SizedBox(height: 24),
                      GroupedCard(children: [
                        ReceiptRow(
                            done: true,
                            text: 'Joined ${info?.name ?? 'the family'} as a caretaker'),
                        if (calendarPicked)
                          const ReceiptRow(done: true, text: 'Your unified calendar connected')
                        else
                          const ReceiptRow(
                              done: false,
                              text: 'No unified calendar yet',
                              note: 'Pick one anytime from Me.'),
                      ]),
                      const SizedBox(height: 16),
                      Text('Delivery reminders, task lists & email notices can be '
                          'added anytime from your caretaker settings.',
                          style: font(kBodyFont, 12.5, 500,
                              color: AppColors.textTertiary, height: 1.5)),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 12, 22, 20),
                child: OnboardingButton(label: 'Go to Home', onPressed: onGoHome),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
