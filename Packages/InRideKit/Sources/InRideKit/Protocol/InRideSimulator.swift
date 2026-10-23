import Foundation

/// Produces genuine obfuscated inRide packets from a target speed and cadence, so the full
/// decode, record and export pipeline can be exercised without the trainer (tests, demo mode,
/// App Review).
public struct InRideSimulator: Sendable {
    public var updateRate: InRideUpdateRate = .hz1
    public var spindownSeconds: Double = 1.75
    public var state: InRideSensorState = .normal
    public var commandResult: InRideCommandResult = .none

    private var previousTicks: UInt32 = 0
    private var previousRevs: UInt8 = 0
    private var rotation = 0

    public init() {}

    /// Ticks for `revs` roller revolutions at `kph`, the inverse of `InRideDecoder.speed`.
    public static func ticks(forKPH kph: Double, revs: UInt8) -> UInt32 {
        guard kph > 0.5, revs > 0 else { return 0 }
        return UInt32((InRideDecoder.speedConstant * Double(revs) / kph).rounded())
    }

    /// Inverse of Kinetic's cadence fit.
    public static func cadenceRaw(forRPM rpm: Double) -> UInt16 {
        guard rpm > 5.2617 else { return 0 }
        return UInt16(((rpm - 5.2617) / 0.8652).rounded())
    }

    public mutating func nextPacket(speedKPH: Double, cadenceRPM: Double) -> [UInt8] {
        // At 1 Hz the roller turns ~55 times per second at 35 km/h; the sensor reports a short
        // window, so scale revs with speed and keep them in a byte.
        let revs = UInt8(clamping: max(1, Int(speedKPH / 2)))
        let ticks = Self.ticks(forKPH: speedKPH, revs: revs)
        let fields = InRidePowerRawFields(
            rotation: rotation,
            stateBits: state.rawValue,
            commandResultBits: commandResult == .undocumented ? 0 : commandResult.rawValue,
            interval: UInt32(updateRate.rawValue) * 1024,
            ticks: ticks,
            revs: ticks == 0 ? 0 : revs,
            ticksPrevious: previousTicks,
            revsPrevious: previousRevs,
            cadenceRaw: Self.cadenceRaw(forRPM: cadenceRPM),
            spindownTicks: UInt32(spindownSeconds * InRideDecoder.sensorHz)
        )
        previousTicks = fields.ticks
        previousRevs = fields.revs
        rotation = (rotation + 1) % 4
        commandResult = .none
        return InRideObfuscation.obfuscate(fields.plainBytes())
    }

    public static func configurationBytes(updateRate: InRideUpdateRate = .hz1, spindown: Double = 1.75) -> [UInt8] {
        var w = ByteWriter()
        w.uint16(602)
        w.uint16(655)
        w.uint16(950)
        w.uint16(327)
        w.uint32(UInt32(spindown * InRideDecoder.sensorHz))
        w.uint16(updateRate.rawValue)
        w.uint16(InRideUpdateRate.hz4.rawValue)
        w.append([0, 0, 0, 0])
        return w.bytes
    }
}
