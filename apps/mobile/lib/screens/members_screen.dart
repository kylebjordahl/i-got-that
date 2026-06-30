import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../models.dart';
import '../state/auth.dart';
import '../state/family.dart';

/// Family members — caretakers and dependents (children). A member can edit
/// their own display name; admins can edit anyone (incl. roles).
class MembersScreen extends ConsumerWidget {
  const MembersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final membersAsync = ref.watch(membersProvider);
    final me = ref.watch(currentMemberProvider).valueOrNull;

    return Scaffold(
      appBar: AppBar(title: const Text('Family')),
      floatingActionButton: (me?.isAdmin ?? false)
          ? FloatingActionButton.extended(
              onPressed: () async {
                final added = await showDialog<bool>(
                  context: context,
                  builder: (_) => const _AddMemberDialog(),
                );
                if (added == true) ref.invalidate(membersProvider);
              },
              icon: const Icon(Icons.person_add),
              label: const Text('Add'),
            )
          : null,
      body: membersAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e')),
        data: (members) => members.isEmpty
            ? const Center(child: Text('No family members yet'))
            : ListView(
                children: [
                  for (final m in members)
                    Builder(
                      builder: (context) {
                        final canEdit = (me?.isAdmin ?? false) || m.id == me?.id;
                        return ListTile(
                          leading: CircleAvatar(
                            child: Icon(m.requiresCaretaker ? Icons.child_care : Icons.person),
                          ),
                          title: Text(m.relationName),
                          subtitle: Text(_roles(m)),
                          trailing: canEdit ? const Icon(Icons.edit, size: 20) : null,
                          onTap: canEdit
                              ? () => _edit(context, ref, m, me?.isAdmin ?? false)
                              : null,
                        );
                      },
                    ),
                ],
              ),
      ),
    );
  }

  Future<void> _edit(BuildContext context, WidgetRef ref, Member member, bool isAdmin) async {
    final changed = await showDialog<bool>(
      context: context,
      builder: (_) => _EditMemberDialog(member: member, canEditRoles: isAdmin),
    );
    if (changed == true) {
      ref.invalidate(membersProvider);
      ref.invalidate(currentMemberProvider);
      ref.invalidate(targetsProvider);
    }
  }

  String _roles(Member m) {
    final r = <String>[];
    if (m.requiresCaretaker) r.add('Dependent');
    if (m.isCaretaker) r.add('Caretaker');
    if (m.isAdmin) r.add('Admin');
    return r.isEmpty ? 'Member' : r.join(' · ');
  }
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
              hintText: 'e.g. Adeline, Dad, Grandma',
            ),
          ),
          SwitchListTile(
            value: _dependent,
            onChanged: (v) => setState(() => _dependent = v),
            title: const Text('Dependent'),
            subtitle: const Text('A child whose events need a caretaker'),
            contentPadding: EdgeInsets.zero,
          ),
          SwitchListTile(
            value: _caretaker,
            onChanged: (v) => setState(() => _caretaker = v),
            title: const Text('Caretaker'),
            subtitle: const Text('Can be assigned tasks'),
            contentPadding: EdgeInsets.zero,
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Add'),
        ),
      ],
    );
  }
}

class _EditMemberDialog extends ConsumerStatefulWidget {
  const _EditMemberDialog({required this.member, required this.canEditRoles});
  final Member member;
  final bool canEditRoles;

  @override
  ConsumerState<_EditMemberDialog> createState() => _EditMemberDialogState();
}

class _EditMemberDialogState extends ConsumerState<_EditMemberDialog> {
  late final TextEditingController _name =
      TextEditingController(text: widget.member.relationName);
  late bool _caretaker = widget.member.isCaretaker;
  late bool _admin = widget.member.isAdmin;
  late bool _dependent = widget.member.requiresCaretaker;
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
      await ref.read(apiClientProvider).updateMember(
            familyId,
            widget.member.id,
            relationName: _name.text.trim(),
            isCaretaker: widget.canEditRoles ? _caretaker : null,
            isAdmin: widget.canEditRoles ? _admin : null,
            requiresCaretaker: widget.canEditRoles ? _dependent : null,
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
      title: const Text('Edit member'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _name,
            decoration: const InputDecoration(labelText: 'Name / relation'),
          ),
          if (widget.canEditRoles) ...[
            SwitchListTile(
              value: _dependent,
              onChanged: (v) => setState(() => _dependent = v),
              title: const Text('Dependent'),
              contentPadding: EdgeInsets.zero,
            ),
            SwitchListTile(
              value: _caretaker,
              onChanged: (v) => setState(() => _caretaker = v),
              title: const Text('Caretaker'),
              contentPadding: EdgeInsets.zero,
            ),
            SwitchListTile(
              value: _admin,
              onChanged: (v) => setState(() => _admin = v),
              title: const Text('Admin'),
              contentPadding: EdgeInsets.zero,
            ),
          ] else
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text('Only admins can change roles.', style: TextStyle(fontSize: 12)),
            ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Save'),
        ),
      ],
    );
  }
}
