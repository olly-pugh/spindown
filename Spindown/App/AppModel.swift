import Foundation
import Observation
import InRideKit

/// Composition root: builds the long-lived services once and wires them together.
@MainActor @Observable
final class AppModel {
    let settings: AppSettings
    let log: DiagnosticsLog
    let trainer: TrainerManager
    let heartRate: HeartRateMonitor
    let store: RideStore
    let session: RideSession
    let uploads: UploadCoordinator
    let keychain = KeychainStore()

    /// Shown once after launch if a ride was recovered.
    var recoveryMessage: String?
    /// The ride just finished, for the summary sheet.
    var finishedRideID: UUID?

    init() {
        let settings = AppSettings()
        let log = DiagnosticsLog()
        let store = RideStore()
        let trainer = TrainerManager(settings: settings, log: log)
        let heartRate = HeartRateMonitor(settings: settings, log: log)
        let keychain = KeychainStore()
        let strava = StravaClient(config: Self.stravaConfig(keychain), transport: URLSession.shared, store: keychain)
        let garmin = GarminConnectClient(transport: URLSession.shared, store: keychain)

        self.settings = settings
        self.log = log
        self.store = store
        self.trainer = trainer
        self.heartRate = heartRate
        self.session = RideSession(trainer: trainer, heartRate: heartRate, store: store, settings: settings)
        self.uploads = UploadCoordinator(store: store, log: log, garmin: garmin, strava: strava)

        trainer.onMeasurement = { [weak session] m, date in session?.handle(m, at: date) }
        trainer.onPacket = { [weak session] p in session?.handlePacket(p) }
        // Heart-rate packets also keep sampling going if the trainer is asleep or disconnected.
        heartRate.onHeartRate = { [weak session] _, date in session?.tick(now: date) }

        store.load()
        log.log("Spindown \(Platform.appVersion) started; \(store.records.count) rides on file")
        switch session.recoverIfNeeded() {
        case .resumed?:
            recoveryMessage = "Spindown was closed during your ride. Recording has resumed where it left off."
        case .saved(let record)?:
            recoveryMessage = "Spindown was closed during a ride. It has been saved to your history as \"\(record.name)\"."
        case .failed(let message)?:
            recoveryMessage = message
        case nil:
            break
        }

        Platform.registerBackgroundUploads { [weak self] in await self?.uploads.process() }
        Task { [uploads] in
            await uploads.refreshAccounts()
            await uploads.process()
        }
    }

    /// Strava API credentials: the user's own (Settings) take precedence over build-time ones.
    static func stravaConfig(_ keychain: KeychainStore) -> StravaConfig {
        let info = Bundle.main.infoDictionary
        let id = keychain.string("strava.clientID") ?? (info?["StravaClientID"] as? String) ?? ""
        let secret = keychain.string("strava.clientSecret") ?? (info?["StravaClientSecret"] as? String) ?? ""
        return StravaConfig(clientID: id.trimmingCharacters(in: .whitespaces), clientSecret: secret.trimmingCharacters(in: .whitespaces))
    }

    func updateStravaCredentials(clientID: String, secret: String) async {
        keychain.set(clientID, for: "strava.clientID")
        keychain.set(secret, for: "strava.clientSecret")
        await uploads.strava.update(config: Self.stravaConfig(keychain))
    }

    /// Strava may hand its OAuth result back through the app's URL scheme (when the Strava app
    /// handles the sign-in) instead of through the web authentication session.
    func handleOpenURL(_ url: URL) {
        guard url.scheme == "spindown" else { return }
        log.log("Opened via link: \(url.host ?? "")\(url.path)")
        Task { await uploads.completePendingStravaSignIn(url) }
    }

    func finishRide() {
        guard let record = session.finish() else { return }
        finishedRideID = record.id
        Task { await uploads.process() }
    }

    func appBecameActive() {
        session.tick()
        Task {
            await uploads.refreshAccounts()
            await uploads.process()
        }
    }

    func appEnteredBackground() {
        session.flush()
        if uploads.hasOutstandingWork { Platform.scheduleBackgroundUploads() }
    }
}
