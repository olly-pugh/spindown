// The Spindown World simulation: the player and the bots moving along a course, drafting, power-ups,
// segments and PRs, the PR ghost, and races. Deterministic and independent of rendering, so it is unit tested
// and the 3D view simply draws `sim.riders`.
import { riderParams, stepSpeed, steadySpeed, draftFraction, cadenceFor } from './physics.js';
import { TIERS, tierFor, POWERUPS, BOT_FIRST, BOT_LAST, JERSEYS, HELMETS, BIKES, WHEELS, REGULARS, PACERS } from './content.js';
import { rng, valueNoise } from './noise.js';
import { medalFor } from './worlds.js';
import * as P from './progression.js';
import * as E from './efforts.js';

export const BIKE_LENGTH = 1.75;
/** Free-ride bot strength relative to the player's W/kg, by the bot's tier (rookie … pro). */
export const RELATIVE_TIER = [0.8, 0.95, 1.1, 1.25, 1.4, 1.6];
const ROAD_HALF = { york: 2.6, dales: 2.2 };

export const RACE_PRESETS = [
  { id: 'gp30', name: 'York Grand Prix', minutes: 30, field: 20, world: 'york', blurb: '30-minute race round the inner ring, finishing under the arch.' },
  { id: 'dales30', name: 'Dales Classic', minutes: 30, field: 18, world: 'dales', blurb: '30 minutes over the fell. Climbers welcome.' },
  { id: 'quick10', name: 'Quick Crit', minutes: 10, field: 14, world: 'york', blurb: 'A short, fast 10-minute race.' },
];

/**
 * Bots in a race: the preset's field, or more so that every regular in the roster is on the grid (Og Pog
 * included; Mark Potts rides as well, as a guest).
 */
export function raceFieldSize(preset) {
  return Math.max(preset.field, REGULARS.filter((x) => !x.power).length);
}

let nextID = 1;

function makeRider(fields) {
  return {
    id: nextID++,
    name: 'Rider',
    isPlayer: false,
    isGhost: false,
    tier: TIERS[1],
    level: 1,
    mass: 75,
    wkg: 2.5,
    d: 0,
    lateral: 0,
    targetLateral: 0,
    v: 0,
    power: 0,
    cadence: 0,
    crank: Math.random() * Math.PI * 2,
    wheel: 0,
    lean: 0,
    draft: 0,
    effects: [],
    held: [],
    finished: false,
    finishTime: null,
    lastSpot: -1,
    kit: null,
    /** Watts held exactly, whatever the road and the field (Mark Potts, pacers); null for everyone else. */
    fixedPower: null,
    /** A PACERS entry for a pacer ghost. */
    pacer: null,
    /** Rides in a race but takes no place in it (a guest). */
    unplaced: false,
    ...fields,
  };
}

export class WorldSim {
  /**
   * route: a course from worlds.js. profile: game profile (mutated with XP etc.). mode: 'free' | 'race'.
   * race: a RACE_PRESETS entry (mode 'race'). player: {ftp}. seed: randomness for bots.
   * pacers: whether the pacer ghosts ride (free ride only); startPacer: watts of the one to start beside, or null.
   */
  constructor({ route, profile, mode = 'free', race = null, ftp = 200, seed = 7, botCount = 16, pacers = true, startPacer = null }) {
    this.route = route;
    this.L = route.length;
    this.profile = profile;
    this.mode = mode;
    this.time = 0; // simulation seconds
    this.random = rng(seed);
    this.roadHalf = ROAD_HALF[route.world] ?? 2.4;
    this.ftp = ftp;
    this.events = [];
    P.syncCourse(profile, route.id, route.version);
    E.syncSegments(profile, route);
    this.spots = route.powerupSpots.map((at, i) => ({ at, lateral: [-1.2, 0, 1.2][i % 3] }));
    this.segmentState = new Map(); // segment id -> the attempt in progress (see startAttempt)
    this.lastPlayerD = null;
    this.lapStart = null; // sim time when the player last crossed the line
    this.lapSamples = [];
    this.sampleClock = 0;
    this.lastLandmark = -1;
    this.checkpointIndex = -1;
    // Adapting to the rider: per-second power log, a field-strength scale, and an FTP estimate.
    this.powerLog = [];
    this.logClock = 0;
    this.fieldScale = 1;
    this.adaptClock = 0;

    const kit = P.equipment(profile);
    this.player = makeRider({
      name: 'You',
      isPlayer: true,
      mass: profile.settings.riderMass ?? 75,
      kit: { jersey: kit.jersey, helmet: kit.helmet, bike: kit.bike, wheels: kit.wheels },
      wkg: ftp / (profile.settings.riderMass ?? 75),
      level: P.level(profile),
    });
    this.player.tier = tierFor(this.player.wkg);
    this.riders = [this.player];

    if (mode === 'race') this.setupRace(race, seed);
    else this.setupFreeRide(botCount);
    if (pacers) this.setupPacers(startPacer);

    // The PR ghost: your best lap of this course, in free ride.
    const ghost = profile.ghosts?.[route.id];
    if (mode === 'free' && ghost?.samples?.length > 10) {
      this.ghost = makeRider({ name: 'Your PR', isGhost: true, kit: this.player.kit, ghostData: ghost, tier: this.player.tier, mass: this.player.mass });
      this.riders.push(this.ghost);
    }
    if (mode === 'free') {
      // Free ride starts on the line, so the first lap counts.
      this.lapStart = 0;
      this.lapStartDistance = this.L;
      this.lapSamples = [0];
      this.startAttempt(route.segments[0], 0, this.player.d);
    }
  }

  // ---- Set-up --------------------------------------------------------------------------------------

  makeBot(wkg, intensity, regular = null) {
    const r = this.random;
    const mass = regular?.mass ?? 58 + r() * 30;
    // A fixed-power rider's W/kg is what they actually ride (for their tier badge).
    if (regular?.power) wkg = regular.power / mass;
    const tier = tierFor(wkg);
    const pick = (list) => list[Math.floor(r() * list.length)];
    const tierIndex = TIERS.indexOf(tier);
    return makeRider({
      name: regular?.name ?? `${pick(BOT_FIRST)} ${pick(BOT_LAST)}`,
      regular: !!regular,
      mass,
      wkg,
      tier,
      level: Math.max(1, Math.min(30, Math.round(3 + tierIndex * 5 + r() * 6))),
      intensity,
      seed: Math.floor(r() * 10000),
      kit: {
        jersey: pick(JERSEYS),
        helmet: pick(HELMETS),
        bike: BIKES[Math.min(BIKES.length - 1, Math.floor(r() * (2 + tierIndex * 1.2)))],
        wheels: WHEELS[Math.min(WHEELS.length - 1, Math.floor(r() * (1.5 + tierIndex)))],
        ...regular?.kit,
      },
      fixedPower: regular?.power ?? null,
      flames: !!regular?.flames,
      build: regular?.build ?? null,
      body: regular?.body ?? null,
      preferredLateral: (r() * 2 - 1) * this.roadHalf * 0.7,
      wPrime: 18000, // anaerobic reserve (J)
      surge: 0,
    });
  }

  setupFreeRide(count) {
    const r = this.random;
    this.player.d = 0;
    this.player.lateral = 0.6;
    // The regulars ride every day (Og Pog always), topped up with occasional visitors; small groups ride
    // together and everyone is spread round the loop. Mark Potts always rides too, on his own.
    const others = REGULARS.filter((x) => !x.fastest && !x.power).sort(() => r() - 0.5);
    const regulars = [REGULARS.find((x) => x.fastest), ...others].slice(0, Math.max(count, Math.min(REGULARS.length - 1, count + 4)));
    const riders = regulars.map((reg) => ({ reg, tier: TIERS.find((t) => t.id === reg.tier) }));
    for (let i = regulars.length; i < count; i++) riders.push({ reg: null, tier: TIERS[Math.floor(r() * TIERS.length)] });
    let i = 0;
    while (i < riders.length) {
      const groupSize = Math.min(riders.length - i, 1 + Math.floor(r() * 3));
      const at = i < 3 ? 25 + i * 14 : r() * this.L; // a few right by the start so there is company straight away
      const intensity = 0.62 + r() * 0.13;
      for (let k = 0; k < groupSize; k++, i++) {
        const { reg, tier } = riders[i];
        // Riders are set relative to your own level, so the road has some slower and some faster than you
        // whatever your fitness: each tier is a step up from the one below (Og Pog well ahead of everyone).
        const step = TIERS.indexOf(tier);
        const rel = reg?.fastest ? 1.75 : RELATIVE_TIER[step] * (0.95 + r() * 0.1);
        const bot = this.makeBot(Math.max(1.2, this.player.wkg * rel), intensity, reg);
        bot.tier = tierFor(bot.wkg);
        bot.d = at - k * (BIKE_LENGTH + 0.6 + r());
        bot.lateral = bot.targetLateral = bot.preferredLateral;
        bot.v = steadySpeed(bot.wkg * bot.mass * bot.intensity, this.route.gradient(bot.d), this.params(bot));
        bot.groupIntensity = reg?.fastest ? 0.86 : intensity; // Og Pog always rides hard
        this.riders.push(bot);
      }
    }
    // Mark Potts starts a little way back, so he comes past in a blaze of fire early on.
    for (const reg of REGULARS.filter((x) => x.power)) {
      const bot = this.makeBot(0, 1, reg);
      bot.d = -(140 + r() * 80);
      bot.preferredLateral = bot.lateral = bot.targetLateral = -0.5;
      bot.v = steadySpeed(bot.fixedPower, this.route.gradient(bot.d), this.params(bot));
      this.riders.push(bot);
    }
  }

  /**
   * The pacer ghosts, spread evenly round the loop so there is always one to find; `startWatts` puts that one just
   * ahead of you on the line. They weigh what you do and ride your bike, so at their watts you hold their pace.
   * In a race they line up behind the grid and set off with everyone, but take no place.
   */
  setupPacers(startWatts = null) {
    const race = this.race;
    const gridRows = race ? Math.ceil(this.riders.length / 3) : 0;
    const n = PACERS.length;
    const first = Math.max(0, PACERS.findIndex((x) => x.watts === startWatts));
    PACERS.forEach((pacer, i) => {
      const k = (i - first + n) % n; // the chosen one first, the rest in order of power round the loop
      const bot = makeRider({
        name: `${pacer.watts} W pacer`,
        pacer,
        fixedPower: pacer.watts,
        mass: this.player.mass,
        kit: this.player.kit,
        level: this.player.level,
        seed: i,
        intensity: 1,
      });
      bot.wkg = pacer.watts / bot.mass;
      bot.tier = tierFor(bot.wkg);
      bot.unplaced = true;
      if (race) {
        // Behind the grid in rows of three, the chosen one (if any) at the front of them.
        bot.d = race.startD - (gridRows + Math.floor(k / 3)) * 2.6;
        bot.preferredLateral = bot.lateral = bot.targetLateral = ((k % 3) - 1) * 1.15;
        bot.v = 0;
      } else {
        bot.d = startWatts != null && k === 0 ? 7 : this.L * ((k + (startWatts != null ? 0 : 0.5)) / n) + 12;
        bot.preferredLateral = bot.lateral = bot.targetLateral = 0.45;
        bot.v = steadySpeed(bot.fixedPower, this.route.gradient(bot.d), this.params(bot));
      }
      this.riders.push(bot);
    });
  }

  setupRace(race, seed) {
    const r = this.random;
    const preset = race ?? RACE_PRESETS[0];
    this.race = { preset, phase: 'grid', countdown: 10, start: null, results: [], distance: 0 };
    // Field: around the player's own level, from a bit weaker to a bit stronger, so it is a real race.
    // Field: spread by sustainable watts below and around your own FTP, so riding at FTP is mid-pack, an all-out
    // 30-minute effort (~5% over FTP) is podium contention, and beating Og Pog takes a great day;
    // each rider's weight then decides how they climb. Og Pog is always the strongest rider there.
    const base = this.ftp;
    const field = raceFieldSize(preset);
    const regulars = REGULARS.filter((x) => !x.fastest && !x.power).sort(() => r() - 0.5);
    for (let i = 0; i < field - 1; i++) {
      const spread = -0.32 + (0.33 * i) / Math.max(1, field - 2); // −32% … +1% of your FTP
      const reg = regulars[i] ?? null;
      const mass = reg?.mass ?? 58 + r() * 30;
      const watts = Math.max(80, base * (1 + spread + (r() - 0.5) * 0.04));
      const bot = this.makeBot(watts / mass, 1, reg ? { ...reg, mass } : null);
      bot.mass = mass;
      this.riders.push(bot);
    }
    const field0 = this.riders.slice(1);
    const bestWkg = Math.max(...field0.map((b) => b.wkg));
    const bestWatts = Math.max(...field0.map((b) => b.wkg * b.mass));
    const og = REGULARS[0];
    this.riders.push(this.makeBot(Math.max(bestWkg * 1.06, (Math.max(bestWatts * 1.13, base * 1.12)) / og.mass), 1, og));
    // Mark Potts rides every race at his 350 W, as a guest: he would win most of them, so he takes no place.
    const guests = REGULARS.filter((x) => x.power).map((reg) => Object.assign(this.makeBot(0, 1, reg), { unplaced: true }));
    // Race distance: what the player would cover at ~95% FTP with typical drafting in the set time, ending on the line.
    const p = this.params(this.player);
    let v = steadySpeed(this.ftp * 0.95, 0, p, 0.12);
    // Account for hills: average over the course.
    let t = 0;
    for (let d = 0; d < this.L; d += 20) t += 20 / Math.max(2, steadySpeed(this.ftp * 0.95, this.route.gradient(d), p, 0.12));
    v = this.L / t;
    const distance = Math.round((v * preset.minutes * 60) / 50) * 50;
    this.race.distance = distance;
    const startD = this.L * Math.ceil(distance / this.L) - distance; // so the finish is on the line
    this.race.startD = startD;
    this.race.finishD = startD + distance;
    // Grid: rows of three, the player in the second row.
    const order = this.riders.slice(1).sort(() => r() - 0.5);
    order.splice(4, 0, this.player);
    order.push(...guests); // from the back of the grid
    this.riders.push(...guests);
    order.forEach((rider, i) => {
      const row = Math.floor(i / 3), col = i % 3;
      rider.d = startD - row * 2.6;
      rider.lateral = rider.targetLateral = (col - 1) * 1.15;
      rider.v = 0;
    });
    // Bike perks that start you with a power-up.
    const perk = this.player.kit.bike.perk?.id;
    if (perk === 'start-hillhopper') this.player.held.push('hillhopper');
    if (perk === 'start-brew') this.player.held.push('brew');
  }

  params(rider) {
    const effects = { cda: rider.kit?.helmet?.aero ?? 1, mass: 0, power: 1, draft: rider.kit?.bike?.perk?.id === 'draft' ? 1.15 : 1 };
    for (const e of rider.effects) {
      const def = POWERUPS.find((x) => x.id === e.id);
      if (!def) continue;
      if (def.effect.cda) effects.cda *= def.effect.cda;
      if (def.effect.mass) effects.mass += def.effect.mass;
      if (def.effect.power) effects.power *= def.effect.power;
      if (def.effect.draft) effects.draft *= def.effect.draft;
    }
    return riderParams({ riderMass: rider.mass, bike: rider.kit?.bike, wheels: rider.kit?.wheels, effects, surface: this.route.surface(rider.d) });
  }

  // ---- Main step -----------------------------------------------------------------------------------

  /** input: {power (W, null = no data), cadence (rpm)}. Returns the events produced this step. */
  step(dt, input = {}) {
    this.events = [];
    if (!(dt > 0)) return this.events;
    dt = Math.min(dt, 1.0);
    this.time += dt;
    const racing = this.mode === 'race';
    const held = racing && (this.race.phase === 'grid' || this.race.phase === 'countdown');
    if (racing) this.stepRaceClock(dt);

    // Expire power-up effects.
    for (const rider of this.riders) rider.effects = rider.effects.filter((e) => e.until > this.time);

    // Player input.
    const p = this.player;
    const hasPower = input.power != null;
    p.power = hasPower ? Math.max(0, input.power) : 0;
    p.inputCadence = input.cadence ?? null;

    // Bot power decisions.
    for (const rider of this.riders) if (!rider.isPlayer && !rider.isGhost) this.botPower(rider, dt);

    // Drafting (computed from positions before moving).
    this.computeDrafts();

    // Move everyone.
    for (const rider of this.riders) {
      if (rider.isGhost) {
        this.moveGhost(rider);
        continue;
      }
      if (held || (racing && rider.finished && rider !== p && this.time - rider.finishTime - this.race.start > 20)) {
        rider.v = held ? 0 : Math.max(0, rider.v - 2 * dt);
      } else {
        const g = this.route.gradient(rider.d);
        rider.v = stepSpeed(rider.v, rider.power, g, dt, this.params(rider), rider.draft);
      }
      const before = rider.d;
      rider.d += rider.v * dt;
      rider.moved = rider.d - before;
      this.steer(rider, dt);
      // Animation state.
      const cad = rider.isPlayer ? (rider.inputCadence ?? cadenceFor(rider.power, this.route.gradient(rider.d))) : cadenceFor(rider.power, this.route.gradient(rider.d));
      rider.cadence = rider.power > 10 ? cad : 0;
      rider.crank = (rider.crank + (rider.cadence / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
      rider.wheel = (rider.wheel + (rider.v / 0.335) * dt) % (Math.PI * 2);
      const targetLean = Math.max(-0.45, Math.min(0.45, Math.atan((rider.v * rider.v * this.route.curvature(rider.d)) / 9.81)));
      rider.lean += (targetLean - rider.lean) * Math.min(1, dt * 4);
      this.collectPowerups(rider, before);
    }

    this.adapt(dt, hasPower);
    this.playerProgress(dt, hasPower, input);
    if (racing) this.updateRace();
    return this.events;
  }

  // ---- Adapting to the rider ------------------------------------------------------------------------

  /**
   * Keeps the bots right for the person actually riding, whatever FTP was set. In a race, once a couple of
   * minutes have passed, the whole field scales with your average power so far versus what the race was
   * planned for (positions still come down to effort). In free ride, after five minutes the bots follow your
   * recent power the same way. Also keeps an FTP estimate from your best 20- and 5-minute efforts.
   */
  adapt(dt, hasPower) {
    const p = this.player;
    this.logClock += dt;
    while (this.logClock >= 1) {
      this.logClock -= 1;
      if (this.race && this.race.phase !== 'racing') continue;
      this.powerLog.push(hasPower ? p.power : 0);
      if (this.powerLog.length > 3600) this.powerLog.shift();
      this.updateFtpEstimate();
    }
    this.adaptClock += dt;
    if (this.adaptClock < 5) return;
    this.adaptClock = 0;
    const log = this.powerLog;
    const avg = (n) => log.slice(-n).reduce((s, x) => s + x, 0) / Math.max(1, Math.min(n, log.length));
    let want = this.fieldScale;
    let ratio = null;
    if (this.race?.phase === 'racing' && log.length >= 120) ratio = avg(log.length) / this.ftp;
    else if (!this.race && log.length >= 300) ratio = avg(300) / (this.ftp * 0.75);
    if (ratio != null) {
      // Within ±15% of what was expected the field stays put, so your place is down to your effort. Beyond that
      // (a wrong FTP) it follows part of the way, so you are never left miles behind or miles clear.
      const band = 0.15;
      const outside = ratio > 1 + band ? ratio / (1 + band) : ratio < 1 - band ? ratio / (1 - band) : 1;
      want = Math.max(0.7, Math.min(1.45, outside ** 0.85));
    }
    // Ease towards it so nobody suddenly surges or stalls.
    this.fieldScale += (want - this.fieldScale) * 0.25;
  }

  updateFtpEstimate() {
    const log = this.powerLog;
    const best = (n) => {
      if (log.length < n) return 0;
      let s = 0;
      for (let i = log.length - n; i < log.length; i++) s += log[i];
      return s / n;
    };
    // Checked every 30 s: 95% of a 20-minute average, or 82% of a 5-minute one.
    if (log.length % 30 !== 0) return;
    const estimate = Math.round(Math.max(best(1200) * 0.95, best(300) * 0.82));
    const prof = this.profile;
    if (estimate >= 60 && (prof.ftpEstimate == null || estimate > prof.ftpEstimate + 2)) {
      const previous = prof.ftpEstimate ?? null;
      prof.ftpEstimate = estimate;
      if (previous != null || log.length >= 1200) this.events.push({ type: 'ftp', ftp: estimate, previous });
    }
  }

  // ---- Bots ----------------------------------------------------------------------------------------

  botPower(bot, dt) {
    if (bot.fixedPower != null) {
      // Exactly the same watts on every road, never scaled to the field, no surges or sprints. (Pacers ride
      // your bike at your weight, so their watts mean the same for you.)
      if (bot.pacer) bot.mass = this.player.mass;
      bot.power = this.race && this.race.phase !== 'racing' && this.race.phase !== 'finished' ? 0 : bot.fixedPower;
      return;
    }
    const ftp = bot.wkg * bot.mass;
    const g = this.route.gradient(bot.d);
    const n = valueNoise(this.time / 25, bot.seed % 97, bot.seed); // slow variation 0..1
    if (this.mode !== 'race') {
      // Endurance pace that varies a little, a touch harder uphill, easing on descents.
      const intensity = (bot.groupIntensity ?? bot.intensity) * (0.9 + 0.2 * n) * (g > 0.02 ? 1.08 : g < -0.03 ? 0.4 : 1);
      bot.power = ftp * intensity * this.fieldScale;
      return;
    }
    const race = this.race;
    if (race.phase !== 'racing' || bot.finished) {
      bot.power = bot.finished ? ftp * 0.4 : 0;
      return;
    }
    const remaining = race.finishD - bot.d;
    let target = ftp * (0.96 + 0.08 * n);
    if (g > 0.03) target *= 1.06;
    if (g < -0.03) target *= 0.55;
    // Occasional attacks while there is energy left.
    if (bot.surge > 0) {
      bot.surge -= dt;
      target = ftp * 1.35;
    } else if (bot.wPrime > 12000 && remaining > 1500 && this.random() < dt / 240) {
      bot.surge = 12 + this.random() * 18;
    }
    // Finishing sprint.
    if (remaining < 450 && bot.wPrime > 3000) target = ftp * (1.5 + 0.4 * (bot.wkg / 6));
    // W' balance: above FTP drains it, below refills it; an empty tank forces an easier pace.
    if (target > ftp) bot.wPrime -= (target - ftp) * dt;
    else bot.wPrime = Math.min(18000, bot.wPrime + (ftp - target) * dt * 0.6);
    if (bot.wPrime < 0) {
      bot.wPrime = 0;
      target = ftp * 0.85;
      bot.surge = 0;
    }
    bot.power = target * this.fieldScale;
    // Race power-ups: use them where they help.
    if (bot.held.length && (g > 0.03 || remaining < 1200 || this.random() < dt / 60)) {
      const id = bot.held[0];
      if ((id !== 'hillhopper' || g > 0.03) && (id !== 'brew' || remaining < 1200)) this.usePowerup(bot);
    }
  }

  moveGhost(ghost) {
    const data = ghost.ghostData;
    if (this.lapStart == null) {
      ghost.hidden = true;
      return;
    }
    const t = this.time - this.lapStart;
    const s = data.samples;
    const i = Math.min(s.length - 2, Math.floor(t));
    const f = Math.min(1, t - i);
    const lapPos = t >= s.length - 1 ? s[s.length - 1] : s[i] + (s[i + 1] - s[i]) * f;
    const prev = ghost.d;
    ghost.d = this.lapStartDistance - this.L + lapPos;
    ghost.v = Math.max(0, (s[Math.min(s.length - 1, i + 1)] - s[i]) || 0);
    ghost.hidden = t > s.length + 3;
    ghost.lateral = -0.9;
    ghost.power = 200;
    ghost.cadence = ghost.v > 1 ? 88 : 0;
    ghost.crank = (ghost.crank + (ghost.cadence / 60) * Math.PI * 2 * 0.016) % (Math.PI * 2);
    ghost.wheel = (ghost.wheel + (Math.max(0, ghost.d - prev) / 0.335)) % (Math.PI * 2);
  }

  // ---- Drafting and steering ------------------------------------------------------------------------

  computeDrafts() {
    const list = this.riders.filter((r) => !r.isGhost);
    for (const a of list) {
      let best = 0, ahead = 0;
      for (const b of list) {
        if (a === b) continue;
        if (b.effects.some((e) => e.id === 'umbrella')) continue; // the Brolly stops anyone drafting
        if (b.regular && b.name === 'Og Pog') continue; // nobody can hold Og Pog's wheel
        let gap = b.d - a.d;
        if (this.mode === 'free') gap = ((gap % this.L) + this.L) % this.L;
        gap -= BIKE_LENGTH;
        if (gap < -0.5 || gap > 12) continue;
        ahead += 1;
        best = Math.max(best, draftFraction(Math.max(0, gap), b.lateral - a.lateral, 1));
      }
      const draftBoost = this.params(a).draftFactor;
      a.draft = Math.min(0.5, best * Math.min(1.25, 1 + 0.06 * Math.max(0, ahead - 1)) * draftBoost);
    }
  }

  /** Keeps riders on the road and passing each other rather than through each other. */
  steer(rider, dt) {
    if (rider.isGhost) return;
    const half = this.roadHalf;
    let target = rider.isPlayer ? (rider.steerTarget ?? 0.6) : rider.preferredLateral ?? 0;
    // Head for a power-up just ahead.
    if (rider.isPlayer || this.mode === 'race') {
      const lapPos = this.route.wrap(rider.d);
      for (const s of this.spots) {
        const ahead = s.at - lapPos;
        if (ahead > 0 && ahead < 70 && rider.lastSpot !== this.spots.indexOf(s)) {
          target = s.lateral;
          break;
        }
      }
    }
    // Someone right in front and we are faster: move out.
    for (const other of this.riders) {
      if (other === rider || other.isGhost) continue;
      let gap = other.d - rider.d;
      if (this.mode === 'free') gap = ((gap % this.L) + this.L) % this.L;
      if (gap > 0 && gap < 5 && Math.abs(other.lateral - target) < 0.75 && rider.v > other.v - 0.3) {
        target = other.lateral + (other.lateral > 0 ? -1.0 : 1.0);
      }
    }
    target = Math.max(-half + 0.4, Math.min(half - 0.4, target));
    rider.targetLateral = target;
    const rate = 1.2 * dt;
    rider.lateral += Math.max(-rate, Math.min(rate, target - rider.lateral));
  }

  // ---- Power-ups -----------------------------------------------------------------------------------

  collectPowerups(rider, before) {
    if (rider.isGhost) return;
    const L = this.L;
    const a = ((before % L) + L) % L, b = ((rider.d % L) + L) % L;
    this.spots.forEach((s, i) => {
      const crossed = a <= b ? s.at > a && s.at <= b : s.at > a || s.at <= b;
      if (!crossed) return;
      const reach = rider.kit?.bike?.perk?.id === 'magnet' ? 3.2 : 1.6;
      if (Math.abs(rider.lateral - s.lateral) > reach) return;
      rider.lastSpot = i;
      const capacity = rider.kit?.bike?.perk?.id === 'pannier' ? 2 : 1;
      if (!rider.isPlayer && this.mode !== 'race') return;
      if (!rider.isPlayer && this.random() > 0.55) return;
      if (rider.held.length >= capacity) return;
      const id = this.randomPowerup(rider);
      rider.held.push(id);
      if (rider.isPlayer) this.events.push({ type: 'pickup', powerup: POWERUPS.find((x) => x.id === id) });
    });
  }

  randomPowerup(rider) {
    const lucky = rider.kit?.bike?.perk?.id === 'lucky';
    const weights = POWERUPS.map((x) => (x.rarity === 1 ? 3 : lucky ? 2 : 1));
    let t = this.random() * weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < POWERUPS.length; i++) {
      t -= weights[i];
      if (t <= 0) return POWERUPS[i].id;
    }
    return POWERUPS[0].id;
  }

  /** Uses the first held power-up. Returns the power-up used, or null. */
  usePowerup(rider = this.player) {
    const id = rider.held.shift();
    if (!id) return null;
    const def = POWERUPS.find((x) => x.id === id);
    const longer = rider.kit?.bike?.perk?.id === 'longlife' ? 1.3 : 1;
    rider.effects.push({ id, until: this.time + def.duration * longer, duration: def.duration * longer });
    if (rider.isPlayer) {
      this.events.push({ type: 'powerup', powerup: def });
      this.events.push(...P.recordPowerupUsed(this.profile));
    }
    return def;
  }

  // ---- Player progress: XP, segments, PRs, ghost, landmarks -----------------------------------------

  playerProgress(dt, hasPower, input) {
    const p = this.player;
    const L = this.L;
    const prevD = p.d - p.moved;
    const riding = hasPower && p.moved > 0 && !(this.race && this.race.phase !== 'racing');
    if (riding) {
      const climb = Math.max(0, this.route.elevation(p.d) - this.route.elevation(prevD));
      this.events.push(...P.recordRiding(this.profile, { distance: p.moved, time: dt, climb, speed: p.v, drafting: p.draft > 0.1 }));
    }
    // Overtakes: bots we were behind and are now ahead of.
    for (const b of this.riders) {
      if (b === p || b.isGhost || b.pacer) continue;
      let rel = b.d - p.d;
      if (this.mode === 'free') {
        rel = ((rel % L) + L) % L;
        if (rel > L / 2) rel -= L;
      }
      const ahead = rel > 0;
      if (b.wasAhead && !ahead && Math.abs(rel) < 20 && riding) this.events.push(...P.recordOvertake(this.profile));
      b.wasAhead = ahead;
    }
    // Segment attempts in progress: a jump along the road (not ridden) voids them; otherwise add this step.
    const jumped = this.lastPlayerD != null && Math.abs(prevD - this.lastPlayerD) > 0.5;
    this.lastPlayerD = p.d;
    if (jumped) {
      for (const att of this.segmentState.values()) this.events.push({ type: 'segment-void', segment: att.seg, reason: 'jump' });
      this.segmentState.clear();
    }
    for (const att of this.segmentState.values()) this.trackAttempt(att, dt, hasPower, input);
    if (!(p.moved > 0)) return;
    const a = ((prevD % L) + L) % L, b = ((p.d % L) + L) % L;
    const crossed = (x) => (a <= b ? x > a && x <= b : x > a || x <= b);
    // How far past x the rider is, and so when x was crossed (linear within the step).
    const past = (x) => (((b - x) % L) + L) % L;
    const when = (x) => this.time - dt * Math.min(1, past(x) / p.moved);

    // The lap line.
    if (b < a) {
      if (this.lapStart != null && this.mode === 'free') this.finishLap();
      this.startAttempt(this.route.segments[0], when(0), p.d - past(0));
      this.lapStart = this.time - (b / Math.max(0.1, p.v));
      this.lapStartDistance = p.d - b + L;
      this.lapSamples = [b];
      this.sampleClock = 0;
      this.checkpointIndex = -1;
      this.events.push({ type: 'lap', lap: Math.floor(p.d / L) });
    } else if (this.lapStart != null) {
      this.sampleClock += dt;
      while (this.sampleClock >= 1) {
        this.sampleClock -= 1;
        this.lapSamples.push(b);
      }
    }

    // Segments (zones, climbs, timed segments): finish any whose end was crossed, then start any entered.
    for (const seg of this.route.segments) {
      if (seg.kind === 'lap') continue;
      const from = ((seg.from % L) + L) % L, to = ((seg.to % L) + L) % L;
      if (crossed(to) && this.segmentState.has(seg.id)) {
        const att = this.segmentState.get(seg.id);
        this.segmentState.delete(seg.id);
        const done = this.finishAttempt(att, when(to), p.d - past(to));
        if (!done) {
          this.events.push({ type: 'segment-void', segment: seg, reason: 'incomplete' });
        } else {
          const { time } = done;
          const medal = medalFor(seg, time);
          const { events, previous, improved } = P.recordSegment(this.profile, this.route.id, seg, time);
          const result = E.recordAttempt(this.profile, this.route.id, seg, { ...done, world: this.route.world });
          this.events.push({ type: 'segment-end', segment: seg, time, medal, previous, improved, speed: (seg.to - seg.from) / time, result }, ...events);
          this.events.push(...P.recordMedal(this.profile, this.route.id, seg, medal, this.route.zones));
        }
      }
      if (crossed(from)) {
        this.startAttempt(seg, when(from), p.d - past(from));
        this.events.push({ type: 'segment-start', segment: seg, pr: E.prFor(this.profile, this.route.id, seg)?.time ?? null });
      }
    }

    // Live delta against your PR lap at each checkpoint.
    if (this.lapStart != null) {
      this.route.checkpoints.forEach((cp, i) => {
        if (!crossed(cp) || i === this.checkpointIndex) return;
        this.checkpointIndex = i;
        const ghostTime = timeAtDistance(this.profile.ghosts?.[this.route.id]?.samples, cp);
        if (ghostTime != null) this.events.push({ type: 'checkpoint', at: cp, delta: this.time - this.lapStart - ghostTime });
      });
    }

    // Landmarks.
    this.route.landmarks.forEach((m, i) => {
      if (crossed(((m.at % L) + L) % L) && i !== this.lastLandmark) {
        this.lastLandmark = i;
        this.events.push({ type: 'banner', text: m.text });
      }
    });
  }

  finishLap() {
    const time = this.time - this.lapStart;
    const lap = this.route.segments[0];
    // The lap counts only when it was ridden all the way round from the line (no jumps).
    const att = this.segmentState.get(lap.id);
    this.segmentState.delete(lap.id);
    const done = att && this.finishAttempt(att, this.time, att.d0 + this.L);
    if (!done) return;
    const ghost = this.profile.ghosts?.[this.route.id];
    const beatGhost = ghost && time < ghost.time;
    const { events, previous, improved } = P.recordSegment(this.profile, this.route.id, lap, time);
    const result = E.recordAttempt(this.profile, this.route.id, lap, { ...done, time, world: this.route.world });
    this.events.push({ type: 'segment-end', segment: lap, time, previous, improved, result }, ...events);
    if (beatGhost) this.events.push(...P.grant(this.profile, 'ghost'));
    if (!ghost || time < ghost.time) {
      this.lapSamples.push(this.L);
      (this.profile.ghosts ??= {})[this.route.id] = { time, samples: this.lapSamples.map((x) => Math.round(x * 10) / 10) };
    }
    this.events.push(...P.grant(this.profile, this.route.world === 'york' ? 'york-lap' : 'dales-lap'));
  }

  // ---- Segment attempts ----------------------------------------------------------------------------

  /** Starts timing a segment entered at sim time t0, at the player's (unwrapped) distance d0. */
  startAttempt(seg, t0, d0) {
    this.segmentState.set(seg.id, { seg, t0, d0, elapsed: 0, energy: 0, powerTime: 0, hrSum: 0, hrTime: 0, splits: [] });
  }

  /** Adds one step to an attempt in progress: power, heart rate, and the time at each 5% of the distance. */
  trackAttempt(att, dt, hasPower, input) {
    const p = this.player;
    att.elapsed += dt;
    if (hasPower) {
      att.energy += p.power * dt;
      att.powerTime += dt;
    }
    const hr = input.heartRate;
    if (Number.isFinite(hr) && hr > 30 && hr < 250) {
      att.hrSum += hr * dt;
      att.hrTime += dt;
    }
    const len = att.seg.to - att.seg.from;
    while (att.splits.length < E.SPLITS) {
      const mark = att.d0 + (len * (att.splits.length + 1)) / E.SPLITS;
      if (p.d < mark) break;
      const t = p.moved > 0 ? this.time - dt * Math.min(1, (p.d - mark) / p.moved) : this.time;
      att.splits.push(Math.max(0, t - att.t0));
    }
  }

  /**
   * Ends an attempt left at sim time t1, at distance d1. Returns {time, power, hr, splits}, or null when it
   * does not count: not ridden the whole way from the start (a jump or skip), or mostly without power data.
   */
  finishAttempt(att, t1, d1) {
    const len = att.seg.to - att.seg.from;
    const time = t1 - att.t0;
    if (!(time > 0) || Math.abs(d1 - att.d0 - len) > Math.max(5, len * 0.02)) return null;
    if (att.powerTime < 0.8 * att.elapsed) return null;
    const power = att.powerTime > 0 ? att.energy / att.powerTime : null;
    const hr = att.hrTime >= 0.5 * att.elapsed && att.hrTime > 0 ? att.hrSum / att.hrTime : null;
    return { time, power, hr, splits: att.splits.length === E.SPLITS ? att.splits : null };
  }

  /**
   * For the HUD: segments in progress (elapsed time, how far through, live delta against your PR) and the
   * next one to start within `lookahead` metres, of the given kinds (zone, kom, segment; never the lap).
   */
  segmentStatus(lookahead = 300, kinds = ['zone', 'kom', 'segment']) {
    const p = this.player, L = this.L, pos = this.route.wrap(p.d);
    const active = [];
    for (const att of this.segmentState.values()) {
      if (!kinds.includes(att.seg.kind)) continue;
      const len = att.seg.to - att.seg.from;
      const fraction = Math.max(0, Math.min(1, (p.d - att.d0) / len));
      const elapsed = Math.max(0, this.time - att.t0);
      const pr = E.prFor(this.profile, this.route.id, att.seg);
      const delta = pr && fraction > 0.02 ? elapsed - E.prTimeAt(pr, fraction) : null;
      active.push({ segment: att.seg, elapsed, fraction, delta, pr, remaining: Math.max(0, len - (p.d - att.d0)) });
    }
    let upcoming = null;
    for (const seg of this.route.segments) {
      if (!kinds.includes(seg.kind) || this.segmentState.has(seg.id)) continue;
      const ahead = (((seg.from - pos) % L) + L) % L;
      if (ahead <= lookahead && (!upcoming || ahead < upcoming.distance)) upcoming = { segment: seg, distance: ahead, pr: E.prFor(this.profile, this.route.id, seg) };
    }
    return { active, upcoming };
  }

  // ---- Race ----------------------------------------------------------------------------------------

  stepRaceClock(dt) {
    const race = this.race;
    if (race.phase === 'countdown') {
      const before = Math.ceil(race.countdown);
      race.countdown -= dt;
      const after = Math.ceil(race.countdown);
      if (after !== before && after <= 5 && after > 0) this.events.push({ type: 'countdown', n: after });
      if (race.countdown <= 0) {
        race.phase = 'racing';
        race.start = this.time;
        this.events.push({ type: 'go' });
      }
    }
  }

  /** Starts the countdown from the grid. */
  startCountdown(seconds = 10) {
    if (this.race?.phase === 'grid') {
      this.race.phase = 'countdown';
      this.race.countdown = seconds;
    }
  }

  updateRace() {
    const race = this.race;
    if (race.phase !== 'racing' && race.phase !== 'finished') return;
    const elapsed = this.time - race.start;
    for (const r of this.riders) {
      if (r.isGhost || r.unplaced || r.finished || r.d < race.finishD) continue;
      // Interpolate the exact moment the line was crossed.
      const over = (r.d - race.finishD) / Math.max(0.1, r.v);
      r.finished = true;
      r.finishTime = Math.max(0, elapsed - over);
      race.results.push(r);
      race.results.sort((x, y) => x.finishTime - y.finishTime);
      if (r.isPlayer) {
        race.phase = 'finished';
        const place = race.results.indexOf(r) + 1;
        race.playerPlace = place;
        const field = this.riders.filter((x) => !x.isGhost && !x.unplaced).length;
        this.events.push({ type: 'race-finish', place, time: r.finishTime, field });
        this.events.push(...P.recordRace(this.profile, place, field));
      }
    }
  }

  /** Riders in race order: finishers by time, then by distance covered. Guests (Mark Potts) take no place. */
  standings() {
    const list = this.riders.filter((r) => !r.isGhost);
    if (this.mode !== 'race') return list.sort((a, b) => b.d - a.d);
    return list.filter((r) => !r.unplaced).sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.d - a.d;
    });
  }

  /** Final or projected results: [{rider, time, projected}] sorted, for the leaderboard. */
  leaderboard() {
    const race = this.race;
    const elapsed = race.start == null ? 0 : this.time - race.start;
    return this.standings().map((r) => ({
      rider: r,
      time: r.finished ? r.finishTime : elapsed + (race.finishD - r.d) / Math.max(1, (r.d - race.startD) / Math.max(1, elapsed)),
      projected: !r.finished,
    })).sort((a, b) => a.time - b.time);
  }
}

/** Time (s) into a lap at which the samples (distance per second) reach `distance`, or null. */
export function timeAtDistance(samples, distance) {
  if (!samples || samples.length < 2) return null;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] >= distance) {
      const a = samples[i - 1], b = samples[i];
      return i - 1 + (b > a ? (distance - a) / (b - a) : 0);
    }
  }
  return null;
}
