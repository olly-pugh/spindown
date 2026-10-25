import Foundation

/// Bluetooth SIG Heart Rate Service, as used by the Polar H9/H10 and most chest straps.
public enum HeartRateGATT {
    public static let service = "180D"
    /// Notify. Flags byte, then heart rate (u8 or u16), optional energy, optional RR intervals.
    public static let measurement = "2A37"
    public static let bodySensorLocation = "2A38"
}

public struct HeartRateMeasurement: Sendable, Equatable {
    public var bpm: Int
    /// nil if the strap does not report skin contact.
    public var sensorContact: Bool?
    /// Kilojoules since the strap's last reset, if reported.
    public var energyExpended: Int?
    /// Beat-to-beat intervals in seconds (1/1024 s resolution on the wire).
    public var rrIntervals: [Double]

    public init(bpm: Int, sensorContact: Bool?, energyExpended: Int?, rrIntervals: [Double]) {
        self.bpm = bpm
        self.sensorContact = sensorContact
        self.energyExpended = energyExpended
        self.rrIntervals = rrIntervals
    }

    public enum ParseError: Error, Equatable { case tooShort }

    /// Parses a Heart Rate Measurement (0x2A37) notification.
    public init(_ data: [UInt8]) throws {
        guard data.count >= 2 else { throw ParseError.tooShort }
        let flags = data[0]
        var r = ByteReader(data, offset: 1)
        let wide = flags & 0x01 != 0
        guard data.count >= (wide ? 3 : 2) else { throw ParseError.tooShort }
        bpm = wide ? Int(r.uint16()) : Int(r.uint8())
        sensorContact = flags & 0x04 != 0 ? flags & 0x02 != 0 : nil
        energyExpended = nil
        if flags & 0x08 != 0, r.offset + 2 <= data.count { energyExpended = Int(r.uint16()) }
        var rr: [Double] = []
        if flags & 0x10 != 0 {
            while r.offset + 2 <= data.count { rr.append(Double(r.uint16()) / 1024) }
        }
        rrIntervals = rr
    }
}
