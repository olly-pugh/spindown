import Foundation

/// The inRide power characteristic is lightly obfuscated: the top two bits of byte 0 pick
/// one of four permutation tables, bytes 1...19 are XORed with a key derived from two
/// other tables, then reordered.
///
/// This is a line-for-line port of `inride_process_power_data` in Kinetic's `inRide.c`.
/// Despite the comment in `inRide.h`, the System ID is *not* used here.
public enum InRideObfuscation {
    public static let packetLength = 20

    static let indices: [[UInt8]] = [
        [14, 15, 12, 16, 11, 5, 17, 3, 2, 1, 19, 13, 6, 4, 8, 9, 10, 18, 7],
        [12, 14, 8, 11, 16, 4, 7, 13, 18, 1, 3, 19, 6, 15, 9, 5, 10, 17, 2],
        [11, 5, 1, 9, 4, 18, 7, 15, 6, 2, 10, 12, 16, 3, 14, 13, 19, 17, 8],
        [13, 5, 18, 1, 3, 12, 15, 10, 14, 19, 16, 8, 6, 11, 2, 9, 4, 17, 7],
    ]

    /// Rotation selector carried in the top two bits of byte 0.
    public static func rotation(of packet: [UInt8]) -> Int {
        Int((packet[0] & 0xC0) >> 6)
    }

    static func xorKey(rotation: Int, index: Int) -> UInt8 {
        let a = (rotation + 1) % 4
        let b = (a + 1) % 4
        return indices[a][index - 1] &+ indices[b][index - 1]
    }

    /// Returns the plain packet, in the field order the decoder expects.
    public static func deobfuscate(_ packet: [UInt8]) -> [UInt8] {
        precondition(packet.count == packetLength)
        let rotation = rotation(of: packet)
        var unxored = packet
        for i in 1..<packetLength {
            unxored[i] = packet[i] ^ xorKey(rotation: rotation, index: i)
        }
        var plain = [UInt8](repeating: 0, count: packetLength)
        plain[0] = unxored[0]
        for i in 0..<(packetLength - 1) {
            plain[i + 1] = unxored[Int(indices[rotation][i])]
        }
        return plain
    }

    /// Exact inverse of `deobfuscate`. Used by the simulator and test fixtures.
    /// The rotation is taken from the top two bits of `plain[0]`.
    public static func obfuscate(_ plain: [UInt8]) -> [UInt8] {
        precondition(plain.count == packetLength)
        let rotation = rotation(of: plain)
        var unxored = [UInt8](repeating: 0, count: packetLength)
        unxored[0] = plain[0]
        for i in 0..<(packetLength - 1) {
            unxored[Int(indices[rotation][i])] = plain[i + 1]
        }
        var packet = unxored
        for i in 1..<packetLength {
            packet[i] = unxored[i] ^ xorKey(rotation: rotation, index: i)
        }
        return packet
    }
}
