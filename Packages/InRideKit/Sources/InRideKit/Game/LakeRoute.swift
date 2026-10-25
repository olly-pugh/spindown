import Foundation

/// The virtual Lake District loop ridden in the game screen. Purely visual: it never affects
/// the trainer, the recording or uploads.
public enum LakeRoute {
    public enum LandmarkKind: Sendable { case start, village, lake, pass, sight }

    public struct Landmark: Sendable, Equatable {
        public let name: String
        /// Metres from the start of a lap.
        public let distance: Double
        public let kind: LandmarkKind
        public let message: String
    }

    /// Bowness-on-Windermere to Keswick, roughly along the A591, then back round.
    public static let lapLength = 32_000.0

    public static let landmarks: [Landmark] = [
        Landmark(name: "Bowness-on-Windermere", distance: 0, kind: .start, message: "Rolling out from Windermere!"),
        Landmark(name: "Ambleside", distance: 8_000, kind: .village, message: "Welcome to Ambleside"),
        Landmark(name: "Rydal Water", distance: 10_500, kind: .lake, message: "Rydal Water — Wordsworth's favourite"),
        Landmark(name: "Grasmere", distance: 13_000, kind: .village, message: "Grasmere — gingerbread time?"),
        Landmark(name: "Dunmail Raise", distance: 17_500, kind: .pass, message: "King of Dunmail Raise! 238 m"),
        Landmark(name: "Thirlmere", distance: 21_000, kind: .lake, message: "Thirlmere — Helvellyn on your right"),
        Landmark(name: "Castlerigg Stone Circle", distance: 28_000, kind: .sight, message: "Castlerigg Stone Circle"),
        Landmark(name: "Keswick", distance: 31_000, kind: .village, message: "Keswick and Derwentwater — lap complete soon!"),
    ]

    /// Lakes along the route: (start, end) metres within a lap.
    static let lakes: [(Double, Double)] = [
        (0, 6_000),          // Windermere
        (10_000, 11_200),    // Rydal Water
        (12_200, 13_600),    // Grasmere
        (19_500, 24_000),    // Thirlmere
        (30_300, 32_000),    // Derwentwater
    ]

    /// Metres within the current lap.
    public static func lapDistance(_ odometer: Double) -> Double {
        let d = odometer.truncatingRemainder(dividingBy: lapLength)
        return d < 0 ? d + lapLength : d
    }

    /// 1-based lap number.
    public static func lap(_ odometer: Double) -> Int {
        Int((max(0, odometer) / lapLength).rounded(.down)) + 1
    }

    /// How much lake is beside the road here, 0...1, with 400 m fades at each shore.
    public static func lakeAmount(at odometer: Double) -> Double {
        let d = lapDistance(odometer)
        var best = 0.0
        for (start, end) in lakes {
            let fade = 400.0
            let rise = (d - start) / fade
            let fall = (end - d) / fade
            best = max(best, min(1, max(0, min(rise + (start == 0 ? 1 : 0), fall))))
        }
        // Windermere wraps round from the end of the previous lap (Derwentwater shore).
        return best
    }

    /// How close a village is, 0...1 (cottages appear within 600 m of one).
    public static func villageAmount(at odometer: Double) -> Double {
        let d = lapDistance(odometer)
        var best = 0.0
        for l in landmarks where l.kind == .village || l.kind == .start {
            let gap = min(abs(d - l.distance), abs(d - l.distance - lapLength), abs(d - l.distance + lapLength))
            best = max(best, max(0, 1 - gap / 600))
        }
        return best
    }

    /// Approximate road height in metres: lakeside ~50 m rising to Dunmail Raise (238 m).
    public static func elevation(at odometer: Double) -> Double {
        let d = lapDistance(odometer)
        let profile: [(Double, Double)] = [
            (0, 45), (8_000, 55), (10_500, 60), (13_000, 65), (17_500, 238),
            (21_000, 180), (26_000, 150), (28_000, 210), (31_000, 80), (32_000, 45),
        ]
        var h = profile.last!.1
        for i in 0..<(profile.count - 1) where d >= profile[i].0 && d <= profile[i + 1].0 {
            let (d0, h0) = profile[i], (d1, h1) = profile[i + 1]
            let f = (d - d0) / (d1 - d0)
            h = h0 + (h1 - h0) * (0.5 - 0.5 * cos(f * .pi))
        }
        return h + 4 * sin(d / 230) + 2 * sin(d / 71)
    }

    /// Next landmark ahead and the distance to it (wrapping into the next lap).
    public static func nextLandmark(after odometer: Double) -> (Landmark, Double) {
        let d = lapDistance(odometer)
        if let next = landmarks.first(where: { $0.distance > d + 1 }) {
            return (next, next.distance - d)
        }
        return (landmarks[0], lapLength - d)
    }

    /// Landmarks passed when moving from `from` to `to` metres (for celebration banners).
    public static func landmarksPassed(from: Double, to: Double) -> [Landmark] {
        guard to > from, to - from < lapLength else { return [] }
        var out: [Landmark] = []
        let lapStart = (from / lapLength).rounded(.down) * lapLength
        for offset in [0.0, lapLength] {
            for l in landmarks {
                let at = lapStart + offset + l.distance
                if at > from && at <= to { out.append(l) }
            }
        }
        return out
    }
}
