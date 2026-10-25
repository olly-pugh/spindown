import Foundation
import Testing
@testable import InRideKit

@Suite("Export")
struct ExportTests {
    static func sampleRide(seconds: Int = 600) -> ExportableRide {
        let start = Date(timeIntervalSince1970: 1_761_200_000)
        var r = RideRecorder(startDate: start)
        for t in 1...seconds {
            if t == seconds / 2 { r.pause(t: Double(t), reading: TrainerReading(power: 200, speedKPH: 30, cadenceRPM: 88)) }
            if t == seconds / 2 + 30 { r.resume(t: Double(t)) }
            r.record(t: Double(t), reading: TrainerReading(power: 180 + t % 40, speedKPH: 30, cadenceRPM: 88))
        }
        let end = start.addingTimeInterval(Double(seconds))
        let record = RideRecord(id: UUID(), name: "Test", startDate: start, endDate: end,
                                summary: r.summary(endT: Double(seconds)), trainer: TrainerInfo(model: "inRide"), recovered: false)
        return ExportableRide(record: record, track: r.track)
    }

    @Test("FIT CRC matches the FIT SDK reference value")
    func crc() {
        // CRC-16 (FIT/ARC) of ASCII "123456789" is 0xBB3D.
        #expect(FITWriter.crc(Array("123456789".utf8)) == 0xBB3D)
    }

    @Test("FIT file is structurally valid")
    func fitStructure() throws {
        let data = [UInt8](ActivityExporter.fit(Self.sampleRide()))
        #expect(data[0] == 14)
        #expect(Array(data[8..<12]) == Array(".FIT".utf8))
        let dataSize = Int(data[4]) | Int(data[5]) << 8 | Int(data[6]) << 16 | Int(data[7]) << 24
        #expect(data.count == 14 + dataSize + 2)
        let headerCRC = UInt16(data[12]) | UInt16(data[13]) << 8
        #expect(headerCRC == FITWriter.crc(Array(data[0..<12])))
        // CRC over the whole file including its trailer is zero.
        #expect(FITWriter.crc(data) == 0)
    }

    @Test("FIT records have strictly increasing timestamps")
    func fitTimestamps() throws {
        let messages = try FITTestReader.read(ActivityExporter.fit(Self.sampleRide()))
        let records = messages.filter { $0.global == 20 }
        #expect(records.count == 571)
        let ts = records.compactMap { $0.fields[253] }
        #expect(zip(ts, ts.dropFirst()).allSatisfy { $0 < $1 })
        let session = try #require(messages.first { $0.global == 18 })
        #expect(session.fields[5] == 2) // cycling
        #expect(session.fields[6] == 6) // indoor_cycling
        #expect(session.fields[8] == 570_000) // timer time, ms
        #expect(messages.filter { $0.global == 21 }.count == 4) // start, stop, start, stop
    }

    @Test("TCX is well-formed XML with one trackpoint per second")
    func tcx() throws {
        let parser = XMLParser(data: ActivityExporter.tcx(Self.sampleRide()))
        let counter = ElementCounter()
        parser.delegate = counter
        #expect(parser.parse(), "\(String(describing: parser.parserError))")
        #expect(counter.counts["Trackpoint"] == 571)
        #expect(counter.counts["ns3:Watts"] == 571)
    }

    final class ElementCounter: NSObject, XMLParserDelegate {
        var counts: [String: Int] = [:]
        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String] = [:]) {
            counts[name, default: 0] += 1
        }
    }

    @Test("CSV has a header and a row per sample")
    func csv() {
        let text = String(decoding: ActivityExporter.csv(Self.sampleRide()), as: UTF8.self)
        let lines = text.split(separator: "\n")
        #expect(lines.first == "elapsed_s,timestamp_utc,power_w,speed_kph,cadence_rpm,distance_m,heart_rate_bpm")
        #expect(lines.count == 572)
    }
}

/// Just enough of a FIT reader to verify our own output in tests.
enum FITTestReader {
    struct Message { var global: UInt16; var fields: [UInt8: UInt64] }

    static func read(_ data: Data) throws -> [Message] {
        let b = [UInt8](data)
        var i = Int(b[0])
        let end = b.count - 2
        var defs: [UInt8: (UInt16, [(UInt8, Int)])] = [:]
        var out: [Message] = []
        while i < end {
            let h = b[i]; i += 1
            let local = h & 0x0F
            if h & 0x40 != 0 {
                let global = UInt16(b[i + 2]) | UInt16(b[i + 3]) << 8
                let n = Int(b[i + 4]); i += 5
                var fields: [(UInt8, Int)] = []
                for _ in 0..<n { fields.append((b[i], Int(b[i + 1]))); i += 3 }
                defs[local] = (global, fields)
            } else {
                guard let def = defs[local] else { throw CocoaError(.fileReadCorruptFile) }
                var values: [UInt8: UInt64] = [:]
                for (num, size) in def.1 {
                    var v: UInt64 = 0
                    if size <= 8 { for k in 0..<size { v |= UInt64(b[i + k]) << (8 * k) } }
                    values[num] = v
                    i += size
                }
                out.append(Message(global: def.0, fields: values))
            }
        }
        return out
    }
}
