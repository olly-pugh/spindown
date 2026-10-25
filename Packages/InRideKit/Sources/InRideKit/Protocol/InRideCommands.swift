import Foundation

/// Control point commands (write with response to E9410102). Every command starts with a
/// 2-byte key derived from the 6-byte System ID; the result arrives in the low nibble of
/// byte 0 of a later power packet.
public enum InRideCommand: Sendable, Equatable {
    /// Sets update rates and the spindown thresholds. Kinetic always sends the same thresholds.
    case configure(updateRate: InRideUpdateRate)
    /// Configure with a custom spindown arming threshold (ticks per roller revolution; lower = faster).
    /// Only the arming speed changes; the timed window (655 to 950 ticks) that Kinetic's power model
    /// is calibrated against stays exactly as Kinetic set it.
    case configureCalibration(updateRate: InRideUpdateRate, readyTicks: UInt16)
    case setName(String)
    case startCalibration
    case stopCalibration
    case setSpindownTime(seconds: Double)

    public var opcode: UInt8 {
        switch self {
        case .configure, .configureCalibration: return 0x01
        case .setName: return 0x02
        case .startCalibration: return 0x03
        case .stopCalibration: return 0x04
        case .setSpindownTime: return 0x05
        }
    }

    public enum BuildError: Error, Equatable, CustomStringConvertible {
        case invalidSystemID
        case invalidName
        case invalidSpindown

        public var description: String {
            switch self {
            case .invalidSystemID: return "System ID must be 6 bytes"
            case .invalidName: return "Name must be 3 to 8 ASCII characters"
            case .invalidSpindown: return "Spindown time out of range"
            }
        }
    }

    /// Kinetic's spindown thresholds, in 32.768 kHz ticks per roller revolution
    /// (KineticInRideCalibrationInterval): arm above ~33.2 km/h, time from ~30.5 to ~21.1 km/h.
    public static let kineticReadyTicks: UInt16 = 602
    public static let kineticStartTicks: UInt16 = 655
    public static let kineticEndTicks: UInt16 = 950
    public static let kineticDebounceTicks: UInt16 = 327

    static func writeConfiguration(_ w: inout ByteWriter, rate: InRideUpdateRate, readyTicks: UInt16) {
        w.uint16(readyTicks)
        w.uint16(kineticStartTicks)
        w.uint16(kineticEndTicks)
        w.uint16(kineticDebounceTicks)
        w.uint16(rate.rawValue)
        w.uint16(InRideUpdateRate.hz4.rawValue) // update rate during calibration
    }

    /// Ticks per revolution for a roller speed, the inverse of `InRideDecoder.speed`.
    public static func ticks(forKPH kph: Double) -> UInt16 {
        UInt16(clamping: Int((InRideDecoder.speedConstant / kph).rounded()))
    }

    /// `systemId[systemId[3] % 6] | systemId[systemId[5] % 6] << 8`, from Kinetic's `command_key`.
    public static func commandKey(systemID: [UInt8]) throws -> [UInt8] {
        guard systemID.count == 6 else { throw BuildError.invalidSystemID }
        return [systemID[Int(systemID[3] % 6)], systemID[Int(systemID[5] % 6)]]
    }

    public func bytes(systemID: [UInt8]) throws -> [UInt8] {
        var w = ByteWriter()
        w.append(try Self.commandKey(systemID: systemID))
        w.uint8(opcode)
        switch self {
        case .configure(let rate):
            Self.writeConfiguration(&w, rate: rate, readyTicks: Self.kineticReadyTicks)
        case .configureCalibration(let rate, let ready):
            guard ready >= 400, ready + 15 <= Self.kineticStartTicks else { throw BuildError.invalidSpindown }
            Self.writeConfiguration(&w, rate: rate, readyTicks: ready)
        case .setName(let name):
            guard name.count >= 3, name.count <= 8, name.allSatisfy({ $0.isASCII }),
                  let data = name.data(using: .ascii) else { throw BuildError.invalidName }
            w.append([UInt8](data))
        case .startCalibration, .stopCalibration:
            break
        case .setSpindownTime(let seconds):
            guard seconds > 0, seconds < 60 else { throw BuildError.invalidSpindown }
            w.uint32(UInt32(seconds * InRideDecoder.sensorHz))
        }
        return w.bytes
    }
}

/// Normal-state notification rate. Kinetic: do not go faster than 8 Hz.
public enum InRideUpdateRate: UInt16, Sendable, CaseIterable, Codable {
    case hz1 = 0x20
    case hz2 = 0x10
    case hz4 = 0x08

    public var hz: Int { 32 / Int(rawValue) }
    public var label: String { "\(hz) Hz" }
}
