import SwiftUI
import InRideKit

/// Trainer, heart-rate strap and watch broadcast in one place, each with a live,
/// verifiable status (data actually arriving, not just "paired").
struct SensorsView: View {
    @Environment(TrainerManager.self) private var trainer
    @Environment(HeartRateMonitor.self) private var heartRate
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                List {
                    trainerSection(now: context.date)
                    heartRateSection(now: context.date)
                    simulatorSection
                }
                .groupedList()
            }
            .navigationTitle("Sensors")
            .inlineNavigationTitle()
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear {
                trainer.startScan()
                heartRate.startScan()
            }
            .onDisappear {
                trainer.stopScan()
                heartRate.stopScan()
            }
        }
    }

    // MARK: Trainer

    private func trainerSection(now: Date) -> some View {
        Section {
            SensorStatusRow(icon: "bicycle", color: trainer.state.color, title: trainer.state.title,
                            detail: trainer.freshReading(now: now).map {
                                String(format: "Receiving: %d W · %.1f km/h", $0.power, $0.speedKPH)
                            } ?? (trainer.state.isConnected ? "Connected — spin the wheel to see data" : nil),
                            verified: trainer.freshReading(now: now) != nil)
            ForEach(trainer.discovered.filter { $0.advertisesInRide }) { device in
                Button {
                    trainer.connect(to: device.id)
                } label: {
                    deviceRow(name: device.name, subtitle: "Kinetic inRide", rssi: device.rssi,
                              selected: device.id == trainer.peripheralID && trainer.state.isConnected)
                }
            }
            if trainer.discovered.filter({ $0.advertisesInRide }).isEmpty, !trainer.state.isConnected {
                searchingRow("Spin the wheel to wake the inRide. Close other apps using it (Kinetic, nRF Connect, Zwift).")
            }
            if settings.rememberedTrainerID != nil {
                Button("Forget Trainer", role: .destructive) { trainer.disconnect(forget: true) }
            }
        } header: {
            Text("Trainer")
        }
    }

    // MARK: Heart rate

    private func heartRateSection(now: Date) -> some View {
        Section {
            SensorStatusRow(icon: "heart.fill", color: heartRateColor(now: now), title: heartRate.statusLine(now: now),
                            detail: heartRateDetail, verified: heartRate.freshHeartRate(now: now) != nil)
            ForEach(heartRate.discovered) { device in
                Button {
                    heartRate.connect(to: device.id)
                } label: {
                    deviceRow(name: device.name, subtitle: "Heart-rate monitor", rssi: device.rssi,
                              selected: device.id == heartRate.deviceID && heartRate.state.isConnected)
                }
            }
            if heartRate.discovered.isEmpty, !heartRate.state.isConnected {
                searchingRow("Put the strap on (moisten the electrodes) so it wakes up. A Polar H9 shows as \"Polar H9 …\".")
            }
            if settings.rememberedHeartRateID != nil {
                Button("Forget Heart-Rate Monitor", role: .destructive) { heartRate.disconnect(forget: true) }
            }
        } header: {
            Text("Heart-rate monitor")
        } footer: {
            Text("A Polar H9 accepts one Bluetooth connection at a time, so disconnect it from other apps (Polar Flow, Zwift) first.")
        }
    }

    private func heartRateColor(now: Date) -> Color {
        if heartRate.freshHeartRate(now: now) != nil { return .green }
        switch heartRate.state {
        case .connected, .waiting, .connecting, .scanning: return .orange
        case .unavailable: return .red
        case .idle: return .gray
        }
    }

    private var heartRateDetail: String? {
        var parts: [String] = []
        if let b = heartRate.battery { parts.append("battery \(b)%") }
        if let r = heartRate.rssi { parts.append("\(r) dBm") }
        if heartRate.packets > 0 { parts.append("\(heartRate.packets) readings") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: Simulator

    private var simulatorSection: some View {
        Section {
            Button(settings.simulatorEnabled ? "Stop Simulated Trainer" : "Use Simulated Trainer") {
                settings.simulatorEnabled.toggle()
                if settings.simulatorEnabled { trainer.startSimulator() } else { trainer.stopSimulator(); trainer.reconnectRemembered() }
            }
        } footer: {
            Text("Generates genuine inRide packets so you can try the app without the trainer.")
        }
    }

    // MARK: Rows

    private func deviceRow(name: String, subtitle: String, rssi: Int, selected: Bool) -> some View {
        HStack {
            VStack(alignment: .leading) {
                Text(name).font(.body.weight(.medium)).foregroundStyle(.primary)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if selected { Image(systemName: "checkmark").foregroundStyle(.green) }
            if rssi != 0 { Text("\(rssi) dBm").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
        }
    }

    private func searchingRow(_ hint: String) -> some View {
        HStack(spacing: 12) {
            ProgressView()
            Text(hint).font(.callout).foregroundStyle(.secondary)
        }
    }
}

struct SensorStatusRow: View {
    let icon: String
    let color: Color
    let title: String
    let detail: String?
    /// True when live data is arriving right now.
    let verified: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).foregroundStyle(color).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium))
                if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            if verified {
                Label("Live", systemImage: "checkmark.seal.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.green)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
