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
        let speeds = (0..<480).map { i in 33.2 + sin(Double(i) * 1.7) * 0.5 + Double.random(in: -0.3...0.3, using: &rng) }
        // Sensor reports normal until armed, then "ready" while the rider keeps pedalling at speed.
        var actions = feed(&coach, Array(speeds[0..<8]), from: 0)
        actions += feed(&coach, Array(speeds[8...]), from: 2, state: .spindownReady)
        #expect(actions == [.sendStart])
        guard case .stopPedalling = coach.phase else { Issue.record("expected stopPedalling, got \(coach.phase)"); return }
    }

    @Test("Arms only after holding the target speed (32.5 km/h by default)")
    func armsAfterHold() {
        var coach = SpindownCoach()
        #expect(feed(&coach, [29, 30.5, 31.5, 32.0, 32.4], from: 0).isEmpty)
        #expect(feed(&coach, [32.6, 32.8, 32.7, 32.9], from: 1.25) == [])
        #expect(feed(&coach, [32.8], from: 2.25) == [.sendStart])
    }

    @Test("The arming speed sits between the timing start and the target")
    func armingSpeed() throws {
        let coach = SpindownCoach()
        let ready = InRideCommand.ticks(forKPH: coach.armingSpeed)
        #expect(ready < InRideCommand.kineticStartTicks)
        #expect(InRideDecoder.speed(ticks: UInt32(InRideCommand.kineticStartTicks), revs: 1) < coach.guardSpeed)
        #expect(coach.armingSpeed < coach.targetSpeed)
        let sys: [UInt8] = [1, 2, 3, 4, 5, 6]
        let bytes = try InRideCommand.configureCalibration(updateRate: .hz4, readyTicks: ready).bytes(systemID: sys)
        #expect(bytes.count == 15)
        #expect(UInt16(bytes[3]) | UInt16(bytes[4]) << 8 == ready)
        #expect(Array(bytes[5...8]) == [0x8F, 0x02, 0xB6, 0x03]) // timing window unchanged: 655, 950
        #expect(throws: InRideCommand.BuildError.invalidSpindown) {
            try InRideCommand.configureCalibration(updateRate: .hz4, readyTicks: 650).bytes(systemID: sys)
        }
    }

    @Test("Slowing down while still pedalling cancels before the sensor can time it")
    func slowSagCancels() {
        var coach = SpindownCoach()
        feed(&coach, Array(repeating: 33, count: 6), from: 0)
        // Easing off at ~0.8 km/h per second while pedalling.
        let sag = stride(from: 32.8, through: 30.6, by: -0.2).map { $0 }
        let actions = feed(&coach, sag, from: 1.5, state: .spindownReady)
        #expect(actions == [.sendStop])
        #expect(coach.phase == .accelerate)
        #expect(coach.hint != nil)
    }

    @Test("A real coast passes the guard and completes")
    func success() {
        var coach = SpindownCoach()
        #expect(feed(&coach, Array(repeating: 33, count: 6), from: 0) == [.sendStart])
        let decay = coast(from: 33, seconds: 0.5)   // standard flywheel, ~5.4 km/h/s
        #expect(feed(&coach, decay, from: 1.5, state: .spindownReady).isEmpty)
        feed(&coach, [29.7, 28.3, 27.0, 25.6, 24.3, 22.9, 21.6], from: 2.0, state: .spindownActive)
        #expect(coach.phase == .measuring)
        feed(&coach, [20], from: 3.75, state: .normal)
        #expect(coach.phase == .finished)
    }

    @Test("A slow Pro Flywheel coast is accepted")
    func proFlywheel() {
        var coach = SpindownCoach()
        feed(&coach, Array(repeating: 33, count: 6), from: 0)
        // ~1.8 km/h per second all the way down.
        let decay = stride(from: 0.25, through: 12.0, by: 0.25).map { 33 - 1.8 * $0 }
        var states: [InRideSensorState] = decay.map { $0 > 30.5 ? .spindownReady : .spindownActive }
        states[states.count - 1] = .normal
        var actions: [SpindownCoach.Action] = []
        for (i, v) in decay.enumerated() {
            if let a = coach.ingest(speedKPH: v, sensorState: states[i], at: 1.5 + Double(i + 1) * 0.25) { actions.append(a) }
        }
        #expect(actions.isEmpty)
        #expect(coach.phase == .finished)
    }

    @Test("Pedalling during the timed run-down is caught by speed rising")
    func pedalDuringMeasurement() {
        var coach = SpindownCoach()
        feed(&coach, Array(repeating: 33, count: 6), from: 0)
        feed(&coach, coast(from: 33, seconds: 0.5), from: 1.5, state: .spindownReady)
        feed(&coach, [30.2], from: 2.0, state: .spindownActive)
        #expect(feed(&coach, [30.6], from: 2.25, state: .spindownActive) == [.sendStop])
        guard case .failed = coach.phase else { Issue.record("expected failure"); return }
    }

    @Test("A slow fade while the sensor is timing (still pedalling) is discarded")
    func slowFadeDuringMeasurement() {
        var coach = SpindownCoach()
        feed(&coach, Array(repeating: 33, count: 6), from: 0)
        feed(&coach, coast(from: 33, seconds: 0.5), from: 1.5, state: .spindownReady)
        // Timing starts, but speed only fades at ~0.6 km/h/s: the rider is still turning the pedals.
        let fade = [30.4, 30.25, 30.1, 29.95, 29.8, 29.65]
        #expect(feed(&coach, fade, from: 2.0, state: .spindownActive) == [.sendStop])
    }

    @Test("A lost start command times out")
    func lostCommand() {
        var coach = SpindownCoach()
        #expect(feed(&coach, Array(repeating: 33, count: 6), from: 0) == [.sendStart])
        #expect(feed(&coach, Array(repeating: 33, count: 64), from: 1.5, state: .normal) == [.sendStop])
    }

    @Test("Sensor restarting its own spindown fails cleanly")
    func sensorRestart() {
        var coach = SpindownCoach()
        feed(&coach, Array(repeating: 33, count: 6), from: 0)
        feed(&coach, coast(from: 33, seconds: 0.5), from: 1.5, state: .spindownReady)
        feed(&coach, [30], from: 2.0, state: .spindownActive)
        #expect(feed(&coach, [29], from: 2.25, state: .spindownIdle) == [.sendStop])
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
