// Port of ProtocolTests.swift, HeartRateTests (parsing) and SpindownCoachTests.swift.
import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from './kinetic-vectors.js';
import { parseHex, hex } from '../src/core/bytes.js';
import { deobfuscate, obfuscate, rotationOf, INDICES } from '../src/core/obfuscation.js';
import {
  decodePower, rawFieldsFromPlain, plainBytes, powerForSpeed, calibrationResultFor, CalibrationResult,
  parseConfiguration, SensorState, speedFor,
} from '../src/core/decoder.js';
import { commandKey, commandBytes, Command, UpdateRate, ticksForKPH, KINETIC_START_TICKS, CommandError } from '../src/core/commands.js';
import { CadenceSmoother, parseHeartRate, InRideSimulator } from '../src/core/sensors.js';
import { SpindownCoach, CoachAction } from '../src/core/coach.js';

const close = (a, s) => {
  const b = Number(s);
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-8);
};

test("matches Kinetic's original C decoder on reference vectors", () => {
  assert.ok(vectors.length >= 200);
  for (const line of vectors) {
    const c = line.split(',');
    const m = decodePower(parseHex(c[0]));
    assert.equal(m.raw.stateBits, Number(c[1]), c[0]);
    assert.equal(m.raw.commandResultBits, Number(c[2]), c[0]);
    assert.equal(m.power, Number(c[3]), `power ${c[0]}`);
    assert.ok(close(m.speedKPH, c[4]), `speed ${c[0]}`);
    assert.ok(close(m.rollerRPM, c[5]), `roller ${c[0]}`);
    assert.ok(close(m.cadenceRPM, c[6]), `cadence ${c[0]}`);
    assert.equal(m.coasting ? '1' : '0', c[7], `coasting ${c[0]}`);
    assert.ok(close(m.spindownTime, c[8]));
    assert.ok(close(m.lastSpindownResultTime, c[9]));
    assert.ok(close(m.rollerResistance, c[10]));
    assert.equal(m.proFlywheel ? '1' : '0', c[11]);
    assert.equal(m.calibrationResult, Number(c[12]));
  }
});

test('obfuscation round-trips for every rotation', () => {
  for (let rotation = 0; rotation < 4; rotation++) {
    for (let n = 0; n < 200; n++) {
      const plain = Array.from({ length: 20 }, () => Math.floor(Math.random() * 256));
      plain[0] = (plain[0] & 0x3f) | (rotation << 6);
      const packet = obfuscate(plain);
      assert.equal(rotationOf(packet), rotation);
      assert.deepEqual(deobfuscate(packet), plain);
    }
  }
});

test('each permutation table is a permutation of bytes 1...19', () => {
  for (const t of INDICES) assert.deepEqual([...t].sort((a, b) => a - b), Array.from({ length: 19 }, (_, i) => i + 1));
});

test('raw fields serialise back to the same plain bytes', () => {
  const f = { rotation: 2, stateBits: 0x20, commandResultBits: 0x0a, interval: 0x123456, ticks: 0xdeadbeef, revs: 17,
    ticksPrevious: 12345, revsPrevious: 16, cadenceRaw: 92, spindownTicks: 57344 };
  assert.deepEqual(rawFieldsFromPlain(plainBytes(f)), f);
});

test('speed and power from a simulated 30 km/h packet', () => {
  const sim = new InRideSimulator();
  sim.nextPacket(30, 90);
  const m = decodePower(sim.nextPacket(30, 90));
  assert.ok(Math.abs(m.speedKPH - 30) < 0.05);
  assert.ok(Math.abs(m.cadenceRPM - 90) < 1);
  assert.equal(m.state, SensorState.normal);
  assert.equal(m.coasting, false);
  assert.equal(m.power, powerForSpeed(m.speedKPH, 1.75));
  assert.ok(m.power >= 150 && m.power <= 260);
});

test('rejects packets of the wrong length; zero ticks means stopped', () => {
  assert.throws(() => decodePower(new Array(19).fill(0)), /Expected 20 bytes, got 19/);
  const f = { rotation: 0, stateBits: 0, commandResultBits: 0, interval: 0, ticks: 0, revs: 0, ticksPrevious: 0, revsPrevious: 0, cadenceRaw: 0, spindownTicks: 0 };
  const m = decodePower(obfuscate(plainBytes(f)));
  assert.ok(m.speedKPH === 0 && m.power === 0 && m.cadenceRPM === 0);
});

test('calibration result windows', () => {
  assert.equal(calibrationResultFor(1.4), CalibrationResult.tooFast);
  assert.equal(calibrationResultFor(1.75), CalibrationResult.success);
  assert.equal(calibrationResultFor(3.0), CalibrationResult.middle);
  assert.equal(calibrationResultFor(5.0), CalibrationResult.success);
  assert.equal(calibrationResultFor(7.0), CalibrationResult.tooSlow);
});

test('configuration characteristic', () => {
  const c = parseConfiguration(InRideSimulator.configurationBytes(UpdateRate.hz2, 5.0));
  assert.ok(c.calibrationReady === 602 && c.calibrationStart === 655 && c.calibrationEnd === 950 && c.calibrationDebounce === 327);
  assert.ok(Math.abs(c.currentSpindownTime - 5.0) < 0.001);
  assert.equal(c.proFlywheel, true);
  assert.equal(c.updateHz, 2);
  assert.equal(c.calibrationUpdateHz, 4);
});

test("command key and command layouts match Kinetic's SDK", () => {
  const sys = [0x10, 0x21, 0x32, 0x43, 0x54, 0x65];
  assert.deepEqual(commandKey(sys), [0x21, 0x65]);
  assert.deepEqual(commandBytes(Command.startCalibration(), sys), [0x21, 0x65, 0x03]);
  assert.deepEqual(commandBytes(Command.stopCalibration(), sys), [0x21, 0x65, 0x04]);
  assert.deepEqual(commandBytes(Command.configure(UpdateRate.hz1), sys), [0x21, 0x65, 0x01, 0x5a, 0x02, 0x8f, 0x02, 0xb6, 0x03, 0x47, 0x01, 0x20, 0x00, 0x08, 0x00]);
  assert.deepEqual(commandBytes(Command.setSpindownTime(2), sys), [0x21, 0x65, 0x05, 0x00, 0x00, 0x01, 0x00]);
  assert.deepEqual(commandBytes(Command.setName('Bike'), sys), [0x21, 0x65, 0x02, 66, 105, 107, 101]);
  assert.throws(() => commandBytes(Command.setName('ab'), sys), CommandError);
  assert.throws(() => commandBytes(Command.startCalibration(), [1, 2]), CommandError);
});

test('cadence smoothing weights the newest value and resets on gaps', () => {
  const s = new CadenceSmoother();
  assert.equal(s.add(90, 0), 90);
  assert.ok(Math.abs(s.add(96, 1) - (96 * 2 + 90) / 3) < 1e-9);
  assert.ok(Math.abs(s.add(93, 2) - (93 * 2 + 96 + 90) / 4) < 1e-9);
  assert.ok(Math.abs(s.add(90, 3) - (90 * 2 + 93 + 96) / 4) < 1e-9);
  assert.equal(s.add(80, 10), 80);
  assert.equal(s.add(0, 11), 0);
});

test('hex parsing', () => {
  assert.deepEqual(parseHex('0a 1B:ff'), [0x0a, 0x1b, 0xff]);
  assert.deepEqual(parseHex('0x01,0x02'), [1, 2]);
  assert.equal(parseHex('abc'), null);
  assert.equal(parseHex('zz'), null);
  assert.equal(hex([1, 255]), '01 ff');
});

test('heart rate parsing (8-bit, 16-bit with energy and RR, edge cases)', () => {
  const a = parseHeartRate([0x06, 128]);
  assert.equal(a.bpm, 128);
  assert.equal(a.sensorContact, true);
  assert.equal(a.energyExpended, null);
  assert.deepEqual(a.rrIntervals, []);
  const b = parseHeartRate([0x1d, 0x2c, 0x01, 0x10, 0x00, 0x00, 0x04, 0x00, 0x02]);
  assert.equal(b.bpm, 300);
  assert.equal(b.sensorContact, false);
  assert.equal(b.energyExpended, 16);
  assert.deepEqual(b.rrIntervals, [1.0, 0.5]);
  assert.equal(parseHeartRate([0x00, 70]).sensorContact, null);
  assert.throws(() => parseHeartRate([0x01, 70]));
  assert.throws(() => parseHeartRate([0x00]));
});

// ---- Spindown coach -------------------------------------------------------------------------------

function feed(coach, speeds, t0, state = SensorState.normal) {
  const actions = [];
  speeds.forEach((v, i) => {
    const a = coach.ingest(v, state, t0 + i * 0.25);
    if (a) actions.push(a);
  });
  return actions;
}
const coast = (start, seconds) => {
  const out = [];
  for (let s = 0.25; s <= seconds + 1e-9; s += 0.25) out.push(start - 5.4 * s);
  return out;
};
const rep = (v, n) => new Array(n).fill(v);

test('coach: pedalling wobble at speed arms once and never cancels', () => {
  const coach = new SpindownCoach();
  const speeds = Array.from({ length: 480 }, (_, i) => 33.2 + Math.sin(i * 1.7) * 0.5 + (Math.random() * 0.6 - 0.3));
  let actions = feed(coach, speeds.slice(0, 8), 0);
  actions = actions.concat(feed(coach, speeds.slice(8), 2, SensorState.spindownReady));
  assert.deepEqual(actions, [CoachAction.sendStart]);
  assert.equal(coach.phase.kind, 'stopPedalling');
});

test('coach: arms only after holding the target speed', () => {
  const coach = new SpindownCoach();
  assert.deepEqual(feed(coach, [29, 30.5, 31.5, 32.0, 32.4], 0), []);
  assert.deepEqual(feed(coach, [32.6, 32.8, 32.7, 32.9], 1.25), []);
  assert.deepEqual(feed(coach, [32.8], 2.25), [CoachAction.sendStart]);
});

test('coach: the arming speed sits between the timing start and the target', () => {
  const coach = new SpindownCoach();
  const ready = ticksForKPH(coach.armingSpeed);
  assert.ok(ready < KINETIC_START_TICKS);
  assert.ok(speedFor(KINETIC_START_TICKS, 1) < coach.guardSpeed);
  assert.ok(coach.armingSpeed < coach.targetSpeed);
  const sys = [1, 2, 3, 4, 5, 6];
  const bytes = commandBytes(Command.configureCalibration(UpdateRate.hz4, ready), sys);
  assert.equal(bytes.length, 15);
  assert.equal(bytes[3] | (bytes[4] << 8), ready);
  assert.deepEqual(bytes.slice(5, 9), [0x8f, 0x02, 0xb6, 0x03]);
  assert.throws(() => commandBytes(Command.configureCalibration(UpdateRate.hz4, 650), sys), CommandError);
});

test('coach: slowing down while still pedalling cancels', () => {
  const coach = new SpindownCoach();
  feed(coach, rep(33, 6), 0);
  const sag = [];
  for (let v = 32.8; v >= 30.6 - 1e-9; v -= 0.2) sag.push(v);
  assert.deepEqual(feed(coach, sag, 1.5, SensorState.spindownReady), [CoachAction.sendStop]);
  assert.equal(coach.phase.kind, 'accelerate');
  assert.ok(coach.hint);
});

test('coach: a real coast passes the guard and completes', () => {
  const coach = new SpindownCoach();
  assert.deepEqual(feed(coach, rep(33, 6), 0), [CoachAction.sendStart]);
  assert.deepEqual(feed(coach, coast(33, 0.5), 1.5, SensorState.spindownReady), []);
  feed(coach, [29.7, 28.3, 27.0, 25.6, 24.3, 22.9, 21.6], 2.0, SensorState.spindownActive);
  assert.equal(coach.phase.kind, 'measuring');
  feed(coach, [20], 3.75, SensorState.normal);
  assert.equal(coach.phase.kind, 'finished');
});

test('coach: a slow Pro Flywheel coast is accepted', () => {
  const coach = new SpindownCoach();
  feed(coach, rep(33, 6), 0);
  const decay = [];
  for (let s = 0.25; s <= 12 + 1e-9; s += 0.25) decay.push(33 - 1.8 * s);
  const states = decay.map((v) => (v > 30.5 ? SensorState.spindownReady : SensorState.spindownActive));
  states[states.length - 1] = SensorState.normal;
  const actions = [];
  decay.forEach((v, i) => {
    const a = coach.ingest(v, states[i], 1.5 + (i + 1) * 0.25);
    if (a) actions.push(a);
  });
  assert.deepEqual(actions, []);
  assert.equal(coach.phase.kind, 'finished');
});

test('coach: pedalling or a slow fade during the timed run-down fails', () => {
  let coach = new SpindownCoach();
  feed(coach, rep(33, 6), 0);
  feed(coach, coast(33, 0.5), 1.5, SensorState.spindownReady);
  feed(coach, [30.2], 2.0, SensorState.spindownActive);
  assert.deepEqual(feed(coach, [30.6], 2.25, SensorState.spindownActive), [CoachAction.sendStop]);
  assert.equal(coach.phase.kind, 'failed');

  coach = new SpindownCoach();
  feed(coach, rep(33, 6), 0);
  feed(coach, coast(33, 0.5), 1.5, SensorState.spindownReady);
  assert.deepEqual(feed(coach, [30.4, 30.25, 30.1, 29.95, 29.8, 29.65], 2.0, SensorState.spindownActive), [CoachAction.sendStop]);
});

test('coach: a lost start command times out; sensor restart fails cleanly', () => {
  let coach = new SpindownCoach();
  assert.deepEqual(feed(coach, rep(33, 6), 0), [CoachAction.sendStart]);
  assert.deepEqual(feed(coach, rep(33, 64), 1.5, SensorState.normal), [CoachAction.sendStop]);

  coach = new SpindownCoach();
  feed(coach, rep(33, 6), 0);
  feed(coach, coast(33, 0.5), 1.5, SensorState.spindownReady);
  feed(coach, [30], 2.0, SensorState.spindownActive);
  assert.deepEqual(feed(coach, [29], 2.25, SensorState.spindownIdle), [CoachAction.sendStop]);
});

test('coach: deceleration estimate', () => {
  const coastSamples = [0, 1, 2, 3].map((i) => ({ t: i * 0.25, speed: 37 - 1.35 * i }));
  assert.ok(Math.abs(SpindownCoach.deceleration(coastSamples) - 5.4) < 0.01);
  assert.equal(SpindownCoach.deceleration([0, 1, 2, 3].map((i) => ({ t: i * 0.25, speed: 37 }))), 0);
  assert.equal(SpindownCoach.deceleration([{ t: 0, speed: 30 }]), null);
});
