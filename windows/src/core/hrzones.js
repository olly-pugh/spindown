// Heart-rate zones as a percentage of maximum heart rate, the way Garmin does it ("Based On: % of Max").
// Five zones; each starts at a percentage of max HR and runs up to where the next starts (zone 5 up to max).
// Garmin's defaults are 50/60/70/80/90 %.

export const DEFAULT_ZONE_PERCENTS = [50, 60, 70, 80, 90];
/** Max heart rate used until one is entered (the rider this app is for: 196 bpm on his Garmin). */
export const DEFAULT_MAX_HR = 196;

export const ZONE_COLORS = ['#8e8e93', '#0a84ff', '#34c759', '#ff9f0a', '#ff453a'];
export const ZONE_NAMES = ['Warm Up', 'Easy', 'Aerobic', 'Threshold', 'Maximum'];

export const MIN_MAX_HR = 100;
export const MAX_MAX_HR = 230;

/** True when there is a usable max heart rate and five rising percentages below 100. */
export function zonesConfigured(maxHR, percents) {
  return validMaxHR(maxHR) && validPercents(percents);
}

export function validMaxHR(maxHR) {
  return Number.isFinite(maxHR) && maxHR >= MIN_MAX_HR && maxHR <= MAX_MAX_HR;
}

export function validPercents(p) {
  return Array.isArray(p) && p.length === 5 && p.every((x, i) => Number.isFinite(x) && x > 0 && x < 100 && (i === 0 || x > p[i - 1]));
}

/** The beats per minute for a percentage of max (Garmin rounds to the nearest beat). */
export function bpmFor(maxHR, percent) {
  return Math.round((maxHR * percent) / 100);
}

/** The percentage of max for a heart rate, to one decimal place. */
export function percentFor(maxHR, bpm) {
  return Math.round((bpm / maxHR) * 1000) / 10;
}

/** The five zones: [{zone: 1..5, low, high, lowPercent, highPercent}] in bpm. Each zone's high is the next one's low. */
export function zoneBounds(maxHR, percents = DEFAULT_ZONE_PERCENTS) {
  return percents.map((p, i) => ({
    zone: i + 1,
    low: bpmFor(maxHR, p),
    high: i < 4 ? bpmFor(maxHR, percents[i + 1]) : maxHR,
    lowPercent: p,
    highPercent: i < 4 ? percents[i + 1] : 100,
  }));
}

/** The zone (1–5) a heart rate is in, 0 below zone 1, or null when there is no heart rate or no zones. */
export function zoneFor(hr, maxHR, percents = DEFAULT_ZONE_PERCENTS) {
  if (hr == null || !(hr > 0) || !zonesConfigured(maxHR, percents)) return null;
  let zone = 0;
  for (let i = 0; i < 5; i++) if (hr >= bpmFor(maxHR, percents[i])) zone = i + 1;
  return zone;
}

/** Zone as a decimal (e.g. 3.4 = 40 % of the way through zone 3), as Garmin shows it. null like zoneFor. */
export function zoneDecimal(hr, maxHR, percents = DEFAULT_ZONE_PERCENTS) {
  const zone = zoneFor(hr, maxHR, percents);
  if (zone == null) return null;
  if (zone === 0) return Math.max(0, hr / bpmFor(maxHR, percents[0]));
  const lo = bpmFor(maxHR, percents[zone - 1]);
  const hi = zone < 5 ? bpmFor(maxHR, percents[zone]) : maxHR;
  return Math.min(5.9, zone + (hi > lo ? Math.min(0.9, (hr - lo) / (hi - lo)) : 0));
}

/** Seconds spent in each zone over a ride's samples ({dt, heartRate}). [below zone 1, z1, z2, z3, z4, z5]. */
export function timeInZones(samples, maxHR, percents = DEFAULT_ZONE_PERCENTS) {
  const out = [0, 0, 0, 0, 0, 0];
  if (!zonesConfigured(maxHR, percents)) return null;
  for (const s of samples) {
    const z = zoneFor(s.heartRate, maxHR, percents);
    if (z != null) out[z] += s.dt ?? 1;
  }
  return out;
}

/**
 * Changing one boundary in the settings. Typing either the bpm or the % works, as on a Garmin; the value is kept
 * between its neighbours so the zones always rise. Returns the new percentages.
 */
export function setBoundary(percents, index, { percent, bpm }, maxHR) {
  const p = [...percents];
  let v = percent ?? (bpm != null && validMaxHR(maxHR) ? percentFor(maxHR, bpm) : null);
  if (!Number.isFinite(v)) return p;
  const lo = index === 0 ? 1 : p[index - 1] + 1;
  const hi = index === 4 ? 99 : p[index + 1] - 1;
  p[index] = Math.round(Math.min(hi, Math.max(lo, v)) * 10) / 10;
  return p;
}
