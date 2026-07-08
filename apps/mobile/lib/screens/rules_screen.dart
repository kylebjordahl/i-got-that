import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../app_shell.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../widgets/primitives.dart';
import '../widgets/settings.dart';

/// Family rules — family-wide behavior settings. Per-feed override rules moved
/// into each linked feed's pipeline (member detail → source calendar); what
/// remains here is family-level tuning, currently the task-threading window.
class RulesScreen extends ConsumerWidget {
  const RulesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(currentMemberProvider).valueOrNull;
    final isAdmin = me?.isAdmin ?? false;
    final threshold = ref.watch(threadingThresholdProvider).valueOrNull ?? 30;

    return Scaffold(
      extendBody: true,
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(22, 12, 22, 130),
          children: [
            const SubPageHeader(title: 'Family rules'),
            const SizedBox(height: 10),
            Text(
              'Family-wide behavior. Event→task rules live on each linked feed '
              '(open a member, tap a source calendar).',
              style: AppText.subtitle,
            ),
            const SizedBox(height: 22),
            const SectionEyebrow('Task threading', color: AppColors.coral),
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SettingRow(
                    icon: Icons.linear_scale_rounded,
                    iconColor: AppColors.coral,
                    title: 'Stitch tasks into a trip',
                    subtitle: 'Tasks within $threshold min render as one chain',
                  ),
                  const SizedBox(height: 6),
                  _ThresholdSlider(
                    key: ValueKey(threshold),
                    initial: threshold,
                    enabled: isAdmin,
                    onCommit: (v) => _saveThreshold(ref, v),
                  ),
                  Text(
                    'A pickup followed by an appointment within this window '
                    'shows as one threaded trip — each leg stays independently '
                    'claimable.',
                    style: AppText.subtitle,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: familyListNav(context, ref),
    );
  }

  Future<void> _saveThreshold(WidgetRef ref, int minutes) async {
    final familyId = await ref.read(familyProvider.future);
    await ref
        .read(apiClientProvider)
        .updateFamily(familyId, threadingThresholdMinutes: minutes);
    ref.invalidate(threadingThresholdProvider);
  }
}

class _ThresholdSlider extends StatefulWidget {
  const _ThresholdSlider({
    super.key,
    required this.initial,
    required this.enabled,
    required this.onCommit,
  });
  final int initial;
  final bool enabled;
  final ValueChanged<int> onCommit;

  @override
  State<_ThresholdSlider> createState() => _ThresholdSliderState();
}

class _ThresholdSliderState extends State<_ThresholdSlider> {
  late double _value = widget.initial.toDouble().clamp(0, 120);

  @override
  Widget build(BuildContext context) {
    return Slider(
      value: _value,
      min: 0,
      max: 120,
      divisions: 24,
      label: '${_value.round()} min',
      onChanged: widget.enabled ? (v) => setState(() => _value = v) : null,
      onChangeEnd: widget.enabled ? (v) => widget.onCommit(v.round()) : null,
    );
  }
}
