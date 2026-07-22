import 'dart:async';

import 'package:flutter/material.dart';

import '../models.dart';
import '../services/geocoding.dart';
import '../theme/app_colors.dart';
import '../theme/app_text.dart';

/// Location input for an exception-feed baseline. When the platform has a
/// geocoder (MapKit on iOS) a search affordance lets the user pick a validated
/// place, capturing coordinates ([GeoLocation]) so the backend can emit travel
/// time. Typing free text keeps working everywhere but clears the coordinates
/// (a hand-typed string isn't validated). On platforms without a geocoder the
/// field is a plain text input.
class LocationPickerField extends StatelessWidget {
  const LocationPickerField({
    super.key,
    required this.controller,
    required this.geo,
    required this.geocoder,
    required this.onChanged,
    this.label = 'Default location',
    this.hint = 'Prefilled onto every task',
  });

  final TextEditingController controller;
  final GeoLocation? geo;
  final GeocodingProvider geocoder;

  /// Fired on every change: the display text and the geocode (null when the
  /// user typed free text or cleared the field).
  final void Function(String text, GeoLocation? geo) onChanged;

  final String label;
  final String hint;

  Future<void> _openSearch(BuildContext context) async {
    final place = await showModalBottomSheet<GeoPlace>(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.card,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _LocationSearchSheet(
        geocoder: geocoder,
        initialQuery: controller.text.trim(),
      ),
    );
    if (place != null) {
      controller.text = place.title;
      onChanged(place.title, place.toGeoLocation());
    }
  }

  @override
  Widget build(BuildContext context) {
    final geocoded = geo != null;
    return TextField(
      controller: controller,
      // Manual edits mean the text no longer matches the geocode: drop it.
      onChanged: (t) => onChanged(t, null),
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        helperText: geocoded
            ? 'Validated — travel time enabled'
            : geocoder.isAvailable
                ? 'Search to validate for travel time'
                : null,
        helperStyle: geocoded
            ? font(kBodyFont, 12, 600, color: AppColors.green)
            : null,
        prefixIcon: Icon(
          geocoded ? Icons.place_rounded : Icons.place_outlined,
          size: 20,
          color: geocoded ? AppColors.green : AppColors.textMuted,
        ),
        suffixIcon: geocoder.isAvailable
            ? IconButton(
                icon: const Icon(Icons.search_rounded, size: 20),
                color: AppColors.textSecondary,
                tooltip: 'Search for a place',
                onPressed: () => _openSearch(context),
              )
            : null,
      ),
    );
  }
}

class _LocationSearchSheet extends StatefulWidget {
  const _LocationSearchSheet({required this.geocoder, required this.initialQuery});

  final GeocodingProvider geocoder;
  final String initialQuery;

  @override
  State<_LocationSearchSheet> createState() => _LocationSearchSheetState();
}

class _LocationSearchSheetState extends State<_LocationSearchSheet> {
  late final TextEditingController _query =
      TextEditingController(text: widget.initialQuery);
  Timer? _debounce;
  List<GeoPlace> _results = const [];
  bool _busy = false;
  String? _error;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    if (widget.initialQuery.isNotEmpty) _run(widget.initialQuery);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _query.dispose();
    super.dispose();
  }

  void _onChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () => _run(q));
  }

  Future<void> _run(String q) async {
    if (q.trim().isEmpty) {
      setState(() {
        _results = const [];
        _error = null;
      });
      return;
    }
    final seq = ++_seq;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final places = await widget.geocoder.search(q);
      if (!mounted || seq != _seq) return; // a newer query superseded this one
      setState(() {
        _results = places;
        _busy = false;
      });
    } catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _error = 'Search failed. Try again.';
        _busy = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final insets = MediaQuery.of(context).viewInsets;
    return Padding(
      padding: EdgeInsets.only(bottom: insets.bottom),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Search for a place', style: AppText.subtitle),
              const SizedBox(height: 12),
              TextField(
                controller: _query,
                autofocus: true,
                textInputAction: TextInputAction.search,
                onChanged: _onChanged,
                onSubmitted: _run,
                decoration: const InputDecoration(
                  hintText: 'e.g. Lincoln Elementary, Springfield',
                  prefixIcon: Icon(Icons.search_rounded, size: 20),
                ),
              ),
              const SizedBox(height: 8),
              if (_busy)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 20),
                  child: Center(
                    child: SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                )
              else if (_error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  child: Text(_error!,
                      style: font(kBodyFont, 13, 500, color: AppColors.coral)),
                )
              else
                Flexible(
                  child: ListView.separated(
                    shrinkWrap: true,
                    itemCount: _results.length,
                    separatorBuilder: (_, __) =>
                        const Divider(height: 1, color: AppColors.divider),
                    itemBuilder: (_, i) {
                      final p = _results[i];
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const Icon(Icons.place_outlined,
                            size: 20, color: AppColors.textMuted),
                        title: Text(p.title,
                            style: font(kBodyFont, 14, 600,
                                color: AppColors.textPrimary)),
                        subtitle: p.address == null
                            ? null
                            : Text(p.address!,
                                style: font(kBodyFont, 12, 500,
                                    color: AppColors.textSecondary)),
                        onTap: () => Navigator.of(context).pop(p),
                      );
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
