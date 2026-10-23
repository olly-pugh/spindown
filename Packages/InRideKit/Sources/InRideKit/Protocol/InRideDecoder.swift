import Foundation

public enum InRideSensorState: UInt8, Sendable, Codable, CustomStringConvertible {
    case normal = 0x00
    /// Calibration armed: rider must accelerate past ~34 km/h.
    case spindownIdle = 0x10
    /// Rider must stop pedalling and coast. Pedalling restarts the process.
    case spindownReady = 0x20
    /// Coasting; the sensor is timing the run-down from ~31 to ~18 km/h.
    case spindownActive = 0x30

    public var description: String {
        switch self {
        case .normal: return "Normal"
        case .spindownIdle: return "Spindown idle"
        case .spindownReady: return "Spindown ready"
        case .spindownActive: return "Spindown active"
        }
    }

    public var isCalibrating: Bool { self != .normal }
}

public enum InRideCalibrationResult: UInt8, Sendable, Codable, CustomStringConvertible {
    case unknown = 0x00
    case success = 0x01
    /// Spindown too short: roller pressure too high, loosen the roller.
    case tooFast = 0x02
    /// Spindown too long: roller pressure too low, tighten the roller.
    case tooSlow = 0x03
    /// Between the standard and Pro Flywheel windows. Loosen if a Pro Flywheel is fitted, otherwise tighten.
    case middle = 0x04

    public var description: String {
        switch self {
        case .unknown: return "Unknown"
        case .success: return "Success"
        case .tooFast: return "Too fast"
        case .tooSlow: return "Too slow"
        case .middle: return "Ambiguous"
        }
    }
}

public enum InRideCommandResult: UInt8, Sendable, Codable, CustomStringConvertible {
    case none = 0x00
    case success = 0x01
    case notSupported = 0x02
    case invalidRequest = 0x03
    case calibrationResult = 0x0A
    case unknownError = 0x0F
    /// Any value not documented by Kinetic. Kept so diagnostics can show it.
    case undocumented = 0xFF

    init(bits: UInt8) {
        self = InRideCommandResult(rawValue: bits) ?? .undocumented
    }

    public var description: String {
        switch self {
        case .none: return "None"
        case .success: return "Success"
        case .notSupported: return "Not supported"
        case .invalidRequest: return "Invalid request"
        case .calibrationResult: return "Calibration result"
        case .unknownError: return "Unknown error"
        case .undocumented: return "Undocumented"
        }
    }
}

/// The plain fields of a power packet after de-obfuscation, before any physics.
public struct InRidePowerRawFields: Sendable, Equatable, Codable {
    public var rotation: Int
    public var stateBits: UInt8
    public var commandResultBits: UInt8
    /// Sensor update interval, in 32.768 kHz ticks (24 bit).
    public var interval: UInt32
    /// Time taken for `revs` roller revolutions, in 32.768 kHz ticks.
    public var ticks: UInt32
    public var revs: UInt8
    public var ticksPrevious: UInt32
    public var revsPrevious: UInt8
    public var cadenceRaw: UInt16
    public var spindownTicks: UInt32

    public init(rotation: Int, stateBits: UInt8, commandResultBits: UInt8, interval: UInt32, ticks: UInt32, revs: UInt8,
                ticksPrevious: UInt32, revsPrevious: UInt8, cadenceRaw: UInt16, spindownTicks: UInt32) {
        self.rotation = rotation
        self.stateBits = stateBits
        self.commandResultBits = commandResultBits
        self.interval = interval
        self.ticks = ticks
        self.revs = revs
        self.ticksPrevious = ticksPrevious
        self.revsPrevious = revsPrevious
        self.cadenceRaw = cadenceRaw
        self.spindownTicks = spindownTicks
    }

    /// Parses an already de-obfuscated packet.
    public init(plain p: [UInt8]) {
        precondition(p.count == InRideObfuscation.packetLength)
        var r = ByteReader(p, offset: 1)
        rotation = Int((p[0] & 0xC0) >> 6)
        stateBits = p[0] & 0x30
        commandResultBits = p[0] & 0x0F
        interval = r.uint24()
        ticks = r.uint32()
        revs = r.uint8()
        ticksPrevious = r.uint32()
        revsPrevious = r.uint8()
        cadenceRaw = r.uint16()
        spindownTicks = r.uint32()
    }

    /// Serialises back into a plain packet. Inverse of `init(plain:)`.
    public func plainBytes() -> [UInt8] {
        var w = ByteWriter()
        w.uint8(UInt8(rotation & 0x3) << 6 | (stateBits & 0x30) | (commandResultBits & 0x0F))
        w.uint24(interval)
        w.uint32(ticks)
        w.uint8(revs)
        w.uint32(ticksPrevious)
        w.uint8(revsPrevious)
        w.uint16(cadenceRaw)
        w.uint32(spindownTicks)
        return w.bytes
    }
}

/// One decoded power notification. Mirrors `inride_power_data` with the intermediate values exposed.
public struct InRidePowerMeasurement: Sendable, Equatable, Codable {
    public var raw: InRidePowerRawFields
    public var state: InRideSensorState
    public var commandResult: InRideCommandResult
    public var power: Int
    /// Roller surface speed. Kinetic: "accurate, very accurate, for the roller".
    public var speedKPH: Double
    public var rollerRPM: Double
    /// Virtual cadence from Kinetic's linear fit, before any smoothing.
    public var cadenceRPM: Double
    public var coasting: Bool
    /// Deceleration figure used by Kinetic's coasting detector.
    public var alpha: Double
    /// Spindown time actually applied to the power curve, seconds.
    public var spindownTime: Double
    /// Most recent spindown time reported by the sensor, seconds. May be outside the valid windows.
    public var lastSpindownResultTime: Double
    /// Normalised roller tension, 0...1, derived from the applied spindown time.
    public var rollerResistance: Double
    public var proFlywheel: Bool
    public var calibrationResult: InRideCalibrationResult
}

/// A port of Kinetic's power, speed and cadence model (`inRide.c`, SDK 2.3.4).
public enum InRideDecoder {
    public static let sensorHz = 32768.0

    public static let spindownMin = 1.5
    public static let spindownMax = 2.0
    public static let spindownMinPro = 4.7
    public static let spindownMaxPro = 6.5
    public static let spindownDefault = (spindownMin + spindownMax) * 0.5

    /// km/h per (rev / tick). The iOS C SDK and GoldenCheetah use 20012.256849, a 54 mm nominal
    /// roller (pi x 54 mm x 32768 x 3600 / 1e6). Kinetic's Java SDK uses 19974.826517, the measured
    /// 169.3287 mm circumference quoted in `inRide.h`. We follow the C SDK, the one the iOS app shipped.
    public static let speedConstant = 20012.256849
    public static let speedConstantJavaSDK = 19974.826517

    /// Kinetic Fit showed this as the speed to reach before a spindown can start.
    public static let calibrationReadySpeedKPH = 33.8

    public enum DecodeError: Error, Equatable, CustomStringConvertible {
        case wrongLength(Int)
        public var description: String {
            switch self {
            case .wrongLength(let n): return "Expected 20 bytes, got \(n)"
            }
        }
    }

    public static func decodePower(_ packet: [UInt8], speedConstant: Double = speedConstant) throws -> InRidePowerMeasurement {
        guard packet.count == InRideObfuscation.packetLength else { throw DecodeError.wrongLength(packet.count) }
        let raw = InRidePowerRawFields(plain: InRideObfuscation.deobfuscate(packet))
        return measurement(from: raw, speedConstant: speedConstant)
    }

    public static func decodePower(_ data: Data, speedConstant: Double = speedConstant) throws -> InRidePowerMeasurement {
        try decodePower([UInt8](data), speedConstant: speedConstant)
    }

    public static func measurement(from raw: InRidePowerRawFields, speedConstant: Double = speedConstant) -> InRidePowerMeasurement {
        let lastSpindown = ticksToSeconds(raw.spindownTicks)
        let speed = speed(ticks: raw.ticks, revs: raw.revs, constant: speedConstant)
        let previousSpeed = Self.speed(ticks: raw.ticksPrevious, revs: raw.revsPrevious, constant: speedConstant)

        var rollerRPM = 0.0
        if raw.ticks > 0 {
            rollerRPM = Double(raw.revs) / ticksToSeconds(raw.ticks) * 60
        }

        let cadence = raw.cadenceRaw == 0 ? 0 : 0.8652 * Double(raw.cadenceRaw) + 5.2617

        var spindownTime = spindownDefault
        var proFlywheel = false
        if lastSpindown >= spindownMin && lastSpindown <= spindownMax {
            spindownTime = lastSpindown
        } else if lastSpindown >= spindownMinPro && lastSpindown <= spindownMaxPro {
            spindownTime = lastSpindown
            proFlywheel = true
        }

        let resistance = proFlywheel
            ? 1 - (spindownTime - spindownMinPro) / (spindownMaxPro - spindownMinPro)
            : 1 - (spindownTime - spindownMin) / (spindownMax - spindownMin)

        let (alpha, coasting) = coastDetection(raw: raw, speed: speed, previousSpeed: previousSpeed, proFlywheel: proFlywheel)
        let power = coasting ? 0 : powerForSpeed(kph: speed, spindown: spindownTime)

        return InRidePowerMeasurement(
            raw: raw,
            state: InRideSensorState(rawValue: raw.stateBits) ?? .normal,
            commandResult: InRideCommandResult(bits: raw.commandResultBits),
            power: power,
            speedKPH: speed,
            rollerRPM: rollerRPM,
            cadenceRPM: cadence,
            coasting: coasting,
            alpha: alpha,
            spindownTime: spindownTime,
            lastSpindownResultTime: lastSpindown,
            rollerResistance: resistance,
            proFlywheel: proFlywheel,
            calibrationResult: calibrationResult(forSpindown: lastSpindown)
        )
    }

    public static func ticksToSeconds(_ ticks: UInt32) -> Double {
        Double(ticks) / sensorHz
    }

    public static func speed(ticks: UInt32, revs: UInt8, constant: Double = speedConstant) -> Double {
        guard ticks > 0, revs > 0 else { return 0 }
        return constant * Double(revs) / Double(ticks)
    }

    public static func hasProFlywheel(spindown: Double) -> Bool {
        spindown >= spindownMinPro && spindown <= spindownMaxPro
    }

    /// Kinetic's `alpha()`: flags coasting when the roller is decelerating faster than pedalling allows.
    static func coastDetection(raw: InRidePowerRawFields, speed: Double, previousSpeed: Double, proFlywheel: Bool) -> (Double, Bool) {
        guard raw.ticks > 0, raw.ticksPrevious > 0 else { return (0, false) }
        // IEEE division, as in C: revs of 0 yields inf/NaN and the comparisons behave the same way.
        let tpr = Double(raw.ticks) / Double(raw.revs)
        let ptpr = Double(raw.ticksPrevious) / Double(raw.revsPrevious)
        let dtpr = tpr - ptpr
        guard dtpr > 0 else { return (0, false) }
        let alpha = (previousSpeed - speed) * dtpr
        let coasting = proFlywheel ? alpha > 20 : alpha > 200
        return (alpha, coasting)
    }

    /// Kinetic's Road Machine power curve with the spindown (tyre pressure / roller tension) correction.
    public static func powerForSpeed(kph: Double, spindown: Double) -> Int {
        let mph = kph * 0.621371
        let rawPower = 5.244820 * mph + 0.019168 * mph * mph * mph
        var dragOffset = 0.0
        if spindown > 0 && rawPower > 0 {
            let pro = hasProFlywheel(spindown: spindown)
            let spindownMS = spindown * 1000
            let dragOffsetSlope = pro ? -0.021 : -0.1425
            let dragOffsetPowerSlope = pro ? 2.62 : 4.55
            let yIntercept = pro ? 104.97 : 236.20
            dragOffset = dragOffsetPowerSlope * spindownMS * rawPower * 0.00001 + dragOffsetSlope * spindownMS + yIntercept
        }
        let power = rawPower + dragOffset
        guard power.isFinite, power > 0 else { return 0 }
        return Int(power) // truncation, as the C `(int)` cast
    }

    public static func calibrationResult(forSpindown time: Double) -> InRideCalibrationResult {
        if time >= spindownMin && time <= spindownMax { return .success }
        if time >= spindownMinPro && time <= spindownMaxPro { return .success }
        if time < spindownMin { return .tooFast }
        if time > spindownMaxPro { return .tooSlow }
        return .middle
    }
}

/// Configuration characteristic (E9410104). Plain little-endian, not obfuscated.
public struct InRideConfiguration: Sendable, Equatable, Codable {
    public var calibrationReady: UInt16
    public var calibrationStart: UInt16
    public var calibrationEnd: UInt16
    public var calibrationDebounce: UInt16
    public var currentSpindownTicks: UInt32
    /// Update interval in 1/32 s units: 0x20 = 1 Hz, 0x10 = 2 Hz, 0x08 = 4 Hz.
    public var updateRateDefault: UInt16
    public var updateRateCalibration: UInt16

    public var currentSpindownTime: Double { InRideDecoder.ticksToSeconds(currentSpindownTicks) }
    public var proFlywheel: Bool { InRideDecoder.hasProFlywheel(spindown: currentSpindownTime) }
    public var updateHz: Double { updateRateDefault == 0 ? 0 : 32.0 / Double(updateRateDefault) }
    public var calibrationUpdateHz: Double { updateRateCalibration == 0 ? 0 : 32.0 / Double(updateRateCalibration) }

    public init(_ data: [UInt8]) throws {
        guard data.count == 20 else { throw InRideDecoder.DecodeError.wrongLength(data.count) }
        var r = ByteReader(data)
        calibrationReady = r.uint16()
        calibrationStart = r.uint16()
        calibrationEnd = r.uint16()
        calibrationDebounce = r.uint16()
        currentSpindownTicks = r.uint32()
        updateRateDefault = r.uint16()
        updateRateCalibration = r.uint16()
    }
}
