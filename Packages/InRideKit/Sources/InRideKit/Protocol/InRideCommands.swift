import Foundation

/// Control point commands (write with response to E9410102). Every command starts with a
/// 2-byte key derived from the 6-byte System ID; the result arrives in the low nibble of
/// byte 0 of a later power packet.
public enum InRideCommand: Sendable, Equatable {
    /// Sets update rates and the spindown thresholds. Kinetic always sends the same thresholds.
    case configure(updateRate: InRideUpdateRate)
    case setName(String)
    case startCalibration
    case stopCalibration
    case setSpindownTime(seconds: Double)

    public var opcode: UInt8 {
        switch self {
        case .configure: return 0x01
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
            // Values from KineticInRideCalibrationInterval / inride_create_config_sensor_command_data.
            w.uint16(602) // calibration ready
            w.uint16(655) // calibration start
            w.uint16(950) // calibration end
            w.uint16(327) // calibration debounce
            w.uint16(rate.rawValue)
            w.uint16(InRideUpdateRate.hz4.rawValue) // update rate during calibration
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
