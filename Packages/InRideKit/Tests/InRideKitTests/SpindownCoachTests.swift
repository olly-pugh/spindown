import Foundation
import Testing
@testable import InRideKit

@Suite("Spindown coach")
struct SpindownCoachTests {
    /// Feeds 4 Hz samples; returns any actions emitted.
    @discardableResult
    func feed(_ coach: inout SpindownCoach, _ speeds: [Double], from t0: Double, state: InRideSensorState = .normal) -> [SpindownCoach.Action] {
        var actions: [SpindownCoach.Action] = []
        for (i, v) in speeds.enumerated() {
            if let a = coach.ingest(speedKPH: v, sensorState: state, at: t0 + Double(i) * 0.25) { actions.append(a) }
        }
        return actions
    }

    /// Coasting decay from `start` km/h: about 5.4 km/h per second, as on the Road Machine.
    func coast(from start: Double, seconds: Double) -> [Double] {
        stride(from: 0.25, through: seconds, by: 0.25).map { start - 5.4 * $0 }
    }

    @Test("Pedalling wobble at speed arms once and never cancels or starts timing")
    func wobbleDoesNotTrigger() {
        var coach = SpindownCoach()
        var rng = SystemRandomNumberGenerator()
        let speeds = (0..<480).map { i in 37 + sin(Double(i) * 1.7) * 0.8 + Double.random(in: -0.4...0.4, using: &rng) }
        // Sensor reports normal until armed, then "ready" while the rider keeps pedalling at speed.
        var actions = feed(&coach, Array(speeds[0..<8]), from: 0)
        actions += feed(&coach, Array(speeds[8...]), from: 2, state: .spindownReady)
        #expect(actions == [.sendStart])
        guard case .stopPedalling = coach.phase else { Issue.record("expected stopPedalling, got \(coach.phase)"); return }
    }

    @Test("Arms only after holding the target speed")
    func armsAfterHold() {
        var coach = SpindownCoach()
        #expect(feed(&coach, [30, 32, 34, 35, 35.9], from: 0).isEmpty)
        #expect(feed(&coach, [36.2, 36.5, 36.4, 36.6], from: 1.25) == [])
        #expect(feed(&coach, [36.7], from: 2.25) == [.sendStart])
    }

    @Test("Slowing down while still pedalling cancels before the sensor can time it")
    func slowSagCancels() {
        var coach = SpindownCoach()
        feed(&coach, Array(repeating: 37, count: 6), from: 0)
        // Easing off at ~1 km/h per second while pedalling.
        let sag = stride(from: 36.75, through: 31.0, by: -0.25).map { $0 }
        let actions = feed(&coach, sag, from: 1.5, state: .spindownReady)
        #expect(actions == [.sendStop])
        #expect(coach.phase == .accelerate)
        #expect(coach.hint != nil)
    }

    @Test("A real coast passes the guard and completes")
    func success() {
        var coach = SpindownCoach()
        #expect(feed(&coach, Array(repeating: 38, count: 6), from: 0) == [.sendStart])
        // Rider stops pedalling: ~5.4 km/h per second.
        let decay = coast(from: 38, seconds: 1.0)
        #expect(feed(&coach, decay, from: 1.5, state: .spindownReady).isEmpty)
        feed(&coach, [31, 29, 27, 25, 23], from: 2.75, state: .spindownActive)
        #expect(coach.phase == .measuring)
        feed(&coach, [20], from: 4.0, state: .normal)
        #expect(coach.phase == .finished)
    }

    @Test("Pedalling during the timed run-down is caught by speed rising")
    func pedalDuringMeasurement() {
        var coach = SpindownCoach()
        feed(&coach, Array(repeating: 37, count: 6), from: 0)
        feed(&coach, coast(from: 37, seconds: 1.25), from: 1.5, state: .spindownReady)
        feed(&coach, [29.5], from: 3.0, state: .spindownActive)
        #expect(feed(&coach, [30.4], from: 3.25, state: .spindownActive) == [.sendStop])
        guard case .failed = coach.phase else { Issue.record("expected failure"); return }
    }

    @Test("A lost start command times out")
    func lostCommand() {
        var coach = SpindownCoach()
        #expect(feed(&coach, Array(repeating: 37, count: 6), from: 0) == [.sendStart])
        #expect(feed(&coach, Array(repeating: 37, count: 64), from: 1.5, state: .normal) == [.sendStop])
    }

    @Test("Sensor restarting its own spindown fails cleanly")
    func sensorRestart() {
        var coach = SpindownCoach()
        feed(&coach, Array(repeating: 37, count: 6), from: 0)
        feed(&coach, coast(from: 37, seconds: 1.25), from: 1.5, state: .spindownReady)
        feed(&coach, [29.5], from: 3.0, state: .spindownActive)
        #expect(feed(&coach, [28], from: 3.25, state: .spindownIdle) == [.sendStop])
    }

    @Test("Deceleration estimate")
    func deceleration() {
        let coastSamples = (0..<4).map { (t: Double($0) * 0.25, speed: 37 - 1.35 * Double($0)) }
        #expect(abs((SpindownCoach.deceleration(coastSamples) ?? 0) - 5.4) < 0.01)
        let steady = (0..<4).map { (t: Double($0) * 0.25, speed: 37.0) }
        #expect(SpindownCoach.deceleration(steady) == 0)
        #expect(SpindownCoach.deceleration([(t: 0, speed: 30)]) == nil)
    }
}
