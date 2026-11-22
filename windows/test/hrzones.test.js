import test from 'node:test';
import assert from 'node:assert/strict';
import * as Z from '../src/core/hrzones.js';

test('default zones at max 196 match the Garmin screen', () => {
  const b = Z.zoneBounds(196);
  assert.deepEqual(b.map((z) => z.low), [98, 118, 137, 157, 176]);
  assert.equal(b[4].high, 196);
});

test('zoneFor and zoneDecimal', () => {
  assert.equal(Z.zoneFor(90, 196), 0);
  assert.equal(Z.zoneFor(98, 196), 1);
  assert.equal(Z.zoneFor(140, 196), 3);
  assert.equal(Z.zoneFor(200, 196), 5);
  assert.equal(Z.zoneFor(null, 196), null);
  assert.equal(Z.zoneFor(140, null), null);
  assert.equal(Z.zoneDecimal(147, 196), 3.5);
  assert.ok(Z.zoneDecimal(210, 196) < 6);
});

test('time in zones', () => {
  const samples = [{ dt: 1, heartRate: 90 }, { dt: 1, heartRate: 120 }, { dt: 2, heartRate: 180 }, { dt: 1, heartRate: null }];
  assert.deepEqual(Z.timeInZones(samples, 196), [1, 0, 1, 0, 0, 2]);
  assert.equal(Z.timeInZones(samples, null), null);
});

test('setting a boundary by bpm or % keeps zones rising', () => {
  const p = Z.DEFAULT_ZONE_PERCENTS;
  assert.deepEqual(Z.setBoundary(p, 2, { percent: 72 }, 196), [50, 60, 72, 80, 90]);
  assert.deepEqual(Z.setBoundary(p, 2, { bpm: 147 }, 196), [50, 60, 75, 80, 90]);
  assert.deepEqual(Z.setBoundary(p, 2, { percent: 95 }, 196), [50, 60, 79, 80, 90]);
  assert.deepEqual(Z.setBoundary(p, 4, { percent: 120 }, 196), [50, 60, 70, 80, 99]);
  assert.ok(Z.validPercents(Z.setBoundary(p, 0, { bpm: 300 }, 196)));
});
