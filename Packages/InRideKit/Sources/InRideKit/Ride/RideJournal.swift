import Foundation

/// Crash journal format. The app appends one JSON object per line while riding; if the app is
/// killed, the next launch replays the lines into a `RideRecorder` and saves the ride.
/// A torn final line (power loss mid-write) is ignored.
public enum RideJournalEntry: Codable, Sendable, Equatable {
    case header(id: UUID, startDate: Date, trainer: TrainerInfo?)
    case sample(RideSample)
    case pause(t: Double)
    case resume(t: Double)
    case trainer(TrainerInfo)

    private enum CodingKeys: String, CodingKey { case k, id, start, trainer, s, t }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .k) {
        case "h":
            self = .header(id: try c.decode(UUID.self, forKey: .id),
                           startDate: Date(timeIntervalSince1970: try c.decode(Double.self, forKey: .start)),
                           trainer: try c.decodeIfPresent(TrainerInfo.self, forKey: .trainer))
        case "s": self = .sample(try c.decode(RideSample.self, forKey: .s))
        case "p": self = .pause(t: try c.decode(Double.self, forKey: .t))
        case "r": self = .resume(t: try c.decode(Double.self, forKey: .t))
        case "i": self = .trainer(try c.decode(TrainerInfo.self, forKey: .trainer))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .k, in: c, debugDescription: "Unknown journal entry \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .header(let id, let start, let trainer):
            try c.encode("h", forKey: .k)
            try c.encode(id, forKey: .id)
            try c.encode(start.timeIntervalSince1970, forKey: .start)
            try c.encodeIfPresent(trainer, forKey: .trainer)
        case .sample(let s):
            try c.encode("s", forKey: .k)
            try c.encode(s, forKey: .s)
        case .pause(let t):
            try c.encode("p", forKey: .k)
            try c.encode(t, forKey: .t)
        case .resume(let t):
            try c.encode("r", forKey: .k)
            try c.encode(t, forKey: .t)
        case .trainer(let info):
            try c.encode("i", forKey: .k)
            try c.encode(info, forKey: .trainer)
        }
    }

    public func line() throws -> Data {
        var data = try JSONEncoder().encode(self)
        data.append(0x0A)
        return data
    }
}

public struct RecoveredRide: Sendable {
    public var id: UUID
    public var trainer: TrainerInfo?
    public var recorder: RideRecorder
    /// Wall-clock offset of the last thing we know happened.
    public var lastT: Double
    public var skippedLines: Int
}

public enum RideJournalReplay {
    public enum ReplayError: Error, Equatable { case missingHeader }

    public static func replay(_ data: Data) throws -> RecoveredRide {
        let decoder = JSONDecoder()
        var header: (UUID, Date, TrainerInfo?)?
        var recorder: RideRecorder?
        var trainer: TrainerInfo?
        var lastT = 0.0
        var skipped = 0

        for line in data.split(separator: 0x0A, omittingEmptySubsequences: true) {
            guard let entry = try? decoder.decode(RideJournalEntry.self, from: Data(line)) else {
                skipped += 1
                continue
            }
            switch entry {
            case .header(let id, let start, let info):
                guard header == nil else { continue }
                header = (id, start, info)
                trainer = info
                recorder = RideRecorder(startDate: start)
            case .sample(let s):
                recorder?.apply(s)
                lastT = max(lastT, s.t)
            case .pause(let t):
                recorder?.replayPause(t: t)
                lastT = max(lastT, t)
            case .resume(let t):
                recorder?.resume(t: t)
                lastT = max(lastT, t)
            case .trainer(let info):
                trainer = info
            }
        }
        guard let header, let recorder else { throw ReplayError.missingHeader }
        return RecoveredRide(id: header.0, trainer: trainer, recorder: recorder, lastT: lastT, skippedLines: skipped)
    }
}
