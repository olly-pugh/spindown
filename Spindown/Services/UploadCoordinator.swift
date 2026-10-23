import Foundation
import Network
import Observation
import InRideKit

/// Sends saved rides to Garmin Connect (first) and Strava, and keeps retrying until each
/// destination either accepts the ride or rejects it for good. Upload state lives in each
/// ride's record.json, so pending uploads survive restarts.
@MainActor @Observable
final class UploadCoordinator {
    private(set) var garminSignedIn = false
    private(set) var garminAccountName: String?
    private(set) var garminNeedsSignIn = false
    private(set) var stravaSignedIn = false
    private(set) var stravaAccountName: String?
    private(set) var stravaNeedsSignIn = false
    private(set) var isProcessing = false
    private(set) var networkAvailable = true

    let garmin: GarminConnectClient
    let strava: StravaClient
    private let store: RideStore
    private let log: DiagnosticsLog
    private var attempts: [String: Int] = [:]
    private var notBefore: [String: Date] = [:]
    private var processAgain = false
    private let monitor = NWPathMonitor()

    init(store: RideStore, log: DiagnosticsLog, garmin: GarminConnectClient, strava: StravaClient) {
        self.store = store
        self.log = log
        self.garmin = garmin
        self.strava = strava
        monitor.pathUpdateHandler = { [weak self] path in
            let available = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                let regained = available && !self.networkAvailable
                self.networkAvailable = available
                if regained {
                    self.log.log("Network available; retrying uploads")
                    self.notBefore.removeAll()
                    await self.process()
                }
            }
        }
        monitor.start(queue: .main)
    }

    func refreshAccounts() async {
        garminSignedIn = await garmin.isSignedIn
        stravaSignedIn = await strava.isSignedIn
        stravaAccountName = await strava.tokens?.athleteName
        if garminSignedIn, garminAccountName == nil {
            garminAccountName = try? await garmin.profileName()
        }
    }

    // MARK: Accounts

    func completeGarminSignIn(ticket: String) async throws {
        try await garmin.signIn(ticket: ticket)
        garminNeedsSignIn = false
        garminAccountName = nil
        await refreshAccounts()
        log.log("Signed in to Garmin Connect\(garminAccountName.map { " as \($0)" } ?? "")")
        notBefore.removeAll()
        await process()
    }

    func testGarmin() async -> String {
        do {
            let name = try await garmin.profileName()
            garminAccountName = name
            garminNeedsSignIn = false
            return "Connected as \(name)."
        } catch let e as ServiceError {
            if case .reauthenticationRequired = e { garminNeedsSignIn = true }
            return e.localizedDescription
        } catch {
            return error.localizedDescription
        }
    }

    func signOutGarmin() async {
        await garmin.signOut()
        garminAccountName = nil
        await refreshAccounts()
        log.log("Signed out of Garmin Connect")
    }

    func completeStravaSignIn(callback: URL, state: String) async throws {
        try await strava.handleCallback(callback, expectedState: state)
        stravaNeedsSignIn = false
        await refreshAccounts()
        log.log("Signed in to Strava\(stravaAccountName.map { " as \($0)" } ?? "")")
        notBefore.removeAll()
        await process()
    }

    func signOutStrava() async {
        await strava.signOut()
        await refreshAccounts()
        log.log("Signed out of Strava")
    }

    // MARK: Queue

    func enqueue(_ id: UUID, to destinations: [UploadDestination]) async {
        for d in destinations {
            store.setUpload(.pending, for: d, ride: id)
            attempts[key(id, d)] = 0
            notBefore[key(id, d)] = nil
        }
        await process()
    }

    /// Uploads everything outstanding, Garmin before Strava, oldest ride first.
    func process() async {
        if isProcessing {
            processAgain = true
            return
        }
        isProcessing = true
        defer { isProcessing = false }
        repeat {
            processAgain = false
            await Platform.withBackgroundTime("Spindown uploads") {
                for record in store.records.sorted(by: { $0.startDate < $1.startDate }) {
                    for destination in UploadDestination.allCases {
                        guard let state = store.record(record.id)?.uploads[destination], needsWork(state) else { continue }
                        if let wait = notBefore[key(record.id, destination)], wait > Date() { continue }
                        await upload(record.id, to: destination, from: state)
                    }
                }
            }
        } while processAgain
        if hasOutstandingWork { Platform.scheduleBackgroundUploads() }
    }

    var hasOutstandingWork: Bool {
        store.records.contains { r in r.uploads.values.contains { needsWork($0) } }
    }

    private func needsWork(_ state: UploadState) -> Bool {
        switch state {
        case .pending, .processing: return true
        case .failed(_, let retryable): return retryable
        case .uploading: return true // interrupted by the app being killed
        case .uploaded, .duplicate: return false
        }
    }

    private func key(_ id: UUID, _ d: UploadDestination) -> String { "\(id.uuidString)/\(d.rawValue)" }

    private func upload(_ id: UUID, to destination: UploadDestination, from state: UploadState) async {
        switch destination {
        case .garmin:
            guard await garmin.isSignedIn, !garminNeedsSignIn else { return } // stays pending until sign-in
        case .strava:
            guard await strava.isSignedIn, !stravaNeedsSignIn else { return }
        }
        guard networkAvailable else { return }
        let k = key(id, destination)

        do {
            let outcome: UploadOutcome
            if case .processing(let ref) = state, destination == .strava {
                outcome = try await pollStrava(ref: ref)
            } else {
                let ride = try store.exportable(id)
                let fit = ActivityExporter.fit(ride)
                store.setUpload(.uploading, for: destination, ride: id)
                log.log("Uploading \(ride.record.name) to \(destination.displayName) (\(fit.count) bytes)")
                switch destination {
                case .garmin:
                    outcome = try await garmin.upload(fit: fit, fileName: ActivityExporter.fileName(for: ride, format: .fit))
                case .strava:
                    let first = try await strava.upload(fit: fit, name: ride.record.name,
                                                        description: "Indoor ride on a Kinetic Road Machine (inRide), recorded with Spindown.",
                                                        externalID: id.uuidString)
                    if case .processing(let ref) = first {
                        store.setUpload(first.state, for: destination, ride: id)
                        outcome = try await pollStrava(ref: ref)
                    } else {
                        outcome = first
                    }
                }
            }
            store.setUpload(outcome.state, for: destination, ride: id)
            attempts[k] = 0
            notBefore[k] = nil
            log.log("\(destination.displayName): \(describe(outcome.state))")
        } catch {
            let attempt = (attempts[k] ?? 0) + 1
            attempts[k] = attempt
            let serviceError = error as? ServiceError
            if case .reauthenticationRequired = serviceError {
                if destination == .garmin { garminNeedsSignIn = true } else { stravaNeedsSignIn = true }
                store.setUpload(.pending, for: destination, ride: id)
                log.log("\(destination.displayName) needs you to sign in again; upload will resume afterwards", level: .warning)
                return
            }
            let retryable = serviceError?.isRetryable ?? true // network errors are retryable
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            store.setUpload(.failed(message: message, retryable: retryable), for: destination, ride: id)
            if retryable {
                let delay = min(1800, 30 * pow(2, Double(min(attempt - 1, 6))))
                notBefore[k] = Date().addingTimeInterval(delay)
                log.log("\(destination.displayName) upload failed (attempt \(attempt)): \(message). Retrying in \(Int(delay)) s", level: .warning)
            } else {
                log.log("\(destination.displayName) upload failed permanently: \(message)", level: .error)
            }
        }
    }

    private func pollStrava(ref: String) async throws -> UploadOutcome {
        var outcome = UploadOutcome.processing(ref: ref)
        for _ in 0..<10 {
            try await Task.sleep(for: .seconds(3))
            outcome = try await strava.checkUpload(ref: ref)
            if case .processing = outcome { continue }
            break
        }
        return outcome
    }

    func retry(_ id: UUID, _ destination: UploadDestination) async {
        await enqueue(id, to: [destination])
    }

    func describe(_ state: UploadState?) -> String {
        switch state {
        case nil: return "Not uploaded"
        case .pending: return "Waiting to upload"
        case .uploading: return "Uploading…"
        case .processing: return "Processing…"
        case .uploaded: return "Uploaded"
        case .duplicate: return "Already on the service"
        case .failed(let message, let retryable): return retryable ? "Retrying: \(message)" : "Failed: \(message)"
        }
    }
}
