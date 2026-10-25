import Foundation

/// Structured workouts for the game screen. Targets are fractions of FTP. They are guidance only:
/// the inRide has no resistance control, so the rider hits targets by gearing and effort.
public struct WorkoutStep: Sendable, Equatable {
    public enum Kind: String, Sendable { case warmup, steady, work, recover, cooldown }

    public var kind: Kind
    public var duration: TimeInterval
    public var low: Double
    public var high: Double
    public var label: String

    public init(_ kind: Kind, minutes: Double, _ low: Double, _ high: Double, _ label: String) {
        self.kind = kind
        self.duration = minutes * 60
        self.low = low
        self.high = high
        self.label = label
    }

    public func targetWatts(ftp: Int) -> ClosedRange<Int> {
        let lo = Int((Double(ftp) * low).rounded())
        let hi = Int((Double(ftp) * high).rounded())
        return lo...max(lo, hi)
    }
}

public struct Workout: Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let tagline: String
    public let steps: [WorkoutStep]

    public var duration: TimeInterval { steps.reduce(0) { $0 + $1.duration } }

    public struct Position: Sendable, Equatable {
        public var index: Int
        public var step: WorkoutStep
        public var elapsedInStep: TimeInterval
        public var remainingInStep: TimeInterval
        public var next: WorkoutStep?
        public var isComplete: Bool
        public var fractionOfWorkout: Double
    }

    /// Where the rider is after `elapsed` seconds of riding the workout.
    public func position(at elapsed: TimeInterval) -> Position {
        var t = max(0, elapsed)
        for (i, step) in steps.enumerated() {
            if t < step.duration {
                return Position(index: i, step: step, elapsedInStep: t, remainingInStep: step.duration - t,
                                next: i + 1 < steps.count ? steps[i + 1] : nil, isComplete: false,
                                fractionOfWorkout: min(1, elapsed / duration))
            }
            t -= step.duration
        }
        let last = steps[steps.count - 1]
        return Position(index: steps.count - 1, step: last, elapsedInStep: last.duration, remainingInStep: 0,
                        next: nil, isComplete: true, fractionOfWorkout: 1)
    }
}

public enum WorkoutLibrary {
    static func repeats(_ n: Int, _ block: [WorkoutStep]) -> [WorkoutStep] {
        (0..<n).flatMap { _ in block }
    }

    public static let all: [Workout] = [
        Workout(id: "windermere", name: "Windermere Warm-Up", tagline: "25 min · easy spin with three short openers",
                steps: [WorkoutStep(.warmup, minutes: 5, 0.50, 0.60, "Easy spin")]
                    + [WorkoutStep(.steady, minutes: 10, 0.60, 0.70, "Lakeside cruise")]
                    + repeats(3, [WorkoutStep(.work, minutes: 1, 0.95, 1.05, "Opener"),
                                  WorkoutStep(.recover, minutes: 2, 0.50, 0.60, "Recover")])
                    + [WorkoutStep(.cooldown, minutes: 1, 0.45, 0.55, "Cool down")]),
        Workout(id: "kirkstone", name: "Kirkstone Pass", tagline: "50 min · 3 × 8 min threshold climbs",
                steps: [WorkoutStep(.warmup, minutes: 10, 0.50, 0.65, "Warm up")]
                    + repeats(3, [WorkoutStep(.work, minutes: 8, 0.88, 0.94, "Climb the pass"),
                                  WorkoutStep(.recover, minutes: 4, 0.50, 0.60, "Descend")])
                    + [WorkoutStep(.cooldown, minutes: 4, 0.45, 0.55, "Cool down")]),
        Workout(id: "sprints", name: "Fell Sprints", tagline: "36 min · 8 × 30 s all-out sprints",
                steps: [WorkoutStep(.warmup, minutes: 10, 0.50, 0.65, "Warm up")]
                    + repeats(8, [WorkoutStep(.work, minutes: 0.5, 1.30, 1.70, "SPRINT!"),
                                  WorkoutStep(.recover, minutes: 1.5, 0.45, 0.55, "Spin easy")])
                    + [WorkoutStep(.steady, minutes: 5, 0.65, 0.75, "Steady")]
                    + [WorkoutStep(.cooldown, minutes: 5, 0.45, 0.55, "Cool down")]),
        Workout(id: "honister", name: "Honister Hammer", tagline: "45 min · 5 × 3 min VO2 max efforts",
                steps: [WorkoutStep(.warmup, minutes: 10, 0.50, 0.65, "Warm up")]
                    + repeats(5, [WorkoutStep(.work, minutes: 3, 1.10, 1.20, "Hammer it"),
                                  WorkoutStep(.recover, minutes: 3, 0.45, 0.55, "Recover")])
                    + [WorkoutStep(.cooldown, minutes: 5, 0.45, 0.55, "Cool down")]),
        Workout(id: "tempo", name: "Lakeside Tempo", tagline: "55 min · 2 × 15 min tempo",
                steps: [WorkoutStep(.warmup, minutes: 10, 0.50, 0.65, "Warm up")]
                    + repeats(2, [WorkoutStep(.work, minutes: 15, 0.76, 0.87, "Tempo"),
                                  WorkoutStep(.recover, minutes: 5, 0.50, 0.60, "Easy")])
                    + [WorkoutStep(.cooldown, minutes: 5, 0.45, 0.55, "Cool down")]),
    ]
}
