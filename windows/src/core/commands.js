// Control point commands (write with response to E9410102). Port of InRideCommands.swift.
// Every command starts with a 2-byte key derived from the 6-byte System ID; the result arrives in
// the low nibble of byte 0 of a later power packet.
import { ByteWriter } from './bytes.js';
import { SPEED_CONSTANT, SENSOR_HZ } from './decoder.js';

/** Normal-state notification rate (raw value = interval in 1/32 s). Kinetic: do not exceed 8 Hz. */
export const UpdateRate = { hz1: 0x20, hz2: 0x10, hz4: 0x08 };
export const UPDATE_RATES = [UpdateRate.hz1, UpdateRate.hz2, UpdateRate.hz4];
export const rateHz = (raw) => 32 / raw;
export const rateLabel = (raw) => `${rateHz(raw)} Hz`;

/** Kinetic's spindown thresholds, ticks per roller revolution: arm above ~33.2 km/h, time ~30.5 to ~21.1 km/h. */
export const KINETIC_READY_TICKS = 602;
export const KINETIC_START_TICKS = 655;
export const KINETIC_END_TICKS = 950;
export const KINETIC_DEBOUNCE_TICKS = 327;

export class CommandError extends Error {}

export const Command = {
  configure: (updateRate) => ({ kind: 'configure', updateRate }),
  configureCalibration: (updateRate, readyTicks) => ({ kind: 'configureCalibration', updateRate, readyTicks }),
  setName: (name) => ({ kind: 'setName', name }),
  startCalibration: () => ({ kind: 'startCalibration' }),
  stopCalibration: () => ({ kind: 'stopCalibration' }),
  setSpindownTime: (seconds) => ({ kind: 'setSpindownTime', seconds }),
};

const OPCODES = { configure: 1, configureCalibration: 1, setName: 2, startCalibration: 3, stopCalibration: 4, setSpindownTime: 5 };

export function describeCommand(c) {
  switch (c.kind) {
    case 'configure': return `configure(updateRate: ${rateLabel(c.updateRate)})`;
    case 'configureCalibration': return `configureCalibration(updateRate: ${rateLabel(c.updateRate)}, readyTicks: ${c.readyTicks})`;
    case 'setName': return `setName("${c.name}")`;
    case 'setSpindownTime': return `setSpindownTime(${c.seconds} s)`;
    default: return c.kind;
  }
}

/** Ticks per revolution for a roller speed, the inverse of the decoder's speed. */
export function ticksForKPH(kph) {
  return Math.min(65535, Math.max(0, Math.round(SPEED_CONSTANT / kph)));
}

/** systemId[systemId[3] % 6] | systemId[systemId[5] % 6] << 8, from Kinetic's command_key. */
export function commandKey(systemID) {
  if (!systemID || systemID.length !== 6) throw new CommandError('System ID must be 6 bytes');
  return [systemID[systemID[3] % 6], systemID[systemID[5] % 6]];
}

function writeConfiguration(w, rate, readyTicks) {
  w.u16(readyTicks);
  w.u16(KINETIC_START_TICKS);
  w.u16(KINETIC_END_TICKS);
  w.u16(KINETIC_DEBOUNCE_TICKS);
  w.u16(rate);
  w.u16(UpdateRate.hz4); // update rate during calibration
}

export function commandBytes(command, systemID) {
  const w = new ByteWriter();
  w.append(commandKey(systemID));
  w.u8(OPCODES[command.kind]);
  switch (command.kind) {
    case 'configure':
      writeConfiguration(w, command.updateRate, KINETIC_READY_TICKS);
      break;
    case 'configureCalibration':
      if (!(command.readyTicks >= 400 && command.readyTicks + 15 <= KINETIC_START_TICKS)) {
        throw new CommandError('Spindown time out of range');
      }
      writeConfiguration(w, command.updateRate, command.readyTicks);
      break;
    case 'setName': {
      const n = command.name;
      if (n.length < 3 || n.length > 8 || !/^[\x00-\x7f]*$/.test(n)) throw new CommandError('Name must be 3 to 8 ASCII characters');
      for (const ch of n) w.u8(ch.charCodeAt(0));
      break;
    }
    case 'startCalibration':
    case 'stopCalibration':
      break;
    case 'setSpindownTime':
      if (!(command.seconds > 0 && command.seconds < 60)) throw new CommandError('Spindown time out of range');
      w.u32(Math.trunc(command.seconds * SENSOR_HZ));
      break;
    default:
      throw new CommandError(`Unknown command ${command.kind}`);
  }
  return w.bytes;
}
