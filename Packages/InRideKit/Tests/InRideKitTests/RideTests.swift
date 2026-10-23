import Foundation
import Testing
@testable import InRideKit

@Suite("Ride recording")
struct RideTests {
    let start = Date(timeIntervalSince1970: 1_761_200_000)

    func steady(_ kph: Double, power: Int = 200, cadence: Double = 90) -> TrainerReading {
        TrainerReading(power: power, speedKPH: kph, cadenceRPM: cadence)
    }

    @Test("Distance integrates speed over time")
    func distance() {
        var r = RideRecorder(startDate: start)
        for t in 1...3600 { r.record(t: Double(t), reading: steady(36)) }
        #expect(abs(r.stats.distance - 36_000) < 0.001)
        #expect(r.stats.movingTime == 3600)
        #expect(r.stats.averagePower == 200)
        #expect(abs(r.stats.averageSpeed - 10) < 1e-9)
        #expect(r.stats.work == 720_000)
    }

    @Test("Pauses are excluded from timer and moving time but not elapsed")
    func pauses() {
        var r = RideRecorder(startDate: start)
        for t in 1...100 { r.record(t: Double(t), reading: steady(30)) }
        r.pause(t: 100.5, reading: steady(30))
        for t in 101...160 { #expect(r.record(t: Double(t), reading: steady(30)) == nil) }
        r.resume(t: 160)
        for t in 161...200 { r.record(t: Double(t), reading: steady(30)) }
        let s = r.summary(endT: 200)
        #expect(s.elapsedTime == 200)
        #expect(s.timerTime == 140.5)
        #expect(s.movingTime == 140.5)
        #expect(r.timerEvents.map(\.kind) == [.start, .stop, .start])
    }

    @Test("Dropouts record no data and do not count as moving")
    func dropouts() {
        var r = RideRecorder(startDate: start)
        for t in 1...10 { r.record(t: Double(t), reading: t > 5 && t <= 8 ? nil : steady(30)) }
        #expect(r.stats.movingTime == 7)
        #expect(r.stats.timerTime == 10)
        #expect(r.samples.filter { !$0.hasData }.count == 3)
    }

    @Test("Long gaps are capped so a suspended app does not invent distance")
    func gapCap() {
        var r = RideRecorder(startDate: start)
        r.record(t: 1, reading: steady(36))
        r.record(t: 600, reading: steady(36))
        #expect(r.stats.timerTime == 1 + RideRecorder.maxSampleGap)
    }

    @Test("Coasting zeros count towards average power while moving")
    func coastingAverage() {
        var r = RideRecorder(startDate: start)
        for t in 1...10 { r.record(t: Double(t), reading: steady(30, power: t <= 5 ? 300 : 0)) }
        #expect(r.stats.averagePower == 150)
        #expect(r.stats.maxPower == 300)
    }

    @Test("Normalised power of a steady ride equals its power")
    func normalizedPower() {
        var r = RideRecorder(startDate: start)
        for t in 1...600 { r.record(t: Double(t), reading: steady(30, power: 250)) }
        #expect(abs(r.summary(endT: 600).normalizedPower! - 250) < 1e-6)
        var short = RideRecorder(startDate: start)
        short.record(t: 1, reading: steady(30))
        #expect(short.summary(endT: 1).normalizedPower == nil)
    }

    @Test("Journal replay reproduces the live ride and ignores a torn last line")
    func journalReplay() throws {
        let id = UUID()
        var live = RideRecorder(startDate: start)
        var journal = try RideJournalEntry.header(id: id, startDate: start, trainer: TrainerInfo(model: "inRide")).line()
        for t in 1...300 {
            if t == 120 {
                if let closing = live.pause(t: 120, reading: steady(25)) { journal += try RideJournalEntry.sample(closing).line() }
                journal += try RideJournalEntry.pause(t: 120).line()
            }
            if t == 150 { live.resume(t: 150); journal += try RideJournalEntry.resume(t: 150).line() }
            if let s = live.record(t: Double(t), reading: steady(25 + Double(t % 7), power: 150 + t % 50)) {
                journal += try RideJournalEntry.sample(s).line()
            }
        }
        journal += Data(#"{"k":"s","s":{"t":301,"dt"#.utf8) // power cut mid-write

        let recovered = try RideJournalReplay.replay(journal)
        #expect(recovered.id == id)
        #expect(recovered.skippedLines == 1)
        #expect(recovered.trainer?.model == "inRide")
        #expect(recovered.recorder.samples == live.samples)
        #expect(recovered.recorder.stats == live.stats)
        #expect(recovered.recorder.timerEvents == live.timerEvents)
        #expect(recovered.lastT == 300)
    }

    @Test("Journal without header cannot be replayed")
    func journalWithoutHeader() throws {
        let data = try RideJournalEntry.pause(t: 3).line()
        #expect(throws: RideJournalReplay.ReplayError.missingHeader) { try RideJournalReplay.replay(data) }
    }

    @Test("Ride records encode upload state readably")
    func recordCoding() throws {
        var record = RideRecord(id: UUID(), name: "x", startDate: start, endDate: start, summary: RideSummary(), trainer: nil, recovered: false)
        record.uploads[.garmin] = .uploaded(activityID: "42")
        record.uploads[.strava] = .failed(message: "nope", retryable: true)
        let data = try JSONEncoder().encode(record)
        #expect(String(decoding: data, as: UTF8.self).contains("\"garmin\""))
        #expect(try JSONDecoder().decode(RideRecord.self, from: data) == record)
    }
}
