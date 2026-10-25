import SwiftUI
import InRideKit

struct DiagnosticsView: View {
    @Environment(TrainerManager.self) private var trainer
    @Environment(HeartRateMonitor.self) private var heartRate
    @Environment(AppSettings.self) private var settings
    @State private var exportURL: URL?
    @State private var exportError: String?

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                List {
                    linkSection(now: context.date)
                    deviceSection
                    configurationSection
                    liveSection
                    rawSection
                    heartRateSection(now: context.date)
                    Section("Tools") {
                        NavigationLink("Packet Log (\(trainer.log.packets.count))") { PacketLogView() }
                        NavigationLink("Event Log (\(trainer.log.events.count))") { EventLogView() }
                        NavigationLink("GATT Explorer") { GATTExplorerView() }
                        NavigationLink("Sensor Commands") { SensorCommandsView() }
                        NavigationLink("Scan All BLE Devices") { RawScanView() }
                    }
                    Section {
                        Button("Prepare Diagnostics Bundle", systemImage: "doc.badge.gearshape") { prepareExport() }
                        if let exportURL {
                            ShareLink(item: exportURL) { Label("Share Diagnostics Bundle", systemImage: "square.and.arrow.up") }
                        }
                        if let exportError { Text(exportError).foregroundStyle(.red) }
                    } footer: {
                        Text("A JSON file with device details, configuration, the event log and the last \(DiagnosticsLog.packetCapacity) packets (raw and de-obfuscated).")
                    }
                }
                .groupedList()
            }
            .navigationTitle("Diagnostics")
        }
    }

    private func linkSection(now: Date) -> some View {
        let s = trainer.stats
        return Section("Link") {
            HStack {
                Circle().fill(trainer.state.color).frame(width: 10, height: 10)
                Text(trainer.state.title)
            }
            LabeledValue("Peripheral", trainer.peripheralName)
            LabeledValue("Identifier", trainer.peripheralID?.uuidString, monospaced: true)
            LabeledValue("RSSI", trainer.rssi.map { "\($0) dBm" })
            LabeledValue("Packets", "\(s.packets)")
            LabeledValue("Measured rate", s.measuredHz > 0 ? String(format: "%.2f Hz", s.measuredHz) : nil)
            LabeledValue("Last packet", trainer.latestAt.map { String(format: "%.1f s ago", now.timeIntervalSince($0)) })
            LabeledValue("Decode errors", "\(s.decodeErrors)")
            LabeledValue("Connected for", s.connectedSince.map { Format.duration(now.timeIntervalSince($0)) })
            LabeledValue("Connects / drops", "\(s.connects) / \(s.disconnects)")
            LabeledValue("Watchdog", "\(s.watchdogResubscribes) resubscribes, \(s.watchdogDrops) drops")
            LabeledValue("Last disconnect", s.lastDisconnect)
            LabeledValue("Max write length", s.maxWriteLength.map { "\($0) bytes" })
        }
    }

    private var deviceSection: some View {
        let i = trainer.info
        return Section {
            LabeledValue("Manufacturer", i.manufacturer)
            LabeledValue("Model", i.model)
            LabeledValue("Serial", i.serial)
            LabeledValue("Firmware", i.firmware.map { i.firmwareIsOutdated ? "\($0) (Kinetic's last: \(InRideGATT.latestPublishedFirmware))" : $0 })
            LabeledValue("Hardware", i.hardware)
            LabeledValue("Software", i.software)
            LabeledValue("System ID", i.systemID?.hexString(), monospaced: true)
            LabeledValue("Command key", i.systemID.flatMap { try? InRideCommand.commandKey(systemID: $0).hexString() }, monospaced: true)
            LabeledValue("Battery", i.battery.map { "\($0)%" })
        } header: {
            Text("Device")
        } footer: {
            Text("The System ID (Device Information 0x2A23) is needed to build control point commands.")
        }
    }

    @ViewBuilder
    private var configurationSection: some View {
        Section("Sensor Configuration (E9410104)") {
            if let c = trainer.configuration {
                LabeledValue("Update rate", String(format: "%.0f Hz (0x%02X)", c.updateHz, c.updateRateDefault))
                LabeledValue("Calibration rate", String(format: "%.0f Hz (0x%02X)", c.calibrationUpdateHz, c.updateRateCalibration))
                LabeledValue("Stored spindown", String(format: "%.3f s (%u ticks)", c.currentSpindownTime, c.currentSpindownTicks))
                LabeledValue("Pro Flywheel", c.proFlywheel ? "Yes" : "No")
                LabeledValue("Cal. ready / start / end", "\(c.calibrationReady) / \(c.calibrationStart) / \(c.calibrationEnd)")
                LabeledValue("Cal. debounce", "\(c.calibrationDebounce)")
                Button("Re-read") { trainer.read(InRideGATT.configCharacteristic) }
            } else {
                Text("Not read yet").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var liveSection: some View {
        Section("Decoded (Kinetic algorithm)") {
            if let m = trainer.latest {
                LabeledValue("State", m.state.description)
                LabeledValue("Command result", "\(m.commandResult) (0x\(String(format: "%X", m.raw.commandResultBits)))")
                LabeledValue("Power", "\(m.power) W")
                LabeledValue("Speed (roller)", String(format: "%.2f km/h", m.speedKPH))
                LabeledValue("Roller", String(format: "%.1f rpm", m.rollerRPM))
                LabeledValue("Cadence raw / smoothed", String(format: "%.1f / %.1f rpm", m.cadenceRPM, trainer.smoothedCadence))
                LabeledValue("Coasting", m.coasting ? "Yes" : "No")
                LabeledValue("Alpha", String(format: "%.2f", m.alpha))
                LabeledValue("Applied spindown", String(format: "%.3f s", m.spindownTime))
                LabeledValue("Last spindown result", String(format: "%.3f s (%@)", m.lastSpindownResultTime, m.calibrationResult.description))
                LabeledValue("Roller resistance", String(format: "%.3f", m.rollerResistance))
                LabeledValue("Pro Flywheel", m.proFlywheel ? "Yes" : "No")
            } else {
                Text("No power packets yet").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var rawSection: some View {
        if let m = trainer.latest, let packet = trainer.latestPacket {
            Section("Raw Fields") {
                LabeledValue("Rotation", "\(m.raw.rotation)")
                LabeledValue("Interval", "\(m.raw.interval) ticks")
                LabeledValue("Ticks / revs", "\(m.raw.ticks) / \(m.raw.revs)")
                LabeledValue("Previous ticks / revs", "\(m.raw.ticksPrevious) / \(m.raw.revsPrevious)")
                LabeledValue("Cadence raw", "\(m.raw.cadenceRaw)")
                LabeledValue("Spindown ticks", "\(m.raw.spindownTicks)")
                VStack(alignment: .leading, spacing: 4) {
                    Text("Received").font(.caption).foregroundStyle(.secondary)
                    Text(packet.hexString).font(.caption.monospaced()).textSelection(.enabled)
                    Text("De-obfuscated").font(.caption).foregroundStyle(.secondary)
                    Text(InRideObfuscation.deobfuscate([UInt8](packet)).hexString()).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        }
    }

    private func heartRateSection(now: Date) -> some View {
        Section("Heart-Rate Monitor") {
            LabeledValue("Status", heartRate.statusLine(now: now))
            LabeledValue("Device", heartRate.deviceName)
            LabeledValue("Identifier", heartRate.deviceID?.uuidString, monospaced: true)
            LabeledValue("Manufacturer / firmware", [heartRate.manufacturer, heartRate.firmware].compactMap { $0 }.joined(separator: " / "))
            LabeledValue("Heart rate", heartRate.bpm.map { "\($0) bpm" })
            LabeledValue("Skin contact", heartRate.sensorContact.map { $0 ? "Yes" : "No" } ?? "Not reported")
            LabeledValue("RR intervals", heartRate.lastRRIntervals.isEmpty ? nil : heartRate.lastRRIntervals.map { String(format: "%.0f ms", $0 * 1000) }.joined(separator: ", "))
            LabeledValue("Last reading", heartRate.lastAt.map { String(format: "%.1f s ago", now.timeIntervalSince($0)) })
            LabeledValue("Readings", "\(heartRate.packets)")
            LabeledValue("Connects / drops", "\(heartRate.connects) / \(heartRate.disconnects)")
            LabeledValue("Battery", heartRate.battery.map { "\($0)%" })
            LabeledValue("RSSI", heartRate.rssi.map { "\($0) dBm" })
            LabeledValue("Last packet", heartRate.lastPacket?.hexString, monospaced: true)
        }
    }

    private func prepareExport() {
        let i = trainer.info
        var device: [String: String] = [:]
        device["name"] = trainer.peripheralName
        device["identifier"] = trainer.peripheralID?.uuidString
        device["manufacturer"] = i.manufacturer
        device["model"] = i.model
        device["serial"] = i.serial
        device["firmware"] = i.firmware
        device["hardware"] = i.hardware
        device["software"] = i.software
        device["systemID"] = i.systemID?.hexString(separator: "")
        device["battery"] = i.battery.map(String.init)
        device["state"] = trainer.state.title
        device["heartRateMonitor"] = heartRate.deviceName
        device["heartRateStatus"] = heartRate.statusLine()
        do {
            exportURL = try trainer.log.exportBundle(device: device, configuration: trainer.configuration, latest: trainer.latest)
            exportError = nil
        } catch {
            exportError = error.localizedDescription
        }
    }
}

struct PacketLogView: View {
    @Environment(TrainerManager.self) private var trainer
    @State private var showPlain = true
    @State private var filterPower = false

    var body: some View {
        @Bindable var log = trainer.log
        let packets = trainer.log.packets.reversed().filter { !filterPower || $0.characteristic == InRideGATT.powerCharacteristic }
        List {
            Section {
                Toggle("Pause logging", isOn: $log.packetLoggingPaused)
                Toggle("Show de-obfuscated bytes", isOn: $showPlain)
                Toggle("Power packets only", isOn: $filterPower)
            }
            ForEach(packets.prefix(500)) { p in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(p.direction == .rx ? "RX" : "TX").font(.caption2.weight(.heavy))
                            .foregroundStyle(p.direction == .rx ? .green : .orange)
                        Text(InRideGATT.name(for: p.characteristic) ?? p.characteristic).font(.caption.weight(.semibold))
                        Spacer()
                        Text(p.date.formatted(.dateTime.hour().minute().second().secondFraction(.fractional(2))))
                            .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    Text([UInt8](p.bytes).hexString()).font(.caption2.monospaced())
                    if showPlain, let plain = p.plain {
                        Text([UInt8](plain).hexString()).font(.caption2.monospaced()).foregroundStyle(.cyan)
                    }
                    Text(p.summary).font(.caption2).foregroundStyle(.secondary)
                }
                .textSelection(.enabled)
            }
        }
        .navigationTitle("Packets")
        .inlineNavigationTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button("Clear") { trainer.log.clear() } }
        }
    }
}

struct EventLogView: View {
    @Environment(TrainerManager.self) private var trainer

    var body: some View {
        List(trainer.log.events.reversed()) { e in
            VStack(alignment: .leading, spacing: 2) {
                Text(e.date.formatted(.dateTime.hour().minute().second()))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                Text(e.message).font(.callout)
                    .foregroundStyle(e.level == .error ? .red : e.level == .warning ? .orange : .primary)
            }
            .textSelection(.enabled)
        }
        .navigationTitle("Events")
        .inlineNavigationTitle()
    }
}

struct GATTExplorerView: View {
    @Environment(TrainerManager.self) private var trainer
    @State private var writeTarget: TrainerManager.GATTCharacteristic?

    var body: some View {
        List {
            if trainer.gatt.isEmpty {
                Text("Connect to a trainer to browse its services.").foregroundStyle(.secondary)
            }
            ForEach(trainer.gatt) { service in
                Section {
                    ForEach(service.characteristics) { c in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(c.name).font(.callout.weight(.semibold))
                            Text(c.uuid).font(.caption2.monospaced()).foregroundStyle(.secondary)
                            Text(c.propertyNames.joined(separator: " · ")).font(.caption)
                            if let v = c.value {
                                Text(v.hexString).font(.caption2.monospaced()).textSelection(.enabled)
                                if let s = String(data: v, encoding: .utf8), s.allSatisfy({ $0.isASCII && !$0.isNewline }), !s.isEmpty {
                                    Text("\"\(s)\"").font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            HStack {
                                if c.properties.contains(.read) {
                                    Button("Read") { trainer.read(c.uuid) }.buttonStyle(.bordered)
                                }
                                if c.properties.contains(.notify) || c.properties.contains(.indicate) {
                                    Button(c.isNotifying ? "Unsubscribe" : "Subscribe") { trainer.setNotify(!c.isNotifying, for: c.uuid) }
                                        .buttonStyle(.bordered)
                                }
                                if c.properties.contains(.write) || c.properties.contains(.writeWithoutResponse) {
                                    Button("Write…") { writeTarget = c }.buttonStyle(.bordered).tint(.orange)
                                }
                            }
                            .font(.caption)
                        }
                    }
                } header: {
                    VStack(alignment: .leading) {
                        Text(service.name)
                        Text(service.uuid).font(.caption2.monospaced())
                    }
                }
            }
        }
        .navigationTitle("GATT")
        .inlineNavigationTitle()
        .sheet(item: $writeTarget) { RawWriteView(characteristic: $0) }
    }
}

struct RawWriteView: View {
    let characteristic: TrainerManager.GATTCharacteristic
    @Environment(TrainerManager.self) private var trainer
    @Environment(\.dismiss) private var dismiss
    @State private var hex = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Hex bytes, e.g. 21 65 03", text: $hex).font(.body.monospaced()).plainTextEntry()
                } footer: {
                    Text("Writes go straight to the sensor. Wrong values on the control point can change its configuration; a power cycle (remove the battery) restores normal operation.")
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(characteristic.name)
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Write") {
                        guard let data = Data(hex: hex), !data.isEmpty else { error = "Not valid hex"; return }
                        do {
                            try trainer.write(data, to: characteristic.uuid, withResponse: characteristic.properties.contains(.write), label: "manual")
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
            }
        }
    }
}

struct SensorCommandsView: View {
    @Environment(TrainerManager.self) private var trainer
    @Environment(AppSettings.self) private var settings
    @State private var message: String?

    var body: some View {
        List {
            Section {
                ForEach(InRideUpdateRate.allCases, id: \.self) { rate in
                    Button("Set update rate to \(rate.label)") { run(.configure(updateRate: rate)) }
                }
            } header: {
                Text("Update rate")
            } footer: {
                Text("Kinetic's configure command, which also rewrites the spindown thresholds with Kinetic's standard values. The result appears in the next power packet.")
            }
            Section("Calibration") {
                Button("Start spindown") { run(.startCalibration) }
                Button("Stop spindown") { run(.stopCalibration) }
            }
            Section("Read") {
                Button("Read configuration") { trainer.read(InRideGATT.configCharacteristic) }
                Button("Read System ID") { trainer.read(InRideGATT.systemID) }
                Button("Read RSSI") { trainer.refreshRSSI() }
            }
            if let message { Text(message).font(.footnote) }
        }
        .navigationTitle("Commands")
        .inlineNavigationTitle()
    }

    private func run(_ command: InRideCommand) {
        do {
            try trainer.send(command)
            message = "Sent \(command). Watch the event log for the command result."
        } catch {
            message = "Failed: \(error)"
        }
    }
}

struct RawScanView: View {
    @Environment(TrainerManager.self) private var trainer

    var body: some View {
        List(trainer.discovered) { d in
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(d.name).font(.callout.weight(.semibold))
                    if d.advertisesInRide { Text("inRide").font(.caption2.weight(.bold)).foregroundStyle(.green) }
                    Spacer()
                    Text("\(d.rssi) dBm").font(.caption.monospacedDigit())
                }
                Text(d.id.uuidString).font(.caption2.monospaced()).foregroundStyle(.secondary)
                if !d.advertisedServices.isEmpty {
                    Text(d.advertisedServices.joined(separator: ", ")).font(.caption2.monospaced())
                }
            }
        }
        .navigationTitle("All Devices")
        .inlineNavigationTitle()
        .onAppear { trainer.startScan(allDevices: true) }
        .onDisappear { trainer.stopScan() }
    }
}
