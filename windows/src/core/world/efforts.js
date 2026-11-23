// Segment efforts: every time the rider completes a segment (a timed segment, a speed zone, the KOM or the
// lap) the attempt is kept in the game profile with its date, time, average power and heart rate, so rides
// can be compared over weeks. Pure functions on the profile object, unit tested.
//
//   profile.efforts[routeId][segmentId] = {
//     sig,              // the segment's geometry when these attempts were ridden ("from:length", metres)
//     attempts: [...],  // oldest first, the last MAX_ATTEMPTS
//     best,             // the fastest ever (kept even when it falls out of `attempts`), with splits
//   }
//   attempt = { date (ISO), time (s), power (W | null), hr (bpm | null), world, splits? (s at each 5%) }

export const MAX_ATTEMPTS = 50;
export const SPLITS = 20; // splits at every 5% of the distance, for the live delta against your PR

/** Geometry signature: attempts ridden on a segment of a different start or length are not comparable. */
export function segmentSig(seg) {
  return `${Math.round(seg.from)}:${Math.round(seg.to - seg.from)}`;
}

/**
 * Turns the old best-only PRs (`profile.prs`) into history: each becomes the first attempt, without power
 * or heart rate. Their geometry is not known yet (sig null): the first ride on the course adopts it.
 */
export function migrateEfforts(p, raw) {
  const efforts = raw?.efforts && typeof raw.efforts === 'object' ? raw.efforts : {};
  const clean = {};
  for (const [routeId, segs] of Object.entries(efforts)) {
    if (!segs || typeof segs !== 'object') continue;
    for (const [segId, e] of Object.entries(segs)) {
      if (!e || typeof e !== 'object') continue;
      const attempts = Array.isArray(e.attempts) ? e.attempts.filter(validAttempt).slice(-MAX_ATTEMPTS) : [];
      const best = validAttempt(e.best) ? e.best : bestOf(attempts);
      if (!attempts.length && !best) continue;
      (clean[routeId] ??= {})[segId] = { sig: typeof e.sig === 'string' ? e.sig : null, attempts, best };
    }
  }
  for (const [routeId, segs] of Object.entries(p.prs ?? {})) {
    if (!segs || typeof segs !== 'object') continue;
    for (const [segId, pr] of Object.entries(segs)) {
      if (clean[routeId]?.[segId] || !(Number.isFinite(pr?.time) && pr.time > 0)) continue;
      const date = typeof pr.date === 'string' && Number.isFinite(Date.parse(pr.date)) ? pr.date : new Date(0).toISOString();
      const first = { date, time: pr.time, power: null, hr: null, world: routeId };
      (clean[routeId] ??= {})[segId] = { sig: null, attempts: [first], best: first };
    }
  }
  p.efforts = clean;
}

function validAttempt(a) {
  return !!a && typeof a === 'object' && Number.isFinite(a.time) && a.time > 0 && typeof a.date === 'string';
}

function bestOf(list) {
  let best = null;
  for (const a of list) if (!best || a.time < best.time) best = a;
  return best;
}

/**
 * Makes the stored history match the course as built now: history (and the PR and medal) of any segment
 * whose geometry has changed is dropped rather than compared; migrated history adopts today's geometry.
 */
export function syncSegments(p, route) {
  p.efforts ??= {};
  const byRoute = p.efforts[route.id];
  if (!byRoute) return;
  for (const seg of route.segments) {
    const e = byRoute[seg.id];
    if (!e) continue;
    const sig = segmentSig(seg);
    if (e.sig == null) e.sig = sig;
    else if (e.sig !== sig) {
      delete byRoute[seg.id];
      if (p.prs?.[route.id]) delete p.prs[route.id][seg.id];
      if (p.medals?.[route.id]) delete p.medals[route.id][seg.id];
      if (seg.kind === 'lap' && p.ghosts) delete p.ghosts[route.id];
    }
  }
}

/** The stored history for a segment, or null. */
export function effortsFor(p, routeId, seg) {
  const e = p.efforts?.[routeId]?.[seg.id];
  if (!e) return null;
  if (e.sig != null && e.sig !== segmentSig(seg)) return null;
  return e;
}

/** Your PR on a segment: {time, date, power, hr, splits?} or null. */
export function prFor(p, routeId, seg) {
  return effortsFor(p, routeId, seg)?.best ?? null;
}

/**
 * Records a completed attempt. Returns {attempt, previousBest, last, isPR, count} where previousBest and
 * last are as they stood before this attempt (null the first time).
 */
export function recordAttempt(p, routeId, seg, { time, power = null, hr = null, splits = null, world = routeId }, now = new Date()) {
  p.efforts ??= {};
  const byRoute = (p.efforts[routeId] ??= {});
  const sig = segmentSig(seg);
  let e = byRoute[seg.id];
  if (!e || (e.sig != null && e.sig !== sig)) e = byRoute[seg.id] = { sig, attempts: [], best: null };
  e.sig = sig;
  const attempt = {
    date: now.toISOString(),
    time: Math.round(time * 10) / 10,
    power: Number.isFinite(power) ? Math.round(power) : null,
    hr: Number.isFinite(hr) ? Math.round(hr) : null,
    world,
  };
  const previousBest = e.best ?? null;
  const last = e.attempts[e.attempts.length - 1] ?? null;
  const isPR = !previousBest || attempt.time < previousBest.time;
  e.attempts.push(attempt);
  if (e.attempts.length > MAX_ATTEMPTS) e.attempts.splice(0, e.attempts.length - MAX_ATTEMPTS);
  if (isPR) {
    // Only the PR keeps its splits (for the live delta next time); older PRs drop theirs.
    if (previousBest) delete previousBest.splits;
    const best = { ...attempt };
    if (Array.isArray(splits) && splits.length === SPLITS) best.splits = splits.map((x) => Math.round(x * 10) / 10);
    e.best = best;
  }
  return { attempt, previousBest, last, isPR, count: e.attempts.length };
}

/** Every stored attempt, newest first, each flagged `isPR`; the PR is included even if it is older than the rest. */
export function attemptList(p, routeId, seg) {
  const e = effortsFor(p, routeId, seg);
  if (!e) return [];
  const list = e.attempts.map((a) => ({ ...a, isPR: false }));
  const best = e.best;
  if (best) {
    const i = list.findIndex((a) => a.date === best.date && a.time === best.time);
    if (i >= 0) list[i].isPR = true;
    else list.unshift({ ...best, isPR: true });
  }
  return list.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

/** How many attempts are stored (at least 1 when there is a PR). */
export function attemptCount(p, routeId, seg) {
  return attemptList(p, routeId, seg).length;
}

/** Time your PR took to reach `fraction` (0..1) of the segment: from its splits, else pro rata. */
export function prTimeAt(best, fraction) {
  if (!best) return null;
  const f = Math.max(0, Math.min(1, fraction));
  const s = best.splits;
  if (!Array.isArray(s) || s.length !== SPLITS) return best.time * f;
  const x = f * SPLITS;
  const i = Math.min(SPLITS - 1, Math.floor(x));
  const a = i === 0 ? 0 : s[i - 1], b = s[i];
  return a + (b - a) * (x - i);
}

// ---- Formatting ------------------------------------------------------------------------------------

/** m:ss (h:mm:ss past an hour). */
export function clock(seconds) {
  if (!Number.isFinite(seconds)) return '--';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A time difference as m:ss without sign (tenths under a second: "0:00.4"). */
export function gap(seconds) {
  const a = Math.abs(seconds);
  if (a < 0.95) return `0:00.${Math.min(9, Math.round(a * 10))}`;
  return clock(a);
}

/** Signed: "−0:06" when faster (negative), "+0:04" when slower. */
export function signedGap(seconds) {
  return `${seconds < 0 ? '−' : '+'}${gap(seconds)}`;
}

/** DD/MM, with the year only when it is not this year (DD/MM/YYYY). Local time. */
export function dayMonth(iso, now = new Date()) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '--';
  const dm = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  return d.getFullYear() === now.getFullYear() ? dm : `${dm}/${d.getFullYear()}`;
}

/** Length and average gradient: "760 m · 0.7%" or "1.5 km · −9.2%". */
export function lengthAndGrade(seg, units = 'metric') {
  const len = seg.to - seg.from;
  const grade = seg.grade ?? 0;
  const lap = seg.kind === 'lap';
  const g = `${grade < -0.0005 ? '−' : ''}${Math.abs(grade * 100).toFixed(1)}%`;
  let l;
  if (units === 'imperial') l = len < 1609 * 0.5 ? `${Math.round(len * 1.0936)} yd` : `${(len / 1609.344).toFixed(2)} mi`;
  else l = len < 1000 ? `${Math.round(len / 10) * 10} m` : `${(len / 1000).toFixed(1)} km`;
  return lap ? l : `${l} · ${g}`;
}

/**
 * The comparison line for a finished attempt: "PR by 0:06", "+0:04 on PR (3:38, 12/11)" or "First time".
 * Also how it compares with the last attempt.
 */
export function comparison(result, now = new Date()) {
  const { attempt, previousBest, last, isPR } = result;
  let pr;
  if (!previousBest) pr = 'First time';
  else if (isPR) pr = `PR by ${gap(previousBest.time - attempt.time)}`;
  else pr = `${signedGap(attempt.time - previousBest.time)} on PR (${clock(previousBest.time)}, ${dayMonth(previousBest.date, now)})`;
  let vsLast = null;
  // Against the last attempt too, unless that was the PR (already said above).
  if (last && !(previousBest && last.date === previousBest.date && last.time === previousBest.time)) {
    const d = attempt.time - last.time;
    vsLast = `${Math.abs(d) < 0.05 ? 'Same as' : `${signedGap(d)} on`} last time (${clock(last.time)}, ${dayMonth(last.date, now)})`;
  }
  return { pr, vsLast };
}

/** One line: "Cove Road Ramp — 3:42 · 205 W · 152 bpm · 23/11 · PR by 0:06". */
export function summaryLine(seg, result, now = new Date()) {
  const a = result.attempt;
  const parts = [clock(a.time)];
  if (a.power != null) parts.push(`${a.power} W`);
  if (a.hr != null) parts.push(`${a.hr} bpm`);
  parts.push(dayMonth(a.date, now), comparison(result, now).pr);
  return `${seg.name} — ${parts.join(' · ')}`;
}
