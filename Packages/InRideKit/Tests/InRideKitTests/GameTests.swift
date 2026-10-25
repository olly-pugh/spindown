import Foundation
import Testing
@testable import InRideKit

@Suite("Game route and workouts")
struct GameTests {
    @Test("Workout durations match their descriptions")
    func durations() {
        let minutes = Dictionary(uniqueKeysWithValues: WorkoutLibrary.all.map { ($0.id, $0.duration / 60) })
        #expect(minutes["windermere"] == 25)
        #expect(minutes["kirkstone"] == 50)
        #expect(minutes["sprints"] == 36)
        #expect(minutes["honister"] == 45)
        #expect(minutes["tempo"] == 55)
    }

    @Test("Workout position walks through steps and completes")
    func position() throws {
        let w = try #require(WorkoutLibrary.all.first { $0.id == "kirkstone" })
        #expect(w.position(at: 0).index == 0)
        #expect(w.position(at: 599).step.kind == .warmup)
        let firstClimb = w.position(at: 600)
        #expect(firstClimb.step.kind == .work && firstClimb.index == 1 && firstClimb.remainingInStep == 480)
        #expect(firstClimb.next?.kind == .recover)
        #expect(w.position(at: w.duration).isComplete)
        #expect(w.position(at: w.duration + 100).fractionOfWorkout == 1)
    }

    @Test("Target watts scale with FTP")
    func targets() {
        let step = WorkoutStep(.work, minutes: 1, 0.88, 0.94, "x")
        #expect(step.targetWatts(ftp: 250) == 220...235)
    }

    @Test("Route: laps, lakes, villages and landmarks")
    func route() {
        #expect(LakeRoute.lap(0) == 1)
        #expect(LakeRoute.lap(LakeRoute.lapLength + 1) == 2)
        #expect(LakeRoute.lapDistance(LakeRoute.lapLength + 500) == 500)
        #expect(LakeRoute.lakeAmount(at: 2_000) == 1)         // on Windermere
        #expect(LakeRoute.lakeAmount(at: 16_000) == 0)        // climbing to Dunmail Raise
        #expect(LakeRoute.lakeAmount(at: 22_000) == 1)        // Thirlmere
        #expect(LakeRoute.villageAmount(at: 8_000) == 1)      // Ambleside
        #expect(LakeRoute.villageAmount(at: 16_000) == 0)
        #expect(LakeRoute.elevation(at: 17_500) > 200)
        #expect(LakeRoute.elevation(at: 2_000) < 80)
        let (next, gap) = LakeRoute.nextLandmark(after: 7_000)
        #expect(next.name == "Ambleside" && abs(gap - 1_000) < 0.001)
        #expect(LakeRoute.landmarksPassed(from: 12_990, to: 13_010).map(\.name) == ["Grasmere"])
        #expect(LakeRoute.landmarksPassed(from: LakeRoute.lapLength - 5, to: LakeRoute.lapLength + 5).map(\.name) == ["Bowness-on-Windermere"])
        #expect(LakeRoute.landmarksPassed(from: 100, to: 200).isEmpty)
    }
}
