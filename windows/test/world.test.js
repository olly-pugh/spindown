// Spindown World game logic: physics, progression, courses, power-ups, segments and races.
import test from 'node:test';
import assert from 'node:assert/strict';
import { riderParams, steadySpeed, stepSpeed, draftFraction, powerForSpeed } from '../src/core/world/physics.js';
import * as P from '../src/core/world/progression.js';
import { xpForLevel, levelFor, BIKES, TIERS, POWERUPS } from '../src/core/world/content.js';
import { makeDales, medalFor } from '../src/core/world/worlds.js';
import { WorldSim, RACE_PRESETS, timeAtDistance } from '../src/core/world/sim.js';

const kmh = (v) => v * 3.6;

test('physics: realistic speeds for power and gradient', () => {
  const p = riderParams();
  // 75 kg rider, ~10 kg of bike: 200 W on the flat is about 32–34 km/h; 300 W about 37–39 km/h.
  assert.ok(kmh(steadySpeed(200, 0, p)) > 31 && kmh(steadySpeed(200, 0, p)) < 35, `${kmh(steadySpeed(200, 0, p))}`);
  assert.ok(kmh(steadySpeed(300, 0, p)) > 36.5 && kmh(steadySpeed(300, 0, p)) < 40);
  // 250 W up 6% with ~86 kg all-up: about 15 km/h (gravity ~50 N dominates).
  const up = kmh(steadySpeed(250, 0.06, p));
  assert.ok(up > 13 && up < 16.5, `${up}`);
  // Coasting down 6% reaches a terminal speed around 55–65 km/h.
  const down = kmh(steadySpeed(0, -0.06, p));
  assert.ok(down > 50 && down < 70, `${down}`);
  // Power needed and speed are consistent.
  assert.ok(Math.abs(powerForSpeed(steadySpeed(220, 0.02, p), 0.02, p) - 220) < 1);
  // Integration converges on the steady speed.
  let v = 0;
  for (let i = 0; i < 3000; i++) v = stepSpeed(v, 200, 0, 0.1, p);
  assert.ok(Math.abs(v - steadySpeed(200, 0, p)) < 0.05);
});

test('physics: drafting and equipment change speed', () => {
  assert.ok(draftFraction(0.5, 0) > 0.3);
  assert.equal(draftFraction(13, 0), 0);
  assert.equal(draftFraction(1, 1.5), 0);
  const base = riderParams();
  assert.ok(steadySpeed(200, 0, base, 0.3) > steadySpeed(200, 0, base) * 1.08);
  const climber = riderParams({ bike: BIKES.find((b) => b.id === 'climber') });
  const tourer = riderParams({ bike: BIKES.find((b) => b.id === 'tourer') });
  assert.ok(steadySpeed(250, 0.07, climber) > steadySpeed(250, 0.07, tourer));
  const aero = riderParams({ bike: BIKES.find((b) => b.id === 'aero') });
  assert.ok(steadySpeed(250, 0, aero) > steadySpeed(250, 0, tourer));
});

test('progression: XP, levels, unlocks and equipping', () => {
  const p = P.newProfile();
  assert.equal(P.level(p), 1);
  assert.equal(levelFor(xpForLevel(5)), 5);
  assert.equal(P.equip(p, 'bike', 'climber'), false, 'climber bike is locked at level 1');
  const events = P.addXP(p, xpForLevel(7), 'test');
  assert.equal(P.level(p), 7);
  const levelUps = events.filter((e) => e.type === 'level');
  assert.equal(levelUps.length, 6);
  assert.ok(levelUps.find((e) => e.level === 7).unlocks.some((u) => u.item.id === 'climber'));
  assert.equal(P.equip(p, 'bike', 'climber'), true);
  // The Laurel jersey needs a race win.
  assert.equal(P.isUnlocked(p, 'jersey', 'laurel'), false);
  P.recordRace(p, 1, 15);
  assert.equal(P.isUnlocked(p, 'jersey', 'laurel'), true);
  // Saved and loaded intact, with nothing locked left equipped.
  const back = P.migrateProfile(JSON.parse(P.serialiseProfile(p)));
  assert.equal(back.equipped.bike, 'climber');
  assert.equal(back.xp, p.xp);
  const damaged = P.migrateProfile({ xp: 'lots', equipped: { bike: 'gold' } });
  assert.equal(damaged.xp, 0);
  assert.equal(damaged.equipped.bike, 'tourer');
});

test('progression: riding earns XP, achievements and completes challenges', () => {
  const p = P.newProfile();
  const all = [];
  for (let i = 0; i < 1200; i++) all.push(...P.recordRiding(p, { distance: 9, time: 1, climb: 0.15, speed: 9, drafting: i % 2 === 0 }));
  assert.ok(p.xp > 200, `${p.xp}`);
  assert.ok(all.some((e) => e.type === 'achievement' && e.achievement.id === 'first-km'));
  assert.ok(all.some((e) => e.type === 'achievement' && e.achievement.id === 'ten-km'));
  assert.ok(all.some((e) => e.type === 'challenge'));
  assert.equal(p.challenges.active.length, 3);
  assert.ok(p.stats.draftTime >= 599);
});

test('courses: the Dales loop is rideable and has medal times', () => {
  const r = makeDales();
  assert.ok(r.length > 7000 && r.length < 11000);
  for (let d = 0; d < r.length; d += 5) assert.ok(Math.abs(r.gradient(d)) < 0.13, `gradient at ${d}`);
  const fell = r.segments.find((s) => s.id === 'fell');
  assert.ok(fell.medals.gold < fell.medals.silver && fell.medals.silver < fell.medals.bronze);
  assert.equal(medalFor(fell, fell.medals.gold - 1), 'gold');
  assert.equal(medalFor(fell, fell.medals.bronze + 1), null);
  // Positions wrap round the loop.
  const a = r.position(10), b = r.position(r.length + 10);
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6);
});

function freeSim(power = 220, profile = P.newProfile()) {
  return new WorldSim({ route: makeDales(), profile, mode: 'free', ftp: 230, seed: 3, botCount: 14 });
}

test('free ride: bots of several tiers ride and animate; the player moves with power', () => {
  const sim = freeSim();
  const bots = sim.riders.filter((r) => !r.isPlayer && !r.isGhost);
  assert.ok(bots.length >= 12);
  assert.ok(new Set(bots.map((b) => b.tier.id)).size >= 4);
  const start = bots.map((b) => b.d);
  const crank0 = sim.player.crank;
  for (let i = 0; i < 5 * 60 * 10; i++) sim.step(1 / 10, { power: 220, cadence: 90 });
  bots.forEach((b, i) => assert.ok(b.d > start[i] + 250, `${b.name} moved`));
  assert.ok(sim.player.d > 1500, `${sim.player.d}`);
  assert.equal(sim.player.cadence, 90);
  const c1 = sim.player.crank;
  sim.step(0.05, { power: 220, cadence: 90 });
  assert.ok(Math.abs(sim.player.crank - c1) > 0.4, 'legs turn at the trainer cadence');
  void crank0;
  // No power, no XP.
  const xp = sim.profile.xp;
  const p2 = freeSim();
  for (let i = 0; i < 100; i++) p2.step(0.1, { power: null });
  assert.equal(p2.profile.xp, 0);
  assert.ok(xp > 0);
});

test('power-ups: collected on the road, then used for their duration', () => {
  const sim = freeSim();
  let picked = null;
  for (let i = 0; i < 2000 && !picked; i++) {
    const ev = sim.step(0.1, { power: 250 });
    picked = ev.find((e) => e.type === 'pickup');
  }
  assert.ok(picked, 'a power-up was collected');
  assert.equal(sim.player.held.length, 1);
  const used = sim.usePowerup();
  assert.ok(used);
  assert.equal(sim.player.held.length, 0);
  assert.equal(sim.player.effects.length, 1);
  const until = sim.player.effects[0].until;
  assert.ok(Math.abs(until - sim.time - used.duration) < 1e-9);
  // The effect changes the physics parameters while active, then expires.
  const def = POWERUPS.find((p) => p.id === used.id);
  const during = sim.params(sim.player);
  if (def.effect.cda) assert.ok(during.cda < riderParams({ bike: sim.player.kit.bike, wheels: sim.player.kit.wheels }).cda);
  for (let i = 0; i < (used.duration + 1) * 10; i++) sim.step(0.1, { power: 250 });
  assert.equal(sim.player.effects.length, 0);
  assert.equal(sim.profile.stats.powerupsUsed, 1);
});

test('segments: a zone gives a time, a medal and a PR; a full lap stores a ghost and later deltas', () => {
  const profile = P.newProfile();
  const sim = freeSim(320, profile);
  const events = [];
  // Ride hard for more than a lap.
  for (let i = 0; i < 20 * 60 * 10 && !profile.ghosts.dales; i++) events.push(...sim.step(0.1, { power: 320 }));
  const ends = events.filter((e) => e.type === 'segment-end');
  assert.ok(ends.some((e) => e.segment.kind === 'zone' && e.medal), 'a speed-zone medal at 320 W');
  assert.ok(events.some((e) => e.type === 'medal'));
  assert.ok(profile.prs.dales.fell.time > 0);
  assert.ok(profile.ghosts.dales.samples.length > 100);
  // Second lap: checkpoint deltas against the ghost, and the ghost rider appears.
  const sim2 = freeSim(320, profile);
  assert.ok(sim2.ghost);
  const ev2 = [];
  for (let i = 0; i < 3 * 60 * 10; i++) ev2.push(...sim2.step(0.1, { power: 300 }));
  const cps = ev2.filter((e) => e.type === 'checkpoint');
  assert.ok(cps.length >= 1);
  assert.ok(cps[0].delta > 0, 'slower than the PR lap so behind the ghost');
  assert.ok(sim2.ghost.d > 0 && !sim2.ghost.hidden);
  assert.equal(timeAtDistance([0, 10, 20], 15), 1.5);
});

test('race: a 30-minute race at FTP-ish power takes 27–33 minutes and ends with an ordered leaderboard', () => {
  const profile = P.newProfile();
  const preset = RACE_PRESETS.find((r) => r.id === 'dales30');
  const sim = new WorldSim({ route: makeDales(), profile, mode: 'race', race: preset, ftp: 230, seed: 11 });
  assert.ok(sim.riders.length === preset.field + 1);
  sim.startCountdown(10);
  const events = [];
  let t = 0;
  while (sim.race.phase !== 'finished' && t < 3600) {
    events.push(...sim.step(0.5, { power: 225 }));
    t += 0.5;
  }
  assert.ok(events.some((e) => e.type === 'go'));
  assert.ok(events.filter((e) => e.type === 'countdown').length >= 3);
  const finish = events.find((e) => e.type === 'race-finish');
  assert.ok(finish, 'the player finished');
  assert.ok(finish.time > 27 * 60 && finish.time < 33 * 60, `race took ${(finish.time / 60).toFixed(1)} min`);
  const board = sim.leaderboard();
  for (let i = 1; i < board.length; i++) assert.ok(board[i].time >= board[i - 1].time);
  assert.equal(board.length, preset.field + 1);
  assert.ok(profile.stats.races === 1 && profile.xp > 150);
  // A spread of results: not everyone finishes together.
  const finished = board.filter((b) => !b.projected);
  assert.ok(finished.length >= 2);
  // The regulars fill the field, and Og Pog is the strongest rider in it.
  const bots = sim.riders.filter((x) => !x.isPlayer);
  assert.ok(bots.filter((b) => b.regular).length >= preset.field - 1);
  const og = bots.find((b) => b.name === 'Og Pog');
  assert.ok(og && bots.every((b) => b === og || b.wkg < og.wkg));
  assert.ok(bots.every((b) => b === og || b.wkg * b.mass < og.wkg * og.mass), 'Og Pog also has the most watts');
  const botOrder = board.filter((x) => !x.rider.isPlayer);
  assert.equal(botOrder[0].rider.name, 'Og Pog', 'Og Pog is the first bot home');
});

test('free ride: the regulars ride, Og Pog is the fastest', () => {
  const sim = freeSim();
  const names = sim.riders.map((r) => r.name);
  for (const n of ['Og Pog', 'Pootle', 'Grandma', 'Big Al', 'Magnum PI']) assert.ok(names.includes(n), n);
  const og = sim.riders.find((r) => r.name === 'Og Pog');
  assert.ok(sim.riders.filter((r) => !r.isPlayer && !r.isGhost).every((b) => b === og || b.wkg <= og.wkg));
});

test('road-distance field matches a brute-force search', async () => {
  const { RouteField } = await import('../src/core/world/field.js');
  const r = makeDales();
  const f = new RouteField(r, { cell: 20, margin: 600 });
  const out = {};
  let worst = 0;
  // Seeded, so the test gives the same answer every run. The field only places scenery (trees, walls, sheep)
  // clear of the road on a 20 m grid, so a few metres is plenty accurate.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 300; i++) {
    const p = r.position(rand() * r.length, (rand() - 0.5) * 400);
    f.query(p.x, p.z, out);
    let best = Infinity;
    for (let k = 0; k < r.count; k++) best = Math.min(best, Math.hypot(r.xs[k] - p.x, r.zs[k] - p.z));
    worst = Math.max(worst, Math.abs(out.distance - best));
  }
  assert.ok(worst < 3, `worst error ${worst} m`);
});

function raceAt(setFtp, ride, seed = 4) {
  const sim = new WorldSim({ route: makeDales(), profile: P.newProfile(), mode: 'race', race: RACE_PRESETS.find((r) => r.id === 'dales30'), ftp: setFtp, seed });
  sim.startCountdown(3);
  for (let t = 0; sim.race.phase !== 'finished' && t < 5000; t += 0.5) sim.step(0.5, { power: ride });
  return { place: sim.race.playerPlace, field: sim.riders.length, time: sim.player.finishTime, winner: sim.leaderboard()[0] };
}

test('races adapt to the rider: a wrong FTP still gives a real race, and effort is rewarded', () => {
  const steady = raceAt(170, 165);
  const hard = raceAt(170, 210);
  const tooHigh = raceAt(230, 160); // FTP set too high for the rider
  const tooLow = raceAt(130, 200); // FTP set too low
  for (const r of [steady, hard, tooHigh, tooLow]) {
    assert.ok(r.place > 1, 'Og Pog still beats a steady rider');
    assert.equal(r.winner.rider.name, 'Og Pog');
    assert.ok(r.time - r.winner.time < 13 * 60, `within reach of the winner (${((r.time - r.winner.time) / 60).toFixed(1)} min)`);
  }
  assert.ok(hard.place < steady.place, `riding harder moves you up (${steady.place} → ${hard.place})`);
  assert.ok(tooHigh.place < tooHigh.field, 'not last even with the FTP set far too high');
  assert.ok(tooLow.place > 1 && tooLow.place <= 6, `near the front, not miles clear, with the FTP set too low (${tooLow.place})`);
});

test('free ride: bots are set around your level and an FTP estimate comes from riding', () => {
  const sim = new WorldSim({ route: makeDales(), profile: P.newProfile(), mode: 'free', ftp: 170, seed: 2 });
  const bots = sim.riders.filter((r) => !r.isPlayer && !r.isGhost);
  const mine = sim.player.wkg;
  assert.ok(bots.some((b) => b.wkg < mine) && bots.some((b) => b.wkg > mine * 1.2));
  assert.ok(bots.every((b) => b.wkg > mine * 0.7 && b.wkg < mine * 1.9));
  const events = [];
  for (let i = 0; i < 25 * 60 * 2; i++) events.push(...sim.step(0.5, { power: 180 }));
  assert.ok(Math.abs(sim.profile.ftpEstimate - 171) <= 3, `estimate ${sim.profile.ftpEstimate}`);
  assert.ok(events.some((e) => e.type === 'ftp'));
});
