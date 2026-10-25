import CoreBluetooth
import Foundation
import Observation
import InRideKit

/// Connects to a standard Bluetooth heart-rate strap (Polar H9, H10, Garmin HRM-Dual, Wahoo TICKR…).
///
/// It runs its own CBCentralManager so it is independent of the trainer connection, and follows
/// the same rules: remember the strap, keep a pending connect outstanding so it reconnects as
/// soon as the strap is worn again, and let iOS restore the connection in the background.
@MainActor @Observable
final class HeartRateMonitor: NSObject {
    enum State: Equatable {
        case unavailable(String)
        case idle
        case scanning
        case waiting(String)
        case connecting(String)
        case connected(String)

        var isConnected: Bool {
            if case .connected = self { return true }
            return false
        }
    }

    struct Discovered: Identifiable, Equatable {
        var id: UUID
        var name: String
        var rssi: Int
    }

    private(set) var state: State = .idle
    private(set) var discovered: [Discovered] = []
    private(set) var bpm: Int?
    private(set) var lastAt: Date?
    private(set) var sensorContact: Bool?
    private(set) var lastRRIntervals: [Double] = []
    private(set) var battery: Int?
    private(set) var rssi: Int?
    private(set) var packets = 0
    private(set) var connects = 0
    private(set) var disconnects = 0
    private(set) var lastPacket: Data?
    private(set) var deviceName: String?
    private(set) var deviceID: UUID?
    private(set) var manufacturer: String?
    private(set) var firmware: String?

    var onHeartRate: ((Int, Date) -> Void)?

    private let settings: AppSettings
    private let log: DiagnosticsLog
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var wantsConnection = false
    private var rssiTask: Task<Void, Never>?

    private static let serviceUUID = CBUUID(string: HeartRateGATT.service)
    private static let measurementUUID = CBUUID(string: HeartRateGATT.measurement)

    init(settings: AppSettings, log: DiagnosticsLog) {
        self.settings = settings
        self.log = log
        super.init()
        var options: [String: Any] = [CBCentralManagerOptionShowPowerAlertKey: false]
        #if os(iOS)
        options[CBCentralManagerOptionRestoreIdentifierKey] = "com.spindown.app.heartrate"
        #endif
        central = CBCentralManager(delegate: self, queue: .main, options: options)
        rssiTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if let p = self?.peripheral, p.state == .connected { p.readRSSI() }
            }
        }
    }

    /// Latest heart rate if it is recent and the strap reports skin contact.
    func freshHeartRate(now: Date = Date()) -> Int? {
        guard let bpm, bpm > 0, let lastAt, now.timeIntervalSince(lastAt) < 3, sensorContact != false else { return nil }
        return bpm
    }

    /// Human-readable status for the sensors screen: what is connected and whether data is flowing.
    func statusLine(now: Date = Date()) -> String {
        switch state {
        case .connected(let name):
            if let hr = freshHeartRate(now: now) { return "\(name) · \(hr) bpm" }
            if sensorContact == false { return "\(name) · no skin contact — moisten the strap" }
            return "\(name) · connected, waiting for data"
        case .waiting(let name): return "Waiting for \(name) — put the strap on"
        case .connecting(let name): return "Connecting to \(name)…"
        case .scanning: return "Searching for heart-rate monitors…"
        case .idle: return "No heart-rate monitor"
        case .unavailable(let why): return why
        }
    }

    func startScan() {
        guard central.state == .poweredOn else { return }
        discovered.removeAll()
        central.scanForPeripherals(withServices: [Self.serviceUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        for p in central.retrieveConnectedPeripherals(withServices: [Self.serviceUUID]) {
            upsert(p, rssi: 0)
        }
        if !state.isConnected { state = .scanning }
        log.log("Scanning for heart-rate monitors")
    }

    func stopScan() {
        guard central.isScanning else { return }
        central.stopScan()
        if state == .scanning { state = .idle }
        if wantsConnection, let p = peripheral, p.state == .disconnected { requestConnect(p) }
    }

    func connect(to id: UUID) {
        guard let p = central.retrievePeripherals(withIdentifiers: [id]).first else { return }
        wantsConnection = false
        stopScan()
        if let current = peripheral, current.identifier != id { central.cancelPeripheralConnection(current) }
        settings.rememberedHeartRateID = id
        settings.rememberedHeartRateName = p.name
        wantsConnection = true
        attach(p)
        requestConnect(p)
    }

    func disconnect(forget: Bool) {
        wantsConnection = false
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        if forget {
            settings.rememberedHeartRateID = nil
            settings.rememberedHeartRateName = nil
            peripheral = nil
            deviceName = nil
            deviceID = nil
        }
        clear()
        state = .idle
        log.log(forget ? "Forgot heart-rate monitor" : "Disconnected heart-rate monitor")
    }

    func reconnectRemembered() {
        guard central.state == .poweredOn, !state.isConnected, let id = settings.rememberedHeartRateID,
              let p = central.retrievePeripherals(withIdentifiers: [id]).first else { return }
        wantsConnection = true
        attach(p)
        requestConnect(p)
    }

    private func attach(_ p: CBPeripheral) {
        peripheral = p
        p.delegate = self
        deviceName = p.name ?? settings.rememberedHeartRateName ?? "Heart-rate monitor"
        deviceID = p.identifier
    }

    private func requestConnect(_ p: CBPeripheral) {
        var options: [String: Any] = [:]
        if #available(iOS 17.0, macOS 14.0, *) { options[CBConnectPeripheralOptionEnableAutoReconnect] = true }
        central.connect(p, options: options)
        state = .waiting(deviceName ?? "heart-rate monitor")
    }

    private func clear() {
        bpm = nil
        lastAt = nil
        sensorContact = nil
        lastRRIntervals = []
        rssi = nil
    }

    private func upsert(_ p: CBPeripheral, rssi: Int) {
        let name = p.name ?? "Heart-rate monitor"
        if let i = discovered.firstIndex(where: { $0.id == p.identifier }) {
            if rssi != 0 && rssi != 127 { discovered[i].rssi = rssi }
            discovered[i].name = name
        } else {
            discovered.append(Discovered(id: p.identifier, name: name, rssi: rssi))
            log.log("Found heart-rate monitor \(name)")
        }
        discovered.sort { $0.rssi > $1.rssi }
    }
}

extension HeartRateMonitor: @preconcurrency CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if case .unavailable = state { state = .idle }
            if let p = peripheral, p.state == .connected {
                p.discoverServices(nil)
            } else if wantsConnection, let p = peripheral {
                requestConnect(p)
            } else {
                reconnectRemembered()
            }
        case .poweredOff: state = .unavailable("Bluetooth is off"); clear()
        case .unauthorized: state = .unavailable("Bluetooth permission denied")
        default: state = .unavailable("Bluetooth unavailable")
        }
    }

    #if os(iOS)
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        if let p = restored.first {
            wantsConnection = true
            attach(p)
            log.log("iOS restored heart-rate monitor connection")
        }
    }
    #endif

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        upsert(peripheral, rssi: RSSI.intValue)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral.identifier == self.peripheral?.identifier else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        connects += 1
        state = .connecting(deviceName ?? "heart-rate monitor")
        log.log("Heart-rate monitor connected: \(peripheral.name ?? "?")")
        peripheral.discoverServices([Self.serviceUUID, CBUUID(string: InRideGATT.batteryService), CBUUID(string: InRideGATT.deviceInformationService)])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        log.log("Heart-rate monitor failed to connect: \(error?.localizedDescription ?? "unknown")", level: .warning)
        if wantsConnection { requestConnect(peripheral) }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                        timestamp: CFAbsoluteTime, isReconnecting: Bool, error: Error?) {
        guard peripheral.identifier == self.peripheral?.identifier else { return }
        disconnects += 1
        clear()
        log.log("Heart-rate monitor disconnected: \(error?.localizedDescription ?? "clean")", level: wantsConnection ? .warning : .info)
        guard wantsConnection else { state = .idle; return }
        if isReconnecting {
            state = .waiting(deviceName ?? "heart-rate monitor")
        } else {
            requestConnect(peripheral)
        }
    }
}

extension HeartRateMonitor: @preconcurrency CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        for s in peripheral.services ?? [] { peripheral.discoverCharacteristics(nil, for: s) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for c in service.characteristics ?? [] {
            switch c.uuid {
            case Self.measurementUUID:
                peripheral.setNotifyValue(true, for: c)
            case CBUUID(string: InRideGATT.batteryLevel):
                peripheral.readValue(for: c)
                if c.properties.contains(.notify) { peripheral.setNotifyValue(true, for: c) }
            case CBUUID(string: InRideGATT.manufacturerName), CBUUID(string: InRideGATT.firmwareRevision):
                peripheral.readValue(for: c)
            default:
                break
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if let error {
            log.log("Heart-rate subscribe failed: \(error.localizedDescription)", level: .error)
            return
        }
        if characteristic.uuid == Self.measurementUUID, characteristic.isNotifying {
            state = .connected(deviceName ?? "Heart-rate monitor")
            log.log("Receiving heart rate from \(deviceName ?? "strap")")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, let data = characteristic.value else { return }
        switch characteristic.uuid {
        case Self.measurementUUID:
            let now = Date()
            lastPacket = data
            packets += 1
            let packet = DiagnosticsLog.Packet(date: now, direction: .rx, characteristic: HeartRateGATT.measurement,
                                               bytes: data, plain: nil, summary: "heart rate")
            log.record(packet)
            guard let m = try? HeartRateMeasurement([UInt8](data)) else { return }
            bpm = m.bpm
            lastAt = now
            sensorContact = m.sensorContact
            if !m.rrIntervals.isEmpty { lastRRIntervals = m.rrIntervals }
            if let hr = freshHeartRate(now: now) { onHeartRate?(hr, now) }
        case CBUUID(string: InRideGATT.batteryLevel):
            battery = data.first.map(Int.init)
        case CBUUID(string: InRideGATT.manufacturerName):
            manufacturer = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .controlCharacters)
        case CBUUID(string: InRideGATT.firmwareRevision):
            firmware = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .controlCharacters)
        default:
            break
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        if error == nil { rssi = RSSI.intValue }
    }
}
