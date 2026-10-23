import Foundation

/// FIT base types used by this app (FIT SDK, "Base Types").
public enum FITBaseType: UInt8, Sendable {
    case enumeration = 0x00
    case uint8 = 0x02
    case uint16 = 0x84
    case uint32 = 0x86
    case string = 0x07
    case uint32z = 0x8C

    var size: Int {
        switch self {
        case .enumeration, .uint8, .string: return 1
        case .uint16: return 2
        case .uint32, .uint32z: return 4
        }
    }

    var invalid: UInt64 {
        switch self {
        case .enumeration, .uint8: return 0xFF
        case .uint16: return 0xFFFF
        case .uint32: return 0xFFFF_FFFF
        case .uint32z: return 0
        case .string: return 0
        }
    }
}

public struct FITField: Sendable {
    public var number: UInt8
    public var type: FITBaseType
    /// nil writes the type's invalid value.
    public var value: UInt64?
    public var string: String?
    public var stringSize: Int

    public static func u8(_ n: UInt8, _ v: Int?) -> FITField { .init(number: n, type: .uint8, value: v.map { UInt64(clamping: min($0, 0xFE)) }) }
    public static func u16(_ n: UInt8, _ v: Int?) -> FITField { .init(number: n, type: .uint16, value: v.map { UInt64(clamping: min($0, 0xFFFE)) }) }
    public static func u32(_ n: UInt8, _ v: Int?) -> FITField { .init(number: n, type: .uint32, value: v.map { UInt64(clamping: min($0, 0xFFFF_FFFE)) }) }
    public static func u32z(_ n: UInt8, _ v: UInt32) -> FITField { .init(number: n, type: .uint32z, value: UInt64(v)) }
    public static func enumeration(_ n: UInt8, _ v: UInt8) -> FITField { .init(number: n, type: .enumeration, value: UInt64(v)) }
    public static func text(_ n: UInt8, _ s: String, size: Int = 20) -> FITField {
        .init(number: n, type: .string, value: nil, string: s, stringSize: size)
    }

    init(number: UInt8, type: FITBaseType, value: UInt64?, string: String? = nil, stringSize: Int = 0) {
        self.number = number
        self.type = type
        self.value = value
        self.string = string
        self.stringSize = stringSize
    }

    var size: Int { type == .string ? stringSize : type.size }
}

/// Minimal, spec-compliant FIT file writer: 14-byte header, definition and data records,
/// little-endian, CRC-16 trailer. Local message types are allocated automatically.
public struct FITWriter {
    public static let fitEpoch: TimeInterval = 631_065_600 // 1989-12-31T00:00:00Z

    private var body: [UInt8] = []
    private var definitions: [String: UInt8] = [:]
    private var nextLocal: UInt8 = 0

    public init() {}

    public static func timestamp(_ date: Date) -> UInt32 {
        UInt32(clamping: Int64((date.timeIntervalSince1970 - fitEpoch).rounded(.down)))
    }

    public mutating func write(global: UInt16, _ fields: [FITField]) {
        let signature = "\(global):" + fields.map { "\($0.number)/\($0.type.rawValue)/\($0.size)" }.joined(separator: ",")
        let local: UInt8
        if let existing = definitions[signature] {
            local = existing
        } else {
            local = nextLocal
            nextLocal = (nextLocal + 1) % 16
            definitions = definitions.filter { $0.value != local }
            definitions[signature] = local
            var w = ByteWriter()
            w.uint8(0x40 | local)
            w.uint8(0) // reserved
            w.uint8(0) // little-endian
            w.uint16(global)
            w.uint8(UInt8(fields.count))
            for f in fields {
                w.uint8(f.number)
                w.uint8(UInt8(f.size))
                w.uint8(f.type.rawValue)
            }
            body += w.bytes
        }

        var w = ByteWriter()
        w.uint8(local)
        for f in fields {
            if f.type == .string {
                var bytes = [UInt8]((f.string ?? "").utf8.prefix(f.stringSize - 1))
                bytes += [UInt8](repeating: 0, count: f.stringSize - bytes.count)
                w.append(bytes)
                continue
            }
            let v = f.value ?? f.type.invalid
            switch f.type.size {
            case 1: w.uint8(UInt8(truncatingIfNeeded: v))
            case 2: w.uint16(UInt16(truncatingIfNeeded: v))
            default: w.uint32(UInt32(truncatingIfNeeded: v))
            }
        }
        body += w.bytes
    }

    public func finish() -> Data {
        var header = ByteWriter()
        header.uint8(14)
        header.uint8(0x20) // protocol 2.0
        header.uint16(2160) // profile 21.60
        header.uint32(UInt32(body.count))
        header.append(Array(".FIT".utf8))
        header.uint16(Self.crc(header.bytes))
        var file = header.bytes + body
        let crc = Self.crc(file)
        file += [UInt8(crc & 0xFF), UInt8(crc >> 8)]
        return Data(file)
    }

    private static let crcTable: [UInt16] = [
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
        0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
    ]

    public static func crc(_ bytes: [UInt8], seed: UInt16 = 0) -> UInt16 {
        var crc = seed
        for byte in bytes {
            var tmp = crcTable[Int(crc & 0xF)]
            crc = (crc >> 4) & 0x0FFF
            crc = crc ^ tmp ^ crcTable[Int(byte & 0xF)]
            tmp = crcTable[Int(crc & 0xF)]
            crc = (crc >> 4) & 0x0FFF
            crc = crc ^ tmp ^ crcTable[Int((byte >> 4) & 0xF)]
        }
        return crc
    }
}
