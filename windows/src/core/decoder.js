// A port of Kinetic's power, speed and cadence model (inRide.c, SDK 2.3.4), via InRideDecoder.swift.
import { ByteReader, ByteWriter } from './bytes.js';
import { deobfuscate, PACKET_LENGTH } from './obfuscation.js';

export const SensorState = {
  normal: 0x00,
  /** Calibration armed: rider must accelerate past ~34 km/h. */
  spindownIdle: 0x10,
  /** Rider must stop pedalling and coast. Pedalling restarts the process. */
  spindownReady: 0x20,
  /** Coasting; the sensor is timing the run-down from ~31 to ~18 km/h. */
  spindownActive: 0x30,
};

export function sensorStateName(s) {
  switch (s) {
    case SensorState.spindownIdle: return 'Spindown idle';
    case SensorState.spindownReady: return 'Spindown ready';
    case SensorState.spindownActive: return 'Spindown active';
    default: return 'Normal';
  }
}

export const CalibrationResult = { unknown: 0x00, success: 0x01, tooFast: 0x02, tooSlow: 0x03, middle: 0x04 };

export function calibrationResultName(r) {
  return ['Unknown', 'Success', 'Too fast', 'Too slow', 'Ambiguous'][r] ?? 'Unknown';
}

export const CommandResult = {
  none: 0x00, success: 0x01, notSupported: 0x02, invalidRequest: 0x03,
  calibrationResult: 0x0a, unknownError: 0x0f, undocumented: 0xff,
};

export function commandResultFromBits(bits) {
  return [0x00, 0x01, 0x02, 0x03, 0x0a, 0x0f].includes(bits) ? bits : CommandResult.undocumented;
}

export function commandResultName(r) {
  switch (r) {
    case 0x00: return 'None';
    case 0x01: return 'Success';
    case 0x02: return 'Not supported';
    case 0x03: return 'Invalid request';
    case 0x0a: return 'Calibration result';
    case 0x0f: return 'Unknown error';
    default: return 'Undocumented';
  }
}

export const SENSOR_HZ = 32768.0;
export const SPINDOWN_MIN = 1.5;
export const SPINDOWN_MAX = 2.0;
export const SPINDOWN_MIN_PRO = 4.7;
export const SPINDOWN_MAX_PRO = 6.5;
export const SPINDOWN_DEFAULT = (SPINDOWN_MIN + SPINDOWN_MAX) * 0.5;
/** km/h per (rev / tick): the iOS C SDK's 54 mm nominal roller (the one Kinetic's iOS app shipped). */
export const SPEED_CONSTANT = 20012.256849;
export const SPEED_CONSTANT_JAVA_SDK = 19974.826517;
/** Kinetic Fit showed this as the speed to reach before a spindown can start. */
export const CALIBRATION_READY_SPEED_KPH = 33.8;

/** Parses an already de-obfuscated packet into raw fields. */
export function rawFieldsFromPlain(p) {
  if (p.length !== PACKET_LENGTH) throw new Error(`Expected 20 bytes, got ${p.length}`);
  const r = new ByteReader(p, 1);
  return {
    rotation: (p[0] & 0xc0) >> 6,
    stateBits: p[0] & 0x30,
    commandResultBits: p[0] & 0x0f,
    interval: r.u24(),
    ticks: r.u32(),
    revs: r.u8(),
    ticksPrevious: r.u32(),
    revsPrevious: r.u8(),
    cadenceRaw: r.u16(),
    spindownTicks: r.u32(),
  };
}

/** Inverse of rawFieldsFromPlain. */
export function plainBytes(f) {
  const w = new ByteWriter();
  w.u8(((f.rotation & 0x3) << 6) | (f.stateBits & 0x30) | (f.commandResultBits & 0x0f));
  w.u24(f.interval);
  w.u32(f.ticks);
  w.u8(f.revs);
  w.u32(f.ticksPrevious);
  w.u8(f.revsPrevious);
  w.u16(f.cadenceRaw);
  w.u32(f.spindownTicks);
  return w.bytes;
}

export function ticksToSeconds(ticks) {
  return ticks / SENSOR_HZ;
}

export function speedFor(ticks, revs, constant = SPEED_CONSTANT) {
  if (!(ticks > 0) || !(revs > 0)) return 0;
  return (constant * revs) / ticks;
}

export function hasProFlywheel(spindown) {
  return spindown >= SPINDOWN_MIN_PRO && spindown <= SPINDOWN_MAX_PRO;
}

/** Kinetic's alpha(): flags coasting when the roller is decelerating faster than pedalling allows. */
export function coastDetection(raw, speed, previousSpeed, proFlywheel) {
  if (!(raw.ticks > 0) || !(raw.ticksPrevious > 0)) return [0, false];
  // IEEE division, as in C: revs of 0 yields inf/NaN and the comparisons behave the same way.
  const tpr = raw.ticks / raw.revs;
  const ptpr = raw.ticksPrevious / raw.revsPrevious;
  const dtpr = tpr - ptpr;
  if (!(dtpr > 0)) return [0, false];
  const alpha = (previousSpeed - speed) * dtpr;
  const coasting = proFlywheel ? alpha > 20 : alpha > 200;
  return [alpha, coasting];
}

/** Kinetic's Road Machine power curve with the spindown (tyre pressure / roller tension) correction. */
export function powerForSpeed(kph, spindown) {
  const mph = kph * 0.621371;
  const rawPower = 5.24482 * mph + 0.019168 * mph * mph * mph;
  let dragOffset = 0;
  if (spindown > 0 && rawPower > 0) {
    const pro = hasProFlywheel(spindown);
    const spindownMS = spindown * 1000;
    const dragOffsetSlope = pro ? -0.021 : -0.1425;
    const dragOffsetPowerSlope = pro ? 2.62 : 4.55;
    const yIntercept = pro ? 104.97 : 236.2;
    dragOffset = dragOffsetPowerSlope * spindownMS * rawPower * 0.00001 + dragOffsetSlope * spindownMS + yIntercept;
  }
  const power = rawPower + dragOffset;
  if (!Number.isFinite(power) || !(power > 0)) return 0;
  return Math.trunc(power); // truncation, as the C (int) cast
}

export function calibrationResultFor(time) {
  if (time >= SPINDOWN_MIN && time <= SPINDOWN_MAX) return CalibrationResult.success;
  if (time >= SPINDOWN_MIN_PRO && time <= SPINDOWN_MAX_PRO) return CalibrationResult.success;
  if (time < SPINDOWN_MIN) return CalibrationResult.tooFast;
  if (time > SPINDOWN_MAX_PRO) return CalibrationResult.tooSlow;
  return CalibrationResult.middle;
}

export function measurementFromRaw(raw, speedConstant = SPEED_CONSTANT) {
  const lastSpindown = ticksToSeconds(raw.spindownTicks);
  const speed = speedFor(raw.ticks, raw.revs, speedConstant);
  const previousSpeed = speedFor(raw.ticksPrevious, raw.revsPrevious, speedConstant);

  let rollerRPM = 0;
  if (raw.ticks > 0) rollerRPM = (raw.revs / ticksToSeconds(raw.ticks)) * 60;

  const cadence = raw.cadenceRaw === 0 ? 0 : 0.8652 * raw.cadenceRaw + 5.2617;

  let spindownTime = SPINDOWN_DEFAULT;
  let proFlywheel = false;
  if (lastSpindown >= SPINDOWN_MIN && lastSpindown <= SPINDOWN_MAX) {
    spindownTime = lastSpindown;
  } else if (lastSpindown >= SPINDOWN_MIN_PRO && lastSpindown <= SPINDOWN_MAX_PRO) {
    spindownTime = lastSpindown;
    proFlywheel = true;
  }

  const resistance = proFlywheel
    ? 1 - (spindownTime - SPINDOWN_MIN_PRO) / (SPINDOWN_MAX_PRO - SPINDOWN_MIN_PRO)
    : 1 - (spindownTime - SPINDOWN_MIN) / (SPINDOWN_MAX - SPINDOWN_MIN);

  const [alpha, coasting] = coastDetection(raw, speed, previousSpeed, proFlywheel);
  const power = coasting ? 0 : powerForSpeed(speed, spindownTime);

  const state = [0x00, 0x10, 0x20, 0x30].includes(raw.stateBits) ? raw.stateBits : SensorState.normal;
  return {
    raw,
    state,
    commandResult: commandResultFromBits(raw.commandResultBits),
    power,
    speedKPH: speed,
    rollerRPM,
    cadenceRPM: cadence,
    coasting,
    alpha,
    spindownTime,
    lastSpindownResultTime: lastSpindown,
    rollerResistance: resistance,
    proFlywheel,
    calibrationResult: calibrationResultFor(lastSpindown),
  };
}

export function decodePower(packet, speedConstant = SPEED_CONSTANT) {
  if (packet.length !== PACKET_LENGTH) throw new Error(`Expected 20 bytes, got ${packet.length}`);
  return measurementFromRaw(rawFieldsFromPlain(deobfuscate(packet)), speedConstant);
}

/** Configuration characteristic (E9410104). Plain little-endian, not obfuscated. */
export function parseConfiguration(data) {
  if (data.length !== 20) throw new Error(`Expected 20 bytes, got ${data.length}`);
  const r = new ByteReader(data);
  const c = {
    calibrationReady: r.u16(),
    calibrationStart: r.u16(),
    calibrationEnd: r.u16(),
    calibrationDebounce: r.u16(),
    currentSpindownTicks: r.u32(),
    /** Update interval in 1/32 s units: 0x20 = 1 Hz, 0x10 = 2 Hz, 0x08 = 4 Hz. */
    updateRateDefault: r.u16(),
    updateRateCalibration: r.u16(),
  };
  c.currentSpindownTime = ticksToSeconds(c.currentSpindownTicks);
  c.proFlywheel = hasProFlywheel(c.currentSpindownTime);
  c.updateHz = c.updateRateDefault === 0 ? 0 : 32 / c.updateRateDefault;
  c.calibrationUpdateHz = c.updateRateCalibration === 0 ? 0 : 32 / c.updateRateCalibration;
  return c;
}
