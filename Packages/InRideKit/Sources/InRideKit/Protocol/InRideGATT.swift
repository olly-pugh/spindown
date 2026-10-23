import Foundation

/// GATT identifiers exposed by the Kinetic inRide (Road Machine Smart / Rock and Roll Smart).
///
/// Source: Kinetic's own SDK (`kinetic-fit/sensors-swift-kinetic`, `inRide.h`) and the
/// Java SDK (`kinetic-fit/kinetic-sdk-java`). The same values ship in GoldenCheetah.
public enum InRideGATT {
    /// Proprietary "inRide Power Service". Advertised by the sensor.
    public static let powerService = "E9410100-B434-446B-B5CC-36592FC4C724"
    /// Notify, 20 bytes, obfuscated. The main measurement.
    public static let powerCharacteristic = "E9410101-B434-446B-B5CC-36592FC4C724"
    /// Write with response, 3 to 15 bytes. Commands must start with the command key.
    public static let controlPointCharacteristic = "E9410102-B434-446B-B5CC-36592FC4C724"
    /// Read / notify, 20 bytes, plain little-endian sensor configuration.
    public static let configCharacteristic = "E9410104-B434-446B-B5CC-36592FC4C724"

    public static let deviceInformationService = "180A"
    /// 6 bytes, tied to the nRF MAC. Needed to derive the command key.
    public static let systemID = "2A23"
    public static let modelNumber = "2A24"
    public static let serialNumber = "2A25"
    public static let firmwareRevision = "2A26"
    public static let hardwareRevision = "2A27"
    public static let softwareRevision = "2A28"
    public static let manufacturerName = "2A29"

    public static let batteryService = "180F"
    public static let batteryLevel = "2A19"

    /// The newest inRide firmware Kinetic published (`kinetic-fit/firmware`, "Fix Calibration Issues").
    public static let latestPublishedFirmware = "1.2"

    /// Human-readable names for the diagnostics GATT browser.
    public static func name(for uuid: String) -> String? {
        switch uuid.uppercased() {
        case powerService: return "inRide Power Service"
        case powerCharacteristic: return "inRide Power"
        case controlPointCharacteristic: return "inRide Control Point"
        case configCharacteristic: return "inRide Configuration"
        case deviceInformationService: return "Device Information"
        case systemID: return "System ID"
        case modelNumber: return "Model Number"
        case serialNumber: return "Serial Number"
        case firmwareRevision: return "Firmware Revision"
        case hardwareRevision: return "Hardware Revision"
        case softwareRevision: return "Software Revision"
        case manufacturerName: return "Manufacturer Name"
        case batteryService: return "Battery"
        case batteryLevel: return "Battery Level"
        case "1800": return "Generic Access"
        case "1801": return "Generic Attribute"
        case "2A00": return "Device Name"
        case "2A01": return "Appearance"
        case "2A04": return "Peripheral Preferred Connection Parameters"
        case "2A05": return "Service Changed"
        case "FE59": return "Nordic Secure DFU"
        case "00001530-1212-EFDE-1523-785FEABCD123": return "Nordic Legacy DFU"
        default: return nil
        }
    }
}
