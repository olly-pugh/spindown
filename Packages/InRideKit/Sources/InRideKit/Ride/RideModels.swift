import Foundation

/// The latest values from the trainer, as fed to the recorder once per second.
public struct TrainerReading: Sendable, Equatable, Codable {
    public var power: Int
    public var speedKPH: Double
    public var cadenceRPM: Double

    public init(power: Int, speedKPH: Double, cadenceRPM: Double) {
        self.power = power
        self.speedKPH = speedKPH
        self.cadenceRPM = cadenceRPM
    }
}

/// One recorded second. Short coding keys keep the crash journal and ride files compact.
public struct RideSample: Codable, Sendable, Equatable {
    /// Seconds since ride start (wall clock).
    public var t: Double
    /// Active seconds this sample accounts for. 0 for the first sample after start.
    public var dt: Double
    /// nil means no fresh trainer data (dropout or disconnected).
    public var power: Int?
    /// m/s
    public var speed: Double?
    public var cadence: Double?
    /// Cumulative metres.
    public var distance: Double

    public var hasData: Bool { speed != nil }

    enum CodingKeys: String, CodingKey {
        case t, dt, power = "p", speed = "v", cadence = "c", distance = "d"
    }

    public init(t: Double, dt: Double, power: Int?, speed: Double?, cadence: Double?, distance: Double) {
        self.t = t
        self.dt = dt
        self.power = power
        self.speed = speed
        self.cadence = cadence
        self.distance = distance
    }
}

public struct RideTimerEvent: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable { case start, stop }
    public var t: Double
    public var kind: Kind

    public init(t: Double, kind: Kind) {
        self.t = t
        self.kind = kind
    }
}

public struct RideSummary: Codable, Sendable, Equatable {
    /// Wall-clock duration, start to finish, including pauses (Strava's "elapsed time").
    public var elapsedTime: Double = 0
    /// Recording time excluding manual pauses (FIT "timer time").
    public var timerTime: Double = 0
    /// Time with the roller turning faster than the moving threshold.
    public var movingTime: Double = 0
    public var distance: Double = 0
    public var averageSpeed: Double = 0
    public var maxSpeed: Double = 0
    public var averagePower: Double?
    public var maxPower: Int?
    public var normalizedPower: Double?
    public var averageCadence: Double?
    public var maxCadence: Double?
    /// Joules.
    public var work: Double = 0
    /// Kilocalories. For cycling, Garmin and Strava both use roughly 1 kcal per kJ of work.
    public var calories: Double { work / 1000 }

    public init() {}
}

/// Snapshot of the trainer used for a ride, stored with the ride for traceability.
public struct TrainerInfo: Codable, Sendable, Equatable {
    public var name: String?
    public var identifier: String?
    public var manufacturer: String?
    public var model: String?
    public var firmware: String?
    public var hardware: String?
    public var systemID: String?
    public var spindownTime: Double?
    public var proFlywheel: Bool?

    public init(name: String? = nil, identifier: String? = nil, manufacturer: String? = nil, model: String? = nil,
                firmware: String? = nil, hardware: String? = nil, systemID: String? = nil,
                spindownTime: Double? = nil, proFlywheel: Bool? = nil) {
        self.name = name
        self.identifier = identifier
        self.manufacturer = manufacturer
        self.model = model
        self.firmware = firmware
        self.hardware = hardware
        self.systemID = systemID
        self.spindownTime = spindownTime
        self.proFlywheel = proFlywheel
    }
}

public enum UploadDestination: String, Codable, CodingKeyRepresentable, Sendable, CaseIterable, Identifiable {
    case garmin, strava
    public var id: String { rawValue }
    public var displayName: String {
        switch self {
        case .garmin: return "Garmin Connect"
        case .strava: return "Strava"
        }
    }
}

public enum UploadState: Codable, Sendable, Equatable {
    case pending
    case uploading
    /// Accepted by the service and still processing. `ref` is the service's upload id.
    case processing(ref: String)
    case uploaded(activityID: String?)
    /// The service already had this activity.
    case duplicate(activityID: String?)
    case failed(message: String, retryable: Bool)

    public var isFinished: Bool {
        switch self {
        case .uploaded, .duplicate: return true
        case .failed(_, let retryable): return !retryable
        default: return false
        }
    }
}

/// Metadata for a stored ride, small enough to load for every ride in the history list.
public struct RideRecord: Codable, Sendable, Identifiable, Equatable {
    public static let currentSchema = 1

    public var schemaVersion = RideRecord.currentSchema
    public var id: UUID
    public var name: String
    public var startDate: Date
    public var endDate: Date
    public var summary: RideSummary
    public var trainer: TrainerInfo?
    /// True when the ride was rebuilt from the crash journal after an unexpected exit.
    public var recovered: Bool
    public var uploads: [UploadDestination: UploadState]
    public var notes: String?

    public init(id: UUID, name: String, startDate: Date, endDate: Date, summary: RideSummary,
                trainer: TrainerInfo?, recovered: Bool, uploads: [UploadDestination: UploadState] = [:], notes: String? = nil) {
        self.id = id
        self.name = name
        self.startDate = startDate
        self.endDate = endDate
        self.summary = summary
        self.trainer = trainer
        self.recovered = recovered
        self.uploads = uploads
        self.notes = notes
    }
}

/// Everything needed to export a ride.
public struct RideTrack: Codable, Sendable, Equatable {
    public var samples: [RideSample]
    public var timerEvents: [RideTimerEvent]

    public init(samples: [RideSample], timerEvents: [RideTimerEvent]) {
        self.samples = samples
        self.timerEvents = timerEvents
    }
}

public extension RideRecord {
    static func defaultName(for date: Date, calendar: Calendar = .current) -> String {
        let hour = calendar.component(.hour, from: date)
        let part: String
        switch hour {
        case 5..<12: part = "Morning"
        case 12..<17: part = "Afternoon"
        case 17..<21: part = "Evening"
        default: part = "Night"
        }
        return "\(part) Indoor Ride"
    }
}
