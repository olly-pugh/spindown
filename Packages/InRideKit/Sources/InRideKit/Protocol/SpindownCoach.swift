import Foundation

/// Runs a spindown so that only a genuine coast is timed.
///
/// The inRide's own state machine is speed-based: after the start command it arms above about
/// 33 km/h (calibration "ready", 602 ticks/rev) and starts timing as soon as speed falls below
/// about 30.5 km/h (655 ticks/rev), whether or not the rider is still pedalling. Riding near
/// those speeds, ordinary fluctuations start false spindowns.
///
/// So the app guards it:
/// 1. The start command is only sent once the rider has held `targetSpeed` (well above the
///    sensor's thresholds), and the rider is then told to stop pedalling.
/// 2. If speed sags towards the timing threshold slowly, as it does when easing off while still
///    pedalling, the spindown is cancelled before the sensor can begin timing.
/// 3. If speed rises while the sensor is timing (pedalling), the run is cancelled and discarded.
/// A coasting Road Machine flywheel loses roughly 5 km/h per second at these speeds; easing off
/// while pedalling is far slower, so the two are easy to tell apart.
public struct SpindownCoach: Sendable {
    public enum Phase: Equatable, Sendable {
        /// Get above the target speed.
        case accelerate
        /// Start command sent at time `since`: stop pedalling now.
        case stopPedalling(since: Double)
        /// The sensor is timing the run-down.
        case measuring
        /// The sensor has finished; read its result.
        case finished
        case failed(String)
    }

    public enum Action: Equatable, Sendable { case sendStart, sendStop }

    /// Speed to hold before arming, with margin over the sensor's ~33.2 km/h arming speed.
    public var targetSpeed: Double
    /// Below this, a slow (pedalling) deceleration cancels before the sensor's ~30.5 km/h timing point.
    public var guardSpeed: Double = 32.5
    /// Deceleration that counts as coasting, km/h per second.
    public var coastingDeceleration: Double = 2.5
    /// Seconds to hold the target speed before arming.
    public var holdTime: Double = 1.0

    public private(set) var phase: Phase = .accelerate
    /// Coaching note for the rider (e.g. why the attempt was cancelled).
    public private(set) var hint: String?

    private var samples: [(t: Double, speed: Double)] = []
    private var aboveTargetSince: Double?
    private var lastT: Double?

    public init(targetSpeed: Double = 36) {
        self.targetSpeed = targetSpeed
    }

    public mutating func reset() {
        phase = .accelerate
        hint = nil
        samples.removeAll()
        aboveTargetSince = nil
        lastT = nil
    }

    /// Average deceleration (km/h per second, positive when slowing) over roughly the last `window` seconds.
    public static func deceleration(_ samples: [(t: Double, speed: Double)], window: Double = 0.5) -> Double? {
        guard let last = samples.last,
              let first = samples.last(where: { last.t - $0.t >= window * 0.8 }) else { return nil }
        let dt = last.t - first.t
        guard dt > 0 else { return nil }
        return (first.speed - last.speed) / dt
    }

    public mutating func ingest(speedKPH: Double, sensorState: InRideSensorState, at t: Double) -> Action? {
        if let lastT, t <= lastT { return nil }
        let previous = samples.last
        lastT = t
        samples.append((t, speedKPH))
        samples.removeAll { t - $0.t > 3 }

        switch phase {
        case .accelerate:
            guard speedKPH >= targetSpeed else {
                aboveTargetSince = nil
                return nil
            }
            if aboveTargetSince == nil { aboveTargetSince = t }
            if let since = aboveTargetSince, t - since >= holdTime {
                phase = .stopPedalling(since: t)
                hint = nil
                return .sendStart
            }
            return nil

        case .stopPedalling(let since):
            if sensorState == .spindownActive {
                phase = .measuring
                return nil
            }
            if speedKPH <= guardSpeed {
                let decel = Self.deceleration(samples) ?? 0
                if decel < coastingDeceleration {
                    return cancel("You slowed down while still pedalling. Speed back up to \(Int(targetSpeed)) km/h, then stop pedalling completely.")
                }
            }
            // Command lost, or the sensor never saw arming speed.
            if t - since > 15, sensorState == .normal {
                phase = .failed("The trainer didn't respond to the calibration command. Check it is connected and try again.")
                return .sendStop
            }
            return nil

        case .measuring:
            if sensorState == .normal {
                phase = .finished
                return nil
            }
            if sensorState == .spindownIdle {
                // The sensor restarts its own process if it detects pedalling.
                phase = .failed("Pedalling was detected during the spindown. Try again and keep your legs still until the wheel stops.")
                return .sendStop
            }
            if let previous, speedKPH > previous.speed + 0.5 {
                phase = .failed("Pedalling was detected during the spindown. Try again and keep your legs still until the wheel stops.")
                return .sendStop
            }
            return nil

        case .finished, .failed:
            return nil
        }
    }

    private mutating func cancel(_ message: String) -> Action {
        phase = .accelerate
        aboveTargetSince = nil
        hint = message
        return .sendStop
    }
}
