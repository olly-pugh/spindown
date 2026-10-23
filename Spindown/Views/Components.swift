import SwiftUI
import InRideKit

enum Format {
    static func duration(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        return String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60)
    }

    static func shortDuration(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds.rounded()))
        return s >= 3600 ? String(format: "%dh %02dm", s / 3600, (s / 60) % 60) : String(format: "%dm %02ds", s / 60, s % 60)
    }

    static func speed(kph: Double?, _ units: UnitSystem) -> String {
        guard let kph else { return "--" }
        return String(format: "%.1f", units == .metric ? kph : kph * 0.621371)
    }

    static func speed(metresPerSecond v: Double?, _ units: UnitSystem) -> String {
        speed(kph: v.map { $0 * 3.6 }, units)
    }

    static func speedUnit(_ units: UnitSystem) -> String { units == .metric ? "km/h" : "mph" }

    static func distance(_ metres: Double, _ units: UnitSystem) -> String {
        String(format: "%.2f", units == .metric ? metres / 1000 : metres / 1609.344)
    }

    static func distanceUnit(_ units: UnitSystem) -> String { units == .metric ? "km" : "mi" }

    static func watts(_ w: Double?) -> String { w.map { String(Int($0.rounded())) } ?? "--" }
    static func watts(_ w: Int?) -> String { w.map(String.init) ?? "--" }
    static func rpm(_ c: Double?) -> String { c.map { String(Int($0.rounded())) } ?? "--" }
}

/// One live number. Large, rounded, monospaced digits so values do not jitter in width.
struct MetricTile: View {
    let title: String
    let value: String
    let unit: String?
    var tint: Color = .primary
    var size: CGFloat = 40

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value)
                    .font(.system(size: size, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(tint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                if let unit {
                    Text(unit).font(.callout.weight(.medium)).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title) \(value) \(unit ?? "")")
    }
}

struct LabeledValue: View {
    let label: String
    let value: String
    var monospaced = false

    init(_ label: String, _ value: String?, monospaced: Bool = false) {
        self.label = label
        self.value = value ?? "—"
        self.monospaced = monospaced
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value)
                .font(monospaced ? .body.monospaced() : .body)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }
}

extension TrainerManager.LinkState {
    var title: String {
        switch self {
        case .unavailable(let why): return why
        case .idle: return "No trainer connected"
        case .scanning: return "Searching for trainers…"
        case .waiting(let name): return "Waiting for \(name) — spin the wheel to wake it"
        case .connecting(let name): return "Connecting to \(name)…"
        case .discovering(let name): return "Setting up \(name)…"
        case .streaming(let name): return name
        case .reconnecting(let name): return "Reconnecting to \(name)…"
        case .simulated: return "Simulated trainer"
        }
    }

    var color: Color {
        switch self {
        case .streaming, .simulated: return .green
        case .waiting, .connecting, .discovering, .reconnecting, .scanning: return .orange
        case .unavailable: return .red
        case .idle: return .gray
        }
    }
}

extension UploadDestination {
    var symbol: String { self == .garmin ? "triangle.fill" : "flame.fill" }
}
