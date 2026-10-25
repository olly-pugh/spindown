import Foundation
import InRideKit

/// Per-frame state of the Lake District ride. Deliberately not @Observable: it is advanced by the
/// 60 fps render loop, and the HUD samples it on its own slower timeline, so nothing else in the
/// app is invalidated every frame. It only reads trainer data; it never changes the recording.
@MainActor
final class GameEngine {
    /// World metres travelled in the game (follows the trainer's speed).
    private(set) var odometer: Double = 0
    /// Speed actually shown, smoothed towards the trainer's (m/s).
    private(set) var speed: Double = 0
    private(set) var wheelAngle: Double = 0
    private(set) var crankAngle: Double = 0
    private(set) var time: Double = 0
    /// Seconds of the chosen workout completed (only advances while the ride is recording).
    private(set) var workoutElapsed: TimeInterval = 0
    private(set) var banner: (text: String, at: Double)?
    private(set) var sheepCount = 0

    struct Particle {
        var x: Double
        var y: Double
        var vx: Double
        var vy: Double
        var life: Double
        var hue: Double
    }
    private(set) var particles: [Particle] = []
    private(set) var confettiUntil: Double = 0

    var workout: Workout? {
        didSet { workoutElapsed = 0 }
    }

    private var lastDate: Date?
    private var lastSheepIndex: Int?

    static let wheelRadius = 0.34 // metres, 700c

    /// Advances the world to `now`. `targetSpeed` in m/s (0 when no fresh data), `cadence` in rpm.
    func step(now: Date, targetSpeed: Double, cadence: Double, recording: Bool) {
        let dt = lastDate.map { min(max(now.timeIntervalSince($0), 0), 0.1) } ?? 0
        lastDate = now
        time += dt

        // Ease towards the trainer's speed so 1-4 Hz updates look continuous.
        speed += (targetSpeed - speed) * min(1, dt * 2.5)
        if targetSpeed == 0 && speed < 0.05 { speed = 0 }

        let before = odometer
        odometer += speed * dt
        wheelAngle += speed / Self.wheelRadius * dt
        crankAngle += cadence / 60 * 2 * .pi * dt

        if recording, workout != nil { workoutElapsed += dt }

        for landmark in LakeRoute.landmarksPassed(from: before, to: odometer) {
            let lap = LakeRoute.lap(odometer)
            let text = landmark.kind == .start && odometer > 10 ? "Lap \(lap)! Back at Windermere" : landmark.message
            celebrate(text)
        }

        // A sheep every ~37 m of verge; count the ones ridden past.
        let sheepIndex = Int(odometer / 37)
        if let last = lastSheepIndex, sheepIndex > last {
            for i in (last + 1)...sheepIndex where GameMath.hash(i * 7 + 3) > 0.72 { sheepCount += 1 }
        }
        lastSheepIndex = sheepIndex

        updateParticles(dt: dt)
    }

    func celebrate(_ text: String) {
        banner = (text, time)
        confettiUntil = time + 1.5
    }

    func clearBannerIfStale() {
        if let banner, time - banner.at > 4 { self.banner = nil }
    }

    func resetWorkout() { workoutElapsed = 0 }

    private func updateParticles(dt: Double) {
        for i in particles.indices {
            particles[i].x += particles[i].vx * dt
            particles[i].y += particles[i].vy * dt
            particles[i].vy += 120 * dt
            particles[i].life -= dt
        }
        particles.removeAll { $0.life <= 0 }
        // Road spray behind the rear wheel, more when fast.
        if speed > 1, particles.count < 60, GameMath.hash(Int(time * 1000)) < min(0.9, speed / 12) {
            particles.append(Particle(x: 0, y: 0, vx: -40 - speed * 6, vy: -30 - 40 * GameMath.hash(Int(time * 997)),
                                      life: 0.6, hue: 0))
        }
        if time < confettiUntil, particles.count < 90 {
            for k in 0..<1 {
                let seed = Int(time * 1000) + k * 31
                particles.append(Particle(x: GameMath.hash(seed) * 400 - 200, y: -260,
                                          vx: GameMath.hash(seed + 1) * 80 - 40, vy: 60 + GameMath.hash(seed + 2) * 80,
                                          life: 2.2, hue: GameMath.hash(seed + 3)))
            }
        }
    }
}

enum GameMath {
    /// Deterministic 0..<1 hash, so scenery is the same every time you pass a spot.
    static func hash(_ n: Int) -> Double {
        var x = UInt64(bitPattern: Int64(n)) &+ 0x9E37_79B9_7F4A_7C15
        x = (x ^ (x >> 30)) &* 0xBF58_476D_1CE4_E5B9
        x = (x ^ (x >> 27)) &* 0x94D0_49BB_1331_11EB
        x ^= x >> 31
        return Double(x % 1_000_000) / 1_000_000
    }

    /// Smooth ridge profile for fells: sum of sines, peaked.
    static func ridge(_ u: Double, seed: Double) -> Double {
        let a = 0.55 * sin(u * 0.0071 + seed)
        let b = 0.30 * sin(u * 0.0173 + seed * 2.3)
        let c = 0.15 * sin(u * 0.0419 + seed * 4.1)
        let v = (a + b + c + 1) / 2 // 0...1
        return pow(max(0, v), 1.6)
    }
}
