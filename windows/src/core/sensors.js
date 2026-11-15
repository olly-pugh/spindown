// Cadence smoothing, heart-rate parsing and the packet simulator.
// Ports of CadenceSmoother.swift, HeartRate.swift and InRideSimulator.swift.
import { ByteReader, ByteWriter } from './bytes.js';
import { SPEED_CONSTANT, SENSOR_HZ, SensorState, CommandResult, plainBytes } from './decoder.js';
import { obfuscate } from './obfuscation.js';
import { UpdateRate } from './commands.js';

/**
 * The rolling cadence average from Kinetic's iOS SDK: buffer of 3, newest value weighted x2, reset on
 * zero cadence or a gap of more than 2 s. Averages only the slots filled since the last reset.
 */
export class CadenceSmoother {
  constructor(bufferSize = 3, newestWeight = 2, resetGap = 2) {
    this.bufferSize = Math.max(1, Math.min(bufferSize, 10));
    this.newestWeight = Math.max(1, newestWeight);
    this.resetGap = resetGap;
    this.values = [];
  }
  reset() {
    this.values = [];
  }
  add(rpm, time) {
    if (!(rpm > 0)) {
      this.reset();
      return 0;
    }
    if (this.values.length && time - this.values[0].time > this.resetGap) this.reset();
    this.values.unshift({ time, rpm });
    if (this.values.length > this.bufferSize) this.values.length = this.bufferSize;
    let total = rpm * this.newestWeight;
    for (const e of this.values.slice(1)) total += e.rpm;
    return total / (this.newestWeight + this.values.length - 1);
  }
}

/** Parses a Heart Rate Measurement (0x2A37) notification. Throws on short packets. */
export function parseHeartRate(data) {
  if (data.length < 2) throw new Error('tooShort');
  const flags = data[0];
  const r = new ByteReader(data, 1);
  const wide = (flags & 0x01) !== 0;
  if (data.length < (wide ? 3 : 2)) throw new Error('tooShort');
  const bpm = wide ? r.u16() : r.u8();
  const sensorContact = (flags & 0x04) !== 0 ? (flags & 0x02) !== 0 : null;
  let energyExpended = null;
  if ((flags & 0x08) !== 0 && r.offset + 2 <= data.length) energyExpended = r.u16();
  const rrIntervals = [];
  if ((flags & 0x10) !== 0) {
    while (r.offset + 2 <= data.length) rrIntervals.push(r.u16() / 1024);
  }
  return { bpm, sensorContact, energyExpended, rrIntervals };
}

/** Produces genuine obfuscated inRide packets from a target speed and cadence. */
export class InRideSimulator {
  constructor() {
    this.updateRate = UpdateRate.hz1;
    this.spindownSeconds = 1.75;
    this.state = SensorState.normal;
    this.commandResult = CommandResult.none;
    this.previousTicks = 0;
    this.previousRevs = 0;
    this.rotation = 0;
  }

  static ticksForKPH(kph, revs) {
    if (!(kph > 0.5) || !(revs > 0)) return 0;
    return Math.round((SPEED_CONSTANT * revs) / kph) >>> 0;
  }

  static cadenceRaw(rpm) {
    if (!(rpm > 5.2617)) return 0;
    return Math.round((rpm - 5.2617) / 0.8652);
  }

  nextPacket(speedKPH, cadenceRPM) {
    const revs = Math.min(255, Math.max(1, Math.trunc(speedKPH / 2)));
    const ticks = InRideSimulator.ticksForKPH(speedKPH, revs);
    const fields = {
      rotation: this.rotation,
      stateBits: this.state,
      commandResultBits: this.commandResult === CommandResult.undocumented ? 0 : this.commandResult,
      interval: this.updateRate * 1024,
      ticks,
      revs: ticks === 0 ? 0 : revs,
      ticksPrevious: this.previousTicks,
      revsPrevious: this.previousRevs,
      cadenceRaw: InRideSimulator.cadenceRaw(cadenceRPM),
      spindownTicks: Math.trunc(this.spindownSeconds * SENSOR_HZ),
    };
    this.previousTicks = fields.ticks;
    this.previousRevs = fields.revs;
    this.rotation = (this.rotation + 1) % 4;
    this.commandResult = CommandResult.none;
    return obfuscate(plainBytes(fields));
  }

  static configurationBytes(updateRate = UpdateRate.hz1, spindown = 1.75) {
    const w = new ByteWriter();
    w.u16(602);
    w.u16(655);
    w.u16(950);
    w.u16(327);
    w.u32(Math.trunc(spindown * SENSOR_HZ));
    w.u16(updateRate);
    w.u16(UpdateRate.hz4);
    w.append([0, 0, 0, 0]);
    return w.bytes;
  }
}
