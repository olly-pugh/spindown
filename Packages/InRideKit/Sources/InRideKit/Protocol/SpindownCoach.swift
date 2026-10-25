import Foundation

/// Runs a spindown so that only a genuine coast is timed.
///
/// The inRide's own state machine is speed-based: after the start command it arms above about
/// 33 km/h (calibration "ready", 602 ticks/rev) and starts timing as soon as speed falls below
/// about 30.5 km/h (655 ticks/rev), whether or not the rider is still pedalling. Riding near
/// those speeds, ordinary fluctuations start false spindowns.
///
/// The timed window (30.5 to 21 km/h) is what Kinetic's power model is built on, so it is never
/// changed. The arming speed is lowered (see `armingSpeed`) so the rider only needs to touch about
/// 32.5 km/h, and the app guards the run:
/// 1. The start command is only sent once the rider has held `targetSpeed`; the rider is then
///    told to stop pedalling.
/// 2. If speed sags to just above the timing point slowly, as it does when easing off while still
///    pedalling, the spindown is cancelled before the sensor can begin timing.
/// 3. While the sensor is timing, the speed must keep falling like a freewheeling flywheel
///    (at least `coastingDeceleration`); a rise or a slow fade means pedalling, and the run is
///    cancelled and discarded.
/// A standard flywheel coasts down at roughly 5 km/h per second here and a Pro Flywheel at about
/// 1.5 to 2; fading while pedalling is slower than either.
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

    /// Speed to hold before arming.
    public var targetSpeed: Double
    /// Speed at which the sensor arms (written to it as calibration "ready"). Must sit between the
    /// timing start (~30.5 km/h) and `targetSpeed`.
    public var armingSpeed: Double = 31.8
    /// Below this, a slow (pedalling) deceleration cancels before the sensor's ~30.5 km/h timing point.
    public var guardSpeed: Double = 31.0
    /// Deceleration that counts as coasting, km/h per second (allows for a Pro Flywheel).
    public var coastingDeceleration: Double = 1.2
    /// Seconds to hold the target speed before arming.
    public var holdTime: Double = 1.0

    public private(set) var phase: Phase = .accelerate
    /// Coaching note for the rider (e.g. why the attempt was cancelled).
    public private(set) var hint: String?

    private var samples: [(t: Double, speed: Double)] = []
    private var aboveTargetSince: Double?
    private var measuringStart: (t: Double, speed: Double)?
    private var lastT: Double?

    public init(targetSpeed: Double = 32.5) {
        self.targetSpeed = targetSpeed
    }

    public mutating func reset() {
        phase = .accelerate
        hint = nil
        samples.removeAll()
        aboveTargetSince = nil
        measuringStart = nil
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
                measuringStart = (t, speedKPH)
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
            let pedalling = "Pedalling was detected during the spindown. Try again and keep your legs still until the wheel stops."
            if let previous, speedKPH > previous.speed + 0.3 {
                phase = .failed(pedalling)
                return .sendStop
            }
            if let start = measuringStart, t - start.t >= 1.0,
               (start.speed - speedKPH) / (t - start.t) < coastingDeceleration {
                phase = .failed(pedalling)
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
