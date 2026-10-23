import Foundation

/// Little-endian reader. Callers check lengths up front, so reads past the end are programmer errors.
struct ByteReader {
    private let bytes: [UInt8]
    private(set) var offset: Int

    init(_ bytes: [UInt8], offset: Int = 0) {
        self.bytes = bytes
        self.offset = offset
    }

    mutating func uint8() -> UInt8 {
        defer { offset += 1 }
        return bytes[offset]
    }

    mutating func uint16() -> UInt16 {
        UInt16(uint8()) | UInt16(uint8()) << 8
    }

    mutating func uint24() -> UInt32 {
        UInt32(uint8()) | UInt32(uint8()) << 8 | UInt32(uint8()) << 16
    }

    mutating func uint32() -> UInt32 {
        UInt32(uint16()) | UInt32(uint16()) << 16
    }
}

/// Little-endian writer.
public struct ByteWriter {
    public private(set) var bytes: [UInt8] = []

    public init() {}

    public mutating func uint8(_ v: UInt8) { bytes.append(v) }
    public mutating func uint16(_ v: UInt16) { bytes += [UInt8(v & 0xFF), UInt8(v >> 8)] }
    public mutating func uint24(_ v: UInt32) { bytes += [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF), UInt8((v >> 16) & 0xFF)] }
    public mutating func uint32(_ v: UInt32) { uint16(UInt16(v & 0xFFFF)); uint16(UInt16(v >> 16)) }
    public mutating func int8(_ v: Int8) { uint8(UInt8(bitPattern: v)) }
    public mutating func append(_ other: [UInt8]) { bytes += other }
}

public extension Sequence where Element == UInt8 {
    /// "0a 1b ff" style, for logs and diagnostics.
    func hexString(separator: String = " ") -> String {
        map { String(format: "%02x", $0) }.joined(separator: separator)
    }
}

public extension Data {
    var hexString: String { [UInt8](self).hexString() }

    /// Parses hex such as "0a1bff", "0a 1b ff" or "0x0a,0x1b". Returns nil on any invalid input.
    init?(hex: String) {
        let cleaned = hex.lowercased()
            .replacingOccurrences(of: "0x", with: "")
            .filter { !" ,:-\n\t".contains($0) }
        guard cleaned.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        var index = cleaned.startIndex
        while index < cleaned.endIndex {
            let next = cleaned.index(index, offsetBy: 2)
            guard let byte = UInt8(cleaned[index..<next], radix: 16) else { return nil }
            out.append(byte)
            index = next
        }
        self.init(out)
    }
}
