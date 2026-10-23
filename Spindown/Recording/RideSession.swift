import Foundation
import Observation
import InRideKit

/// The ride in progress. Samples once per whole second, driven both by a timer and by
/// incoming packets (iOS suspends timers in the background but wakes the app for BLE).
@MainActor @Observable
final class RideSession {
    enum Phase: Equatable { case idle, recording, paused }

    enum RecoveryOutcome {
        /// The app was relaunched shortly after dying mid-ride; recording continues.
        case resumed
        /// The journal was too old to continue; it was saved as a recovered ride.
        case saved(RideRecord)
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var recorder: RideRecorder?
    private(set) var rideID: UUID?
    private(set) var clock = Date()
    private(set) var lastError: String?

    private let trainer: TrainerManager
    private let store: RideStore
    private let settings: AppSettings
    private var journal: RideJournalWriter?
    private var lastRecordedSecond = 0.0
    private var timerTask: Task<Void, Never>?
    private var powerWindow: [(Date, Int)] = []

    static let resumeWindow: TimeInterval = 15 * 60

    init(trainer: TrainerManager, store: RideStore, settings: AppSettings) {
        self.trainer = trainer
        self.store = store
        self.settings = settings
    }

    // MARK: Live values

    var startDate: Date? { recorder?.startDate }
    var stats: RideStats { recorder?.stats ?? RideStats() }

    func elapsed(at now: Date) -> TimeInterval {
        startDate.map { max(0, now.timeIntervalSince($0)) } ?? 0
    }

    /// Power for display, averaged over the chosen window. nil when there is no fresh data.
    func displayPower(at now: Date) -> Int? {
        guard trainer.freshReading(now: now) != nil else { return nil }
        let cutoff = now.addingTimeInterval(-Double(settings.powerSmoothing.rawValue) - 0.25)
        let values = powerWindow.filter { $0.0 >= cutoff }.map(\.1)
        guard !values.isEmpty else { return trainer.latest?.power }
        return Int((Double(values.reduce(0, +)) / Double(values.count)).rounded())
    }

    // MARK: Trainer input

    func handle(_ m: InRidePowerMeasurement, at date: Date) {
        powerWindow.append((date, m.power))
        powerWindow.removeAll { date.timeIntervalSince($0.0) > 12 }
        tick(now: date)
    }

    func handlePacket(_ p: DiagnosticsLog.Packet) {
        guard phase != .idle, settings.captureRawPackets else { return }
        journal?.appendPacket(p)
    }

    // MARK: Control

    func start() {
        guard phase == .idle else { return }
        do {
            let id = UUID()
            let start = Date()
            let writer = try RideJournalWriter(directory: store.activeDirectory, resume: false)
            writer.append(.header(id: id, startDate: start, trainer: trainer.trainerInfo), sync: true)
            journal = writer
            rideID = id
            recorder = RideRecorder(startDate: start)
            lastRecordedSecond = 0
            clock = start
            phase = .recording
            lastError = nil
            startTimer()
            trainer.log.log("Ride started")
        } catch {
            lastError = "Could not start recording: \(error.localizedDescription)"
            trainer.log.log(lastError!, level: .error)
        }
    }

    func pause() {
        guard phase == .recording, var r = recorder else { return }
        let t = Date().timeIntervalSince(r.startDate)
        if let closing = r.pause(t: t, reading: trainer.freshReading()) {
            journal?.append(.sample(closing))
        }
        journal?.append(.pause(t: t), sync: true)
        recorder = r
        phase = .paused
        trainer.log.log("Ride paused")
    }

    func resume() {
        guard phase == .paused, var r = recorder else { return }
        let t = Date().timeIntervalSince(r.startDate)
        r.resume(t: t)
        journal?.append(.resume(t: t), sync: true)
        recorder = r
        lastRecordedSecond = t.rounded(.down)
        phase = .recording
        trainer.log.log("Ride resumed")
    }

    /// Stops recording and saves. Returns the saved record.
    func finish() -> RideRecord? {
        guard phase != .idle, var r = recorder, let id = rideID else { return nil }
        let endDate = Date()
        let endT = endDate.timeIntervalSince(r.startDate)
        if phase == .recording, let closing = r.pause(t: endT, reading: trainer.freshReading()) {
            journal?.append(.sample(closing))
        }
        journal?.append(.pause(t: endT), sync: true)
        let record = RideRecord(id: id, name: RideRecord.defaultName(for: r.startDate), startDate: r.startDate, endDate: endDate,
                                summary: r.summary(endT: endT), trainer: trainer.trainerInfo, recovered: false,
                                uploads: Dictionary(uniqueKeysWithValues: settings.autoUploadDestinations.map { ($0, .pending) }))
        do {
            journal?.close()
            try store.save(record: record, track: r.track, packetCapture: settings.captureRawPackets ? journal?.packetsURL : nil)
            try? FileManager.default.removeItem(at: store.activeDirectory)
            reset()
            trainer.log.log("Ride saved: \(Int(record.summary.distance)) m, \(Int(record.summary.timerTime)) s")
            return record
        } catch {
            // Keep the journal: the ride will be recovered on next launch.
            lastError = "Could not save the ride (\(error.localizedDescription)). It is kept and will be recovered."
            trainer.log.log(lastError!, level: .error)
            return nil
        }
    }

    func discard() {
        journal?.close()
        try? FileManager.default.removeItem(at: store.activeDirectory)
        reset()
        trainer.log.log("Ride discarded")
    }

    private func reset() {
        timerTask?.cancel()
        timerTask = nil
        journal = nil
        recorder = nil
        rideID = nil
        phase = .idle
        Platform.setScreenAlwaysOn(false)
    }

    /// Flushes the journal; call when the app moves to the background.
    func flush() { journal?.flush() }

    // MARK: Sampling

    private func startTimer() {
        timerTask?.cancel()
        Platform.setScreenAlwaysOn(settings.keepScreenOn)
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                // Wake just after each whole second of ride time.
                let start = self?.startDate ?? Date()
                let frac = Date().timeIntervalSince(start).truncatingRemainder(dividingBy: 1)
                try? await Task.sleep(for: .milliseconds(Int((1.02 - frac) * 1000)))
                self?.tick(now: Date())
            }
        }
    }

    func tick(now: Date = Date()) {
        clock = now
        guard phase == .recording, var r = recorder else { return }
        let second = now.timeIntervalSince(r.startDate).rounded(.down)
        guard second > lastRecordedSecond else { return }
        lastRecordedSecond = second
        if let sample = r.record(t: second, reading: trainer.freshReading(now: now)) {
            journal?.append(.sample(sample))
        }
        recorder = r
    }

    // MARK: Crash recovery

    /// Call once at launch, before connecting. Continues or saves a ride left by a previous process.
    func recoverIfNeeded() -> RecoveryOutcome? {
        let url = store.activeDirectory.appendingPathComponent("journal.jsonl")
        guard phase == .idle, let data = try? Data(contentsOf: url), !data.isEmpty else { return nil }
        do {
            let recovered = try RideJournalReplay.replay(data)
            let start = recovered.recorder.startDate
            let lastKnown = start.addingTimeInterval(recovered.lastT)
            trainer.log.log("Found unfinished ride from \(start.formatted()) (\(recovered.recorder.samples.count) samples, \(recovered.skippedLines) unreadable lines)", level: .warning)

            if Date().timeIntervalSince(lastKnown) < Self.resumeWindow {
                journal = try RideJournalWriter(directory: store.activeDirectory, resume: true)
                rideID = recovered.id
                recorder = recovered.recorder
                lastRecordedSecond = recovered.lastT.rounded(.down)
                phase = recovered.recorder.isPaused ? .paused : .recording
                clock = Date()
                startTimer()
                trainer.log.log("Resumed the unfinished ride")
                return .resumed
            }

            var r = recovered.recorder
            if !r.isPaused { r.pause(t: recovered.lastT) }
            let record = RideRecord(id: recovered.id, name: RideRecord.defaultName(for: start), startDate: start, endDate: lastKnown,
                                    summary: r.summary(endT: recovered.lastT), trainer: recovered.trainer, recovered: true,
                                    uploads: Dictionary(uniqueKeysWithValues: settings.autoUploadDestinations.map { ($0, .pending) }))
            try store.save(record: record, track: r.track, packetCapture: store.activeDirectory.appendingPathComponent("packets.jsonl"))
            try? FileManager.default.removeItem(at: store.activeDirectory)
            trainer.log.log("Saved the unfinished ride as a recovered ride")
            return .saved(record)
        } catch {
            // Keep the files for diagnosis but move them aside so they do not block new rides.
            let aside = store.ridesDirectory.deletingLastPathComponent()
                .appendingPathComponent("UnrecoverableRide-\(Int(Date().timeIntervalSince1970))")
            try? FileManager.default.moveItem(at: store.activeDirectory, to: aside)
            trainer.log.log("Could not recover unfinished ride: \(error)", level: .error)
            return .failed("An unfinished ride could not be recovered. Its raw files were kept in the Files app.")
        }
    }
}
