// The courses: the Yorkshire Dales loop (procedural countryside) and York (built from OpenStreetMap data).
// Each course has segments (speed zones, climbs, the lap), checkpoints for live PR deltas, power-up spots
// and landmarks for on-screen banners.
import { Route } from './route.js';
import { fbm } from './noise.js';
import { riderParams, stepSpeed, steadySpeed } from './physics.js';

// ---- Yorkshire Dales -------------------------------------------------------------------------------

const DALES_SEED = 1873;

/** The Dales loop centreline: a star-shaped closed curve (never crosses itself) with bends. */
function dalesPoints() {
  const pts = [];
  const N = 720;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const r = 1250 * (1 + 0.22 * Math.sin(2 * t + 0.6) + 0.12 * Math.sin(3 * t + 2.1) + 0.05 * Math.sin(7 * t + 0.3) + 0.022 * Math.sin(13 * t + 1.7));
    pts.push(Math.sin(t) * r, -Math.cos(t) * r);
  }
  return pts;
}

/**
 * Road height along the Dales loop (metres): the village by the river at the start, a long drag up the fell
 * to a summit at ~3.4 km, a fast descent, rolling moor and a short sharp climb before dropping back home.
 */
export function dalesProfile(d, L) {
  const f = d / L;
  const bump = (centre, width, height) => {
    const x = (f - centre) / width;
    return Math.abs(x) >= 1 ? 0 : height * (0.5 + 0.5 * Math.cos(Math.PI * x));
  };
  return 140
    + bump(0.37, 0.24, 115) // the fell climb and descent
    + bump(0.66, 0.06, 28) // rolling moor
    + bump(0.78, 0.05, 22)
    + bump(0.895, 0.05, 20) // short sharp climb
    + 6 * (fbm(f * 40, 3.3, 3, DALES_SEED) - 0.5);
}

export function makeDales() {
  const points = dalesPoints();
  let L = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    L += Math.hypot(points[j] - points[i], points[j + 1] - points[i + 1]);
  }
  const route = new Route({ id: 'dales', name: 'Dales Loop', points, elevation: (d) => dalesProfile(d, L), step: 2 });
  L = route.length;
  return withCourse(route, {
    world: 'dales',
    title: 'Yorkshire Dales',
    blurb: 'Stone walls, sheep and a proper climb up the fell.',
    village: { from: L - 260, to: 420, name: 'Thornby' },
    river: { at: 0.03 * L, name: 'River Thorn' },
    landmarks: [
      { at: 0, name: 'Thornby village green', text: 'Welcome to Thornby' },
      { at: 0.03 * L, name: 'Thorn Bridge', text: 'Over the old packhorse bridge' },
      { at: 0.2 * L, name: 'Foot of the fell', text: 'The climb starts here: 3 km to the top' },
      { at: 0.37 * L, name: 'Fell Top', text: 'Fell Top — what a view!' },
      { at: 0.66 * L, name: 'High Moor', text: 'Out on the moor' },
      { at: 0.855 * L, name: 'Kirk Bank', text: 'Kirk Bank: short and steep' },
    ],
    segments: [
      { id: 'fell', name: 'Fell Climb', kind: 'kom', from: 0.2 * L, to: 0.37 * L },
      { id: 'kirk', name: 'Kirk Bank', kind: 'kom', from: 0.855 * L, to: 0.895 * L },
      { id: 'valley-sprint', name: 'Valley Speed Trap', kind: 'zone', from: 0.055 * L, to: 0.055 * L + 400 },
      { id: 'village-sprint', name: 'Village Sprint', kind: 'zone', from: 0.94 * L, to: 0.94 * L + 300 },
    ],
  });
}

// ---- York ------------------------------------------------------------------------------------------

/** York data (x east, y north in metres) to world points (x east, z south). */
export function yorkWorldPoints(flat) {
  const out = new Array(flat.length);
  for (let i = 0; i < flat.length; i += 2) {
    out[i] = flat[i];
    out[i + 1] = -flat[i + 1];
  }
  return out;
}

export function makeYork(data) {
  const points = yorkWorldPoints(data.route.points);
  // Bridges over the Ouse get a gentle hump; the rest of York is flat (about 12 m above sea level).
  const bridges = ['lendalBridge', 'skeldergateBridge'].map((k) => data.landmarks?.[k]).filter(Boolean).map((b) => ({ x: b.x, z: -b.y }));
  const elevation = (_d, x, z) => {
    let h = 12;
    for (const b of bridges) {
      const r = Math.hypot(x - b.x, z - b.z);
      if (r < 70) h += 3.2 * (0.5 + 0.5 * Math.cos((Math.PI * r) / 70));
    }
    return h;
  };
  const route = new Route({ id: 'york', name: data.route.name ?? 'York Inner Ring', points, elevation, step: 2 });
  const L = route.length;
  const near = (lm) => (lm ? route.nearest(lm.x, -lm.y).along : null);
  const marks = [
    { at: 0, name: 'Start / finish', text: 'York — the inner ring' },
    { at: near(data.landmarks?.minster), name: 'York Minster', text: 'York Minster on your left' },
    { at: near(data.landmarks?.lendalBridge), name: 'Lendal Bridge', text: 'Over the Ouse on Lendal Bridge' },
    { at: near(data.landmarks?.skeldergateBridge), name: 'Skeldergate Bridge', text: 'Skeldergate Bridge' },
    { at: near(data.landmarks?.cliffordsTower), name: "Clifford's Tower", text: "Clifford's Tower up on its mound" },
  ].filter((m) => m.at != null);
  return withCourse(route, {
    world: 'york',
    title: 'York',
    blurb: "Real streets: the city walls, the Minster, the Ouse bridges and Clifford's Tower.",
    landmarks: marks.sort((a, b) => a.at - b.at),
    streets: data.route.streets ?? [],
    segments: [
      { id: 'walls-sprint', name: 'City Walls Sprint', kind: 'zone', from: 0.12 * L, to: 0.12 * L + 400 },
      { id: 'ouse-sprint', name: 'Ouse Speed Trap', kind: 'zone', from: 0.45 * L, to: 0.45 * L + 350 },
      { id: 'tower-sprint', name: 'Tower Dash', kind: 'zone', from: 0.72 * L, to: 0.72 * L + 300 },
    ],
  });
}

/** Common course furniture: the lap segment, checkpoints every 500 m, power-up spots and zone thresholds. */
function withCourse(route, course) {
  const L = route.length;
  route.course = course;
  route.world = course.world;
  route.title = course.title;
  route.blurb = course.blurb;
  route.landmarks = course.landmarks;
  route.segments = [{ id: 'lap', name: `${course.title} lap`, kind: 'lap', from: 0, to: L }, ...course.segments.map((s) => ({ ...s, ...medalThresholds(route, s) }))];
  route.zones = route.segments.filter((s) => s.kind === 'zone' || s.kind === 'kom');
  route.checkpoints = [];
  for (let d = 500; d < L - 100; d += 500) route.checkpoints.push(d);
  route.powerupSpots = [];
  for (let d = 350; d < L - 150; d += 1100) route.powerupSpots.push(d);
  return route;
}

/**
 * Medal times for a zone: the time a rider at a given power would take (gold ~4.5 W/kg-ish effort, silver ~3.5,
 * bronze ~2.6 for a 75 kg rider), worked out by riding the zone with the physics model. Stored as seconds.
 */
const MEDAL_POWER = { gold: 340, silver: 265, bronze: 195 };

function medalThresholds(route, seg) {
  const p = riderParams();
  const medals = {};
  for (const [medal, power] of Object.entries(MEDAL_POWER)) {
    let v = steadySpeed(power, route.gradient(seg.from - 30), p);
    let d = seg.from, t = 0;
    const dt = 0.25;
    while (d < seg.to && t < 3600) {
      v = stepSpeed(v, power, route.gradient(d), dt, p);
      d += v * dt;
      t += dt;
    }
    medals[medal] = Math.round(t * 10) / 10;
  }
  return { medals, length: seg.to - seg.from };
}

/** Medal for a time through a zone, or null. */
export function medalFor(seg, time) {
  if (!seg.medals) return null;
  if (time <= seg.medals.gold) return 'gold';
  if (time <= seg.medals.silver) return 'silver';
  if (time <= seg.medals.bronze) return 'bronze';
  return null;
}
