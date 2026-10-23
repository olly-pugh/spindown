import Foundation

/// Abstracts URLSession so upload clients can be tested with canned responses.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

extension URLSession: HTTPTransport {
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

/// Persists secrets. The app backs this with the Keychain.
public protocol SecretStore: Sendable {
    func load(_ key: String) -> Data?
    func save(_ data: Data, for key: String)
    func delete(_ key: String)
}

/// The result of handing a file to a service.
public enum UploadOutcome: Sendable, Equatable {
    case processing(ref: String)
    case uploaded(activityID: String?)
    case duplicate(activityID: String?)

    public var state: UploadState {
        switch self {
        case .processing(let ref): return .processing(ref: ref)
        case .uploaded(let id): return .uploaded(activityID: id)
        case .duplicate(let id): return .duplicate(activityID: id)
        }
    }
}

public enum ServiceError: Error, Sendable, Equatable, LocalizedError {
    case notSignedIn
    /// The saved login is no longer accepted; the user must sign in again.
    case reauthenticationRequired(String)
    case rateLimited
    case http(status: Int, message: String)
    case invalidResponse(String)
    case rejected(String)
    case misconfigured(String)

    /// Network trouble and rate limits are retried; a rejected file or a revoked login is not.
    public var isRetryable: Bool {
        switch self {
        case .rateLimited, .invalidResponse: return true
        case .http(let status, _): return status >= 500 || status == 408
        case .notSignedIn, .reauthenticationRequired, .rejected, .misconfigured: return false
        }
    }

    public var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Not signed in."
        case .reauthenticationRequired(let why): return "Please sign in again. \(why)"
        case .rateLimited: return "The service is rate limiting requests. Will retry."
        case .http(let status, let message): return "HTTP \(status): \(message)"
        case .invalidResponse(let why): return "Unexpected response: \(why)"
        case .rejected(let why): return why
        case .misconfigured(let why): return why
        }
    }
}

public struct MultipartForm {
    public let boundary = "Spindown-\(UUID().uuidString)"
    private var body = Data()

    public init() {}

    public mutating func add(name: String, value: String) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }

    public mutating func add(name: String, fileName: String, mimeType: String, data: Data) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(fileName)\"\r\nContent-Type: \(mimeType)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n".utf8))
    }

    public var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    public func finalized() -> Data {
        var out = body
        out.append(Data("--\(boundary)--\r\n".utf8))
        return out
    }
}

extension URLRequest {
    mutating func setForm(_ fields: [(String, String)]) {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let body = fields
            .map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
            .joined(separator: "&")
        httpBody = Data(body.utf8)
        setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    }
}

enum JWT {
    /// Reads the payload of a JWT without verifying it (only used to learn expiry and client id).
    static func payload(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var b64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

func bodySnippet(_ data: Data, limit: Int = 300) -> String {
    String(decoding: data.prefix(limit), as: UTF8.self)
}
