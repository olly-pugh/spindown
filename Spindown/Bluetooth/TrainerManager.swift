import CoreBluetooth
import Foundation
import Observation
import InRideKit

/// Owns the CoreBluetooth central and the connection to one inRide sensor.
///
/// Reliability rules:
/// - The central runs on the main queue. The sensor sends at most a few packets a second, so
///   this keeps every state change on one actor with no locking.
/// - Once the rider has chosen a trainer we keep a pending `connect` outstanding whenever we are
///   not connected. CoreBluetooth then reconnects the moment the sensor advertises again (the
///   inRide sleeps when the roller stops and wakes when it turns), with no polling or timeouts.
/// - iOS 17 auto-reconnect is requested too, and state restoration lets iOS relaunch the app
///   for the trainer if it was terminated in the background mid-ride.
/// - A watchdog re-subscribes, then drops the link, if the sensor goes silent while connected.
@MainActor @Observable
final class TrainerManager: NSObject {
    enum LinkState: Equatable {
        case unavailable(String)
        case idle
        case scanning
        /// A connect request is pending; the sensor may be asleep.
        case waiting(String)
        case connecting(String)
        case discovering(String)
        case streaming(String)
        case reconnecting(String)
        case simulated

        var isConnected: Bool {
            switch self {
            case .discovering, .streaming, .simulated: return true
            default: return false
            }
        }

        var isStreaming: Bool {
            if case .streaming = self { return true }
            return self == .simulated
        }
    }

    struct Discovered: Identifiable, Equatable {
        var id: UUID
        var name: String
        var rssi: Int
        var lastSeen: Date
        var advertisesInRide: Bool
        var advertisedServices: [String]
        var connectable: Bool?
    }

    struct DeviceInfo: Equatable {
        var manufacturer: String?
        var model: String?
        var serial: String?
        var firmware: String?
        var hardware: String?
        var software: String?
        var systemID: [UInt8]?
        var battery: Int?

        var firmwareIsOutdated: Bool {
            guard let firmware else { return false }
            return firmware.compare(InRideGATT.latestPublishedFirmware, options: .numeric) == .orderedAscending
        }
    }

    struct LinkStats: Equatable {
        var packets = 0
        var decodeErrors = 0
        var connects = 0
        var disconnects = 0
        var watchdogResubscribes = 0
        var watchdogDrops = 0
        var connectedSince: Date?
        var lastDisconnect: String?
        var measuredHz: Double = 0
        var maxWriteLength: Int?
    }

    struct GATTCharacteristic: Identifiable, Equatable {
        var id: String { uuid }
        var uuid: String
        var properties: CBCharacteristicProperties
        var isNotifying: Bool
        var value: Data?
        var name: String { InRideGATT.name(for: uuid) ?? uuid }

        var propertyNames: [String] {
            var out: [String] = []
            if properties.contains(.read) { out.append("read") }
            if properties.contains(.write) { out.append("write") }
            if properties.contains(.writeWithoutResponse) { out.append("write-no-rsp") }
            if properties.contains(.notify) { out.append("notify") }
            if properties.contains(.indicate) { out.append("indicate") }
            return out
        }
    }

    struct GATTService: Identifiable, Equatable {
        var id: String { uuid }
        var uuid: String
        var characteristics: [GATTCharacteristic]
        var name: String { InRideGATT.name(for: uuid) ?? uuid }
    }

    // MARK: Observable state

    private(set) var state: LinkState = .idle
    private(set) var discovered: [Discovered] = []
    private(set) var scanAllDevices = false
    private(set) var latest: InRidePowerMeasurement?
    private(set) var latestAt: Date?
    private(set) var latestPacket: Data?
    private(set) var smoothedCadence: Double = 0
    private(set) var configuration: InRideConfiguration?
    private(set) var info = DeviceInfo()
    private(set) var rssi: Int?
    private(set) var stats = LinkStats()
    private(set) var gatt: [GATTService] = []
    private(set) var peripheralName: String?
    private(set) var peripheralID: UUID?

    let log: DiagnosticsLog
    private let settings: AppSettings

    /// Called for every decoded power packet. The ride session hooks in here.
    var onMeasurement: ((InRidePowerMeasurement, Date) -> Void)?
    /// Called for every packet received or sent, for raw ride captures.
    var onPacket: ((DiagnosticsLog.Packet) -> Void)?

    // MARK: Private

    private static let restoreIdentifier = "com.spindown.app.central"
    private static let powerUUID = CBUUID(string: InRideGATT.powerCharacteristic)
    private static let configUUID = CBUUID(string: InRideGATT.configCharacteristic)
    private static let controlUUID = CBUUID(string: InRideGATT.controlPointCharacteristic)
    private static let serviceUUID = CBUUID(string: InRideGATT.powerService)

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var characteristics: [CBUUID: CBCharacteristic] = [:]
    /// True while the rider wants to be connected; false after an explicit disconnect.
    private var wantsConnection = false
    private var cadenceSmoother = CadenceSmoother()
    private var lastPacketAt: Date?
    private var watchdogTask: Task<Void, Never>?
    private var simulatorTask: Task<Void, Never>?
    private var pendingUpdateRateCheck = true
    /// Set when iOS no longer knows the remembered identifier and we scan to find it again.
    private var connectWhenRememberedSeen = false

    init(settings: AppSettings, log: DiagnosticsLog) {
        self.settings = settings
        self.log = log
        super.init()
        var options: [String: Any] = [CBCentralManagerOptionShowPowerAlertKey: true]
        #if os(iOS)
        options[CBCentralManagerOptionRestoreIdentifierKey] = Self.restoreIdentifier
        #endif
        central = CBCentralManager(delegate: self, queue: .main, options: options)
        startWatchdog()
    }

    // MARK: Public API

    /// Fresh enough to record? Allows for 1 Hz updates plus one dropped packet.
    func freshReading(now: Date = Date()) -> TrainerReading? {
        guard let latest, let latestAt, now.timeIntervalSince(latestAt) < 2.5 else { return nil }
        return TrainerReading(power: latest.power, speedKPH: latest.speedKPH, cadenceRPM: smoothedCadence)
    }

    var trainerInfo: TrainerInfo {
        TrainerInfo(name: peripheralName, identifier: peripheralID?.uuidString, manufacturer: info.manufacturer,
                    model: info.model, firmware: info.firmware, hardware: info.hardware,
                    systemID: info.systemID?.hexString(separator: ""),
                    spindownTime: latest?.spindownTime ?? configuration?.currentSpindownTime,
                    proFlywheel: latest?.proFlywheel ?? configuration?.proFlywheel)
    }

    var hasRememberedTrainer: Bool { settings.rememberedTrainerID != nil }

    func startScan(allDevices: Bool = false) {
        guard central.state == .poweredOn else {
            log.log("Scan requested but Bluetooth is \(central.state.label)", level: .warning)
            return
        }
        scanAllDevices = allDevices
        discovered.removeAll()
        // Scanning for the service UUID works in the background; "all devices" is a diagnostics aid
        // for sensors that do not advertise it.
        central.scanForPeripherals(withServices: allDevices ? nil : [Self.serviceUUID],
                                   options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        if !state.isConnected { state = .scanning }
        log.log(allDevices ? "Scanning for all BLE devices" : "Scanning for inRide sensors")
        // Previously paired sensors that are already connected to iOS do not advertise.
        for p in central.retrieveConnectedPeripherals(withServices: [Self.serviceUUID]) {
            upsertDiscovered(p, rssi: 0, advertisesInRide: true, services: [InRideGATT.powerService], connectable: true)
        }
    }

    func stopScan() {
        guard central.isScanning else { return }
        central.stopScan()
        log.log("Scan stopped")
        if state == .scanning { state = .idle }
        resumePendingConnectIfNeeded()
    }

    func connect(to id: UUID) {
        stopSimulator()
        guard let p = central.retrievePeripherals(withIdentifiers: [id]).first else {
            log.log("Could not find peripheral \(id)", level: .error)
            return
        }
        wantsConnection = false
        connectWhenRememberedSeen = false
        stopScan()
        if let current = peripheral, current.identifier != id {
            central.cancelPeripheralConnection(current)
        }
        settings.rememberedTrainerID = id
        settings.rememberedTrainerName = p.name
        wantsConnection = true
        attach(p)
        requestConnect(p, initial: true)
    }

    /// Disconnects. `forget` also stops automatic reconnection on future launches.
    func disconnect(forget: Bool) {
        wantsConnection = false
        stopSimulator()
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        if forget {
            settings.rememberedTrainerID = nil
            settings.rememberedTrainerName = nil
            peripheral = nil
            peripheralName = nil
            peripheralID = nil
            gatt = []
            info = DeviceInfo()
            configuration = nil
        }
        clearLiveData()
        state = .idle
        log.log(forget ? "Disconnected and forgot trainer" : "Disconnected by user")
    }

    /// Re-establishes the connection to the remembered trainer (app launch, or after Bluetooth returns).
    func reconnectRemembered() {
        guard settings.autoConnect, !settings.simulatorEnabled, let id = settings.rememberedTrainerID,
              central.state == .poweredOn, !state.isConnected else { return }
        guard let p = central.retrievePeripherals(withIdentifiers: [id]).first else {
            log.log("Remembered trainer not known to iOS; scanning", level: .warning)
            connectWhenRememberedSeen = true
            startScan()
            return
        }
        wantsConnection = true
        attach(p)
        requestConnect(p, initial: true)
    }

    func send(_ command: InRideCommand) throws {
        guard let systemID = info.systemID else {
            throw InRideCommand.BuildError.invalidSystemID
        }
        let bytes = try command.bytes(systemID: systemID)
        try write(Data(bytes), to: InRideGATT.controlPointCharacteristic, withResponse: true, label: "\(command)")
    }

    func write(_ data: Data, to characteristic: String, withResponse: Bool, label: String? = nil) throws {
        guard let p = peripheral, let c = characteristics[CBUUID(string: characteristic)] else {
            throw CocoaError(.featureUnsupported, userInfo: [NSLocalizedDescriptionKey: "Characteristic not available"])
        }
        p.writeValue(data, for: c, type: withResponse ? .withResponse : .withoutResponse)
        let packet = DiagnosticsLog.Packet(date: Date(), direction: .tx, characteristic: c.uuid.uuidString, bytes: data,
                                           plain: nil, summary: label ?? "write")
        log.record(packet)
        onPacket?(packet)
        log.log("Wrote \(data.count) bytes to \(InRideGATT.name(for: c.uuid.uuidString) ?? c.uuid.uuidString)\(label.map { " (\($0))" } ?? "")")
    }

    func read(_ characteristic: String) {
        guard let p = peripheral, let c = characteristics[CBUUID(string: characteristic)] else { return }
        p.readValue(for: c)
    }

    func setNotify(_ on: Bool, for characteristic: String) {
        guard let p = peripheral, let c = characteristics[CBUUID(string: characteristic)] else { return }
        p.setNotifyValue(on, for: c)
    }

    func refreshRSSI() {
        guard let p = peripheral, p.state == .connected else { return }
        p.readRSSI()
    }

    // MARK: Simulator

    func startSimulator() {
        disconnect(forget: false)
        state = .simulated
        peripheralName = "Simulated inRide"
        info = DeviceInfo(manufacturer: "Kinetic", model: "inRide (simulated)", firmware: InRideGATT.latestPublishedFirmware,
                          systemID: [0x10, 0x21, 0x32, 0x43, 0x54, 0x65], battery: 88)
        configuration = try? InRideConfiguration(InRideSimulator.configurationBytes())
        stats.connectedSince = Date()
        log.log("Simulator started")
        simulatorTask = Task { [weak self] in
            var sim = InRideSimulator()
            var t = 0.0
            while !Task.isCancelled {
                t += 1
                // A gentle interval session: 5 minutes steady, 1 minute hard, with a short coast.
                let phase = t.truncatingRemainder(dividingBy: 360)
                let speed = phase < 300 ? 30 + 2 * sin(t / 20) : (phase < 350 ? 38 : 20)
                let cadence = phase >= 350 ? 0 : 88 + 4 * sin(t / 7)
                let packet = sim.nextPacket(speedKPH: speed, cadenceRPM: cadence)
                self?.handlePowerPacket(Data(packet), from: InRideGATT.powerCharacteristic)
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func stopSimulator() {
        guard simulatorTask != nil else { return }
        simulatorTask?.cancel()
        simulatorTask = nil
        if state == .simulated { state = .idle }
        clearLiveData()
        log.log("Simulator stopped")
    }

    // MARK: Internals

    private func attach(_ p: CBPeripheral) {
        peripheral = p
        p.delegate = self
        peripheralName = p.name ?? settings.rememberedTrainerName ?? "inRide"
        peripheralID = p.identifier
    }

    private func requestConnect(_ p: CBPeripheral, initial: Bool) {
        var options: [String: Any] = [:]
        if #available(iOS 17.0, macOS 14.0, *) {
            options[CBConnectPeripheralOptionEnableAutoReconnect] = true
        }
        central.connect(p, options: options)
        let name = peripheralName ?? "inRide"
        state = initial ? .waiting(name) : .reconnecting(name)
        log.log("Connection requested to \(name) (\(initial ? "initial" : "reconnect"))")
    }

    private func resumePendingConnectIfNeeded() {
        if wantsConnection, let p = peripheral, p.state == .disconnected {
            requestConnect(p, initial: false)
        }
    }

    private func clearLiveData() {
        latest = nil
        latestAt = nil
        smoothedCadence = 0
        cadenceSmoother.reset()
        rssi = nil
        stats.measuredHz = 0
    }

    private func upsertDiscovered(_ p: CBPeripheral, rssi: Int, advertisesInRide: Bool, services: [String], connectable: Bool?) {
        let name = p.name ?? "Unnamed"
        if let i = discovered.firstIndex(where: { $0.id == p.identifier }) {
            discovered[i].rssi = rssi == 127 ? discovered[i].rssi : rssi
            discovered[i].lastSeen = Date()
            discovered[i].name = name
            discovered[i].advertisesInRide = discovered[i].advertisesInRide || advertisesInRide
        } else {
            discovered.append(Discovered(id: p.identifier, name: name, rssi: rssi, lastSeen: Date(),
                                         advertisesInRide: advertisesInRide, advertisedServices: services, connectable: connectable))
            log.log("Discovered \(name) RSSI \(rssi)\(advertisesInRide ? " [inRide]" : "")")
        }
        discovered.sort { ($0.advertisesInRide ? 1 : 0, $0.rssi) > ($1.advertisesInRide ? 1 : 0, $1.rssi) }
    }

    fileprivate func handlePowerPacket(_ data: Data, from uuid: String) {
        let now = Date()
        do {
            let m = try InRideDecoder.decodePower(data)
            if let last = lastPacketAt {
                let dt = now.timeIntervalSince(last)
                if dt > 0.05 && dt < 10 {
                    let hz = 1 / dt
                    stats.measuredHz = stats.measuredHz == 0 ? hz : stats.measuredHz * 0.8 + hz * 0.2
                }
            }
            lastPacketAt = now
            stats.packets += 1
            smoothedCadence = cadenceSmoother.add(m.cadenceRPM, at: now.timeIntervalSince1970)
            latest = m
            latestAt = now
            latestPacket = data
            if m.commandResult != .none {
                log.log("Command result: \(m.commandResult)\(m.commandResult == .calibrationResult ? " — \(m.calibrationResult), spindown \(String(format: "%.2f", m.lastSpindownResultTime)) s" : "")")
            }
            let packet = DiagnosticsLog.Packet(
                date: now, direction: .rx, characteristic: uuid, bytes: data,
                plain: Data(InRideObfuscation.deobfuscate([UInt8](data))),
                summary: String(format: "%d W  %.1f km/h  %.0f rpm  %@%@", m.power, m.speedKPH, smoothedCadence,
                                m.state.description, m.coasting ? "  coasting" : ""))
            log.record(packet)
            onPacket?(packet)
            onMeasurement?(m, now)
        } catch {
            stats.decodeErrors += 1
            let packet = DiagnosticsLog.Packet(date: now, direction: .rx, characteristic: uuid, bytes: data, plain: nil,
                                               summary: "decode error: \(error)")
            log.record(packet)
            onPacket?(packet)
            log.log("Power packet decode failed: \(error) (\(data.hexString))", level: .error)
        }
    }

    private func handleConfiguration(_ data: Data) {
        do {
            let c = try InRideConfiguration([UInt8](data))
            configuration = c
            log.log(String(format: "Configuration: update %.0f Hz (calibration %.0f Hz), spindown %.3f s%@",
                           c.updateHz, c.calibrationUpdateHz, c.currentSpindownTime, c.proFlywheel ? ", Pro Flywheel" : ""))
            applyPreferredUpdateRateIfNeeded()
        } catch {
            log.log("Configuration decode failed: \(error) (\(data.hexString))", level: .error)
        }
    }

    /// Writes the configure command only if the rider asked for a rate the sensor is not using.
    private func applyPreferredUpdateRateIfNeeded() {
        guard pendingUpdateRateCheck, let preferred = settings.preferredUpdateRate,
              let c = configuration, info.systemID != nil else { return }
        pendingUpdateRateCheck = false
        guard c.updateRateDefault != preferred.rawValue else { return }
        do {
            try send(.configure(updateRate: preferred))
            log.log("Requested update rate \(preferred.label)")
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                self?.read(InRideGATT.configCharacteristic)
            }
        } catch {
            log.log("Could not set update rate: \(error)", level: .error)
        }
    }

    /// Rate in use before calibration, restored afterwards.
    private var rateBeforeCalibration: InRideUpdateRate?

    /// Switches to 4 packets a second (so a coast can be told from pedalling quickly) and lowers the
    /// sensor's spindown arming speed. The timed window Kinetic's power model uses is unchanged.
    func enterCalibrationMode(armingSpeed: Double) {
        if rateBeforeCalibration == nil {
            rateBeforeCalibration = configuration.flatMap { InRideUpdateRate(rawValue: $0.updateRateDefault) } ?? .hz1
        }
        let ticks = InRideCommand.ticks(forKPH: armingSpeed)
        do {
            try send(.configureCalibration(updateRate: .hz4, readyTicks: ticks))
            log.log(String(format: "Calibration: 4 Hz, arming at %.1f km/h (%d ticks)", armingSpeed, ticks))
        } catch {
            log.log("Calibration: could not configure sensor: \(error)", level: .warning)
        }
    }

    /// Restores Kinetic's standard thresholds and the previous update rate.
    func exitCalibrationMode() {
        guard let previous = rateBeforeCalibration else { return }
        rateBeforeCalibration = nil
        do {
            try send(.configure(updateRate: settings.preferredUpdateRate ?? previous))
            log.log("Calibration: standard sensor settings restored")
        } catch {
            log.log("Calibration: could not restore update rate: \(error)", level: .warning)
        }
    }

    func applyUpdateRateNow() {
        pendingUpdateRateCheck = true
        applyPreferredUpdateRateIfNeeded()
    }

    private func rebuildGATTSnapshot() {
        guard let p = peripheral else { gatt = []; return }
        gatt = (p.services ?? []).map { s in
            GATTService(uuid: s.uuid.uuidString, characteristics: (s.characteristics ?? []).map { c in
                GATTCharacteristic(uuid: c.uuid.uuidString, properties: c.properties, isNotifying: c.isNotifying, value: c.value)
            })
        }
    }

    private func startWatchdog() {
        watchdogTask = Task { [weak self] in
            var resubscribedAt: Date?
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self else { return }
                guard case .streaming = self.state, let last = self.lastPacketAt else {
                    resubscribedAt = nil
                    continue
                }
                let silence = Date().timeIntervalSince(last)
                if silence > 45, let p = self.peripheral {
                    self.stats.watchdogDrops += 1
                    self.log.log("No data for \(Int(silence)) s; dropping link to force a reconnect", level: .error)
                    self.central.cancelPeripheralConnection(p)
                    resubscribedAt = nil
                } else if silence > 15, resubscribedAt == nil {
                    self.stats.watchdogResubscribes += 1
                    self.log.log("No data for \(Int(silence)) s; re-subscribing", level: .warning)
                    self.setNotify(false, for: InRideGATT.powerCharacteristic)
                    self.setNotify(true, for: InRideGATT.powerCharacteristic)
                    resubscribedAt = Date()
                } else if silence < 5 {
                    resubscribedAt = nil
                }
                if self.peripheral?.state == .connected { self.refreshRSSI() }
            }
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension TrainerManager: @preconcurrency CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        log.log("Bluetooth \(central.state.label)")
        switch central.state {
        case .poweredOn:
            if state.isConnected == false, case .unavailable = state { state = .idle }
            if let p = peripheral, p.state == .connected {
                // Restored by iOS with the link intact.
                p.discoverServices(nil)
            } else if wantsConnection, let p = peripheral {
                requestConnect(p, initial: false)
            } else if settings.simulatorEnabled {
                startSimulator()
            } else {
                reconnectRemembered()
            }
        case .poweredOff:
            state = .unavailable("Bluetooth is off")
            clearLiveData()
        case .unauthorized:
            state = .unavailable("Bluetooth permission denied. Allow it in Settings › Spindown.")
        case .unsupported:
            state = .unavailable("This device does not support Bluetooth LE")
        case .resetting:
            state = .unavailable("Bluetooth is resetting")
        default:
            state = .unavailable("Bluetooth unavailable")
        }
    }

    #if os(iOS)
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        log.log("iOS restored Bluetooth state with \(restored.count) peripheral(s)")
        if let p = restored.first(where: { $0.identifier == settings.rememberedTrainerID }) ?? restored.first {
            wantsConnection = true
            attach(p)
        }
    }
    #endif

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                                    advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []).map(\.uuidString)
        let isInRide = services.contains(InRideGATT.powerService) || (peripheral.name ?? "").localizedCaseInsensitiveContains("inride")
        let connectable = (advertisementData[CBAdvertisementDataIsConnectable] as? NSNumber)?.boolValue
        upsertDiscovered(peripheral, rssi: RSSI.intValue, advertisesInRide: isInRide, services: services, connectable: connectable)
        // The remembered trainer turned up under scanning (e.g. iOS forgot its identifier mapping).
        if connectWhenRememberedSeen, peripheral.identifier == settings.rememberedTrainerID {
            connect(to: peripheral.identifier)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral.identifier == self.peripheral?.identifier else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        stats.connects += 1
        stats.connectedSince = Date()
        stats.maxWriteLength = peripheral.maximumWriteValueLength(for: .withResponse)
        pendingUpdateRateCheck = true
        characteristics.removeAll()
        state = .discovering(peripheralName ?? "inRide")
        log.log("Connected to \(peripheral.name ?? "inRide"); discovering services")
        peripheral.discoverServices(nil)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        log.log("Failed to connect: \(error?.localizedDescription ?? "unknown")", level: .error)
        if wantsConnection, peripheral.identifier == self.peripheral?.identifier {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                self?.resumePendingConnectIfNeeded()
            }
        } else {
            state = .idle
        }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                                    timestamp: CFAbsoluteTime, isReconnecting: Bool, error: Error?) {
        handleDisconnect(peripheral, error: error, systemReconnecting: isReconnecting)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        handleDisconnect(peripheral, error: error, systemReconnecting: false)
    }

    private func handleDisconnect(_ p: CBPeripheral, error: Error?, systemReconnecting: Bool) {
        guard p.identifier == peripheral?.identifier else { return }
        stats.disconnects += 1
        stats.lastDisconnect = error?.localizedDescription ?? "Clean disconnect"
        stats.connectedSince = nil
        lastPacketAt = nil
        clearLiveData()
        rebuildGATTSnapshot()
        log.log("Disconnected: \(stats.lastDisconnect ?? "")\(systemReconnecting ? " (iOS reconnecting)" : "")",
                level: wantsConnection ? .warning : .info)
        guard wantsConnection else {
            state = .idle
            return
        }
        if systemReconnecting {
            state = .reconnecting(peripheralName ?? "inRide")
        } else {
            requestConnect(p, initial: false)
        }
    }
}

// MARK: - CBPeripheralDelegate

extension TrainerManager: @preconcurrency CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { log.log("Service discovery failed: \(error.localizedDescription)", level: .error) }
        let services = peripheral.services ?? []
        log.log("Services: \(services.map { InRideGATT.name(for: $0.uuid.uuidString) ?? $0.uuid.uuidString }.joined(separator: ", "))")
        if !services.contains(where: { $0.uuid == Self.serviceUUID }) {
            log.log("inRide Power Service not found on this device", level: .error)
        }
        for s in services { peripheral.discoverCharacteristics(nil, for: s) }
        rebuildGATTSnapshot()
    }

    func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
        log.log("Peripheral changed its services; rediscovering", level: .warning)
        peripheral.discoverServices(nil)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error { log.log("Characteristic discovery failed for \(service.uuid): \(error.localizedDescription)", level: .error) }
        for c in service.characteristics ?? [] {
            characteristics[c.uuid] = c
            switch c.uuid {
            case Self.powerUUID:
                peripheral.setNotifyValue(true, for: c)
            case Self.configUUID:
                peripheral.readValue(for: c)
                if c.properties.contains(.notify) { peripheral.setNotifyValue(true, for: c) }
            case CBUUID(string: InRideGATT.batteryLevel):
                peripheral.readValue(for: c)
                if c.properties.contains(.notify) { peripheral.setNotifyValue(true, for: c) }
            default:
                if service.uuid == CBUUID(string: InRideGATT.deviceInformationService), c.properties.contains(.read) {
                    peripheral.readValue(for: c)
                }
            }
        }
        rebuildGATTSnapshot()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        let uuid = characteristic.uuid.uuidString
        if let error {
            log.log("Read of \(InRideGATT.name(for: uuid) ?? uuid) failed: \(error.localizedDescription)", level: .error)
            return
        }
        guard let data = characteristic.value else { return }
        if characteristic.uuid == Self.powerUUID {
            handlePowerPacket(data, from: uuid)
            return
        }
        let packet = DiagnosticsLog.Packet(date: Date(), direction: .rx, characteristic: uuid, bytes: data, plain: nil,
                                           summary: InRideGATT.name(for: uuid) ?? "value")
        log.record(packet)
        onPacket?(packet)
        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .controlCharacters.union(.whitespaces))
        switch uuid {
        case InRideGATT.configCharacteristic: handleConfiguration(data)
        case InRideGATT.manufacturerName: info.manufacturer = text
        case InRideGATT.modelNumber: info.model = text
        case InRideGATT.serialNumber: info.serial = text
        case InRideGATT.firmwareRevision:
            info.firmware = text
            if info.firmwareIsOutdated {
                log.log("Firmware \(text ?? "?") is older than Kinetic's last release (\(InRideGATT.latestPublishedFirmware))", level: .warning)
            }
        case InRideGATT.hardwareRevision: info.hardware = text
        case InRideGATT.softwareRevision: info.software = text
        case InRideGATT.systemID:
            info.systemID = [UInt8](data)
            log.log("System ID \(data.hexString)")
            applyPreferredUpdateRateIfNeeded()
        case InRideGATT.batteryLevel: info.battery = data.first.map(Int.init)
        default: break
        }
        rebuildGATTSnapshot()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        let name = InRideGATT.name(for: characteristic.uuid.uuidString) ?? characteristic.uuid.uuidString
        if let error {
            log.log("Subscribe to \(name) failed: \(error.localizedDescription)", level: .error)
            return
        }
        log.log("\(characteristic.isNotifying ? "Subscribed to" : "Unsubscribed from") \(name)")
        if characteristic.uuid == Self.powerUUID, characteristic.isNotifying {
            state = .streaming(peripheralName ?? "inRide")
        }
        rebuildGATTSnapshot()
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        let name = InRideGATT.name(for: characteristic.uuid.uuidString) ?? characteristic.uuid.uuidString
        if let error {
            log.log("Write to \(name) failed: \(error.localizedDescription)", level: .error)
        } else {
            log.log("Write to \(name) acknowledged")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        if error == nil { rssi = RSSI.intValue }
    }
}

extension CBManagerState {
    var label: String {
        switch self {
        case .poweredOn: return "on"
        case .poweredOff: return "off"
        case .unauthorized: return "unauthorised"
        case .unsupported: return "unsupported"
        case .resetting: return "resetting"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }
}
