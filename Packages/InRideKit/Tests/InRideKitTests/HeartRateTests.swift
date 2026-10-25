import Foundation
import Testing
@testable import InRideKit

@Suite("Heart rate and sensor broadcast")
struct HeartRateTests {
    @Test("Parses 8-bit heart rate with contact")
    func eightBit() throws {
        let m = try HeartRateMeasurement([0x06, 128])
        #expect(m.bpm == 128)
        #expect(m.sensorContact == true)
        #expect(m.energyExpended == nil)
        #expect(m.rrIntervals.isEmpty)
    }

    @Test("Parses 16-bit heart rate, energy and RR intervals (Polar H9 style)")
    func sixteenBitWithRR() throws {
        // flags: 16-bit HR, contact supported but not detected, energy, RR present
        let m = try HeartRateMeasurement([0x1D, 0x2C, 0x01, 0x10, 0x00, 0x00, 0x04, 0x00, 0x02])
        #expect(m.bpm == 300)
        #expect(m.sensorContact == false)
        #expect(m.energyExpended == 16)
        #expect(m.rrIntervals == [1.0, 0.5])
    }

    @Test("Contact unknown when not supported; rejects short packets")
    func edgeCases() throws {
        #expect(try HeartRateMeasurement([0x00, 70]).sensorContact == nil)
        #expect(throws: HeartRateMeasurement.ParseError.tooShort) { try HeartRateMeasurement([0x01, 70]) }
        #expect(throws: HeartRateMeasurement.ParseError.tooShort) { try HeartRateMeasurement([0x00]) }
        #expect(try HeartRateMeasurement(HeartRateMeasurement.encode(bpm: 141)).bpm == 141)
    }

    @Test("Heart rate is recorded, averaged and survives dropouts of the trainer")
    func recording() {
        var r = RideRecorder(startDate: Date())
        for t in 1...10 {
            let reading = t <= 5 ? TrainerReading(power: 200, speedKPH: 30, cadenceRPM: 90) : nil
            r.record(t: Double(t), reading: reading, heartRate: t <= 5 ? 120 : 140)
        }
        let s = r.summary(endT: 10)
        #expect(s.averageHeartRate == 130)
        #expect(s.maxHeartRate == 140)
        #expect(r.samples.last?.heartRate == 140)
        #expect(r.samples.last?.speed == nil)
    }

    @Test("Older ride files without heart rate still decode")
    func backwardCompatible() throws {
        let old = #"{"t":1,"dt":1,"p":200,"v":8.3,"c":90,"d":8.3}"#
        let s = try JSONDecoder().decode(RideSample.self, from: Data(old.utf8))
        #expect(s.heartRate == nil)
        let summary = try JSONDecoder().decode(RideSummary.self, from: JSONEncoder().encode(RideSummary()))
        #expect(summary.averageHeartRate == nil)
    }

    @Test("Heart rate appears in FIT, TCX and CSV")
    func exports() throws {
        var r = RideRecorder(startDate: Date(timeIntervalSince1970: 1_761_200_000))
        for t in 1...120 { r.record(t: Double(t), reading: TrainerReading(power: 200, speedKPH: 30, cadenceRPM: 90), heartRate: 100 + t % 20) }
        let start = Date(timeIntervalSince1970: 1_761_200_000)
        let record = RideRecord(id: UUID(), name: "HR", startDate: start, endDate: start.addingTimeInterval(120),
                                summary: r.summary(endT: 120), trainer: TrainerInfo(model: "inRide", heartRateMonitor: "Polar H9 ABCD"), recovered: false)
        let ride = ExportableRide(record: record, track: r.track)

        let messages = try FITTestReader.read(ActivityExporter.fit(ride))
        let records = messages.filter { $0.global == 20 }
        #expect(records.allSatisfy { ($0.fields[3] ?? 0) >= 100 && ($0.fields[3] ?? 0) < 120 })
        let session = try #require(messages.first { $0.global == 18 })
        #expect(session.fields[17] == 119) // max HR
        #expect(session.fields[16] == UInt64(record.summary.averageHeartRate!.rounded()))
        let hrm = messages.filter { $0.global == 23 }.first { $0.fields[0] == 2 }
        #expect(hrm?.fields[2] == 123) // polar_electro

        let tcx = String(decoding: ActivityExporter.tcx(ride), as: UTF8.self)
        #expect(tcx.contains("<HeartRateBpm><Value>"))
        #expect(tcx.contains("<MaximumHeartRateBpm><Value>119</Value>"))
        #expect(XMLParser(data: Data(tcx.utf8)).parse())

        let csv = String(decoding: ActivityExporter.csv(ride), as: UTF8.self)
        #expect(csv.hasPrefix("elapsed_s,timestamp_utc,power_w,speed_kph,cadence_rpm,distance_m,heart_rate_bpm\n"))
    }

    @Test("Cycling power broadcast synthesises crank and wheel counters")
    func powerBroadcast() throws {
        var e = CyclingPowerEmitter(wheelCircumference: 2.0)
        _ = e.measurement(power: 250, cadenceRPM: 90, speedKPH: 36, at: 0)
        var last: (power: Int, wheelRevs: UInt32, wheelTime: UInt16, crankRevs: UInt16, crankTime: UInt16)?
        for i in 1...60 {
            last = CyclingPowerEmitter.parse(e.measurement(power: 250, cadenceRPM: 90, speedKPH: 36, at: Double(i)))
        }
        let m = try #require(last)
        #expect(m.power == 250)
        #expect(m.crankRevs == 90) // 90 rpm for 60 s
        #expect(m.wheelRevs == 300) // 10 m/s / 2 m for 60 s
        // Event times are 16-bit counters that wrap (every 64 s for crank, 32 s for wheel);
        // receivers use the wrapped difference between consecutive packets.
        #expect(Int(m.crankTime) == (60 * 1024) % 65536)
        #expect(Int(m.wheelTime) == (60 * 2048) % 65536)
    }

    @Test("Stopped pedalling leaves counters and event times unchanged")
    func powerBroadcastStopped() throws {
        var e = CyclingPowerEmitter()
        _ = e.measurement(power: 200, cadenceRPM: 60, speedKPH: 30, at: 0)
        let a = try #require(CyclingPowerEmitter.parse(e.measurement(power: 200, cadenceRPM: 60, speedKPH: 30, at: 10)))
        let b = try #require(CyclingPowerEmitter.parse(e.measurement(power: 0, cadenceRPM: 0, speedKPH: 0, at: 11)))
        #expect(a.crankRevs == b.crankRevs && a.crankTime == b.crankTime)
        #expect(a.wheelRevs == b.wheelRevs)
        #expect(b.power == 0)
    }
}

@Suite("Account verification")
struct AccountTests {
    @Test("Garmin bridge communication events carry the page's message")
    func garminMessage() {
        let event: [String: Any] = ["eventType": "COMMUNICATION", "flowName": "AUTHENTICATION",
                                    "data": ["communication": ["type": "ERROR", "message": "Invalid sign in. (Passwords are case sensitive.)", "confirmationText": "OK"]]]
        let e = GarminConnectConfig.bridgeEvent(from: event)
        #expect(e?.message == "Invalid sign in. (Passwords are case sensitive.)")
        #expect(e?.messageType == "ERROR")
        #expect(e?.ticket == nil)
    }

    @Test("Strava verify returns the athlete's name")
    func stravaVerify() async throws {
        let store = MemoryStore()
        store.save(try JSONEncoder().encode(StravaTokens(accessToken: "a", refreshToken: "r", expiresAt: Date().addingTimeInterval(3600))), for: StravaClient.tokenKey)
        let transport = MockTransport([(200, #"{"id":1,"firstname":"Olly","lastname":"Pugh"}"#)])
        let client = StravaClient(config: StravaConfig(clientID: "1", clientSecret: "s"), transport: transport, store: store)
        #expect(try await client.verify() == "Olly Pugh")
        #expect(transport.sent[0].url?.absoluteString == "https://www.strava.com/api/v3/athlete")
        #expect(await client.tokens?.athleteName == "Olly Pugh")
    }

    @Test("Strava verify flags a revoked login")
    func stravaRevoked() async throws {
        let store = MemoryStore()
        store.save(try JSONEncoder().encode(StravaTokens(accessToken: "a", refreshToken: "r", expiresAt: Date().addingTimeInterval(3600))), for: StravaClient.tokenKey)
        let client = StravaClient(config: StravaConfig(clientID: "1", clientSecret: "s"), transport: MockTransport([(401, "{}")]), store: store)
        await #expect(throws: ServiceError.reauthenticationRequired("Strava refused the saved login (HTTP 401).")) { try await client.verify() }
    }
}
