import CoreBluetooth
import Foundation
import Observation
import InRideKit

/// Makes the iPhone appear as a standard Bluetooth power meter (Cycling Power Service) and,
/// optionally, a heart-rate strap, carrying the trainer's power, cadence and speed.
///
/// Garmin only estimates cycling VO2 max for rides recorded on the watch or Edge with a paired
/// power meter and heart rate. The watch cannot talk to the inRide's proprietary protocol, so
/// Spindown translates it: pair the watch with "Spindown" as a power sensor and record an
/// indoor ride on the watch.
@MainActor @Observable
final class SensorBroadcaster: NSObject {
    enum State: Equatable {
        case off
        case unavailable(String)
        case starting
        case advertising
        /// A watch has subscribed to power data.
        case streaming
    }

    static let advertisedName = "Spindown"

    private(set) var state: State = .off
    private(set) var powerSubscribers = 0
    private(set) var heartRateSubscribers = 0
    private(set) var packetsSent = 0
    private(set) var lastSentPower: Int?
    private(set) var lastSent: Data?

    private let settings: AppSettings
    private let log: DiagnosticsLog
    private var manager: CBPeripheralManager?
    private var powerCharacteristic: CBMutableCharacteristic?
    private var heartRateCharacteristic: CBMutableCharacteristic?
    private var servicesAdded = 0
    private var emitter = CyclingPowerEmitter()
    private let clockStart = Date()

    init(settings: AppSettings, log: DiagnosticsLog) {
        self.settings = settings
        self.log = log
        super.init()
        if settings.broadcastToWatch { start() }
    }

    func setEnabled(_ on: Bool) {
        settings.broadcastToWatch = on
        on ? start() : stop()
    }

    /// Restarts so a change to the heart-rate relay setting takes effect.
    func restart() {
        guard settings.broadcastToWatch else { return }
        stop()
        start()
    }

    func start() {
        guard manager == nil else { return }
        state = .starting
        servicesAdded = 0
        manager = CBPeripheralManager(delegate: self, queue: .main, options: [CBPeripheralManagerOptionShowPowerAlertKey: true])
        log.log("Watch broadcast starting")
    }

    func stop() {
        manager?.stopAdvertising()
        manager?.removeAllServices()
        manager?.delegate = nil
        manager = nil
        powerCharacteristic = nil
        heartRateCharacteristic = nil
        powerSubscribers = 0
        heartRateSubscribers = 0
        state = .off
        log.log("Watch broadcast stopped")
    }

    /// Sends the current values to any subscribed watch. Call about once a second and on each
    /// trainer packet. Stale trainer data is sent as zero so the watch does not freeze a value.
    func update(reading: TrainerReading?, heartRate: Int?) {
        guard let manager, state == .advertising || state == .streaming else { return }
        let t = Date().timeIntervalSince(clockStart)
        if let c = powerCharacteristic, powerSubscribers > 0 {
            let power = reading?.power ?? 0
            let bytes = emitter.measurement(power: power, cadenceRPM: reading?.cadenceRPM ?? 0,
                                            speedKPH: reading?.speedKPH ?? 0, at: t)
            if manager.updateValue(Data(bytes), for: c, onSubscribedCentrals: nil) {
                packetsSent += 1
                lastSentPower = power
                lastSent = Data(bytes)
            }
        }
        if let c = heartRateCharacteristic, heartRateSubscribers > 0, let heartRate {
            _ = manager.updateValue(Data(HeartRateMeasurement.encode(bpm: heartRate)), for: c, onSubscribedCentrals: nil)
        }
    }

    private func addServices(_ manager: CBPeripheralManager) {
        let measurement = CBMutableCharacteristic(type: CBUUID(string: CyclingPowerGATT.measurement),
                                                  properties: [.notify], value: nil, permissions: [])
        let feature = CBMutableCharacteristic(type: CBUUID(string: CyclingPowerGATT.feature), properties: [.read],
                                              value: Data(CyclingPowerGATT.featureValue), permissions: [.readable])
        let location = CBMutableCharacteristic(type: CBUUID(string: CyclingPowerGATT.sensorLocation), properties: [.read],
                                               value: Data(CyclingPowerGATT.sensorLocationValue), permissions: [.readable])
        let power = CBMutableService(type: CBUUID(string: CyclingPowerGATT.service), primary: true)
        power.characteristics = [measurement, feature, location]
        powerCharacteristic = measurement
        manager.add(power)

        if settings.relayHeartRate {
            let hr = CBMutableCharacteristic(type: CBUUID(string: HeartRateGATT.measurement), properties: [.notify],
                                             value: nil, permissions: [])
            let body = CBMutableCharacteristic(type: CBUUID(string: HeartRateGATT.bodySensorLocation), properties: [.read],
                                               value: Data([1]), permissions: [.readable]) // chest
            let service = CBMutableService(type: CBUUID(string: HeartRateGATT.service), primary: true)
            service.characteristics = [hr, body]
            heartRateCharacteristic = hr
            manager.add(service)
        }
    }

    private var expectedServices: Int { settings.relayHeartRate ? 2 : 1 }

    private func startAdvertising(_ manager: CBPeripheralManager) {
        var uuids = [CBUUID(string: CyclingPowerGATT.service)]
        if settings.relayHeartRate { uuids.append(CBUUID(string: HeartRateGATT.service)) }
        manager.startAdvertising([CBAdvertisementDataLocalNameKey: Self.advertisedName,
                                  CBAdvertisementDataServiceUUIDsKey: uuids])
    }
}

extension SensorBroadcaster: @preconcurrency CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            if servicesAdded == 0 { addServices(peripheral) }
        case .poweredOff: state = .unavailable("Bluetooth is off")
        case .unauthorized: state = .unavailable("Bluetooth permission denied")
        case .unsupported: state = .unavailable("This iPhone cannot act as a Bluetooth sensor")
        default: break
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error {
            state = .unavailable("Could not create sensor: \(error.localizedDescription)")
            log.log("Watch broadcast: adding service failed: \(error.localizedDescription)", level: .error)
            return
        }
        servicesAdded += 1
        if servicesAdded == expectedServices { startAdvertising(peripheral) }
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error {
            state = .unavailable("Could not advertise: \(error.localizedDescription)")
            log.log("Watch broadcast: advertising failed: \(error.localizedDescription)", level: .error)
        } else {
            state = powerSubscribers > 0 ? .streaming : .advertising
            log.log("Watch broadcast advertising as \"\(Self.advertisedName)\"")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        if characteristic.uuid == CBUUID(string: CyclingPowerGATT.measurement) {
            powerSubscribers += 1
            state = .streaming
            log.log("A watch subscribed to power")
        } else if characteristic.uuid == CBUUID(string: HeartRateGATT.measurement) {
            heartRateSubscribers += 1
            log.log("A watch subscribed to heart rate")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        if characteristic.uuid == CBUUID(string: CyclingPowerGATT.measurement) {
            powerSubscribers = max(0, powerSubscribers - 1)
            if powerSubscribers == 0, state == .streaming { state = .advertising }
            log.log("A watch unsubscribed from power")
        } else if characteristic.uuid == CBUUID(string: HeartRateGATT.measurement) {
            heartRateSubscribers = max(0, heartRateSubscribers - 1)
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        // Queue had filled; the next one-second update will resend current values.
    }
}
