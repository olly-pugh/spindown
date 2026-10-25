import Foundation
import Observation
import InRideKit

enum UnitSystem: String, CaseIterable, Identifiable {
    case metric, imperial
    var id: String { rawValue }
    var label: String { self == .metric ? "Metric (km/h, km)" : "Imperial (mph, mi)" }
}

enum PowerSmoothing: Int, CaseIterable, Identifiable {
    case instant = 1, three = 3, five = 5, ten = 10
    var id: Int { rawValue }
    var label: String { self == .instant ? "Instant" : "\(rawValue) s average" }
}

/// User preferences, persisted in UserDefaults. Secrets live in the Keychain, not here.
@MainActor @Observable
final class AppSettings {
    private let defaults: UserDefaults

    var units: UnitSystem { didSet { defaults.set(units.rawValue, forKey: "units") } }
    var powerSmoothing: PowerSmoothing { didSet { defaults.set(powerSmoothing.rawValue, forKey: "powerSmoothing") } }
    var keepScreenOn: Bool { didSet { defaults.set(keepScreenOn, forKey: "keepScreenOn") } }
    /// nil = leave the sensor's own setting alone (what Kinetic Fit did).
    var preferredUpdateRate: InRideUpdateRate? {
        didSet { defaults.set(preferredUpdateRate.map { Int($0.rawValue) } ?? 0, forKey: "updateRate") }
    }
    var autoConnect: Bool { didSet { defaults.set(autoConnect, forKey: "autoConnect") } }
    var autoUploadGarmin: Bool { didSet { defaults.set(autoUploadGarmin, forKey: "autoUploadGarmin") } }
    var autoUploadStrava: Bool { didSet { defaults.set(autoUploadStrava, forKey: "autoUploadStrava") } }
    var captureRawPackets: Bool { didSet { defaults.set(captureRawPackets, forKey: "captureRawPackets") } }
    var simulatorEnabled: Bool { didSet { defaults.set(simulatorEnabled, forKey: "simulator") } }
    /// The trainer to reconnect to automatically.
    var rememberedTrainerID: UUID? { didSet { defaults.set(rememberedTrainerID?.uuidString, forKey: "trainerID") } }
    var rememberedTrainerName: String? { didSet { defaults.set(rememberedTrainerName, forKey: "trainerName") } }
    /// The heart-rate strap to reconnect to automatically.
    var rememberedHeartRateID: UUID? { didSet { defaults.set(rememberedHeartRateID?.uuidString, forKey: "hrmID") } }
    var rememberedHeartRateName: String? { didSet { defaults.set(rememberedHeartRateName, forKey: "hrmName") } }
    /// Functional threshold power, for workout targets in the Lakes game.
    var ftp: Int { didSet { defaults.set(ftp, forKey: "ftp") } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            "units": Locale.current.measurementSystem == .us ? UnitSystem.imperial.rawValue : UnitSystem.metric.rawValue,
            "powerSmoothing": PowerSmoothing.three.rawValue,
            "keepScreenOn": true,
            "autoConnect": true,
            "autoUploadGarmin": true,
            // Off by default: Garmin forwards uploads to Strava for most riders, so both would duplicate.
            "autoUploadStrava": false,
            "captureRawPackets": true,
            "ftp": 200,
        ])
        units = UnitSystem(rawValue: defaults.string(forKey: "units") ?? "") ?? .metric
        powerSmoothing = PowerSmoothing(rawValue: defaults.integer(forKey: "powerSmoothing")) ?? .three
        keepScreenOn = defaults.bool(forKey: "keepScreenOn")
        preferredUpdateRate = InRideUpdateRate(rawValue: UInt16(clamping: defaults.integer(forKey: "updateRate")))
        autoConnect = defaults.bool(forKey: "autoConnect")
        autoUploadGarmin = defaults.bool(forKey: "autoUploadGarmin")
        autoUploadStrava = defaults.bool(forKey: "autoUploadStrava")
        captureRawPackets = defaults.bool(forKey: "captureRawPackets")
        simulatorEnabled = defaults.bool(forKey: "simulator")
        rememberedTrainerID = defaults.string(forKey: "trainerID").flatMap(UUID.init(uuidString:))
        rememberedTrainerName = defaults.string(forKey: "trainerName")
        rememberedHeartRateID = defaults.string(forKey: "hrmID").flatMap(UUID.init(uuidString:))
        rememberedHeartRateName = defaults.string(forKey: "hrmName")
        ftp = defaults.integer(forKey: "ftp")
    }

    var autoUploadDestinations: [UploadDestination] {
        var out: [UploadDestination] = []
        if autoUploadGarmin { out.append(.garmin) }
        if autoUploadStrava { out.append(.strava) }
        return out
    }
}
