import SwiftUI
import InRideKit

struct RideView: View {
    @Environment(AppModel.self) private var model
    @Environment(TrainerManager.self) private var trainer
    @Environment(RideSession.self) private var session
    @Environment(AppSettings.self) private var settings

    @State private var showTrainerPicker = false
    @State private var showCalibration = false
    @State private var confirmFinish = false
    @State private var confirmDiscard = false

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                GeometryReader { geo in
                    let landscape = geo.size.width > geo.size.height
                    content(now: context.date, landscape: landscape)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 8)
                }
            }
            .background(Color.black)
            .navigationTitle("Ride")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Trainer…", systemImage: "antenna.radiowaves.left.and.right") { showTrainerPicker = true }
                        Button("Calibrate (spindown)…", systemImage: "gauge.with.dots.needle.33percent") { showCalibration = true }
                            .disabled(!trainer.state.isStreaming)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .sheet(isPresented: $showTrainerPicker) { TrainerPickerView() }
            .sheet(isPresented: $showCalibration) { CalibrationView() }
            .confirmationDialog("Finish ride?", isPresented: $confirmFinish, titleVisibility: .visible) {
                Button("Save Ride") { model.finishRide() }
                Button("Discard Ride", role: .destructive) { confirmDiscard = true }
                Button("Keep Riding", role: .cancel) {}
            }
            .alert("Discard this ride?", isPresented: $confirmDiscard) {
                Button("Discard", role: .destructive) { session.discard() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The recording will be deleted and cannot be recovered.")
            }
        }
    }

    @ViewBuilder
    private func content(now: Date, landscape: Bool) -> some View {
        if landscape {
            HStack(spacing: 12) {
                VStack(spacing: 12) {
                    connectionBar
                    powerHero(now: now, size: 120)
                    controls
                }
                .frame(maxWidth: .infinity)
                ScrollView { metricsGrid(now: now, columns: 2, size: 32) }
                    .frame(maxWidth: .infinity)
            }
        } else {
            VStack(spacing: 10) {
                connectionBar
                powerHero(now: now, size: 112)
                metricsGrid(now: now, columns: 2, size: 38)
                Spacer(minLength: 0)
                if let error = session.lastError {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                controls
            }
        }
    }

    private var connectionBar: some View {
        Button { showTrainerPicker = true } label: {
            HStack(spacing: 8) {
                Circle().fill(trainer.state.color).frame(width: 10, height: 10)
                Text(trainer.state.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer()
                if trainer.state.isStreaming, trainer.stats.measuredHz > 0 {
                    Text(String(format: "%.0f Hz", trainer.stats.measuredHz.rounded()))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                if let battery = trainer.info.battery {
                    Label("\(battery)%", systemImage: battery < 20 ? "battery.25" : "battery.75")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(battery < 20 ? .red : .secondary)
                }
                if session.phase != .idle {
                    Text(session.phase == .paused ? "PAUSED" : "REC")
                        .font(.caption2.weight(.heavy))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(session.phase == .paused ? Color.yellow : Color.red, in: Capsule())
                        .foregroundStyle(.black)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.white.opacity(0.07), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Trainer: \(trainer.state.title)")
    }

    private func powerHero(now: Date, size: CGFloat) -> some View {
        let power = session.displayPower(at: now)
        return VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(Format.watts(power))
                    .font(.system(size: size, weight: .bold, design: .rounded).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.4)
                    .contentTransition(.numericText())
                Text("W").font(.title.weight(.semibold)).foregroundStyle(.secondary)
            }
            Text(settings.powerSmoothing == .instant ? "POWER" : "POWER · \(settings.powerSmoothing.rawValue)s")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if trainer.latest?.coasting == true, power == 0 {
                Text("Coasting").font(.caption).foregroundStyle(.orange)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Power \(power.map(String.init) ?? "no data") watts")
    }

    private func metricsGrid(now: Date, columns: Int, size: CGFloat) -> some View {
        let reading = trainer.freshReading(now: now)
        let stats = session.stats
        let u = settings.units
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: columns), spacing: 10) {
            MetricTile(title: "Speed", value: Format.speed(kph: reading?.speedKPH, u), unit: Format.speedUnit(u), size: size)
            MetricTile(title: "Cadence", value: Format.rpm(reading.map { $0.cadenceRPM }), unit: "rpm", size: size)
            MetricTile(title: "Elapsed", value: Format.duration(session.elapsed(at: now)), unit: nil, size: size)
            MetricTile(title: "Moving", value: Format.duration(stats.movingTime), unit: nil, size: size)
            MetricTile(title: "Distance", value: Format.distance(stats.distance, u), unit: Format.distanceUnit(u), size: size)
            MetricTile(title: "Avg Power", value: Format.watts(stats.averagePower), unit: "W", size: size)
            MetricTile(title: "Avg Speed", value: Format.speed(metresPerSecond: stats.movingTime > 0 ? stats.averageSpeed : nil, u),
                       unit: Format.speedUnit(u), size: size)
            MetricTile(title: "Max Power", value: Format.watts(stats.maxPower), unit: "W", size: size)
        }
    }

    @ViewBuilder
    private var controls: some View {
        switch session.phase {
        case .idle:
            VStack(spacing: 6) {
                if !trainer.state.isStreaming {
                    Text("You can start now; data is recorded as soon as the trainer connects.")
                        .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                bigButton("Start Ride", systemImage: "play.fill", color: .green) { session.start() }
            }
        case .recording:
            HStack(spacing: 10) {
                bigButton("Pause", systemImage: "pause.fill", color: .yellow) { session.pause() }
                bigButton("Finish", systemImage: "stop.fill", color: .red) { confirmFinish = true }
            }
        case .paused:
            HStack(spacing: 10) {
                bigButton("Resume", systemImage: "play.fill", color: .green) { session.resume() }
                bigButton("Finish", systemImage: "stop.fill", color: .red) { confirmFinish = true }
            }
        }
    }

    private func bigButton(_ title: String, systemImage: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.title3.weight(.bold))
                .frame(maxWidth: .infinity, minHeight: 60)
        }
        .buttonStyle(.borderedProminent)
        .tint(color)
        .foregroundStyle(.black)
        .sensoryFeedback(.impact, trigger: session.phase)
    }
}

struct TrainerPickerView: View {
    @Environment(TrainerManager.self) private var trainer
    @Environment(AppSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Circle().fill(trainer.state.color).frame(width: 10, height: 10)
                        Text(trainer.state.title)
                    }
                    if trainer.state.isConnected || settings.rememberedTrainerID != nil {
                        Button("Disconnect", role: .destructive) { trainer.disconnect(forget: false) }
                        Button("Forget This Trainer", role: .destructive) { trainer.disconnect(forget: true) }
                    }
                }

                Section {
                    if trainer.discovered.isEmpty {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Looking for an inRide… Spin the wheel to wake the sensor; it sleeps when the roller stops.")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(trainer.discovered) { device in
                        Button {
                            trainer.connect(to: device.id)
                            dismiss()
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(device.name).font(.body.weight(.medium))
                                    Text(device.advertisesInRide ? "Kinetic inRide" : "Other BLE device")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if device.id == trainer.peripheralID, trainer.state.isConnected {
                                    Image(systemName: "checkmark").foregroundStyle(.green)
                                }
                                Text("\(device.rssi) dBm").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(!device.advertisesInRide && !trainer.scanAllDevices)
                    }
                } header: {
                    Text("Nearby")
                }

                Section {
                    Button(settings.simulatorEnabled ? "Stop Simulator" : "Use Simulated Trainer") {
                        settings.simulatorEnabled.toggle()
                        if settings.simulatorEnabled { trainer.startSimulator() } else { trainer.stopSimulator(); trainer.reconnectRemembered() }
                        dismiss()
                    }
                } footer: {
                    Text("The simulator generates genuine inRide packets so you can try the app without the trainer.")
                }
            }
            .groupedList()
            .navigationTitle("Trainer")
            .inlineNavigationTitle()
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { trainer.startScan() }
            .onDisappear { trainer.stopScan() }
        }
    }
}
