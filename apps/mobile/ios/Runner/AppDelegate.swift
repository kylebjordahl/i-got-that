import Flutter
import MapKit
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    let registry = engineBridge.pluginRegistry
    GeneratedPluginRegistrant.register(with: registry)
    if let registrar = registry.registrar(forPlugin: "GeocodingChannel") {
      GeocodingChannel.register(with: registrar)
    }
    if let registrar = registry.registrar(forPlugin: "PushChannel") {
      PushChannel.register(with: registrar)
    }
  }

  // APNs hands the token back asynchronously, so `register` on the Dart side
  // resolves here rather than at the call site.
  override func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    PushChannel.didRegister(token: deviceToken.map { String(format: "%02x", $0) }.joined())
    super.application(
      application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
  }

  override func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    PushChannel.didFailToRegister(message: error.localizedDescription)
    super.application(
      application, didFailToRegisterForRemoteNotificationsWithError: error)
  }
}

/// Remote push registration + permission, exposed to Flutter over the
/// `igt/push` MethodChannel — the same shape as `GeocodingChannel` below.
///
/// Deliberately not a plugin dependency: the app only needs a device token and
/// an authorization status, and the system draws the banner itself from the
/// APNs `alert` payload. Notification *content* is decided server-side (see
/// `services/digest.ts`), so there is nothing here to configure.
enum PushChannel {
  private static var channel: FlutterMethodChannel?
  /// Pending `register` calls waiting on APNs. Registration is per-process, so
  /// several Dart calls can be in flight against one round trip.
  private static var pendingRegistrations: [FlutterResult] = []
  /// A notification tapped before Flutter was listening (cold start).
  private static var pendingTapPayload: [String: Any]?

  static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(
      name: "igt/push",
      binaryMessenger: registrar.messenger()
    )
    self.channel = channel
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "authorizationStatus":
        UNUserNotificationCenter.current().getNotificationSettings { settings in
          DispatchQueue.main.async { result(statusName(settings.authorizationStatus)) }
        }
      case "requestPermission":
        UNUserNotificationCenter.current().requestAuthorization(
          options: [.alert, .badge, .sound]
        ) { granted, error in
          DispatchQueue.main.async {
            if let error = error {
              result(
                FlutterError(
                  code: "permission_failed", message: error.localizedDescription,
                  details: nil))
            } else {
              result(granted)
            }
          }
        }
      case "register":
        // The token arrives in the AppDelegate callbacks above.
        pendingRegistrations.append(result)
        UIApplication.shared.registerForRemoteNotifications()
      case "apsEnvironment":
        result(
          Bundle.main.object(forInfoDictionaryKey: "IGTApsEnvironment") as? String
            ?? "production")
      case "timezone":
        // The IANA identifier (e.g. "America/Los_Angeles"). Dart only exposes
        // an abbreviation, and the server needs a real zone to read a
        // schedule's send time and day window in.
        result(TimeZone.current.identifier)
      case "openSettings":
        // Once notifications are denied the app can't prompt again; Settings is
        // the only way back.
        if let url = URL(string: UIApplication.openSettingsURLString) {
          UIApplication.shared.open(url)
        }
        result(nil)
      case "takeInitialTap":
        result(pendingTapPayload)
        pendingTapPayload = nil
      case "setBadge":
        // The app-icon badge is the count of things still waiting on a human,
        // which the client recomputes from the server whenever it can (see
        // `state/badge.dart`) — a digest's badge would otherwise stay lit long
        // after the work behind it was claimed.
        let count = (call.arguments as? [String: Any])?["count"] as? Int ?? 0
        setBadge(count)
        if count == 0 {
          // Whatever raised the badge is done with, so the digests that
          // carried it are stale too — leaving them stacked in Notification
          // Center is its own kind of unread marker.
          UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        }
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  /// Set the app-icon badge, on whichever API this OS version offers.
  /// `setBadgeCount` is iOS 16+; the deployment target is still 15.
  private static func setBadge(_ count: Int) {
    if #available(iOS 16.0, *) {
      UNUserNotificationCenter.current().setBadgeCount(count)
    } else {
      UIApplication.shared.applicationIconBadgeNumber = count
    }
  }

  static func didRegister(token: String) {
    let waiting = pendingRegistrations
    pendingRegistrations = []
    DispatchQueue.main.async { waiting.forEach { $0(token) } }
  }

  static func didFailToRegister(message: String) {
    let waiting = pendingRegistrations
    pendingRegistrations = []
    DispatchQueue.main.async {
      waiting.forEach {
        $0(FlutterError(code: "registration_failed", message: message, details: nil))
      }
    }
  }

  /// A tapped notification. Held until Flutter asks for it if the channel isn't
  /// up yet — a cold start from the lock screen gets here before the engine.
  static func didTap(payload: [String: Any]) {
    guard let channel = channel else {
      pendingTapPayload = payload
      return
    }
    channel.invokeMethod("onNotificationTap", arguments: payload)
  }

  private static func statusName(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    case .denied: return "denied"
    case .notDetermined: return "notDetermined"
    @unknown default: return "notDetermined"
    }
  }
}

extension AppDelegate {
  /// Show the banner even when the app is already open — a digest that arrives
  /// while you're looking at yesterday's plan is exactly when it's useful.
  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler:
      @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .badge, .sound])
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    PushChannel.didTap(
      payload: userInfo.reduce(into: [String: Any]()) { acc, entry in
        if let key = entry.key as? String { acc[key] = entry.value }
      })
    completionHandler()
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
