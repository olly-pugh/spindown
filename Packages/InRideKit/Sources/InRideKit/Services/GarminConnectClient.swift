import Foundation

/// Uploads FIT files to Garmin Connect.
///
/// Garmin offers no public activity-upload API (the Connect Developer Program, including the
/// tiers reopened in October 2026, is read-only for activities). This client therefore uses the
/// same path as Garmin Connect Mobile, as documented by the maintained open-source
/// `python-garminconnect` (0.3.x, October 2026):
///
/// 1. The user signs in on Garmin's own mobile SSO page in a web view (the app never sees the
///    password; MFA and bot checks are handled by Garmin's page).
/// 2. SSO redirects to `mobile.integration.garmin.com/gcm/ios?ticket=ST-...`; the app captures
///    the service ticket.
/// 3. The ticket is exchanged at diauth.garmin.com for a DI OAuth2 access and refresh token.
/// 4. FIT files are POSTed to connectapi.garmin.com/upload-service/upload/.fit.
///
/// It is unofficial and can break if Garmin changes its login. All identifiers are kept in
/// `GarminConnectConfig` so a fix is a one-line change.
public struct GarminConnectConfig: Sendable, Equatable {
    public var ssoHost = "https://sso.garmin.com"
    public var ssoClientID = "GCM_IOS_DARK"
    public var serviceURL = "https://mobile.integration.garmin.com/gcm/ios"
    public var tokenURL = "https://diauth.garmin.com/di-oauth2-service/oauth/token"
    public var grantType = "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket"
    public var diClientIDs = [
        "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
        "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4",
        "GARMIN_CONNECT_MOBILE_ANDROID_DI",
        "GARMIN_CONNECT_MOBILE_IOS_DI",
    ]
    public var apiHost = "https://connectapi.garmin.com"
    public var uploadPath = "/upload-service/upload/.fit"
    /// Mirrors the native app identity python-garminconnect uses for token and API calls.
    public var nativeHeaders: [String: String] = [
        "User-Agent": "GCM-Android-5.23",
        "X-Garmin-User-Agent": "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
        "X-Garmin-Paired-App-Version": "10861",
        "X-Garmin-Client-Platform": "Android",
        "X-App-Ver": "10861",
        "X-Lang": "en",
        "X-GCExperience": "GC5",
        "Accept-Language": "en-US,en;q=0.9",
    ]

    public init() {}

    public var signInURL: URL {
        var c = URLComponents(string: "\(ssoHost)/mobile/sso/en_US/sign-in")!
        c.queryItems = [URLQueryItem(name: "clientId", value: ssoClientID), URLQueryItem(name: "service", value: serviceURL)]
        return c.url!
    }

    /// Returns the service ticket if `url` is a post-login redirect carrying one.
    public func ticket(fromRedirect url: URL) -> String? {
        guard let service = URL(string: serviceURL), url.host == service.host,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let ticket = items.first(where: { $0.name == "ticket" })?.value, ticket.hasPrefix("ST-") else { return nil }
        return ticket
    }

    /// Name of the native bridge Garmin's mobile sign-in page calls
    /// (`window.webkit.messageHandlers.GMNEventHandler.postMessage(event)`).
    public static let bridgeHandlerName = "GMNEventHandler"

    public struct BridgeEvent: Sendable, Equatable {
        public var type: String
        public var flow: String?
        public var title: String?
        public var ticket: String?
        public var serviceURL: String?
    }

    /// Parses a bridge message. The page sends `{eventType, flowName, logMessage, data}`; on success
    /// `eventType` is `USER_AUTHENTICATED` and `data` holds `serviceTicket` and `serviceUrl`.
    /// Older builds pass the event as a JSON string, so both forms are accepted.
    public static func bridgeEvent(from body: Any) -> BridgeEvent? {
        var object = body
        if let s = body as? String, let data = s.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) {
            object = parsed
        }
        guard let dict = object as? [String: Any], let type = dict["eventType"] as? String else { return nil }
        let data = dict["data"] as? [String: Any]
        let ticket = (data?["serviceTicket"] as? String).flatMap { $0.hasPrefix("ST-") ? $0 : nil }
        return BridgeEvent(type: type, flow: dict["flowName"] as? String, title: data?["title"] as? String,
                           ticket: ticket, serviceURL: data?["serviceUrl"] as? String)
    }
}

public struct GarminTokens: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String?
    public var clientID: String
    public var expiresAt: Date?
    public var obtainedAt: Date

    func expiresSoon(now: Date) -> Bool {
        guard let expiresAt else { return now.timeIntervalSince(obtainedAt) > 3000 }
        return expiresAt.timeIntervalSince(now) < 300
    }
}

public actor GarminConnectClient {
    public static let tokenKey = "garmin.tokens"

    public nonisolated let config: GarminConnectConfig
    private let transport: HTTPTransport
    private let store: SecretStore
    private let now: @Sendable () -> Date

    public init(config: GarminConnectConfig = .init(), transport: HTTPTransport, store: SecretStore,
                now: @escaping @Sendable () -> Date = Date.init) {
        self.config = config
        self.transport = transport
        self.store = store
        self.now = now
    }

    public var tokens: GarminTokens? {
        store.load(Self.tokenKey).flatMap { try? JSONDecoder().decode(GarminTokens.self, from: $0) }
    }

    public var isSignedIn: Bool { tokens != nil }

    public func signOut() {
        store.delete(Self.tokenKey)
    }

    private func save(_ tokens: GarminTokens) {
        if let data = try? JSONEncoder().encode(tokens) { store.save(data, for: Self.tokenKey) }
    }

    private func tokenRequest(clientID: String, form: [(String, String)]) -> URLRequest {
        var r = URLRequest(url: URL(string: config.tokenURL)!)
        r.httpMethod = "POST"
        for (k, v) in config.nativeHeaders { r.setValue(v, forHTTPHeaderField: k) }
        r.setValue("Basic " + Data("\(clientID):".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        r.setForm(form)
        r.timeoutInterval = 30
        return r
    }

    private func parseTokens(_ data: Data, fallbackClientID: String, previousRefresh: String?) throws -> GarminTokens {
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let access = json["access_token"] as? String else {
            throw ServiceError.invalidResponse("token response without access_token")
        }
        let payload = JWT.payload(access)
        let clientID = payload?["client_id"] as? String ?? fallbackClientID
        var expires: Date?
        if let exp = payload?["exp"] as? Double {
            expires = Date(timeIntervalSince1970: exp)
        } else if let secs = json["expires_in"] as? Double {
            expires = now().addingTimeInterval(secs)
        }
        return GarminTokens(accessToken: access, refreshToken: json["refresh_token"] as? String ?? previousRefresh,
                            clientID: clientID, expiresAt: expires, obtainedAt: now())
    }

    /// Step 3: exchange the SSO service ticket for DI OAuth2 tokens.
    public func signIn(ticket: String) async throws {
        var failures: [String] = []
        for clientID in config.diClientIDs {
            let request = tokenRequest(clientID: clientID, form: [
                ("client_id", clientID),
                ("service_ticket", ticket),
                ("grant_type", config.grantType),
                ("service_url", config.serviceURL),
            ])
            let (data, response) = try await transport.send(request)
            if response.statusCode == 429 { throw ServiceError.rateLimited }
            guard (200..<300).contains(response.statusCode) else {
                failures.append("\(clientID): HTTP \(response.statusCode)")
                continue
            }
            save(try parseTokens(data, fallbackClientID: clientID, previousRefresh: nil))
            return
        }
        throw ServiceError.rejected("Garmin did not accept the sign-in (\(failures.joined(separator: "; "))).")
    }

    public func refresh() async throws {
        guard let current = tokens else { throw ServiceError.notSignedIn }
        guard let refresh = current.refreshToken else {
            throw ServiceError.reauthenticationRequired("Garmin did not issue a refresh token.")
        }
        let request = tokenRequest(clientID: current.clientID, form: [
            ("grant_type", "refresh_token"),
            ("client_id", current.clientID),
            ("refresh_token", refresh),
        ])
        let (data, response) = try await transport.send(request)
        switch response.statusCode {
        case 200..<300:
            save(try parseTokens(data, fallbackClientID: current.clientID, previousRefresh: refresh))
        case 429:
            throw ServiceError.rateLimited
        case 400, 401, 403:
            throw ServiceError.reauthenticationRequired("Garmin refused the saved login (HTTP \(response.statusCode)).")
        default:
            throw ServiceError.http(status: response.statusCode, message: bodySnippet(data))
        }
    }

    private func validAccessToken() async throws -> String {
        guard let t = tokens else { throw ServiceError.notSignedIn }
        if t.expiresSoon(now: now()) {
            try await refresh()
            guard let fresh = tokens else { throw ServiceError.notSignedIn }
            return fresh.accessToken
        }
        return t.accessToken
    }

    /// Step 4: upload a FIT file.
    public func upload(fit: Data, fileName: String) async throws -> UploadOutcome {
        var attempt = 0
        while true {
            attempt += 1
            let token = try await validAccessToken()
            var form = MultipartForm()
            form.add(name: "file", fileName: fileName, mimeType: "application/octet-stream", data: fit)
            var request = URLRequest(url: URL(string: config.apiHost + config.uploadPath)!)
            request.httpMethod = "POST"
            for (k, v) in config.nativeHeaders { request.setValue(v, forHTTPHeaderField: k) }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = form.finalized()
            request.timeoutInterval = 120

            let (data, response) = try await transport.send(request)
            if response.statusCode == 401, attempt == 1 {
                try await refresh()
                continue
            }
            return try Self.interpretUpload(status: response.statusCode, body: data)
        }
    }

    /// Display name of the signed-in account. Doubles as a connection test.
    public func profileName() async throws -> String {
        var attempt = 0
        while true {
            attempt += 1
            let token = try await validAccessToken()
            var request = URLRequest(url: URL(string: config.apiHost + "/userprofile-service/socialProfile")!)
            for (k, v) in config.nativeHeaders { request.setValue(v, forHTTPHeaderField: k) }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, response) = try await transport.send(request)
            switch response.statusCode {
            case 200..<300:
                let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                return (json?["fullName"] as? String) ?? (json?["displayName"] as? String) ?? "Garmin user"
            case 401 where attempt == 1:
                try await refresh()
            case 401, 403:
                throw ServiceError.reauthenticationRequired("Garmin refused the saved login (HTTP \(response.statusCode)).")
            case 429:
                throw ServiceError.rateLimited
            default:
                throw ServiceError.http(status: response.statusCode, message: bodySnippet(data))
            }
        }
    }

    /// Garmin answers 201 (created), 202 (accepted, still processing) or 409 (duplicate), with a
    /// `detailedImportResult` body listing successes and failures.
    static func interpretUpload(status: Int, body: Data) throws -> UploadOutcome {
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let result = json?["detailedImportResult"] as? [String: Any]
        let successes = result?["successes"] as? [[String: Any]] ?? []
        let failures = result?["failures"] as? [[String: Any]] ?? []
        let activityID = successes.first.flatMap { idString($0["internalId"]) }
        let failureMessages = failures
            .flatMap { ($0["messages"] as? [[String: Any]]) ?? [] }
            .compactMap { $0["content"] as? String }
        let failureID = failures.first.flatMap { idString($0["internalId"]) }
        let isDuplicate = status == 409 || failureMessages.contains { $0.localizedCaseInsensitiveContains("duplicate") }

        switch status {
        case 200..<300 where isDuplicate:
            return .duplicate(activityID: failureID)
        case 200..<300 where !failureMessages.isEmpty && successes.isEmpty:
            throw ServiceError.rejected("Garmin rejected the file: \(failureMessages.joined(separator: " "))")
        case 200..<300:
            return .uploaded(activityID: activityID)
        case 409:
            return .duplicate(activityID: failureID)
        case 401, 403:
            throw ServiceError.reauthenticationRequired("Garmin refused the upload (HTTP \(status)).")
        case 429:
            throw ServiceError.rateLimited
        default:
            throw ServiceError.http(status: status, message: failureMessages.first ?? bodySnippet(body))
        }
    }

    static func idString(_ any: Any?) -> String? {
        switch any {
        case let n as NSNumber: return n.stringValue
        case let s as String: return s
        default: return nil
        }
    }

    public static func activityURL(_ id: String) -> URL? {
        URL(string: "https://connect.garmin.com/modern/activity/\(id)")
    }
}
