import Foundation
import Testing
@testable import InRideKit

@Suite("inRide protocol")
struct ProtocolTests {
    @Test("Matches Kinetic's original C decoder on reference vectors")
    func matchesKineticReference() throws {
        #expect(kineticReferenceVectors.count >= 200)
        for line in kineticReferenceVectors {
            let c = line.split(separator: ",").map(String.init)
            let packet = [UInt8](try #require(Data(hex: c[0])))
            let m = try InRideDecoder.decodePower(packet)
            #expect(Int(m.raw.stateBits) == Int(c[1]), "\(c[0])")
            #expect(Int(m.raw.commandResultBits) == Int(c[2]), "\(c[0])")
            #expect(m.power == Int(c[3]), "power \(c[0])")
            #expect(close(m.speedKPH, c[4]), "speed \(c[0])")
            #expect(close(m.rollerRPM, c[5]), "roller \(c[0])")
            #expect(close(m.cadenceRPM, c[6]), "cadence \(c[0])")
            #expect((m.coasting ? "1" : "0") == c[7], "coasting \(c[0])")
            #expect(close(m.spindownTime, c[8]))
            #expect(close(m.lastSpindownResultTime, c[9]))
            #expect(close(m.rollerResistance, c[10]))
            #expect((m.proFlywheel ? "1" : "0") == c[11])
            #expect(Int(m.calibrationResult.rawValue) == Int(c[12]))
        }
    }

    private func close(_ a: Double, _ s: String) -> Bool {
        guard let b = Double(s) else { return false }
        return abs(a - b) <= max(1e-6, abs(b) * 1e-8)
    }

    @Test("Obfuscation round-trips for every rotation")
    func obfuscationRoundTrip() {
        var rng = SystemRandomNumberGenerator()
        for rotation in 0..<4 {
            for _ in 0..<200 {
                var plain = (0..<20).map { _ in UInt8.random(in: 0...255, using: &rng) }
                plain[0] = (plain[0] & 0x3F) | UInt8(rotation << 6)
                let packet = InRideObfuscation.obfuscate(plain)
                #expect(InRideObfuscation.rotation(of: packet) == rotation)
                #expect(InRideObfuscation.deobfuscate(packet) == plain)
            }
        }
    }

    @Test("Each permutation table is a permutation of bytes 1...19")
    func permutationTables() {
        for table in InRideObfuscation.indices {
            #expect(Set(table) == Set(1...19))
        }
    }

    @Test("Raw fields serialise back to the same plain bytes")
    func rawFieldRoundTrip() {
        let f = InRidePowerRawFields(rotation: 2, stateBits: 0x20, commandResultBits: 0x0A, interval: 0x123456,
                                     ticks: 0xDEADBEEF, revs: 17, ticksPrevious: 12345, revsPrevious: 16,
                                     cadenceRaw: 92, spindownTicks: 57344)
        #expect(InRidePowerRawFields(plain: f.plainBytes()) == f)
    }

    @Test("Speed and power from a simulated 30 km/h packet")
    func simulatedPacket() throws {
        var sim = InRideSimulator()
        _ = sim.nextPacket(speedKPH: 30, cadenceRPM: 90)
        let m = try InRideDecoder.decodePower(sim.nextPacket(speedKPH: 30, cadenceRPM: 90))
        #expect(abs(m.speedKPH - 30) < 0.05)
        #expect(abs(m.cadenceRPM - 90) < 1)
        #expect(m.state == .normal)
        #expect(!m.coasting)
        // Kinetic curve at 30 km/h with a 1.75 s spindown.
        #expect(m.power == InRideDecoder.powerForSpeed(kph: m.speedKPH, spindown: 1.75))
        #expect((150...260).contains(m.power))
    }

    @Test("Rejects packets of the wrong length")
    func wrongLength() {
        #expect(throws: InRideDecoder.DecodeError.wrongLength(19)) {
            try InRideDecoder.decodePower([UInt8](repeating: 0, count: 19))
        }
    }

    @Test("Zero ticks means stopped, not a crash")
    func stopped() throws {
        let f = InRidePowerRawFields(rotation: 0, stateBits: 0, commandResultBits: 0, interval: 0, ticks: 0, revs: 0,
                                     ticksPrevious: 0, revsPrevious: 0, cadenceRaw: 0, spindownTicks: 0)
        let m = try InRideDecoder.decodePower(InRideObfuscation.obfuscate(f.plainBytes()))
        #expect(m.speedKPH == 0 && m.power == 0 && m.cadenceRPM == 0)
    }

    @Test("Calibration result windows")
    func calibrationWindows() {
        #expect(InRideDecoder.calibrationResult(forSpindown: 1.4) == .tooFast)
        #expect(InRideDecoder.calibrationResult(forSpindown: 1.75) == .success)
        #expect(InRideDecoder.calibrationResult(forSpindown: 3.0) == .middle)
        #expect(InRideDecoder.calibrationResult(forSpindown: 5.0) == .success)
        #expect(InRideDecoder.calibrationResult(forSpindown: 7.0) == .tooSlow)
    }

    @Test("Configuration characteristic")
    func configuration() throws {
        let c = try InRideConfiguration(InRideSimulator.configurationBytes(updateRate: .hz2, spindown: 5.0))
        #expect(c.calibrationReady == 602 && c.calibrationStart == 655 && c.calibrationEnd == 950 && c.calibrationDebounce == 327)
        #expect(abs(c.currentSpindownTime - 5.0) < 0.001)
        #expect(c.proFlywheel)
        #expect(c.updateHz == 2)
        #expect(c.calibrationUpdateHz == 4)
    }

    @Test("Command key and command layouts match Kinetic's SDK")
    func commands() throws {
        let sys: [UInt8] = [0x10, 0x21, 0x32, 0x43, 0x54, 0x65]
        // 0x43 % 6 = 1 -> 0x21; 0x65 % 6 = 5 -> 0x65
        #expect(try InRideCommand.commandKey(systemID: sys) == [0x21, 0x65])
        #expect(try InRideCommand.startCalibration.bytes(systemID: sys) == [0x21, 0x65, 0x03])
        #expect(try InRideCommand.stopCalibration.bytes(systemID: sys) == [0x21, 0x65, 0x04])
        #expect(try InRideCommand.configure(updateRate: .hz1).bytes(systemID: sys)
            == [0x21, 0x65, 0x01, 0x5A, 0x02, 0x8F, 0x02, 0xB6, 0x03, 0x47, 0x01, 0x20, 0x00, 0x08, 0x00])
        #expect(try InRideCommand.setSpindownTime(seconds: 2).bytes(systemID: sys) == [0x21, 0x65, 0x05, 0x00, 0x00, 0x01, 0x00])
        #expect(try InRideCommand.setName("Bike").bytes(systemID: sys) == [0x21, 0x65, 0x02] + Array("Bike".utf8))
        #expect(throws: InRideCommand.BuildError.invalidName) { try InRideCommand.setName("ab").bytes(systemID: sys) }
        #expect(throws: InRideCommand.BuildError.invalidSystemID) { try InRideCommand.startCalibration.bytes(systemID: [1, 2]) }
    }

    @Test("Cadence smoothing weights the newest value and resets on gaps")
    func cadenceSmoothing() {
        var s = CadenceSmoother()
        #expect(s.add(90, at: 0) == 90) // no stale slots after a reset
        #expect(abs(s.add(96, at: 1) - (96 * 2 + 90) / 3) < 1e-9)
        #expect(abs(s.add(93, at: 2) - (93 * 2 + 96 + 90) / 4) < 1e-9)
        #expect(abs(s.add(90, at: 3) - (90 * 2 + 93 + 96) / 4) < 1e-9)
        #expect(s.add(80, at: 10) == 80) // > 2 s gap
        #expect(s.add(0, at: 11) == 0)
    }

    @Test("Hex parsing")
    func hex() {
        #expect(Data(hex: "0a 1B:ff")! == Data([0x0A, 0x1B, 0xFF]))
        #expect(Data(hex: "0x01,0x02")! == Data([1, 2]))
        #expect(Data(hex: "abc") == nil)
        #expect(Data(hex: "zz") == nil)
    }
}
