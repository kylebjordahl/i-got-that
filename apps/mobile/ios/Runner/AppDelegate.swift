import Flutter
import MapKit
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    let registry = engineBridge.pluginRegistry
    GeneratedPluginRegistrant.register(with: registry)
    if let registrar = registry.registrar(forPlugin: "GeocodingChannel") {
      GeocodingChannel.register(with: registrar)
    }
  }
}

/// Native place search backed by Apple MapKit (`MKLocalSearch`). Free, no API
/// key/billing. Exposed to Flutter over the `igt/geocoding` MethodChannel; the
/// Dart `MapKitGeocodingProvider` calls `search`. Results carry coordinates so
/// the backend can emit GEO + X-APPLE-STRUCTURED-LOCATION for travel time. The
/// identical result shape is what an OpenStreetMap/Photon provider would return.
enum GeocodingChannel {
  static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(
      name: "igt/geocoding",
      binaryMessenger: registrar.messenger()
    )
    channel.setMethodCallHandler { call, result in
      guard call.method == "search",
        let args = call.arguments as? [String: Any],
        let query = (args["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
        !query.isEmpty
      else {
        result(FlutterMethodNotImplemented)
        return
      }
      let request = MKLocalSearch.Request()
      request.naturalLanguageQuery = query
      MKLocalSearch(request: request).start { response, error in
        if let error = error {
          result(
            FlutterError(
              code: "search_failed", message: error.localizedDescription, details: nil))
          return
        }
        let mapped: [[String: Any]] = (response?.mapItems ?? []).prefix(10).map { item in
          let coord = item.placemark.coordinate
          var dict: [String: Any] = ["lat": coord.latitude, "lon": coord.longitude]
          if let name = item.name { dict["title"] = name }
          if let address = item.placemark.title { dict["address"] = address }
          return dict
        }
        result(mapped)
      }
    }
  }
}
