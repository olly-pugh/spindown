// GATT identifiers exposed by the Kinetic inRide. Port of InRideGATT.swift and HeartRate.swift (ids).
// Source: Kinetic's own SDK (sensors-swift-kinetic, inRide.h) and the Java SDK.

export const InRideGATT = {
  /** Proprietary "inRide Power Service". Advertised by the sensor. */
  powerService: 'E9410100-B434-446B-B5CC-36592FC4C724',
  /** Notify, 20 bytes, obfuscated. The main measurement. */
  powerCharacteristic: 'E9410101-B434-446B-B5CC-36592FC4C724',
  /** Write with response, 3 to 15 bytes. Commands must start with the command key. */
  controlPointCharacteristic: 'E9410102-B434-446B-B5CC-36592FC4C724',
  /** Read / notify, 20 bytes, plain little-endian sensor configuration. */
  configCharacteristic: 'E9410104-B434-446B-B5CC-36592FC4C724',

  deviceInformationService: '180A',
  /** 6 bytes, tied to the nRF MAC. Needed to derive the command key. */
  systemID: '2A23',
  modelNumber: '2A24',
  serialNumber: '2A25',
  firmwareRevision: '2A26',
  hardwareRevision: '2A27',
  softwareRevision: '2A28',
  manufacturerName: '2A29',

  batteryService: '180F',
  batteryLevel: '2A19',

  /** The newest inRide firmware Kinetic published (kinetic-fit/firmware, "Fix Calibration Issues"). */
  latestPublishedFirmware: '1.2',
};

export const HeartRateGATT = {
  service: '180D',
  measurement: '2A37',
  bodySensorLocation: '2A38',
};

const NAMES = {
  [InRideGATT.powerService]: 'inRide Power Service',
  [InRideGATT.powerCharacteristic]: 'inRide Power',
  [InRideGATT.controlPointCharacteristic]: 'inRide Control Point',
  [InRideGATT.configCharacteristic]: 'inRide Configuration',
  '180A': 'Device Information',
  '2A23': 'System ID',
  '2A24': 'Model Number',
  '2A25': 'Serial Number',
  '2A26': 'Firmware Revision',
  '2A27': 'Hardware Revision',
  '2A28': 'Software Revision',
  '2A29': 'Manufacturer Name',
  '180F': 'Battery',
  '2A19': 'Battery Level',
  '1800': 'Generic Access',
  '1801': 'Generic Attribute',
  '2A00': 'Device Name',
  '2A01': 'Appearance',
  '2A04': 'Peripheral Preferred Connection Parameters',
  '2A05': 'Service Changed',
  FE59: 'Nordic Secure DFU',
  '00001530-1212-EFDE-1523-785FEABCD123': 'Nordic Legacy DFU',
  '180D': 'Heart Rate',
  '2A37': 'Heart Rate Measurement',
  '2A38': 'Body Sensor Location',
};

/** Human-readable names for the diagnostics GATT browser. */
export function gattName(uuid) {
  return NAMES[String(uuid).toUpperCase()] ?? null;
}

const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/** Web Bluetooth reports full lowercase UUIDs; use the short uppercase form for SIG ids, as CoreBluetooth does. */
export function shortUUID(uuid) {
  const u = String(uuid).toLowerCase();
  if (u.length === 36 && u.endsWith(BASE_SUFFIX) && u.startsWith('0000')) return u.slice(4, 8).toUpperCase();
  return u.toUpperCase();
}

/** The form Web Bluetooth accepts: 16-bit SIG ids as numbers, others as lowercase strings. */
export function webUUID(uuid) {
  const u = String(uuid);
  if (/^[0-9a-fA-F]{4}$/.test(u)) return parseInt(u, 16);
  return u.toLowerCase();
}
