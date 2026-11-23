// App settings: the heart-rate zone defaults (max 196 bpm, Garmin's 50/60/70/80/90 %) and the migration of
// settings saved before there was a default max heart rate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Settings, SETTINGS_DEFAULTS, migrateSettings } from '../src/main/storage.js';
import { DEFAULT_MAX_HR, zoneBounds, zoneFor } from '../src/core/hrzones.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spindown-settings-'));
const write = (dir, values) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(values));
const saved = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));

test('max heart rate defaults to 196 bpm, so zones show from the start', () => {
  assert.equal(DEFAULT_MAX_HR, 196);
  assert.equal(SETTINGS_DEFAULTS.maxHeartRate, 196);
  assert.deepEqual(SETTINGS_DEFAULTS.hrZonePercents, [50, 60, 70, 80, 90]);
  const s = new Settings(tmp());
  assert.equal(s.get('maxHeartRate'), 196);
  assert.deepEqual(zoneBounds(s.get('maxHeartRate'), s.get('hrZonePercents')).map((z) => z.low), [98, 118, 137, 157, 176]);
  assert.equal(zoneFor(142, s.get('maxHeartRate'), s.get('hrZonePercents')), 3);
});

test('saved settings with no max heart rate are migrated to 196, and written back', () => {
  const dir = tmp();
  write(dir, { ftp: 180, maxHeartRate: null, hrZonePercents: [50, 60, 70, 80, 90], onboarded: true });
  const s = new Settings(dir);
  assert.equal(s.get('maxHeartRate'), 196);
  assert.equal(s.get('ftp'), 180, 'everything else kept');
  assert.equal(saved(dir).maxHeartRate, 196);
  // A file from before the setting existed at all.
  const old = tmp();
  write(old, { ftp: 200 });
  assert.equal(new Settings(old).get('maxHeartRate'), 196);
});

test('a max heart rate that was set is kept; broken zone percentages are reset', () => {
  const dir = tmp();
  write(dir, { maxHeartRate: 185, hrZonePercents: [50, 60, 70, 80, 90] });
  const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.equal(new Settings(dir).get('maxHeartRate'), 185);
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), before, 'nothing to migrate, file untouched');
  const v = { maxHeartRate: 'abc', hrZonePercents: [90, 80] };
  assert.deepEqual(migrateSettings(v).sort(), ['hrZonePercents', 'maxHeartRate']);
  assert.equal(v.maxHeartRate, 196);
  assert.deepEqual(v.hrZonePercents, [50, 60, 70, 80, 90]);
  // Changing it later still works.
  const s = new Settings(dir);
  s.set('maxHeartRate', 190);
  assert.equal(new Settings(dir).get('maxHeartRate'), 190);
});
