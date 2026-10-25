import Foundation

/// Running totals. A pure fold over samples: the live screen, crash recovery and the saved
/// summary all go through `add(_:)`, so they cannot disagree.
public struct RideStats: Sendable, Equatable, Codable {
    /// 2 km/h. Below this the roller is effectively stopped.
    public static let movingThreshold = 2.0 / 3.6

    public private(set) var timerTime = 0.0
    public private(set) var movingTime = 0.0
    public private(set) var distance = 0.0
    public private(set) var work = 0.0
    public private(set) var maxSpeed = 0.0
    public private(set) var maxPower: Int?
    public private(set) var maxCadence: Double?
    private var powerSeconds = 0.0
    private var powerIntegral = 0.0
    private var cadenceSeconds = 0.0
    private var cadenceIntegral = 0.0
    public private(set) var maxHeartRate: Int?
    private var heartRateSeconds = 0.0
    private var heartRateIntegral = 0.0

    public init() {}

    public var averageSpeed: Double { movingTime > 0 ? distance / movingTime : 0 }
    /// Time-weighted over moving time, including zeros while coasting (matches Strava and Garmin).
    public var averagePower: Double? { powerSeconds > 0 ? powerIntegral / powerSeconds : nil }
    /// Time-weighted, excluding zero cadence (the usual convention).
    public var averageCadence: Double? { cadenceSeconds > 0 ? cadenceIntegral / cadenceSeconds : nil }
    /// Time-weighted over recording time with heart-rate data, moving or not (as Garmin does).
    public var averageHeartRate: Double? { heartRateSeconds > 0 ? heartRateIntegral / heartRateSeconds : nil }

    public mutating func add(_ s: RideSample) {
        timerTime += s.dt
        distance = s.distance
        if let hr = s.heartRate, hr > 0 {
            maxHeartRate = max(maxHeartRate ?? 0, hr)
            heartRateSeconds += s.dt
            heartRateIntegral += Double(hr) * s.dt
        }
        guard let speed = s.speed else { return }
        maxSpeed = max(maxSpeed, speed)
        if let p = s.power {
            work += Double(p) * s.dt
            maxPower = max(maxPower ?? 0, p)
        }
        if let c = s.cadence, c > 0 {
            maxCadence = max(maxCadence ?? 0, c)
            cadenceSeconds += s.dt
            cadenceIntegral += c * s.dt
        }
        guard speed > Self.movingThreshold else { return }
        movingTime += s.dt
        if let p = s.power {
            powerSeconds += s.dt
            powerIntegral += Double(p) * s.dt
        }
    }
}

/// Builds a ride one second at a time. Owns no clock and no I/O, so it is deterministic and
/// can be rebuilt exactly from the crash journal.
public struct RideRecorder: Sendable {
    /// Longest gap credited between two samples. Beyond this (app suspended, clock jump) time
    /// is not counted as riding.
    public static let maxSampleGap = 5.0

    public let startDate: Date
    public private(set) var samples: [RideSample] = []
    public private(set) var timerEvents: [RideTimerEvent] = [RideTimerEvent(t: 0, kind: .start)]
    public private(set) var stats = RideStats()
    public private(set) var isPaused = false
    private var lastT: Double? = 0

    public init(startDate: Date) {
        self.startDate = startDate
    }

    /// Records a sample at `t` seconds after start. Pass nil when there is no fresh trainer data
    /// (or heart rate). Heart rate is recorded even while the trainer is disconnected.
    @discardableResult
    public mutating func record(t: Double, reading: TrainerReading?, heartRate: Int? = nil) -> RideSample? {
        guard !isPaused else { return nil }
        let dt = lastT.map { min(max(t - $0, 0), Self.maxSampleGap) } ?? 0
        lastT = t
        let speed = reading.map { max(0, $0.speedKPH) / 3.6 }
        let distance = (samples.last?.distance ?? 0) + (speed ?? 0) * dt
        let sample = RideSample(
            t: t,
            dt: dt,
            power: reading.map { max(0, $0.power) },
            speed: speed,
            cadence: reading.map { max(0, $0.cadenceRPM) },
            distance: distance,
            heartRate: heartRate.flatMap { $0 > 0 ? $0 : nil }
        )
        apply(sample)
        return sample
    }

    /// Pauses the timer. Pass the current reading so the time up to the pause is credited;
    /// the closing sample is returned so the caller can journal it.
    @discardableResult
    public mutating func pause(t: Double, reading: TrainerReading? = nil, heartRate: Int? = nil) -> RideSample? {
        guard !isPaused else { return nil }
        var closing: RideSample?
        if let lastT, t > lastT { closing = record(t: t, reading: reading, heartRate: heartRate) }
        isPaused = true
        timerEvents.append(RideTimerEvent(t: t, kind: .stop))
        return closing
    }

    /// Journal replay: marks a pause without recording a closing sample (it is already in the journal).
    mutating func replayPause(t: Double) {
        guard !isPaused else { return }
        isPaused = true
        timerEvents.append(RideTimerEvent(t: t, kind: .stop))
    }

    public mutating func resume(t: Double) {
        guard isPaused else { return }
        isPaused = false
        lastT = t
        timerEvents.append(RideTimerEvent(t: t, kind: .start))
    }

    /// Appends a sample produced earlier (journal replay). Keeps its stored dt and distance.
    public mutating func apply(_ sample: RideSample) {
        samples.append(sample)
        stats.add(sample)
        lastT = sample.t
    }

    public func summary(endT: Double) -> RideSummary {
        var s = RideSummary()
        s.elapsedTime = max(endT, samples.last?.t ?? 0)
        s.timerTime = stats.timerTime
        s.movingTime = stats.movingTime
        s.distance = stats.distance
        s.averageSpeed = stats.averageSpeed
        s.maxSpeed = stats.maxSpeed
        s.averagePower = stats.averagePower
        s.maxPower = stats.maxPower
        s.averageCadence = stats.averageCadence
        s.maxCadence = stats.maxCadence
        s.averageHeartRate = stats.averageHeartRate
        s.maxHeartRate = stats.maxHeartRate
        s.work = stats.work
        s.normalizedPower = Self.normalizedPower(samples)
        return s
    }

    public var track: RideTrack { RideTrack(samples: samples, timerEvents: timerEvents) }

    /// Coggan normalised power: 30 s rolling mean of 1 Hz power, fourth-power mean, fourth root.
    /// Paused time is excluded; dropouts count as zero.
    public static func normalizedPower(_ samples: [RideSample]) -> Double? {
        let watts = samples.map { Double($0.power ?? 0) }
        guard watts.count >= 30 else { return nil }
        var window = watts.prefix(30).reduce(0, +)
        var sum4 = pow(window / 30, 4)
        for i in 30..<watts.count {
            window += watts[i] - watts[i - 30]
            sum4 += pow(window / 30, 4)
        }
        let np = pow(sum4 / Double(watts.count - 29), 0.25)
        return np > 0 ? np : nil
    }
}
