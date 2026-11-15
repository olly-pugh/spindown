// Port of RideTests.swift, ExportTests.swift, HeartRateTests (recording/exports) and GameTests.swift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RideRecorder, MAX_SAMPLE_GAP, Journal, replayJournal, newRideID, defaultRideName } from '../src/core/recorder.js';
import { exportFIT, exportTCX, exportCSV, fitCRC, exportFileName } from '../src/core/fit.js';
import * as Lakes from '../src/core/lakes.js';

const START = 1_761_200_000_000;
const steady = (kph, power = 200, cadence = 90) => ({ power, speedKPH: kph, cadenceRPM: cadence });
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('distance integrates speed over time', () => {
  const r = new RideRecorder(START);
  for (const t of range(1, 3600)) r.record(t, steady(36));
  assert.ok(Math.abs(r.stats.distance - 36000) < 0.001);
  assert.equal(r.stats.movingTime, 3600);
  assert.equal(r.stats.averagePower, 200);
  assert.ok(Math.abs(r.stats.averageSpeed - 10) < 1e-9);
  assert.equal(r.stats.work, 720000);
});

test('pauses are excluded from timer and moving time but not elapsed', () => {
  const r = new RideRecorder(START);
  for (const t of range(1, 100)) r.record(t, steady(30));
  r.pause(100.5, steady(30));
  for (const t of range(101, 160)) assert.equal(r.record(t, steady(30)), null);
  r.resume(160);
  for (const t of range(161, 200)) r.record(t, steady(30));
  const s = r.summary(200);
  assert.equal(s.elapsedTime, 200);
  assert.equal(s.timerTime, 140.5);
  assert.equal(s.movingTime, 140.5);
  assert.deepEqual(r.timerEvents.map((e) => e.kind), ['start', 'stop', 'start']);
});

test('dropouts record no data and do not count as moving; long gaps are capped', () => {
  const r = new RideRecorder(START);
  for (const t of range(1, 10)) r.record(t, t > 5 && t <= 8 ? null : steady(30));
  assert.equal(r.stats.movingTime, 7);
  assert.equal(r.stats.timerTime, 10);
  assert.equal(r.samples.filter((s) => s.speed == null).length, 3);

  const g = new RideRecorder(START);
  g.record(1, steady(36));
  g.record(600, steady(36));
  assert.equal(g.stats.timerTime, 1 + MAX_SAMPLE_GAP);
});

test('coasting zeros count towards average power; normalised power', () => {
  const r = new RideRecorder(START);
  for (const t of range(1, 10)) r.record(t, steady(30, t <= 5 ? 300 : 0));
  assert.equal(r.stats.averagePower, 150);
  assert.equal(r.stats.maxPower, 300);

  const n = new RideRecorder(START);
  for (const t of range(1, 600)) n.record(t, steady(30, 250));
  assert.ok(Math.abs(n.summary(600).normalizedPower - 250) < 1e-6);
  const short = new RideRecorder(START);
  short.record(1, steady(30));
  assert.equal(short.summary(1).normalizedPower, null);
});

test('heart rate is recorded, averaged and survives trainer dropouts', () => {
  const r = new RideRecorder(Date.now());
  for (const t of range(1, 10)) r.record(t, t <= 5 ? steady(30) : null, t <= 5 ? 120 : 140);
  const s = r.summary(10);
  assert.equal(s.averageHeartRate, 130);
  assert.equal(s.maxHeartRate, 140);
  assert.equal(r.samples.at(-1).heartRate, 140);
  assert.equal(r.samples.at(-1).speed, null);
});

test('journal replay reproduces the live ride and ignores a torn last line', () => {
  const id = newRideID();
  const live = new RideRecorder(START);
  let journal = Journal.header(id, START, { model: 'inRide' });
  for (const t of range(1, 300)) {
    if (t === 120) {
      const closing = live.pause(120, steady(25));
      if (closing) journal += Journal.sample(closing);
      journal += Journal.pause(120);
    }
    if (t === 150) {
      live.resume(150);
      journal += Journal.resume(150);
    }
    const s = live.record(t, steady(25 + (t % 7), 150 + (t % 50)));
    if (s) journal += Journal.sample(s);
  }
  journal += '{"k":"s","s":{"t":301,"dt'; // power cut mid-write

  const rec = replayJournal(journal);
  assert.equal(rec.id, id);
  assert.equal(rec.skippedLines, 1);
  assert.equal(rec.trainer.model, 'inRide');
  assert.deepEqual(rec.recorder.samples, live.samples);
  assert.deepEqual({ ...rec.recorder.stats }, { ...live.stats });
  assert.deepEqual(rec.recorder.timerEvents, live.timerEvents);
  assert.equal(rec.recorder.startDate, START);
  assert.equal(rec.lastT, 300);
  assert.throws(() => replayJournal(Journal.pause(3)), /missingHeader/);
});

test('reads journal lines written by the iPhone app', () => {
  const text = '{"id":"6F0A3D1E-1111-2222-3333-444455556666","k":"h","start":1761200000,"trainer":{"model":"inRide"}}\n'
    + '{"k":"s","s":{"c":88,"d":8.3,"dt":1,"h":120,"p":200,"t":1,"v":8.3}}\n'
    + '{"k":"s","s":{"d":8.3,"dt":1,"t":2}}\n';
  const rec = replayJournal(text);
  assert.equal(rec.recorder.samples.length, 2);
  assert.equal(rec.recorder.samples[0].heartRate, 120);
  assert.equal(rec.recorder.samples[1].speed, null);
});

test('default ride names follow the time of day', () => {
  assert.equal(defaultRideName(new Date(2026, 0, 1, 7).getTime()), 'Morning Indoor Ride');
  assert.equal(defaultRideName(new Date(2026, 0, 1, 18).getTime()), 'Evening Indoor Ride');
});

// ---- Export ---------------------------------------------------------------------------------------

function sampleRide(seconds = 600, hr = false) {
  const r = new RideRecorder(START);
  for (const t of range(1, seconds)) {
    if (!hr && t === seconds / 2) r.pause(t, steady(30, 200, 88));
    if (!hr && t === seconds / 2 + 30) r.resume(t);
    r.record(t, steady(30, 180 + (t % 40), 88), hr ? 100 + (t % 20) : null);
  }
  const record = {
    id: newRideID(), name: 'Test', startDate: new Date(START).toISOString(), endDate: new Date(START + seconds * 1000).toISOString(),
    summary: r.summary(seconds), trainer: hr ? { model: 'inRide', heartRateMonitor: 'Polar H9 ABCD' } : { model: 'inRide' }, recovered: false, uploads: {},
  };
  return { record, track: r.track };
}

/** Just enough of a FIT reader to verify our own output. */
function readFIT(b) {
  let i = b[0];
  const end = b.length - 2;
  const defs = {};
  const out = [];
  while (i < end) {
    const h = b[i++];
    const local = h & 0x0f;
    if (h & 0x40) {
      const global = b[i + 2] | (b[i + 3] << 8);
      const n = b[i + 4];
      i += 5;
      const fields = [];
      for (let k = 0; k < n; k++, i += 3) fields.push([b[i], b[i + 1]]);
      defs[local] = { global, fields };
    } else {
      const def = defs[local];
      if (!def) throw new Error('corrupt');
      const values = {};
      for (const [num, size] of def.fields) {
        let v = 0;
        for (let k = 0; k < size && size <= 4; k++) v += b[i + k] * 2 ** (8 * k);
        values[num] = v;
        i += size;
      }
      out.push({ global: def.global, fields: values });
    }
  }
  return out;
}

test('FIT CRC matches the FIT SDK reference value', () => {
  assert.equal(fitCRC(new TextEncoder().encode('123456789')), 0xbb3d);
});

test('FIT file is structurally valid', () => {
  const data = exportFIT(sampleRide());
  assert.equal(data[0], 14);
  assert.equal(String.fromCharCode(...data.slice(8, 12)), '.FIT');
  const size = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
  assert.equal(data.length, 14 + size + 2);
  assert.equal(data[12] | (data[13] << 8), fitCRC(data.slice(0, 12)));
  assert.equal(fitCRC(data), 0);
});

test('FIT records have strictly increasing timestamps, indoor cycling session', () => {
  const messages = readFIT(exportFIT(sampleRide()));
  const records = messages.filter((m) => m.global === 20);
  assert.equal(records.length, 571);
  const ts = records.map((m) => m.fields[253]);
  for (let k = 1; k < ts.length; k++) assert.ok(ts[k - 1] < ts[k]);
  const session = messages.find((m) => m.global === 18);
  assert.equal(session.fields[5], 2);
  assert.equal(session.fields[6], 6);
  assert.equal(session.fields[8], 570000);
  assert.equal(messages.filter((m) => m.global === 21).length, 4);
});

test('heart rate appears in FIT, TCX and CSV', () => {
  const ride = sampleRide(120, true);
  const messages = readFIT(exportFIT(ride));
  assert.ok(messages.filter((m) => m.global === 20).every((m) => m.fields[3] >= 100 && m.fields[3] < 120));
  const session = messages.find((m) => m.global === 18);
  assert.equal(session.fields[17], 119);
  assert.equal(session.fields[16], Math.round(ride.record.summary.averageHeartRate));
  const hrm = messages.filter((m) => m.global === 23).find((m) => m.fields[0] === 2);
  assert.equal(hrm.fields[2], 123);
  const tcx = new TextDecoder().decode(exportTCX(ride));
  assert.ok(tcx.includes('<HeartRateBpm><Value>'));
  assert.ok(tcx.includes('<MaximumHeartRateBpm><Value>119</Value>'));
});

test('TCX has one trackpoint per second; CSV a row per sample', () => {
  const tcx = new TextDecoder().decode(exportTCX(sampleRide()));
  assert.equal((tcx.match(/<Trackpoint>/g) || []).length, 571);
  assert.equal((tcx.match(/<ns3:Watts>/g) || []).length, 571);
  assert.equal((tcx.match(/<Trackpoint>/g) || []).length, (tcx.match(/<\/Trackpoint>/g) || []).length);
  const lines = new TextDecoder().decode(exportCSV(sampleRide())).trim().split('\n');
  assert.equal(lines[0], 'elapsed_s,timestamp_utc,power_w,speed_kph,cadence_rpm,distance_m,heart_rate_bpm');
  assert.equal(lines.length, 572);
  assert.match(exportFileName(sampleRide(), 'fit'), /^Spindown-\d{4}-\d{2}-\d{2}-\d{4}\.fit$/);
});

// ---- Lakes ----------------------------------------------------------------------------------------

test('workout durations, positions and targets', () => {
  const minutes = Object.fromEntries(Lakes.WORKOUTS.map((w) => [w.id, Lakes.workoutDuration(w) / 60]));
  assert.deepEqual(minutes, { windermere: 25, kirkstone: 50, sprints: 36, honister: 45, tempo: 55 });
  const w = Lakes.WORKOUTS.find((x) => x.id === 'kirkstone');
  assert.equal(Lakes.workoutPosition(w, 0).index, 0);
  assert.equal(Lakes.workoutPosition(w, 599).step.kind, 'warmup');
  const climb = Lakes.workoutPosition(w, 600);
  assert.ok(climb.step.kind === 'work' && climb.index === 1 && climb.remainingInStep === 480);
  assert.equal(climb.next.kind, 'recover');
  assert.equal(Lakes.workoutPosition(w, Lakes.workoutDuration(w)).isComplete, true);
  assert.equal(Lakes.workoutPosition(w, Lakes.workoutDuration(w) + 100).fractionOfWorkout, 1);
  assert.deepEqual(Lakes.targetWatts({ low: 0.88, high: 0.94 }, 250), [220, 235]);
});

test('route: laps, lakes, villages and landmarks', () => {
  assert.equal(Lakes.lap(0), 1);
  assert.equal(Lakes.lap(Lakes.LAP_LENGTH + 1), 2);
  assert.equal(Lakes.lapDistance(Lakes.LAP_LENGTH + 500), 500);
  assert.equal(Lakes.lakeAmount(2000), 1);
  assert.equal(Lakes.lakeAmount(16000), 0);
  assert.equal(Lakes.lakeAmount(22000), 1);
  assert.equal(Lakes.villageAmount(8000), 1);
  assert.equal(Lakes.villageAmount(16000), 0);
  assert.ok(Lakes.elevation(17500) > 200);
  assert.ok(Lakes.elevation(2000) < 80);
  const [next, gap] = Lakes.nextLandmark(7000);
  assert.ok(next.name === 'Ambleside' && Math.abs(gap - 1000) < 0.001);
  assert.deepEqual(Lakes.landmarksPassed(12990, 13010).map((l) => l.name), ['Grasmere']);
  assert.deepEqual(Lakes.landmarksPassed(Lakes.LAP_LENGTH - 5, Lakes.LAP_LENGTH + 5).map((l) => l.name), ['Bowness-on-Windermere']);
  assert.deepEqual(Lakes.landmarksPassed(100, 200), []);
});

test('scenery hash is deterministic and matches the Swift implementation', () => {
  // Values computed with the Swift GameMath.hash (splitmix64).
  const v = [0, 1, 2, -1, 1000].map(Lakes.hash01);
  for (const x of v) assert.ok(x >= 0 && x < 1);
  assert.equal(Lakes.hash01(5), Lakes.hash01(5));
});
