import AppIntents
import Foundation
import Security

// Siri answers to "Who's picking up Felix tomorrow?" — App Intents that call the
// API's `/assistant/*` endpoints directly, without starting Flutter. The
// sentence Siri speaks is composed server-side (`services/assistant.ts`), so the
// copy is shared and fixable without an app update; this file only resolves
// who and which day, and reads the answer back.
//
// Siri allows at most one parameter in a spoken App Shortcut phrase, and only
// an entity or enum. The person is that parameter; the day is either fixed by
// the intent ("…tomorrow", "…today") or asked for ("Which day?"). Hence the
// fixed-day intents below: "tomorrow" is the question people actually ask, and
// a follow-up prompt for it would make the common case a two-turn exchange.
//
// iOS 17+ (the app's floor is 15): `authenticationPolicy` and the
// `AppShortcut` initializer used here are 17-era API, and nothing older is
// worth a second code path.

// MARK: - Session (read from what the Flutter side already stores)

/// The session the Flutter app persists via `flutter_secure_storage`
/// (`lib/state/auth.dart`). Read straight from its Keychain items rather than
/// handed over a channel, so signing out in the app signs Siri out too with no
/// extra bookkeeping. Coupled to that plugin's layout — generic-password items
/// under its default service name, keyed by the Dart key — which has to be
/// revisited if the plugin's major version or its `IOSOptions` change.
enum AssistantSession {
  private static let service = "flutter_secure_storage_service"

  static var token: String? { read("session_token") }
  static var apiBaseUrl: String? { read("api_base_url") }

  private static func read(_ account: String) -> String? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: account,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }
}

// MARK: - API

@available(iOS 17.0, *)
enum AssistantError: Error, CustomLocalizedStringResourceConvertible {
  case signedOut
  case memberGone
  case unreachable

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .signedOut: return "Open IGT and sign in first."
    case .memberGone: return "I couldn't find them in your family any more."
    case .unreachable: return "I couldn't reach IGT just now. Try again in a moment."
    }
  }
}

@available(iOS 17.0, *)
enum AssistantAPI {
  private struct MemberDTO: Decodable {
    let id: String
    let name: String
    let familyName: String
  }

  private struct MembersResponse: Decodable { let members: [MemberDTO] }
  private struct CoverageResponse: Decodable { let speech: String }

  static func members() async throws -> [FamilyMemberEntity] {
    let body: MembersResponse = try await get("/assistant/members", query: [])
    return body.members.map { FamilyMemberEntity(id: $0.id, name: $0.name, familyName: $0.familyName) }
  }

  /// The sentence to speak for `member`'s tasks of `type` on `day`.
  static func coverage(
    memberId: String, day: Date, type: String, text: String?
  ) async throws -> String {
    var query = [
      URLQueryItem(name: "memberId", value: memberId),
      URLQueryItem(name: "date", value: localDateKey(day)),
      URLQueryItem(name: "tz", value: TimeZone.current.identifier),
      URLQueryItem(name: "type", value: type),
    ]
    if let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
      query.append(URLQueryItem(name: "q", value: text))
    }
    let body: CoverageResponse = try await get("/assistant/coverage", query: query)
    return body.speech
  }

  /// `YYYY-MM-DD` in the device's calendar and zone — "tomorrow" is the asker's.
  private static func localDateKey(_ date: Date) -> String {
    let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }

  private static func get<T: Decodable>(_ path: String, query: [URLQueryItem]) async throws -> T {
    guard let token = AssistantSession.token, let base = AssistantSession.apiBaseUrl,
      var components = URLComponents(string: base + path)
    else { throw AssistantError.signedOut }
    if !query.isEmpty { components.queryItems = query }
    guard let url = components.url else { throw AssistantError.unreachable }

    var request = URLRequest(url: url, timeoutInterval: 8)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")

    guard let fetched = try? await URLSession.shared.data(for: request) else {
      throw AssistantError.unreachable
    }
    let (data, response) = fetched
    switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
    case 200: break
    case 401: throw AssistantError.signedOut
    case 404: throw AssistantError.memberGone
    default: throw AssistantError.unreachable
    }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw AssistantError.unreachable
    }
  }
}

// MARK: - Entities

/// A person Siri can be asked about — any member of any family the user is in.
@available(iOS 17.0, *)
struct FamilyMemberEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Family member"
  static let defaultQuery = FamilyMemberQuery()

  let id: String
  let name: String
  let familyName: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)", subtitle: "\(familyName)")
  }
}

@available(iOS 17.0, *)
struct FamilyMemberQuery: EntityStringQuery {
  func entities(for identifiers: [FamilyMemberEntity.ID]) async throws -> [FamilyMemberEntity] {
    try await AssistantAPI.members().filter { identifiers.contains($0.id) }
  }

  /// What Siri matches a spoken name against, and what the Shortcuts picker lists.
  func suggestedEntities() async throws -> [FamilyMemberEntity] {
    try await AssistantAPI.members()
  }

  func entities(matching string: String) async throws -> [FamilyMemberEntity] {
    let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
    return try await AssistantAPI.members().filter {
      $0.name.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive]) != nil
    }
  }
}

/// A day as people say it. A weekday is its next occurrence, today included —
/// "on Friday" asked on a Friday means today.
@available(iOS 17.0, *)
enum AssistantDay: String, AppEnum {
  case today, tomorrow, monday, tuesday, wednesday, thursday, friday, saturday, sunday

  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Day"
  static let caseDisplayRepresentations: [AssistantDay: DisplayRepresentation] = [
    .today: "Today",
    .tomorrow: "Tomorrow",
    .monday: "Monday",
    .tuesday: "Tuesday",
    .wednesday: "Wednesday",
    .thursday: "Thursday",
    .friday: "Friday",
    .saturday: "Saturday",
    .sunday: "Sunday",
  ]

  /// `Calendar` weekday numbering: 1 = Sunday … 7 = Saturday.
  private var weekday: Int? {
    switch self {
    case .sunday: return 1
    case .monday: return 2
    case .tuesday: return 3
    case .wednesday: return 4
    case .thursday: return 5
    case .friday: return 6
    case .saturday: return 7
    case .today, .tomorrow: return nil
    }
  }

  func resolve(from now: Date = Date(), calendar: Calendar = .current) -> Date {
    let today = calendar.startOfDay(for: now)
    switch self {
    case .today: return today
    case .tomorrow: return calendar.date(byAdding: .day, value: 1, to: today) ?? today
    default:
      let current = calendar.component(.weekday, from: today)
      let ahead = ((weekday ?? current) - current + 7) % 7
      return calendar.date(byAdding: .day, value: ahead, to: today) ?? today
    }
  }
}

// MARK: - Intents
//
// Every intent is `.requiresAuthentication`: a family's schedule shouldn't be
// read out to whoever picks up a locked phone, and the session's Keychain item
// (`kSecAttrAccessibleWhenUnlocked`, the plugin default) is unreadable then anyway.

@available(iOS 17.0, *)
private func answer(
  _ member: FamilyMemberEntity, _ day: AssistantDay, _ type: String, text: String? = nil
) async throws -> String {
  try await AssistantAPI.coverage(
    memberId: member.id, day: day.resolve(), type: type, text: text)
}

@available(iOS 17.0, *)
struct PickupIntent: AppIntent {
  static let title: LocalizedStringResource = "Who's picking up"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Who", requestValueDialog: "Who are you asking about?")
  var member: FamilyMemberEntity
  @Parameter(title: "Day", requestValueDialog: "For which day?")
  var day: AssistantDay

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let speech = try await answer(member, day, "pickup")
    return .result(dialog: "\(speech)")
  }
}

@available(iOS 17.0, *)
struct DropoffIntent: AppIntent {
  static let title: LocalizedStringResource = "Who's dropping off"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Who", requestValueDialog: "Who are you asking about?")
  var member: FamilyMemberEntity
  @Parameter(title: "Day", requestValueDialog: "For which day?")
  var day: AssistantDay

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let speech = try await answer(member, day, "dropoff")
    return .result(dialog: "\(speech)")
  }
}

/// Everything on the day — drop-offs, pickups and events someone's going to.
/// `event` narrows it ("doctor"); Siri never asks for it, but Shortcuts can pass it.
@available(iOS 17.0, *)
struct CoverageIntent: AppIntent {
  static let title: LocalizedStringResource = "Who's covering"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Who", requestValueDialog: "Who are you asking about?")
  var member: FamilyMemberEntity
  @Parameter(title: "Day", requestValueDialog: "For which day?")
  var day: AssistantDay
  @Parameter(title: "Event", description: "Words from the event's title, like \"doctor\".")
  var event: String?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let speech = try await answer(member, day, "any", text: event)
    return .result(dialog: "\(speech)")
  }
}

// The fixed-day variants: same answer, day taken from the phrase.

@available(iOS 17.0, *)
struct PickupTomorrowIntent: AppIntent {
  static let title: LocalizedStringResource = "Who's picking up tomorrow"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Who", requestValueDialog: "Who are you asking about?")
  var member: FamilyMemberEntity
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let speech = try await answer(member, .tomorrow, "pickup")
    return .result(dialog: "\(speech)")
  }
}

@available(iOS 17.0, *)
struct PickupTodayIntent: AppIntent {
  static let title: LocalizedStringResource = "Who's picking up today"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Who", requestValueDialog: "Who are you asking about?")
  var member: FamilyMemberEntity
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let speech = try await answer(member, .today, "pickup")
    return .result(dialog: "\(speech)")
  }
}

@available(iOS 17.0, *)
struct DropoffTomorrowIntent: AppIntent {
  static let title: LocalizedStringResource = "Who's dropping off tomorrow"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Who", requestValueDialog: "Who are you asking about?")
  var member: FamilyMemberEntity
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let speech = try await answer(member, .tomorrow, "dropoff")
    return .result(dialog: "\(speech)")
  }
}

@available(iOS 17.0, *)
struct DropoffTodayIntent: AppIntent {
  static let title: LocalizedStringResource = "Who's dropping off today"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Who", requestValueDialog: "Who are you asking about?")
  var member: FamilyMemberEntity
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let speech = try await answer(member, .today, "dropoff")
    return .result(dialog: "\(speech)")
  }
}

@available(iOS 17.0, *)
struct CoverageTomorrowIntent: AppIntent {
  static let title: LocalizedStringResource = "Who's covering tomorrow"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Who", requestValueDialog: "Who are you asking about?")
  var member: FamilyMemberEntity
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let speech = try await answer(member, .tomorrow, "any")
    return .result(dialog: "\(speech)")
  }
}

@available(iOS 17.0, *)
struct CoverageTodayIntent: AppIntent {
  static let title: LocalizedStringResource = "Who's covering today"
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Who", requestValueDialog: "Who are you asking about?")
  var member: FamilyMemberEntity
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let speech = try await answer(member, .today, "any")
    return .result(dialog: "\(speech)")
  }
}

// MARK: - Siri phrases

/// Nine of Apple's ten-shortcut limit. Every phrase must name the app; Siri
/// also accepts the `INAlternativeAppNames` in Info.plist ("I Got That").
@available(iOS 17.0, *)
struct IGTShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: PickupTomorrowIntent(),
      phrases: [
        "Who's picking up \(\.$member) tomorrow in \(.applicationName)",
        "Who's picking \(\.$member) up tomorrow in \(.applicationName)",
        "Who's getting \(\.$member) tomorrow in \(.applicationName)",
        "Ask \(.applicationName) who's picking up \(\.$member) tomorrow",
      ],
      shortTitle: "Pickup tomorrow",
      systemImageName: "car"
    )
    AppShortcut(
      intent: PickupTodayIntent(),
      phrases: [
        "Who's picking up \(\.$member) today in \(.applicationName)",
        "Who's picking \(\.$member) up today in \(.applicationName)",
        "Who's getting \(\.$member) today in \(.applicationName)",
        "Ask \(.applicationName) who's picking up \(\.$member) today",
      ],
      shortTitle: "Pickup today",
      systemImageName: "car"
    )
    AppShortcut(
      intent: PickupIntent(),
      phrases: [
        "Who's picking up \(\.$member) in \(.applicationName)",
        "Ask \(.applicationName) who's picking up \(\.$member)",
      ],
      shortTitle: "Who's picking up",
      systemImageName: "car"
    )
    AppShortcut(
      intent: DropoffTomorrowIntent(),
      phrases: [
        "Who's dropping off \(\.$member) tomorrow in \(.applicationName)",
        "Who's dropping \(\.$member) off tomorrow in \(.applicationName)",
        "Ask \(.applicationName) who's dropping off \(\.$member) tomorrow",
      ],
      shortTitle: "Drop-off tomorrow",
      systemImageName: "figure.and.child.holdinghands"
    )
    AppShortcut(
      intent: DropoffTodayIntent(),
      phrases: [
        "Who's dropping off \(\.$member) today in \(.applicationName)",
        "Who's dropping \(\.$member) off today in \(.applicationName)",
        "Ask \(.applicationName) who's dropping off \(\.$member) today",
      ],
      shortTitle: "Drop-off today",
      systemImageName: "figure.and.child.holdinghands"
    )
    AppShortcut(
      intent: DropoffIntent(),
      phrases: [
        "Who's dropping off \(\.$member) in \(.applicationName)",
        "Ask \(.applicationName) who's dropping off \(\.$member)",
      ],
      shortTitle: "Who's dropping off",
      systemImageName: "figure.and.child.holdinghands"
    )
    AppShortcut(
      intent: CoverageTomorrowIntent(),
      phrases: [
        "Who's taking \(\.$member) tomorrow in \(.applicationName)",
        "Who has \(\.$member) tomorrow in \(.applicationName)",
        "Ask \(.applicationName) who's taking \(\.$member) tomorrow",
      ],
      shortTitle: "Who has them tomorrow",
      systemImageName: "person.2"
    )
    AppShortcut(
      intent: CoverageTodayIntent(),
      phrases: [
        "Who's taking \(\.$member) today in \(.applicationName)",
        "Who has \(\.$member) today in \(.applicationName)",
        "Ask \(.applicationName) who's taking \(\.$member) today",
      ],
      shortTitle: "Who has them today",
      systemImageName: "person.2"
    )
    AppShortcut(
      intent: CoverageIntent(),
      phrases: [
        "Who's taking \(\.$member) in \(.applicationName)",
        "Who has \(\.$member) in \(.applicationName)",
        "Ask \(.applicationName) who's taking \(\.$member)",
      ],
      shortTitle: "Who has them",
      systemImageName: "person.2"
    )
  }
}
