// The rider's game profile: XP, level, unlocked and equipped kit, achievements, challenges, PRs and ghosts.
// A plain JSON object, saved by the main process as game.json. Everything here is pure and unit tested.
import { ITEMS, ACHIEVEMENTS, CHALLENGES, levelFor, xpForLevel, MAX_LEVEL } from './content.js';

export const PROFILE_VERSION = 1;

export function newProfile() {
  return {
    version: PROFILE_VERSION,
    xp: 0,
    equipped: { jersey: 'classic', helmet: 'basic', bike: 'tourer', wheels: 'training' },
    achievements: {}, // id -> ISO date
    challenges: { active: [], done: 0 },
    stats: { distance: 0, time: 0, climb: 0, races: 0, wins: 0, podiums: 0, powerupsUsed: 0, draftTime: 0, maxSpeed: 0, medals: 0, overtakes: 0, rideDays: [] },
    prs: {}, // routeId -> segmentId -> {time, date}
    medals: {}, // routeId -> zoneId -> 'bronze'|'silver'|'gold' (best)
    ghosts: {}, // routeId -> {time, samples: [distance at each second]}
    courses: {}, // routeId -> course version the PRs, medals and ghost above were set on
    settings: { quality: 'auto', camera: 'chase', timeOfDay: 'morning', weather: 'fair', sound: true, riderMass: 75, units: null, startPacer: null },
    lastRoute: 'york',
    ftpEstimate: null, // watts, from your best efforts in the game
  };
}

/** Fills in anything missing (older or damaged files), keeping what is valid. */
export function migrateProfile(raw) {
  const p = newProfile();
  if (!raw || typeof raw !== 'object') return p;
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  p.xp = Math.max(0, num(raw.xp, 0));
  for (const slot of Object.keys(p.equipped)) if (typeof raw.equipped?.[slot] === 'string') p.equipped[slot] = raw.equipped[slot];
  if (raw.achievements && typeof raw.achievements === 'object') p.achievements = { ...raw.achievements };
  if (Array.isArray(raw.challenges?.active)) p.challenges.active = raw.challenges.active.filter((c) => CHALLENGES.some((x) => x.id === c.id)).map((c) => ({ id: c.id, progress: num(c.progress, 0) }));
  p.challenges.done = num(raw.challenges?.done, 0);
  for (const k of Object.keys(p.stats)) {
    if (k === 'rideDays') p.stats.rideDays = Array.isArray(raw.stats?.rideDays) ? raw.stats.rideDays.slice(-30) : [];
    else p.stats[k] = num(raw.stats?.[k], 0);
  }
  if (raw.prs && typeof raw.prs === 'object') p.prs = raw.prs;
  if (raw.medals && typeof raw.medals === 'object') p.medals = raw.medals;
  if (raw.ghosts && typeof raw.ghosts === 'object') p.ghosts = raw.ghosts;
  if (raw.courses && typeof raw.courses === 'object') p.courses = { ...raw.courses };
  if (raw.settings && typeof raw.settings === 'object') p.settings = { ...p.settings, ...raw.settings };
  if (typeof raw.lastRoute === 'string') p.lastRoute = raw.lastRoute;
  if (Number.isFinite(raw.ftpEstimate) && raw.ftpEstimate > 40 && raw.ftpEstimate < 600) p.ftpEstimate = raw.ftpEstimate;
  // Never leave something equipped that is not unlocked.
  for (const slot of Object.keys(p.equipped)) if (!isUnlocked(p, slot, p.equipped[slot])) p.equipped[slot] = ITEMS[slot][0].id;
  ensureChallenges(p);
  return p;
}

export const level = (p) => levelFor(p.xp);

/** Progress through the current level, 0..1, and XP to the next one. */
export function levelProgress(p) {
  const n = level(p);
  if (n >= MAX_LEVEL) return { level: n, fraction: 1, toNext: 0 };
  const lo = xpForLevel(n), hi = xpForLevel(n + 1);
  return { level: n, fraction: (p.xp - lo) / (hi - lo), toNext: hi - p.xp };
}

export function isUnlocked(p, slot, id) {
  const item = ITEMS[slot]?.find((i) => i.id === id);
  if (!item) return false;
  if (item.achievement) return !!p.achievements[item.achievement];
  return level(p) >= item.level;
}

export function equip(p, slot, id) {
  if (!isUnlocked(p, slot, id)) return false;
  p.equipped[slot] = id;
  return true;
}

export function item(slot, id) {
  return ITEMS[slot].find((i) => i.id === id) ?? ITEMS[slot][0];
}

export function equipment(p) {
  return { jersey: item('jersey', p.equipped.jersey), helmet: item('helmet', p.equipped.helmet), bike: item('bike', p.equipped.bike), wheels: item('wheels', p.equipped.wheels) };
}

/** Items that become available exactly at level n. */
export function unlocksAtLevel(n) {
  const out = [];
  for (const [slot, list] of Object.entries(ITEMS)) for (const i of list) if (!i.achievement && i.level === n && n > 1) out.push({ slot, item: i });
  return out;
}

/**
 * Adds XP and returns events: [{type:'xp', amount, reason}, {type:'level', level, unlocks}].
 */
export function addXP(p, amount, reason) {
  if (!(amount > 0)) return [];
  const before = level(p);
  p.xp += Math.round(amount);
  const events = [{ type: 'xp', amount: Math.round(amount), reason }];
  const after = level(p);
  for (let n = before + 1; n <= after; n++) {
    events.push({ type: 'level', level: n, unlocks: unlocksAtLevel(n) });
    for (const id of ['level-10', 'level-20', 'level-30']) if (n >= Number(id.split('-')[1])) events.push(...grant(p, id));
  }
  return events;
}

/** Grants an achievement once; returns its events (including its XP). */
export function grant(p, id, now = new Date()) {
  if (p.achievements[id]) return [];
  const a = ACHIEVEMENTS.find((x) => x.id === id);
  if (!a) return [];
  p.achievements[id] = now.toISOString();
  return [{ type: 'achievement', achievement: a }, ...addXP(p, a.xp, a.name)];
}

/** Keeps three challenges active, choosing ones not active yet in a fixed rotation. */
export function ensureChallenges(p) {
  let k = p.challenges.done;
  let guard = 0;
  while (p.challenges.active.length < 3 && guard++ < 50) {
    const c = CHALLENGES[(k++ * 7 + 3) % CHALLENGES.length];
    if (!p.challenges.active.some((a) => a.id === c.id)) p.challenges.active.push({ id: c.id, progress: 0 });
  }
}

/** Adds to a challenge metric; completes and replaces challenges. Returns events. */
export function progressChallenges(p, metric, amount) {
  if (!(amount > 0)) return [];
  const events = [];
  for (const a of [...p.challenges.active]) {
    const c = CHALLENGES.find((x) => x.id === a.id);
    if (!c || c.metric !== metric) continue;
    a.progress += amount;
    if (a.progress >= c.goal) {
      p.challenges.active = p.challenges.active.filter((x) => x !== a);
      p.challenges.done += 1;
      events.push({ type: 'challenge', challenge: c }, ...addXP(p, c.xp, c.name));
    }
  }
  ensureChallenges(p);
  return events;
}

/**
 * Records riding progress (one call per simulation tick or per second). Returns events.
 * delta: {distance (m), time (s), climb (m), speed (m/s), drafting (bool)}
 */
export function recordRiding(p, delta, now = new Date()) {
  const events = [];
  const s = p.stats;
  const beforeKm = Math.floor(s.distance / 1000);
  s.distance += delta.distance;
  s.time += delta.time;
  s.climb += delta.climb;
  if (delta.drafting) s.draftTime += delta.time;
  if (delta.speed > s.maxSpeed) s.maxSpeed = delta.speed;
  const km = Math.floor(s.distance / 1000);
  if (km > beforeKm) events.push(...addXP(p, (km - beforeKm) * 20, 'Distance'));
  // Time and climbing XP accumulate fractionally in the stats; award whole points as they build up.
  p._xpCarry = (p._xpCarry ?? 0) + (delta.time / 60) * 2 + delta.climb * 0.5;
  if (p._xpCarry >= 10) {
    const whole = Math.floor(p._xpCarry);
    p._xpCarry -= whole;
    events.push(...addXP(p, whole, 'Riding'));
  }
  events.push(...progressChallenges(p, 'distance', delta.distance));
  events.push(...progressChallenges(p, 'time', delta.time));
  events.push(...progressChallenges(p, 'climb', delta.climb));
  if (delta.drafting) events.push(...progressChallenges(p, 'draftTime', delta.time));
  if (s.distance >= 1000) events.push(...grant(p, 'first-km', now));
  if (s.distance >= 10000) events.push(...grant(p, 'ten-km', now));
  if (s.distance >= 100000) events.push(...grant(p, 'hundred-km', now));
  if (s.distance >= 1000000) events.push(...grant(p, 'thousand-km', now));
  if (s.climb >= 1000) events.push(...grant(p, 'everest-lite', now));
  if (s.draftTime >= 300) events.push(...grant(p, 'draft-5', now));
  if (delta.speed * 3.6 >= 50) events.push(...grant(p, 'speed-50', now));
  if (delta.speed * 3.6 >= 65) events.push(...grant(p, 'speed-65', now));
  return events;
}

/** Called once when a ride session in the world starts: day streaks and early-bird. */
export function noteRideDay(p, now = new Date()) {
  const events = [];
  const day = now.toISOString().slice(0, 10);
  const days = p.stats.rideDays;
  if (days[days.length - 1] !== day) days.push(day);
  if (days.length > 30) days.splice(0, days.length - 30);
  if (now.getHours() < 7) events.push(...grant(p, 'early-bird', now));
  // Three consecutive calendar days at the end of the list.
  if (days.length >= 3) {
    const t = days.slice(-3).map((d) => Date.parse(d));
    if (t[2] - t[1] === 86400000 && t[1] - t[0] === 86400000) events.push(...grant(p, 'streak-3', now));
  }
  return events;
}

export function recordPowerupUsed(p) {
  p.stats.powerupsUsed += 1;
  const events = progressChallenges(p, 'powerupsUsed', 1);
  if (p.stats.powerupsUsed >= 10) events.push(...grant(p, 'powerups-10'));
  return events;
}

export function recordOvertake(p, n = 1) {
  p.stats.overtakes += n;
  const events = progressChallenges(p, 'overtakes', n);
  if (p.stats.overtakes >= 50) events.push(...grant(p, 'overtake-50'));
  return events;
}

/** A race result for the player: place (1-based) out of `field`. */
export function recordRace(p, place, field) {
  const events = [];
  p.stats.races += 1;
  events.push(...addXP(p, 150 + Math.max(0, field - place) * 10, 'Race finish'));
  events.push(...progressChallenges(p, 'races', 1));
  events.push(...grant(p, 'race-finish'));
  if (place <= 3) {
    p.stats.podiums += 1;
    events.push(...addXP(p, [400, 250, 150][place - 1], `Race: ${['1st', '2nd', '3rd'][place - 1]}`));
    events.push(...grant(p, 'race-podium'));
  }
  if (place === 1) {
    p.stats.wins += 1;
    events.push(...grant(p, 'race-win'));
  }
  return events;
}

/**
 * When a course is rebuilt (a new version), PRs, medals and the ghost set on the old one no longer mean
 * anything: clear them for that route once. Courses without a version are left alone.
 */
export function syncCourse(p, routeId, version) {
  if (!version) return;
  p.courses ??= {};
  if (p.courses[routeId] === version) return;
  delete p.prs[routeId];
  delete p.medals[routeId];
  delete p.ghosts[routeId];
  p.courses[routeId] = version;
}

/** A segment or zone time; returns {events, previous, improved}. Lower time is better. */
export function recordSegment(p, routeId, segment, time, now = new Date()) {
  const byRoute = (p.prs[routeId] ??= {});
  const previous = byRoute[segment.id]?.time ?? null;
  const events = [];
  let improved = false;
  if (previous == null || time < previous) {
    byRoute[segment.id] = { time, date: now.toISOString() };
    improved = true;
    if (previous != null) events.push({ type: 'pr', segment, time, previous }, ...addXP(p, 50, `PR: ${segment.name}`), ...grant(p, 'pr', now));
  }
  return { events, previous, improved };
}

const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3 };

/** A medal in a speed zone or climb. Returns events. */
export function recordMedal(p, routeId, zone, medal, zonesOnRoute) {
  if (!medal) return [];
  const events = [{ type: 'medal', zone, medal }];
  p.stats.medals += 1;
  events.push(...addXP(p, { bronze: 25, silver: 50, gold: 100 }[medal], `${medal[0].toUpperCase()}${medal.slice(1)}: ${zone.name}`));
  const byRoute = (p.medals[routeId] ??= {});
  if (!byRoute[zone.id] || MEDAL_RANK[medal] > MEDAL_RANK[byRoute[zone.id]]) byRoute[zone.id] = medal;
  if (medal === 'gold') events.push(...grant(p, zone.kind === 'kom' ? 'gold-kom' : 'gold-zone'));
  if (zonesOnRoute && zonesOnRoute.every((z) => byRoute[z.id])) events.push(...grant(p, 'all-zones'));
  events.push(...progressChallenges(p, 'medals', 1));
  return events;
}

/** Strips transient fields before saving. */
export function serialiseProfile(p) {
  const { _xpCarry, ...rest } = p;
  return JSON.stringify(rest);
}
