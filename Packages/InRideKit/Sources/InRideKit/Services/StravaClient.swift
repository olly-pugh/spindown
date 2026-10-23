import Foundation

/// Strava API settings. Each user registers their own (free) API application at
/// https://www.strava.com/settings/api with Authorization Callback Domain "localhost",
/// because Strava limits how many athletes one application can serve.
public struct StravaConfig: Sendable, Equatable {
    public var clientID: String
    public var clientSecret: String
    public var redirectURI = "spindown://localhost/strava"
    public var scope = "read,activity:write"

    public init(clientID: String, clientSecret: String) {
        self.clientID = clientID
        self.clientSecret = clientSecret
    }

    public var isComplete: Bool { !clientID.isEmpty && !clientSecret.isEmpty }
    public var callbackScheme: String { URL(string: redirectURI)?.scheme ?? "spindown" }
}

public struct StravaTokens: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var expiresAt: Date
    public var athleteName: String?
}

public actor StravaClient {
    public static let tokenKey = "strava.tokens"
    static let api = "https://www.strava.com/api/v3"

    private let transport: HTTPTransport
    private let store: SecretStore
    private let now: @Sendable () -> Date
    public private(set) var config: StravaConfig

    public init(config: StravaConfig, transport: HTTPTransport, store: SecretStore,
                now: @escaping @Sendable () -> Date = Date.init) {
        self.config = config
        self.transport = transport
        self.store = store
        self.now = now
    }

    public func update(config: StravaConfig) { self.config = config }

    public var tokens: StravaTokens? {
        store.load(Self.tokenKey).flatMap { try? JSONDecoder().decode(StravaTokens.self, from: $0) }
    }

    public var isSignedIn: Bool { tokens != nil }

    private func save(_ t: StravaTokens) {
        if let data = try? JSONEncoder().encode(t) { store.save(data, for: Self.tokenKey) }
    }

    /// Mobile OAuth page. Strava redirects to `redirectURI?code=...&scope=...&state=...`.
    public func authorizeURL(state: String) throws -> URL {
        guard config.isComplete else { throw ServiceError.misconfigured("Add your Strava Client ID and Secret in Settings first.") }
        var c = URLComponents(string: "https://www.strava.com/oauth/mobile/authorize")!
        c.queryItems = [
            .init(name: "client_id", value: config.clientID),
            .init(name: "redirect_uri", value: config.redirectURI),
            .init(name: "response_type", value: "code"),
            .init(name: "approval_prompt", value: "auto"),
            .init(name: "scope", value: config.scope),
            .init(name: "state", value: state),
        ]
        return c.url!
    }

    public func handleCallback(_ url: URL, expectedState: String) async throws {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func item(_ name: String) -> String? { items.first { $0.name == name }?.value }
        if let error = item("error") { throw ServiceError.rejected("Strava authorisation failed: \(error)") }
        guard item("state") == expectedState else { throw ServiceError.rejected("Strava sign-in did not match this request.") }
        guard let code = item("code") else { throw ServiceError.invalidResponse("no authorisation code") }
        guard item("scope")?.contains("activity:write") ?? false else {
            throw ServiceError.rejected("Strava sign-in needs permission to upload activities. Please allow it.")
        }
        try await tokenRequest([
            ("client_id", config.clientID), ("client_secret", config.clientSecret),
            ("code", code), ("grant_type", "authorization_code"),
        ], previous: nil)
    }

    private func tokenRequest(_ form: [(String, String)], previous: StravaTokens?) async throws {
        var r = URLRequest(url: URL(string: "https://www.strava.com/oauth/token")!)
        r.httpMethod = "POST"
        r.setForm(form)
        let (data, response) = try await transport.send(r)
        switch response.statusCode {
        case 200..<300: break
        case 429: throw ServiceError.rateLimited
        case 400, 401, 403: throw ServiceError.reauthenticationRequired("Strava refused the login (HTTP \(response.statusCode)).")
        default: throw ServiceError.http(status: response.statusCode, message: bodySnippet(data))
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let access = json["access_token"] as? String,
              let refresh = json["refresh_token"] as? String,
              let expires = json["expires_at"] as? Double else {
            throw ServiceError.invalidResponse("token response")
        }
        var name = previous?.athleteName
        if let athlete = json["athlete"] as? [String: Any] {
            name = [athlete["firstname"] as? String, athlete["lastname"] as? String].compactMap { $0 }.joined(separator: " ")
        }
        save(StravaTokens(accessToken: access, refreshToken: refresh, expiresAt: Date(timeIntervalSince1970: expires), athleteName: name))
    }

    private func validAccessToken() async throws -> String {
        guard let t = tokens else { throw ServiceError.notSignedIn }
        if t.expiresAt.timeIntervalSince(now()) < 300 {
            try await tokenRequest([
                ("client_id", config.clientID), ("client_secret", config.clientSecret),
                ("grant_type", "refresh_token"), ("refresh_token", t.refreshToken),
            ], previous: t)
        }
        guard let fresh = tokens else { throw ServiceError.notSignedIn }
        return fresh.accessToken
    }

    public func signOut() async {
        if let t = tokens {
            var r = URLRequest(url: URL(string: "https://www.strava.com/oauth/deauthorize")!)
            r.httpMethod = "POST"
            r.setForm([("access_token", t.accessToken)])
            _ = try? await transport.send(r)
        }
        store.delete(Self.tokenKey)
    }

    /// Uploads a FIT file flagged as an indoor trainer ride. `externalID` makes retries idempotent.
    public func upload(fit: Data, name: String, description: String?, externalID: String) async throws -> UploadOutcome {
        let token = try await validAccessToken()
        var form = MultipartForm()
        form.add(name: "data_type", value: "fit")
        form.add(name: "name", value: name)
        if let description { form.add(name: "description", value: description) }
        form.add(name: "trainer", value: "1")
        form.add(name: "commute", value: "0")
        form.add(name: "external_id", value: externalID)
        form.add(name: "file", fileName: "\(externalID).fit", mimeType: "application/octet-stream", data: fit)

        var r = URLRequest(url: URL(string: "\(Self.api)/uploads")!)
        r.httpMethod = "POST"
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        r.httpBody = form.finalized()
        r.timeoutInterval = 120
        let (data, response) = try await transport.send(r)
        return try Self.interpretUpload(status: response.statusCode, body: data)
    }

    public func checkUpload(ref: String) async throws -> UploadOutcome {
        let token = try await validAccessToken()
        var r = URLRequest(url: URL(string: "\(Self.api)/uploads/\(ref)")!)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await transport.send(r)
        return try Self.interpretUpload(status: response.statusCode, body: data)
    }

    static func interpretUpload(status: Int, body: Data) throws -> UploadOutcome {
        switch status {
        case 200..<300: break
        case 401, 403: throw ServiceError.reauthenticationRequired("Strava refused the upload (HTTP \(status)).")
        case 429: throw ServiceError.rateLimited
        default:
            let message = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["message"] as? String
            throw ServiceError.http(status: status, message: message ?? bodySnippet(body))
        }
        guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
            throw ServiceError.invalidResponse("upload response")
        }
        if let error = json["error"] as? String, !error.isEmpty {
            if error.localizedCaseInsensitiveContains("duplicate") {
                return .duplicate(activityID: Self.activityID(inDuplicateMessage: error))
            }
            throw ServiceError.rejected("Strava rejected the file: \(error)")
        }
        if let activity = GarminConnectClient.idString(json["activity_id"]) {
            return .uploaded(activityID: activity)
        }
        guard let ref = (json["id_str"] as? String) ?? GarminConnectClient.idString(json["id"]) else {
            throw ServiceError.invalidResponse("upload response without id")
        }
        return .processing(ref: ref)
    }

    /// Strava reports e.g. "file.fit duplicate of <a href='/activities/123456'>Morning Ride</a>".
    static func activityID(inDuplicateMessage message: String) -> String? {
        guard let range = message.range(of: "activities/") else { return nil }
        let digits = message[range.upperBound...].prefix { $0.isNumber }
        return digits.isEmpty ? nil : String(digits)
    }

    public static func activityURL(_ id: String) -> URL? {
        URL(string: "https://www.strava.com/activities/\(id)")
    }
}
