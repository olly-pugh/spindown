import Foundation

/// The rolling cadence average from Kinetic's iOS SDK (`+[KineticInRide adjustCadence:timestamp:]`):
/// buffer of 3, newest value weighted x2, reset on zero cadence or a gap of more than 2 s.
///
/// One deliberate deviation: Kinetic's version always divides by the full buffer size, so after a
/// reset it averages in stale or zero slots and reads low for the first couple of packets. This
/// version averages only the slots filled since the last reset.
public struct CadenceSmoother: Sendable {
    public var bufferSize: Int
    public var newestWeight: Int
    public var resetGap: TimeInterval

    private var values: [(time: TimeInterval, rpm: Double)] = []

    public init(bufferSize: Int = 3, newestWeight: Int = 2, resetGap: TimeInterval = 2) {
        self.bufferSize = max(1, min(bufferSize, 10))
        self.newestWeight = max(1, newestWeight)
        self.resetGap = resetGap
    }

    public mutating func reset() { values.removeAll() }

    public mutating func add(_ rpm: Double, at time: TimeInterval) -> Double {
        guard rpm > 0 else {
            reset()
            return 0
        }
        if let newest = values.first, time - newest.time > resetGap {
            reset()
        }
        values.insert((time, rpm), at: 0)
        if values.count > bufferSize { values.removeLast(values.count - bufferSize) }

        var total = rpm * Double(newestWeight)
        for entry in values.dropFirst() { total += entry.rpm }
        return total / Double(newestWeight + values.count - 1)
    }
}
