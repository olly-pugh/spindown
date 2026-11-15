// The virtual Lake District loop and structured workouts. Ports of LakeRoute.swift and Workouts.swift.
// Purely visual: it never affects the trainer, the recording or uploads.

export const LAP_LENGTH = 32000;

export const LANDMARKS = [
  { name: 'Bowness-on-Windermere', distance: 0, kind: 'start', message: 'Rolling out from Windermere!' },
  { name: 'Ambleside', distance: 8000, kind: 'village', message: 'Welcome to Ambleside' },
  { name: 'Rydal Water', distance: 10500, kind: 'lake', message: "Rydal Water — Wordsworth's favourite" },
  { name: 'Grasmere', distance: 13000, kind: 'village', message: 'Grasmere — gingerbread time?' },
  { name: 'Dunmail Raise', distance: 17500, kind: 'pass', message: 'King of Dunmail Raise! 238 m' },
  { name: 'Thirlmere', distance: 21000, kind: 'lake', message: 'Thirlmere — Helvellyn on your right' },
  { name: 'Castlerigg Stone Circle', distance: 28000, kind: 'sight', message: 'Castlerigg Stone Circle' },
  { name: 'Keswick', distance: 31000, kind: 'village', message: 'Keswick and Derwentwater — lap complete soon!' },
];

const LAKES = [
  [0, 6000], // Windermere
  [10000, 11200], // Rydal Water
  [12200, 13600], // Grasmere
  [19500, 24000], // Thirlmere
  [30300, 32000], // Derwentwater
];

export function lapDistance(odometer) {
  const d = odometer % LAP_LENGTH;
  return d < 0 ? d + LAP_LENGTH : d;
}

export function lap(odometer) {
  return Math.floor(Math.max(0, odometer) / LAP_LENGTH) + 1;
}

/** How much lake is beside the road here, 0...1, with 400 m fades at each shore. */
export function lakeAmount(odometer) {
  const d = lapDistance(odometer);
  let best = 0;
  for (const [start, end] of LAKES) {
    const fade = 400;
    const rise = (d - start) / fade;
    const fall = (end - d) / fade;
    best = Math.max(best, Math.min(1, Math.max(0, Math.min(rise + (start === 0 ? 1 : 0), fall))));
  }
  return best;
}

/** How close a village is, 0...1 (cottages appear within 600 m of one). */
export function villageAmount(odometer) {
  const d = lapDistance(odometer);
  let best = 0;
  for (const l of LANDMARKS) {
    if (l.kind !== 'village' && l.kind !== 'start') continue;
    const gap = Math.min(Math.abs(d - l.distance), Math.abs(d - l.distance - LAP_LENGTH), Math.abs(d - l.distance + LAP_LENGTH));
    best = Math.max(best, Math.max(0, 1 - gap / 600));
  }
  return best;
}

const PROFILE = [
  [0, 45], [8000, 55], [10500, 60], [13000, 65], [17500, 238],
  [21000, 180], [26000, 150], [28000, 210], [31000, 80], [32000, 45],
];

/** Approximate road height in metres: lakeside ~50 m rising to Dunmail Raise (238 m). */
export function elevation(odometer) {
  const d = lapDistance(odometer);
  let h = PROFILE[PROFILE.length - 1][1];
  for (let i = 0; i < PROFILE.length - 1; i++) {
    if (d >= PROFILE[i][0] && d <= PROFILE[i + 1][0]) {
      const [d0, h0] = PROFILE[i];
      const [d1, h1] = PROFILE[i + 1];
      const f = (d - d0) / (d1 - d0);
      h = h0 + (h1 - h0) * (0.5 - 0.5 * Math.cos(f * Math.PI));
    }
  }
  return h + 4 * Math.sin(d / 230) + 2 * Math.sin(d / 71);
}

/** Next landmark ahead and the distance to it (wrapping into the next lap). */
export function nextLandmark(odometer) {
  const d = lapDistance(odometer);
  const next = LANDMARKS.find((l) => l.distance > d + 1);
  if (next) return [next, next.distance - d];
  return [LANDMARKS[0], LAP_LENGTH - d];
}

/** Landmarks passed when moving from `from` to `to` metres (for celebration banners). */
export function landmarksPassed(from, to) {
  if (!(to > from) || !(to - from < LAP_LENGTH)) return [];
  const out = [];
  const lapStart = Math.floor(from / LAP_LENGTH) * LAP_LENGTH;
  for (const offset of [0, LAP_LENGTH]) {
    for (const l of LANDMARKS) {
      const at = lapStart + offset + l.distance;
      if (at > from && at <= to) out.push(l);
    }
  }
  return out;
}

// ---- Workouts --------------------------------------------------------------------------------------
// Targets are fractions of FTP. Guidance only: the inRide has no resistance control.

const step = (kind, minutes, low, high, label) => ({ kind, duration: minutes * 60, low, high, label });
const repeats = (n, block) => Array.from({ length: n }, () => block).flat();

export function targetWatts(s, ftp) {
  const lo = Math.round(ftp * s.low);
  const hi = Math.round(ftp * s.high);
  return [lo, Math.max(lo, hi)];
}

export function workoutDuration(w) {
  return w.steps.reduce((a, s) => a + s.duration, 0);
}

/** Where the rider is after `elapsed` seconds of riding the workout. */
export function workoutPosition(w, elapsed) {
  let t = Math.max(0, elapsed);
  const duration = workoutDuration(w);
  for (let i = 0; i < w.steps.length; i++) {
    const s = w.steps[i];
    if (t < s.duration) {
      return {
        index: i, step: s, elapsedInStep: t, remainingInStep: s.duration - t,
        next: i + 1 < w.steps.length ? w.steps[i + 1] : null, isComplete: false,
        fractionOfWorkout: Math.min(1, elapsed / duration),
      };
    }
    t -= s.duration;
  }
  const last = w.steps[w.steps.length - 1];
  return { index: w.steps.length - 1, step: last, elapsedInStep: last.duration, remainingInStep: 0, next: null, isComplete: true, fractionOfWorkout: 1 };
}

export const WORKOUTS = [
  {
    id: 'windermere', name: 'Windermere Warm-Up', tagline: '25 min · easy spin with three short openers',
    steps: [step('warmup', 5, 0.5, 0.6, 'Easy spin'), step('steady', 10, 0.6, 0.7, 'Lakeside cruise'),
      ...repeats(3, [step('work', 1, 0.95, 1.05, 'Opener'), step('recover', 2, 0.5, 0.6, 'Recover')]),
      step('cooldown', 1, 0.45, 0.55, 'Cool down')],
  },
  {
    id: 'kirkstone', name: 'Kirkstone Pass', tagline: '50 min · 3 × 8 min threshold climbs',
    steps: [step('warmup', 10, 0.5, 0.65, 'Warm up'),
      ...repeats(3, [step('work', 8, 0.88, 0.94, 'Climb the pass'), step('recover', 4, 0.5, 0.6, 'Descend')]),
      step('cooldown', 4, 0.45, 0.55, 'Cool down')],
  },
  {
    id: 'sprints', name: 'Fell Sprints', tagline: '36 min · 8 × 30 s all-out sprints',
    steps: [step('warmup', 10, 0.5, 0.65, 'Warm up'),
      ...repeats(8, [step('work', 0.5, 1.3, 1.7, 'SPRINT!'), step('recover', 1.5, 0.45, 0.55, 'Spin easy')]),
      step('steady', 5, 0.65, 0.75, 'Steady'), step('cooldown', 5, 0.45, 0.55, 'Cool down')],
  },
  {
    id: 'honister', name: 'Honister Hammer', tagline: '45 min · 5 × 3 min VO2 max efforts',
    steps: [step('warmup', 10, 0.5, 0.65, 'Warm up'),
      ...repeats(5, [step('work', 3, 1.1, 1.2, 'Hammer it'), step('recover', 3, 0.45, 0.55, 'Recover')]),
      step('cooldown', 5, 0.45, 0.55, 'Cool down')],
  },
  {
    id: 'tempo', name: 'Lakeside Tempo', tagline: '55 min · 2 × 15 min tempo',
    steps: [step('warmup', 10, 0.5, 0.65, 'Warm up'),
      ...repeats(2, [step('work', 15, 0.76, 0.87, 'Tempo'), step('recover', 5, 0.5, 0.6, 'Easy')]),
      step('cooldown', 5, 0.45, 0.55, 'Cool down')],
  },
];

const hashCache = new Map();

/** Deterministic 0..<1 hash, so scenery is the same every time you pass a spot. Port of GameMath.hash. */
export function hash01(n) {
  n = Math.trunc(n);
  const cached = hashCache.get(n);
  if (cached !== undefined) return cached;
  let x = BigInt.asUintN(64, BigInt(n) + 0x9e3779b97f4a7c15n);
  x = BigInt.asUintN(64, (x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n);
  x = BigInt.asUintN(64, (x ^ (x >> 27n)) * 0x94d049bb133111ebn);
  x ^= x >> 31n;
  const v = Number(x % 1000000n) / 1000000;
  if (hashCache.size > 50000) hashCache.clear();
  hashCache.set(n, v);
  return v;
}

/** Smooth ridge profile for fells: sum of sines, peaked. */
export function ridge(u, seed) {
  const a = 0.55 * Math.sin(u * 0.0071 + seed);
  const b = 0.3 * Math.sin(u * 0.0173 + seed * 2.3);
  const c = 0.15 * Math.sin(u * 0.0419 + seed * 4.1);
  const v = (a + b + c + 1) / 2;
  return Math.pow(Math.max(0, v), 1.6);
}
