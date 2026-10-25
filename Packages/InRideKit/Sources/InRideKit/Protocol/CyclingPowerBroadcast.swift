import Foundation

/// Bluetooth SIG Cycling Power Service, used to re-broadcast the trainer's data from the iPhone
/// so a Garmin watch or Edge can pair with it as an ordinary power meter. Recording on the
/// watch is what lets Garmin estimate cycling VO2 max; the watch cannot read the inRide itself.
public enum CyclingPowerGATT {
    public static let service = "1818"
    /// Notify: flags, instantaneous power, wheel and crank revolution data.
    public static let measurement = "2A63"
    /// Read: supported features.
    public static let feature = "2A65"
    /// Read: sensor location.
    public static let sensorLocation = "2A5D"

    /// Wheel revolution data (bit 2) and crank revolution data (bit 3) supported.
    public static let featureValue: [UInt8] = [0x0C, 0x00, 0x00, 0x00]
    /// 13 = rear hub.
    public static let sensorLocationValue: [UInt8] = [13]
}

/// Turns live power, cadence and speed into Cycling Power Measurement packets, synthesising the
/// cumulative crank and wheel revolution counters that watches use for cadence, speed and distance.
public struct CyclingPowerEmitter: Sendable {
    /// 700x25c, Garmin's usual default. Set the same circumference on the watch for matching speed.
    public var wheelCircumference: Double = 2.105

    private var crankRevs = 0.0
    private var wheelRevs = 0.0
    private var lastCrankEvent: Double = 0
    private var lastWheelEvent: Double = 0
    private var lastTime: Double?

    public init(wheelCircumference: Double = 2.105) {
        self.wheelCircumference = wheelCircumference
    }

    /// Builds the next measurement at time `t` (seconds, monotonic).
    public mutating func measurement(power: Int, cadenceRPM: Double, speedKPH: Double, at t: Double) -> [UInt8] {
        if let last = lastTime {
            let dt = min(max(t - last, 0), 5)
            advance(&crankRevs, &lastCrankEvent, ratePerSecond: max(0, cadenceRPM) / 60, dt: dt, now: t)
            advance(&wheelRevs, &lastWheelEvent, ratePerSecond: max(0, speedKPH) / 3.6 / wheelCircumference, dt: dt, now: t)
        }
        lastTime = t

        var w = ByteWriter()
        w.uint16(0x0030) // wheel + crank revolution data present
        w.uint16(UInt16(bitPattern: Int16(clamping: max(0, power))))
        w.uint32(UInt32(truncatingIfNeeded: Int64(wheelRevs.rounded(.down))))
        w.uint16(UInt16(truncatingIfNeeded: Int64((lastWheelEvent * 2048).rounded())))
        w.uint16(UInt16(truncatingIfNeeded: Int64(crankRevs.rounded(.down))))
        w.uint16(UInt16(truncatingIfNeeded: Int64((lastCrankEvent * 1024).rounded())))
        return w.bytes
    }

    /// Advances a revolution counter. The event time is when the last whole revolution completed,
    /// interpolated within the interval, which is what receivers divide by.
    private func advance(_ revs: inout Double, _ eventTime: inout Double, ratePerSecond: Double, dt: Double, now: Double) {
        guard ratePerSecond > 0, dt > 0 else { return }
        let before = revs
        revs += ratePerSecond * dt
        if revs.rounded(.down) > before.rounded(.down) {
            let overshoot = revs - revs.rounded(.down)
            eventTime = now - overshoot / ratePerSecond
        }
    }

    /// Parses a measurement this emitter produced (for tests and diagnostics).
    public static func parse(_ b: [UInt8]) -> (power: Int, wheelRevs: UInt32, wheelTime: UInt16, crankRevs: UInt16, crankTime: UInt16)? {
        guard b.count == 14 else { return nil }
        var r = ByteReader(b)
        _ = r.uint16()
        let power = Int(Int16(bitPattern: r.uint16()))
        return (power, r.uint32(), r.uint16(), r.uint16(), r.uint16())
    }
}
