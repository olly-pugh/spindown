import Foundation
import Observation
import InRideKit

/// In-memory ring buffers of connection events and BLE packets for the diagnostics screens,
/// exportable as JSON so a capture can be shared and replayed against the decoder.
@MainActor @Observable
final class DiagnosticsLog {
    struct Event: Identifiable, Codable {
        enum Level: String, Codable { case info, warning, error }
        var id = UUID()
        var date: Date
        var level: Level
        var message: String
    }

    struct Packet: Identifiable, Codable {
        enum Direction: String, Codable { case rx, tx }
        var id = UUID()
        var date: Date
        var direction: Direction
        var characteristic: String
        var bytes: Data
        /// De-obfuscated bytes, for power packets.
        var plain: Data?
        var summary: String
    }

    static let eventCapacity = 2000
    static let packetCapacity = 5000

    private(set) var events: [Event] = []
    /// Documents/Logs/events.log — survives restarts and can be pulled over USB or from the Files app.
    let logFileURL: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs", isDirectory: true).appendingPathComponent("events.log")
    private var logFile: FileHandle?
    private static let maxLogBytes: UInt64 = 2_000_000
    private let lineFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private(set) var packets: [Packet] = []
    var packetLoggingPaused = false

    func log(_ message: String, level: Event.Level = .info) {
        let event = Event(date: Date(), level: level, message: message)
        events.append(event)
        if events.count > Self.eventCapacity { events.removeFirst(events.count - Self.eventCapacity) }
        persist(event)
    }

    private func persist(_ e: Event) {
        let fm = FileManager.default
        if logFile == nil {
            try? fm.createDirectory(at: logFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let size = (try? fm.attributesOfItem(atPath: logFileURL.path))?[.size] as? UInt64, size > Self.maxLogBytes {
                let old = logFileURL.deletingLastPathComponent().appendingPathComponent("events.1.log")
                try? fm.removeItem(at: old)
                try? fm.moveItem(at: logFileURL, to: old)
            }
            if !fm.fileExists(atPath: logFileURL.path) { fm.createFile(atPath: logFileURL.path, contents: nil) }
            logFile = try? FileHandle(forWritingTo: logFileURL)
            _ = try? logFile?.seekToEnd()
        }
        let line = "\(lineFormatter.string(from: e.date)) [\(e.level.rawValue)] \(e.message)\n"
        try? logFile?.write(contentsOf: Data(line.utf8))
    }

    func record(_ packet: Packet) {
        guard !packetLoggingPaused else { return }
        packets.append(packet)
        if packets.count > Self.packetCapacity { packets.removeFirst(packets.count - Self.packetCapacity) }
    }

    func clear() {
        events.removeAll()
        packets.removeAll()
    }

    struct Bundle: Codable {
        var generated: Date
        var app: String
        var device: [String: String]
        var configuration: InRideConfiguration?
        var latest: InRidePowerMeasurement?
        var events: [Event]
        var packets: [Packet]
    }

    func exportBundle(device: [String: String], configuration: InRideConfiguration?, latest: InRidePowerMeasurement?) throws -> URL {
        let bundle = Bundle(generated: Date(), app: Platform.appVersion, device: device, configuration: configuration,
                            latest: latest, events: events, packets: packets)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        encoder.dataEncodingStrategy = .custom { data, enc in
            var c = enc.singleValueContainer()
            try c.encode(data.hexString)
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("spindown-diagnostics-\(Int(Date().timeIntervalSince1970)).json")
        try encoder.encode(bundle).write(to: url, options: .atomic)
        return url
    }
}
