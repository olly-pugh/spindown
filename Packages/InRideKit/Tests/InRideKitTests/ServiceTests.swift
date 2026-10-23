import Foundation
import Testing
@testable import InRideKit

final class MemoryStore: SecretStore, @unchecked Sendable {
    private var items: [String: Data] = [:]
    private let lock = NSLock()
    func load(_ key: String) -> Data? { lock.withLock { items[key] } }
    func save(_ data: Data, for key: String) { lock.withLock { items[key] = data } }
    func delete(_ key: String) { _ = lock.withLock { items.removeValue(forKey: key) } }
}

/// Replays queued responses and records requests.
final class MockTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [(Int, String)]
    private(set) var requests: [URLRequest] = []

    init(_ responses: [(Int, String)]) { self.responses = responses }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body) = lock.withLock { () -> (Int, String) in
            requests.append(request)
            return responses.isEmpty ? (500, "no more responses") : responses.removeFirst()
        }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    var sent: [URLRequest] { lock.withLock { requests } }
}

func jwt(_ payload: [String: Any]) -> String {
    let body = try! JSONSerialization.data(withJSONObject: payload).base64EncodedString()
        .replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    return "eyJhbGciOiJub25lIn0.\(body).sig"
}

func formFields(_ r: URLRequest) -> [String: String] {
    let s = String(decoding: r.httpBody ?? Data(), as: UTF8.self)
    var out: [String: String] = [:]
    for pair in s.split(separator: "&") {
        let kv = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? "" }
        if kv.count == 2 { out[kv[0]] = kv[1] }
    }
    return out
}

@Suite("Garmin Connect")
struct GarminTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test("Captures the service ticket only from the expected redirect")
    func ticket() {
        let c = GarminConnectConfig()
        #expect(c.ticket(fromRedirect: URL(string: "https://mobile.integration.garmin.com/gcm/ios?ticket=ST-0123-abc")!) == "ST-0123-abc")
        #expect(c.ticket(fromRedirect: URL(string: "https://evil.example.com/gcm/ios?ticket=ST-1")!) == nil)
        #expect(c.ticket(fromRedirect: URL(string: "https://mobile.integration.garmin.com/gcm/ios?ticket=XX")!) == nil)
        #expect(c.signInURL.absoluteString.contains("clientId=GCM_IOS_DARK"))
    }

    @Test("Reads the ticket from the sign-in page's native bridge message")
    func bridgeMessage() {
        let success: [String: Any] = ["eventType": "USER_AUTHENTICATED", "flowName": "signIn", "logMessage": "",
                                      "data": ["serviceTicket": "ST-123-abc", "serviceUrl": "https://mobile.integration.garmin.com/gcm/ios"]]
        let e = GarminConnectConfig.bridgeEvent(from: success)
        #expect(e?.type == "USER_AUTHENTICATED")
        #expect(e?.ticket == "ST-123-abc")
        #expect(e?.serviceURL == "https://mobile.integration.garmin.com/gcm/ios")

        let json = #"{"eventType":"USER_AUTHENTICATED","data":{"serviceTicket":"ST-9"}}"#
        #expect(GarminConnectConfig.bridgeEvent(from: json)?.ticket == "ST-9")

        let pageLoad: [String: Any] = ["eventType": "PAGE_LOAD", "flowName": "signIn", "data": ["title": "Sign In"]]
        #expect(GarminConnectConfig.bridgeEvent(from: pageLoad)?.ticket == nil)
        #expect(GarminConnectConfig.bridgeEvent(from: pageLoad)?.title == "Sign In")
        #expect(GarminConnectConfig.bridgeEvent(from: ["eventType": "USER_AUTHENTICATED", "data": ["serviceTicket": "bogus"]])?.ticket == nil)
        #expect(GarminConnectConfig.bridgeEvent(from: 42) == nil)
    }

    @Test("Exchanges the ticket, falling through client IDs")
    func exchange() async throws {
        let access = jwt(["client_id": "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4", "exp": 1_800_003_600])
        let transport = MockTransport([(401, "{}"), (200, #"{"access_token":"\#(access)","refresh_token":"r1"}"#)])
        let store = MemoryStore()
        let client = GarminConnectClient(transport: transport, store: store, now: { [now] in now })
        try await client.signIn(ticket: "ST-1")
        let t = try #require(await client.tokens)
        #expect(t.refreshToken == "r1")
        #expect(t.clientID == "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4")
        #expect(t.expiresAt == Date(timeIntervalSince1970: 1_800_003_600))
        let sent = transport.sent
        #expect(sent.count == 2)
        #expect(formFields(sent[1])["service_ticket"] == "ST-1")
        #expect(formFields(sent[1])["service_url"] == "https://mobile.integration.garmin.com/gcm/ios")
        #expect(sent[1].value(forHTTPHeaderField: "Authorization") == "Basic " + Data("GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4:".utf8).base64EncodedString())
    }

    @Test("Refreshes an expiring token before uploading")
    func refreshThenUpload() async throws {
        let store = MemoryStore()
        let old = GarminTokens(accessToken: "old", refreshToken: "r1", clientID: "C", expiresAt: now.addingTimeInterval(60), obtainedAt: now)
        store.save(try JSONEncoder().encode(old), for: GarminConnectClient.tokenKey)
        let fresh = jwt(["exp": 1_800_007_200])
        let transport = MockTransport([
            (200, #"{"access_token":"\#(fresh)","refresh_token":"r2"}"#),
            (201, #"{"detailedImportResult":{"uploadId":9,"successes":[{"internalId":123456}],"failures":[]}}"#),
        ])
        let client = GarminConnectClient(transport: transport, store: store, now: { [now] in now })
        let outcome = try await client.upload(fit: Data([1, 2, 3]), fileName: "a.fit")
        #expect(outcome == .uploaded(activityID: "123456"))
        let sent = transport.sent
        #expect(formFields(sent[0])["grant_type"] == "refresh_token")
        #expect(sent[1].value(forHTTPHeaderField: "Authorization") == "Bearer \(fresh)")
        #expect(sent[1].url?.absoluteString == "https://connectapi.garmin.com/upload-service/upload/.fit")
        #expect(await client.tokens?.refreshToken == "r2")
    }

    @Test("Interprets Garmin upload responses")
    func interpret() throws {
        #expect(try GarminConnectClient.interpretUpload(status: 202, body: Data(#"{"detailedImportResult":{"successes":[],"failures":[]}}"#.utf8)) == .uploaded(activityID: nil))
        #expect(try GarminConnectClient.interpretUpload(status: 409, body: Data(#"{"detailedImportResult":{"successes":[],"failures":[{"internalId":77,"messages":[{"code":202,"content":"Duplicate Activity."}]}]}}"#.utf8)) == .duplicate(activityID: "77"))
        #expect(try GarminConnectClient.interpretUpload(status: 200, body: Data(#"{"detailedImportResult":{"successes":[],"failures":[{"messages":[{"content":"Duplicate Activity."}]}]}}"#.utf8)) == .duplicate(activityID: nil))
        #expect(throws: ServiceError.self) {
            try GarminConnectClient.interpretUpload(status: 200, body: Data(#"{"detailedImportResult":{"successes":[],"failures":[{"messages":[{"content":"Invalid file"}]}]}}"#.utf8))
        }
        #expect(throws: ServiceError.reauthenticationRequired("Garmin refused the upload (HTTP 403).")) {
            try GarminConnectClient.interpretUpload(status: 403, body: Data())
        }
        #expect(throws: ServiceError.rateLimited) { try GarminConnectClient.interpretUpload(status: 429, body: Data()) }
    }

    @Test("A refused refresh asks the user to sign in again")
    func refusedRefresh() async throws {
        let store = MemoryStore()
        store.save(try JSONEncoder().encode(GarminTokens(accessToken: "a", refreshToken: "r", clientID: "C", expiresAt: now, obtainedAt: now)), for: GarminConnectClient.tokenKey)
        let client = GarminConnectClient(transport: MockTransport([(401, "{}"), (401, "{}")]), store: store, now: { [now] in now })
        await #expect(throws: ServiceError.self) { try await client.upload(fit: Data(), fileName: "a.fit") }
        do {
            _ = try await client.upload(fit: Data(), fileName: "a.fit")
        } catch let e as ServiceError {
            #expect(!e.isRetryable)
        }
    }
}

@Suite("Strava")
struct StravaTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test("Authorisation URL and callback")
    func oauth() async throws {
        let transport = MockTransport([(200, #"{"access_token":"a","refresh_token":"r","expires_at":1800021600,"athlete":{"firstname":"Sam","lastname":"Rider"}}"#)])
        let client = StravaClient(config: StravaConfig(clientID: "123", clientSecret: "s"), transport: transport, store: MemoryStore(), now: { [now] in now })
        let url = try await client.authorizeURL(state: "xyz").absoluteString
        #expect(url.hasPrefix("https://www.strava.com/oauth/mobile/authorize?"))
        #expect(url.contains("scope=read,activity:write"))
        try await client.handleCallback(URL(string: "spindown://localhost/strava?state=xyz&code=c0de&scope=read,activity:write")!, expectedState: "xyz")
        #expect(await client.tokens?.athleteName == "Sam Rider")
        #expect(formFields(transport.sent[0])["code"] == "c0de")
    }

    @Test("Rejects a callback with the wrong state or missing upload scope")
    func badCallback() async {
        let client = StravaClient(config: StravaConfig(clientID: "1", clientSecret: "s"), transport: MockTransport([]), store: MemoryStore())
        await #expect(throws: ServiceError.self) {
            try await client.handleCallback(URL(string: "spindown://localhost/strava?state=bad&code=c&scope=read,activity:write")!, expectedState: "good")
        }
        await #expect(throws: ServiceError.self) {
            try await client.handleCallback(URL(string: "spindown://localhost/strava?state=s&code=c&scope=read")!, expectedState: "s")
        }
    }

    @Test("Upload is flagged as a trainer ride with an external id")
    func upload() async throws {
        let store = MemoryStore()
        store.save(try JSONEncoder().encode(StravaTokens(accessToken: "a", refreshToken: "r", expiresAt: now.addingTimeInterval(3600))), for: StravaClient.tokenKey)
        let transport = MockTransport([(201, #"{"id":555,"id_str":"555","error":null,"status":"Your activity is still being processed.","activity_id":null}"#)])
        let client = StravaClient(config: StravaConfig(clientID: "1", clientSecret: "s"), transport: transport, store: store, now: { [now] in now })
        let outcome = try await client.upload(fit: Data([0]), name: "Ride", description: nil, externalID: "abc")
        #expect(outcome == .processing(ref: "555"))
        let body = String(decoding: transport.sent[0].httpBody!, as: UTF8.self)
        #expect(body.contains("name=\"trainer\"\r\n\r\n1\r\n"))
        #expect(body.contains("name=\"external_id\"\r\n\r\nabc\r\n"))
        #expect(body.contains("name=\"data_type\"\r\n\r\nfit\r\n"))
    }

    @Test("Interprets Strava upload status")
    func interpret() throws {
        #expect(try StravaClient.interpretUpload(status: 200, body: Data(#"{"id":1,"error":null,"activity_id":987}"#.utf8)) == .uploaded(activityID: "987"))
        #expect(try StravaClient.interpretUpload(status: 200, body: Data(#"{"id":1,"error":"a.fit duplicate of <a href='/activities/4242'>Ride</a>","activity_id":null}"#.utf8)) == .duplicate(activityID: "4242"))
        #expect(throws: ServiceError.self) { try StravaClient.interpretUpload(status: 200, body: Data(#"{"id":1,"error":"Corrupt file"}"#.utf8)) }
    }
}
