import Foundation
import Observation
import InRideKit

/// File-based ride storage, one folder per ride:
///
///     Documents/Rides/<uuid>/record.json   metadata + summary + upload states
///     Documents/Rides/<uuid>/track.json    1 Hz samples and timer events
///     Documents/Rides/<uuid>/packets.jsonl raw BLE capture (optional)
///     Documents/ActiveRide/                crash journal of the ride in progress
///
/// Plain, versioned JSON with no database: nothing to migrate when iOS changes, files are
/// included in device backups and visible in the Files app, and a damaged ride cannot take
/// the others with it.
@MainActor @Observable
final class RideStore {
    private(set) var records: [RideRecord] = []
    private(set) var loadErrors: [String] = []

    let ridesDirectory: URL
    let activeDirectory: URL

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    init(root: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]) {
        ridesDirectory = root.appendingPathComponent("Rides", isDirectory: true)
        activeDirectory = root.appendingPathComponent("ActiveRide", isDirectory: true)
        try? FileManager.default.createDirectory(at: ridesDirectory, withIntermediateDirectories: true)
    }

    func load() {
        var loaded: [RideRecord] = []
        var errors: [String] = []
        let folders = (try? FileManager.default.contentsOfDirectory(at: ridesDirectory, includingPropertiesForKeys: nil)) ?? []
        for folder in folders where folder.hasDirectoryPath {
            let url = folder.appendingPathComponent("record.json")
            do {
                loaded.append(try decoder.decode(RideRecord.self, from: Data(contentsOf: url)))
            } catch {
                errors.append("\(folder.lastPathComponent): \(error.localizedDescription)")
            }
        }
        records = loaded.sorted { $0.startDate > $1.startDate }
        loadErrors = errors
    }

    func folder(for id: UUID) -> URL {
        ridesDirectory.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    func record(_ id: UUID) -> RideRecord? {
        records.first { $0.id == id }
    }

    /// Saves a finished ride. Track first, record last, so a record never points at a missing track.
    func save(record: RideRecord, track: RideTrack, packetCapture: URL?) throws {
        let dir = folder(for: record.id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try encoder.encode(track).write(to: dir.appendingPathComponent("track.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        if let packetCapture, FileManager.default.fileExists(atPath: packetCapture.path) {
            let dest = dir.appendingPathComponent("packets.jsonl")
            try? FileManager.default.removeItem(at: dest)
            try? FileManager.default.moveItem(at: packetCapture, to: dest)
        }
        try writeRecord(record)
        records.removeAll { $0.id == record.id }
        records.append(record)
        records.sort { $0.startDate > $1.startDate }
    }

    func update(_ record: RideRecord) {
        do {
            try writeRecord(record)
            if let i = records.firstIndex(where: { $0.id == record.id }) { records[i] = record }
        } catch {
            loadErrors.append("Could not update \(record.id): \(error.localizedDescription)")
        }
    }

    func setUpload(_ state: UploadState, for destination: UploadDestination, ride id: UUID) {
        guard var r = record(id) else { return }
        r.uploads[destination] = state
        update(r)
    }

    private func writeRecord(_ record: RideRecord) throws {
        try encoder.encode(record).write(to: folder(for: record.id).appendingPathComponent("record.json"),
                                         options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func delete(_ id: UUID) {
        try? FileManager.default.removeItem(at: folder(for: id))
        records.removeAll { $0.id == id }
    }

    func track(for id: UUID) throws -> RideTrack {
        try decoder.decode(RideTrack.self, from: Data(contentsOf: folder(for: id).appendingPathComponent("track.json")))
    }

    func packetCaptureURL(for id: UUID) -> URL? {
        let url = folder(for: id).appendingPathComponent("packets.jsonl")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func exportable(_ id: UUID) throws -> ExportableRide {
        guard let r = record(id) else { throw CocoaError(.fileNoSuchFile) }
        return ExportableRide(record: r, track: try track(for: id))
    }

    /// Writes an export to a temporary file for sharing.
    func exportFile(_ id: UUID, format: ExportFormat) throws -> URL {
        let ride = try exportable(id)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(ActivityExporter.fileName(for: ride, format: format))
        try ActivityExporter.export(ride, as: format).write(to: url, options: .atomic)
        return url
    }
}

/// Append-only writer for the ride in progress. Every line is a complete JSON object, and the
/// file is fsync'd every few seconds and at every pause, so at most a few seconds can be lost.
final class RideJournalWriter {
    let directory: URL
    var journalURL: URL { directory.appendingPathComponent("journal.jsonl") }
    var packetsURL: URL { directory.appendingPathComponent("packets.jsonl") }

    private var journal: FileHandle?
    private var packets: FileHandle?
    private var linesSinceSync = 0

    init(directory: URL, resume: Bool) throws {
        self.directory = directory
        let fm = FileManager.default
        if !resume {
            try? fm.removeItem(at: directory)
        }
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        for url in [journalURL, packetsURL] where !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        }
        journal = try FileHandle(forWritingTo: journalURL)
        packets = try FileHandle(forWritingTo: packetsURL)
        try journal?.seekToEnd()
        try packets?.seekToEnd()
    }

    func append(_ entry: RideJournalEntry, sync: Bool = false) {
        guard let journal, let line = try? entry.line() else { return }
        try? journal.write(contentsOf: line)
        linesSinceSync += 1
        if sync || linesSinceSync >= 5 { flush() }
    }

    func appendPacket(_ p: DiagnosticsLog.Packet) {
        let line = String(format: "{\"t\":%.3f,\"dir\":\"%@\",\"c\":\"%@\",\"hex\":\"%@\"}\n",
                          p.date.timeIntervalSince1970, p.direction.rawValue, p.characteristic, [UInt8](p.bytes).hexString(separator: ""))
        try? packets?.write(contentsOf: Data(line.utf8))
    }

    func flush() {
        try? journal?.synchronize()
        try? packets?.synchronize()
        linesSinceSync = 0
    }

    func close() {
        flush()
        try? journal?.close()
        try? packets?.close()
        journal = nil
        packets = nil
    }
}
