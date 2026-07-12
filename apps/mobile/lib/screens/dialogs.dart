import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';
import '../theme/app_colors.dart';
import '../widgets/primitives.dart';

/// Shared, themed member dialogs — reused by the People list and the quick-add
/// sheet so the create/redeem flows live in one place.

Future<bool> showAddMemberDialog(BuildContext context, WidgetRef ref) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => const _AddMemberDialog(),
  );
  if (ok == true) ref.invalidate(membersProvider);
  return ok == true;
}

Future<bool> showEditNameDialog(BuildContext context, WidgetRef ref, Member m) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => _EditNameDialog(member: m),
  );
  if (ok == true) {
    ref.invalidate(membersProvider);
    ref.invalidate(currentMemberProvider);
  }
  return ok == true;
}

Future<bool> showRedeemInviteDialog(BuildContext context, WidgetRef ref) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => const _RedeemInviteDialog(),
  );
  if (ok == true) {
    ref.invalidate(familyProvider);
    ref.invalidate(membersProvider);
    ref.invalidate(currentMemberProvider);
  }
  return ok == true;
}

/// Link another magic-link email to the current account. Mirrors the login
/// magic-link flow (request → verify with the dev token), but attaches the
/// email to the signed-in user instead of starting a new account. Returns true
/// when a method was linked.
Future<bool> showAddLoginMethodDialog(BuildContext context, WidgetRef ref) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (_) => const _AddLoginMethodDialog(),
  );
  if (ok == true) ref.invalidate(loginIdentitiesProvider);
  return ok == true;
}

class _AddMemberDialog extends ConsumerStatefulWidget {
  const _AddMemberDialog();
  @override
  ConsumerState<_AddMemberDialog> createState() => _AddMemberDialogState();
}

class _AddMemberDialogState extends ConsumerState<_AddMemberDialog> {
  final _name = TextEditingController();
  bool _caretaker = false;
  bool _dependent = true;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_name.text.trim().isEmpty) {
      setState(() => _error = 'A name is required');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref.read(apiClientProvider).createMember(
            familyId,
            relationName: _name.text.trim(),
            isCaretaker: _caretaker,
            requiresCaretaker: _dependent,
          );
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Add family member'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _name,
            autofocus: true,
            decoration: const InputDecoration(
              labelText: 'Name / relation',
            ),
          ),
          SwitchListTile(
            value: _dependent,
            onChanged: (v) => setState(() => _dependent = v),
            title: const Text('Child'),
            subtitle: const Text('A child whose events need a caretaker'),
            contentPadding: EdgeInsets.zero,
          ),
          SwitchListTile(
            value: _caretaker,
            onChanged: (v) => setState(() => _caretaker = v),
            title: const Text('Caretaker'),
            subtitle: const Text('Can claim tasks'),
            contentPadding: EdgeInsets.zero,
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: const TextStyle(color: AppColors.coral)),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        PillButton(
          label: _busy ? 'Adding…' : 'Add',
          variant: PillVariant.amber,
          onPressed: _busy ? null : _save,
        ),
      ],
    );
  }
}

class _EditNameDialog extends ConsumerStatefulWidget {
  const _EditNameDialog({required this.member});
  final Member member;
  @override
  ConsumerState<_EditNameDialog> createState() => _EditNameDialogState();
}

class _EditNameDialogState extends ConsumerState<_EditNameDialog> {
  late final _name = TextEditingController(text: widget.member.relationName);
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_name.text.trim().isEmpty) return;
    setState(() => _busy = true);
    try {
      final familyId = await ref.read(familyProvider.future);
      await ref
          .read(apiClientProvider)
          .updateMember(familyId, widget.member.id, relationName: _name.text.trim());
      if (mounted) Navigator.of(context).pop(true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Edit name'),
      content: TextField(
        controller: _name,
        autofocus: true,
        decoration: const InputDecoration(labelText: 'Name / relation'),
        onSubmitted: (_) => _save(),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        PillButton(
          label: 'Save',
          variant: PillVariant.amber,
          onPressed: _busy ? null : _save,
        ),
      ],
    );
  }
}

class _AddLoginMethodDialog extends ConsumerStatefulWidget {
  const _AddLoginMethodDialog();
  @override
  ConsumerState<_AddLoginMethodDialog> createState() => _AddLoginMethodDialogState();
}

class _AddLoginMethodDialogState extends ConsumerState<_AddLoginMethodDialog> {
  final _email = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _link() async {
    final email = _email.text.trim();
    if (email.isEmpty) {
      setState(() => _error = 'Enter an email');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final api = ref.read(apiClientProvider);
      final devToken = await api.requestMagicLink(email);
      if (devToken == null) {
        // Production sends the link by email; there's no in-app token to attach.
        throw Exception('Magic link sent — open it on this device to finish.');
      }
      await api.linkMagicLink(devToken);
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (e) {
      final code = (e.response?.data as Map<String, dynamic>?)?['error'];
      setState(() => _error = code == 'identity_linked_to_other_user'
          ? 'That email is already linked to a different account.'
          : '$e');
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Add a login method'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Link another email so you can sign in with it and land on this same '
            'account.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _email,
            autofocus: true,
            keyboardType: TextInputType.emailAddress,
            decoration: const InputDecoration(
              labelText: 'Email',
              hintText: 'you@example.com',
            ),
            onSubmitted: (_) => _link(),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(_error!, style: const TextStyle(color: AppColors.coral)),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        PillButton(
          label: _busy ? 'Linking…' : 'Link',
          variant: PillVariant.amber,
          onPressed: _busy ? null : _link,
        ),
      ],
    );
  }
}

class _RedeemInviteDialog extends ConsumerStatefulWidget {
  const _RedeemInviteDialog();
  @override
  ConsumerState<_RedeemInviteDialog> createState() => _RedeemInviteDialogState();
}

class _RedeemInviteDialogState extends ConsumerState<_RedeemInviteDialog> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;
  String? _preview;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _check() async {
    setState(() {
      _error = null;
      _preview = null;
    });
    try {
      final p = await ref.read(apiClientProvider).previewInvite(_code.text.trim());
      setState(() => _preview =
          'Join "${p['familyName']}" as ${p['relationName'] ?? 'a caretaker'} (${p['status']})');
    } catch (_) {
      setState(() => _error = 'Code not found');
    }
  }

  Future<void> _accept() async {
    if (_code.text.trim().isEmpty) {
      setState(() => _error = 'Paste a code');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await ref.read(apiClientProvider).acceptInvite(_code.text.trim());
      // Land the user on the family they just joined — without this, the
      // account's already-cached "first family" stays selected and nothing
      // visibly changes even though the claim succeeded.
      final joinedFamilyId = res['familyId'] as String?;
      if (joinedFamilyId != null) {
        ref.read(selectedFamilyIdProvider.notifier).state = joinedFamilyId;
      }
      ref.invalidate(familiesListProvider);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Redeem invite code'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _code,
            autofocus: true,
            decoration: InputDecoration(
              labelText: 'Invite code',
              suffixIcon: IconButton(icon: const Icon(Icons.search), onPressed: _check),
            ),
            onSubmitted: (_) => _check(),
          ),
          if (_preview != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(_preview!, style: Theme.of(context).textTheme.bodySmall),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Text(_error!, style: const TextStyle(color: AppColors.coral)),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        PillButton(
          label: _busy ? 'Joining…' : 'Join',
          variant: PillVariant.amber,
          onPressed: _busy ? null : _accept,
        ),
      ],
    );
  }
}
