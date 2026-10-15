import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';
import '../util/format.dart';
import 'app_bottom_nav.dart';
import 'primitives.dart';

/// Opens the phone's own mail app with a prefilled message. The server never
/// sends anything — this is the whole delivery path — and it sits behind a
/// provider so tests can stand in for the mail app.
abstract class MailLauncher {
  /// Whether a mail app accepted [uri].
  Future<bool> open(Uri uri);
}

class UrlLauncherMail implements MailLauncher {
  const UrlLauncherMail();

  @override
  Future<bool> open(Uri uri) async {
    try {
      return await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      return false;
    }
  }
}

final mailLauncherProvider = Provider<MailLauncher>(
  (ref) => const UrlLauncherMail(),
);

/// Completes the next time the app comes back to the foreground *after having
/// left it* — i.e. the person went off to the mail app and returned.
class ForegroundReturn {
  ForegroundReturn() {
    WidgetsBinding.instance.addObserver(_observer);
  }

  final _done = Completer<void>();
  late final _observer = _ReturnObserver(_onState);
  bool _left = false;

  Future<void> get returned => _done.future;

  void _onState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (_left) cancel(completed: true);
    } else {
      _left = true;
    }
  }

  void cancel({bool completed = false}) {
    WidgetsBinding.instance.removeObserver(_observer);
    if (completed && !_done.isCompleted) _done.complete();
  }
}

class _ReturnObserver with WidgetsBindingObserver {
  _ReturnObserver(this._onState);
  final void Function(AppLifecycleState) _onState;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _onState(state);
}

/// `mailto:` for a notice, prefilled with to / cc / subject / body. Built by
/// hand: [Uri]'s query encoder turns spaces into `+`, which mail apps show
/// literally. Line breaks are CRLF, as RFC 6068 asks.
Uri absenceMailto(AbsenceNotice n) {
  String enc(String s) => Uri.encodeComponent(s.replaceAll('\n', '\r\n'));
  final params = [
    if (n.cc.isNotEmpty) 'cc=${n.cc.join(',')}',
    'subject=${enc(n.subject)}',
    'body=${enc(n.body)}',
  ];
  return Uri.parse('mailto:${n.to.join(',')}?${params.join('&')}');
}

/// "Sent by Mom, Today 3:12 PM" / "Times changed since Mom sent it" — null when
/// nobody has sent it yet.
String? absenceSentLine(AbsenceNotice n, {DateTime? now}) {
  if (n.state == 'outstanding') return null;
  final who = n.sentBy ?? 'someone';
  final at = n.sentAt;
  final when = at == null
      ? ''
      : ', ${dayHeading(dayKey(at), now ?? DateTime.now())} ${friendlyTime(at)}';
  return n.needsUpdate
      ? 'Times changed since $who sent it$when'
      : 'Sent by $who$when';
}

/// Compose the notice in the mail app, then — once the app is back in the
/// foreground — ask whether it was actually sent. Only "Yes" records anything;
/// cancelling in Mail, or answering "Not yet", leaves the notice outstanding.
Future<void> composeAbsenceNotice(
  BuildContext context,
  WidgetRef ref,
  AbsenceNotice notice,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final back = ForegroundReturn();
  final opened = await ref
      .read(mailLauncherProvider)
      .open(absenceMailto(notice));
  if (!opened) {
    back.cancel();
    if (!context.mounted) return;
    messenger.showSnackBar(
      SnackBar(
        content: const Text('No mail app is available on this device.'),
        margin: snackBarMarginAboveNav(context),
      ),
    );
    return;
  }
  await back.returned;
  if (!context.mounted) return;
  final sent = await showDidYouSendDialog(context, notice);
  if (sent != true || !context.mounted) return;
  try {
    final familyId = await ref.read(familyProvider.future);
    await ref
        .read(apiClientProvider)
        .markAbsenceNoticeSent(
          familyId,
          notice.eventId,
          gapStamp: notice.gapStamp,
        );
    // Refetch what shows the state; the badge listens to the list.
    ref.invalidate(absenceNoticesProvider);
    ref.invalidate(absenceNoticeProvider);
  } on DioException catch (e) {
    ref.invalidate(absenceNoticesProvider);
    ref.invalidate(absenceNoticeProvider);
    if (!context.mounted) return;
    final changed = e.response?.statusCode == 409;
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          changed
              ? 'The times changed while you were writing. Compose it again.'
              : 'Couldn’t record that it was sent. Try again.',
        ),
        margin: snackBarMarginAboveNav(context),
      ),
    );
  }
}

/// "Did you send it?" — true only for an explicit yes.
Future<bool?> showDidYouSendDialog(BuildContext context, AbsenceNotice notice) {
  return showDialog<bool>(
    context: context,
    useRootNavigator: true,
    builder: (ctx) => AlertDialog(
      title: const Text('Did you send it?'),
      content: Text(
        'If you sent the email about ${notice.child}’s absence '
        '(${_dateLabel(notice.date)}), mark it sent so nobody sends it twice.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(false),
          child: const Text('Not yet'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(ctx).pop(true),
          child: const Text('Yes, I sent it'),
        ),
      ],
    ),
  );
}

String _dateLabel(String ymd) {
  final p = ymd.split('-').map(int.parse).toList();
  return dayHeading(DateTime(p[0], p[1], p[2]), DateTime.now());
}

/// The "Email school" block of an event's detail sheet. Renders nothing unless
/// the event leads to an eligible notice (and the viewer can send it), so a
/// link without recipients never shows a button.
class AbsenceNoticeSection extends ConsumerWidget {
  const AbsenceNoticeSection({super.key, required this.eventId});

  final String eventId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notice = ref.watch(absenceNoticeProvider(eventId)).valueOrNull;
    if (notice == null) return const SizedBox.shrink();
    final line = absenceSentLine(notice);
    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: AppCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(
                  Icons.mail_outline_rounded,
                  size: 20,
                  color: AppColors.indigo,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    '${notice.child} will be ${notice.schedule}',
                    style: AppText.subtitle,
                  ),
                ),
              ],
            ),
            if (line != null) ...[
              const SizedBox(height: 8),
              Text(
                line,
                key: const Key('absence-sent-line'),
                style: AppText.subtitle.copyWith(
                  color: notice.needsUpdate ? AppColors.amber : AppColors.green,
                ),
              ),
            ],
            const SizedBox(height: 12),
            PillButton(
              label: notice.isSent
                  ? 'Email school again'
                  : notice.needsUpdate
                  ? 'Email school an update'
                  : 'Email school',
              icon: Icons.mail_rounded,
              variant: notice.isSent ? PillVariant.ghost : PillVariant.indigo,
              dense: true,
              onPressed: () => composeAbsenceNotice(context, ref, notice),
            ),
          ],
        ),
      ),
    );
  }
}

/// A Home card for an absence email still to send.
class AbsenceNoticeCard extends ConsumerWidget {
  const AbsenceNoticeCard({super.key, required this.notice});

  final AbsenceNotice notice;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final line = absenceSentLine(notice);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.tint(AppColors.indigo, 0.07),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.indigo.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.mail_outline_rounded,
                size: 20,
                color: AppColors.indigo,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  '${notice.child} · ${_dateLabel(notice.date)}',
                  style: AppText.sectionItemTitle,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'Will be ${notice.schedule}. Let the school know.',
            style: AppText.subtitle,
          ),
          if (line != null) ...[
            const SizedBox(height: 4),
            Text(
              line,
              style: AppText.subtitle.copyWith(color: AppColors.amber),
            ),
          ],
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: PillButton(
                  label: notice.needsUpdate ? 'Compose update' : 'Compose',
                  icon: Icons.mail_rounded,
                  variant: PillVariant.indigo,
                  dense: true,
                  onPressed: () => composeAbsenceNotice(context, ref, notice),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
