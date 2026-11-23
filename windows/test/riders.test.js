// Spindown World riders: Mark Potts and the pacers at fixed watts, the whole roster in races, and who takes a place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as P from '../src/core/world/progression.js';
import { REGULARS, PACERS } from '../src/core/world/content.js';
import { makeDales as makeDalesFrom } from '../src/core/world/worlds.js';
import { WorldSim, RACE_PRESETS, raceFieldSize } from '../src/core/world/sim.js';

const dalesData = JSON.parse(fs.readFileSync(new URL('../src/renderer/game3d/data/dales.json', import.meta.url), 'utf8'));
const makeDales = () => makeDalesFrom(dalesData);

test('the roster: new regulars with their own kit and builds', () => {
  for (const name of ['Barrel Rider', 'Deev', 'Roggus McPoggus', 'Bobby', 'Big Bird', 'Moggis', 'Mimi', 'Bippy', 'Big Al', 'The Wheezhog', 'Mark Potts']) {
    assert.equal(REGULARS.filter((r) => r.name === name).length, 1, name);
  }
  assert.equal(REGULARS.find((r) => r.name === 'Big Bird').build, 'tall');
  assert.equal(REGULARS.find((r) => r.name === 'Barrel Rider').build, 'broad');
  assert.ok(REGULARS.find((r) => r.name === 'Barrel Rider').mass >= 110);
  const kits = REGULARS.filter((r) => r.kit).map((r) => r.kit.jersey.id);
  assert.equal(new Set(kits).size, kits.length, 'each has a jersey of their own');
  assert.equal(PACERS.length, 11);
  assert.equal(new Set(PACERS.map((p) => p.color)).size, 11, 'every pacer a different colour');
});

test('Mark Potts and the pacers hold exactly their watts on every road, whatever the field does', () => {
  const sim = new WorldSim({ route: makeDales(), profile: P.newProfile(), mode: 'free', ftp: 170, seed: 5 });
  const mark = sim.riders.find((r) => r.name === 'Mark Potts');
  const pacers = sim.riders.filter((r) => r.pacer);
  assert.ok(mark && mark.fixedPower === 350 && mark.flames);
  assert.deepEqual(pacers.map((p) => p.fixedPower), [150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250]);
  let up = 0, down = 0;
  // Ride far below the set FTP for long enough that the field scales down; the fixed riders must not.
  for (let i = 0; i < 12 * 60 * 2; i++) {
    sim.step(0.5, { power: 90 });
    const g = sim.route.gradient(mark.d);
    if (g > 0.04) up++;
    if (g < -0.03) down++;
    assert.equal(mark.power, 350);
    for (const p of pacers) assert.equal(p.power, p.pacer.watts);
  }
  assert.ok(sim.fieldScale < 0.95, `field scaled to ${sim.fieldScale}`);
  assert.ok(up > 20 && down > 5, `Mark rode climbs (${up}) and descents (${down})`);
  // Pacers weigh what you do and ride your bike, so their watts mean the same to you.
  for (const p of pacers) assert.ok(p.mass === sim.player.mass && p.kit.bike === sim.player.kit.bike);
});

test('a pacer goes exactly as fast as you would at its watts', () => {
  const solo = new WorldSim({ route: makeDales(), profile: P.newProfile(), mode: 'free', ftp: 170, seed: 5, botCount: 0, pacers: false });
  solo.riders = [solo.player];
  const other = new WorldSim({ route: makeDales(), profile: P.newProfile(), mode: 'free', ftp: 170, seed: 5, botCount: 0 });
  const ghost = other.riders.find((r) => r.pacer?.watts === 200);
  other.riders = [other.player, ghost];
  ghost.d = solo.player.d = 500;
  ghost.v = solo.player.v = 0;
  other.player.d = 3000; // well away, so nobody drafts anybody
  for (let i = 0; i < 600; i++) {
    solo.step(0.5, { power: 200 });
    other.step(0.5, { power: 0 });
  }
  assert.ok(ghost.d > 900, `${ghost.d}`);
  assert.ok(Math.abs(ghost.d - solo.player.d) < 0.5, `pacer ${ghost.d.toFixed(1)} m, you ${solo.player.d.toFixed(1)} m`);
});

test('free ride: pacers spread round the loop, or the one you pick starts beside you', () => {
  const spread = new WorldSim({ route: makeDales(), profile: P.newProfile(), mode: 'free', ftp: 200, seed: 1 });
  const at = spread.riders.filter((r) => r.pacer).map((r) => r.d).sort((a, b) => a - b);
  const gaps = at.slice(1).map((d, i) => d - at[i]);
  assert.ok(gaps.every((g) => Math.abs(g - spread.L / 11) < 1), 'evenly spaced');
  const chosen = new WorldSim({ route: makeDales(), profile: P.newProfile(), mode: 'free', ftp: 200, seed: 1, startPacer: 200 });
  const p = chosen.riders.find((r) => r.pacer?.watts === 200);
  assert.ok(p.d > chosen.player.d && p.d - chosen.player.d < 10, 'the 200 W pacer starts just ahead of you');
});

test('races: the whole roster is on the grid; pacers and Mark Potts ride but never take a place', () => {
  for (const preset of RACE_PRESETS) {
    const sim = new WorldSim({ route: makeDales(), profile: P.newProfile(), mode: 'race', race: preset, ftp: 170, seed: 9 });
    const names = sim.riders.map((r) => r.name);
    for (const reg of REGULARS) assert.ok(names.includes(reg.name), `${reg.name} in the ${preset.name}`);
    for (const pacer of PACERS) assert.ok(names.includes(`${pacer.watts} W pacer`), `${pacer.watts} W pacer on the road in the ${preset.name}`);
    assert.ok(sim.riders.filter((r) => r.pacer || r.fixedPower != null).every((r) => r.unplaced));
    assert.ok(sim.standings().every((r) => !r.unplaced));
    assert.equal(sim.standings().length, raceFieldSize(preset) + 1);
  }
  // A whole race: the pacers and Mark ride it (Mark and the strong pacers cross the line first), but the
  // results are the real riders only.
  const preset = RACE_PRESETS.find((r) => r.id === 'quick10');
  const sim = new WorldSim({ route: makeDales(), profile: P.newProfile(), mode: 'race', race: preset, ftp: 170, seed: 2 });
  const unplaced = sim.riders.filter((r) => r.unplaced);
  const start = unplaced.map((r) => r.d);
  sim.startCountdown(3);
  const events = [];
  for (let t = 0; sim.race.phase !== 'finished' && t < 3600; t += 0.5) events.push(...sim.step(0.5, { power: 165 }));
  const fin = events.find((e) => e.type === 'race-finish');
  assert.ok(fin, 'you finished');
  assert.equal(fin.field, raceFieldSize(preset) + 1);
  const board = sim.leaderboard();
  assert.equal(board.length, raceFieldSize(preset) + 1);
  assert.ok(board.every((b) => !b.rider.unplaced));
  assert.ok(sim.race.results.every((r) => !r.unplaced));
  unplaced.forEach((r, i) => assert.ok(r.d > start[i] + 1000, `${r.name} rode the race`));
  const mark = sim.riders.find((r) => r.name === 'Mark Potts');
  assert.ok(mark.d > sim.race.finishD, 'Mark Potts crossed the line, unplaced');
  assert.equal(board[0].rider.name, 'Og Pog', 'Og Pog still wins');
});
