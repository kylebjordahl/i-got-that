import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models.dart';

/// One geocoded search result. Carries coordinates so the backend can emit
/// GEO + X-APPLE-STRUCTURED-LOCATION (Apple travel time). This is the shape any
/// provider returns — MapKit today, an OpenStreetMap/Photon provider later.
class GeoPlace {
  const GeoPlace({
    required this.title,
    this.address,
    required this.lat,
    required this.lon,
  });

  final String title;
  final String? address;
  final double lat;
  final double lon;

  GeoLocation toGeoLocation() =>
      GeoLocation(lat: lat, lon: lon, title: title, address: address);
}

/// Validates/geocodes a free-text query into candidate places. Implementations
/// are platform-specific; callers must check [isAvailable] and fall back to a
/// plain text location (no coordinates, so no travel time) when false.
abstract class GeocodingProvider {
  bool get isAvailable;
  Future<List<GeoPlace>> search(String query);
}

/// iOS: Apple MapKit `MKLocalSearch` over the `igt/geocoding` MethodChannel
/// (see `ios/Runner/AppDelegate.swift`). Free, no API key or billing.
class MapKitGeocodingProvider implements GeocodingProvider {
  const MapKitGeocodingProvider();

  static const MethodChannel _channel = MethodChannel('igt/geocoding');

  @override
  bool get isAvailable => true;

  @override
  Future<List<GeoPlace>> search(String query) async {
    if (query.trim().isEmpty) return const [];
    final raw = await _channel.invokeListMethod<dynamic>('search', {'query': query});
    if (raw == null) return const [];
    return raw
        .map((e) => (e as Map).cast<String, dynamic>())
        .where((m) => m['lat'] is num && m['lon'] is num)
        .map((m) => GeoPlace(
              title: (m['title'] as String?) ?? (m['address'] as String?) ?? 'Location',
              address: m['address'] as String?,
              lat: (m['lat'] as num).toDouble(),
              lon: (m['lon'] as num).toDouble(),
            ))
        .toList();
  }
}

/// Platforms without native geocoding (web today, Android later until an
/// OpenStreetMap/Photon provider lands): the picker degrades to plain text.
class UnavailableGeocodingProvider implements GeocodingProvider {
  const UnavailableGeocodingProvider();

  @override
  bool get isAvailable => false;

  @override
  Future<List<GeoPlace>> search(String query) async => const [];
}

GeocodingProvider createGeocodingProvider() {
  if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
    return const MapKitGeocodingProvider();
  }
  return const UnavailableGeocodingProvider();
}

/// Overridable in tests/widget previews.
final geocoderProvider =
    Provider<GeocodingProvider>((ref) => createGeocodingProvider());
