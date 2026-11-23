// The courses: Malham in the Yorkshire Dales and York, both built from OpenStreetMap and open terrain data.
// Each course has segments (speed zones, climbs, the lap), checkpoints for live PR deltas, power-up spots
// and landmarks for on-screen banners.
import { Route } from './route.js';
import { riderParams, stepSpeed, steadySpeed } from './physics.js';
import { HeightGrid } from './heightgrid.js';
import { BIKES, WHEELS } from './content.js';

// ---- Yorkshire Dales: Malham ---------------------------------------------------------------------
//
// A real loop from Malham village (data from scripts/build-dales.mjs: OpenStreetMap roads and features, road
// heights from the Mapzen/AWS terrain tiles): up Cove Road past Malham Cove, across the limestone plateau on
// Henside Road below Malham Tarn, along the lane to Street Gate, then down Malham Rakes back into the village.

/** The first named feature in the data matching `re` (optionally of the given kinds), or null. */
function feature(data, re, kinds = null) {
  return (data.names ?? []).find((n) => re.test(n.n) && (!kinds || kinds.includes(n.k))) ?? null;
}

export function makeDales(data) {
  if (!data?.route) throw new Error('makeDales needs the Malham map data (src/renderer/game3d/data/dales.json)');
  const points = yorkWorldPoints(data.route.points);
  // Road height: the elevation profile from the build (one value per point, decimetres), by distance.
  const cum = [0];
  for (let i = 2; i < points.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]));
  const elev = data.route.elev;
  const elevation = (d) => {
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const f = cum[hi] > cum[lo] ? Math.min(1, Math.max(0, (d - cum[lo]) / (cum[hi] - cum[lo]))) : 0;
    return (elev[lo] + (elev[hi] - elev[lo]) * f) / 10;
  };
  const route = new Route({ id: 'dales', name: 'Malham Cove and Tarn', points, elevation, step: 2 });
  route.version = `malham-${Math.round(route.length)}`;
  const L = route.length;
  const street = (name) => (data.route.streets ?? []).find((s) => s.n === name);
  const cove = street('Cove Road') ?? { from: 0, to: 0.4 * L };
  const rakes = street('Malham Rakes') ?? { from: 0.66 * L, to: 0.97 * L };
  const henside = street('Henside Road') ?? { from: 0.42 * L, to: 0.56 * L };

  // The climb: from the last low point at the foot of Cove Road to the summit of the loop.
  let top = cove.from, topY = -Infinity;
  for (let d = cove.from; d <= cove.to + 400; d += 4) if (route.elevation(d) > topY) [top, topY] = [d, route.elevation(d)];
  let foot = cove.from, footY = Infinity;
  for (let d = cove.from; d < top - 600; d += 4) if (route.elevation(d) <= footY) [foot, footY] = [d, route.elevation(d)];
  const climbLen = top - foot, climbGain = topY - footY;
  // The KOM is the steep heart of it, past the Cove: the 1.6 km with the most height gained.
  let komFrom = foot, best = -Infinity;
  for (let d = foot; d + 1600 <= top; d += 10) {
    const gain = route.elevation(d + 1600) - route.elevation(d);
    if (gain > best) [best, komFrom] = [gain, d];
  }
  const komTo = komFrom + 1600;

  // Where a named feature is nearest the road, and on which side.
  const near = (f) => {
    if (!f) return null;
    const n = route.nearest(f.x, -f.y);
    const p = route.position(n.along);
    const side = (f.x - p.x) * Math.cos(p.heading) + (-f.y - p.z) * Math.sin(p.heading) > 0 ? 'right' : 'left';
    return { at: n.along, side, distance: n.distance };
  };
  const cliff = near(feature(data, /^Malham Cove$/, ['cliff']));
  const tarn = near(feature(data, /^Malham Tarn$/, ['water']));
  const gordale = near(feature(data, /^Gordale Scar$/, ['attraction', 'viewpoint', 'information']));
  const sinks = near(feature(data, /^Water Sinks$/, ['parking']));
  const streetGate = near(feature(data, /^Street Gate$/, ['locality']));
  const landmarks = [
    { at: 0, name: 'Malham', text: 'Malham: the Buck Inn, the beck and the green' },
    { at: komFrom, name: 'Cove Road', text: `Cove Road climb: ${((komTo - komFrom) / 1000).toFixed(1)} km at ${Math.round(best / 16)}%, ${(climbLen / 1000).toFixed(1)} km to the top` },
    cliff && { at: Math.max(foot + 60, cliff.at), name: 'Malham Cove', text: `Malham Cove, the great limestone cliff, on your ${cliff.side}` },
    { at: top, name: 'Top of Cove Road', text: `Top of Cove Road, ${Math.round(topY)} m` },
    sinks && { at: sinks.at, name: 'Water Sinks', text: 'Water Sinks, where the stream from the tarn drops underground' },
    tarn && { at: tarn.at, name: 'Malham Tarn', text: `Malham Tarn up on the moor to your ${tarn.side}` },
    streetGate && { at: streetGate.at, name: 'Street Gate', text: 'Street Gate, on the old Mastiles Lane drove road' },
    { at: rakes.from + 160, name: 'Malham Rakes', text: 'Down Malham Rakes: steep, take care' },
    gordale && { at: gordale.at, name: 'Gordale Scar', text: `Gordale Scar's gorge away to your ${gordale.side}` },
    { at: L - 60, name: 'New Bridge', text: 'Over Malham Beck into the village' },
  ].filter(Boolean).sort((a, b) => a.at - b.at);

  // Speed trap on the flattest 400 m of the plateau.
  let trap = henside.from + 100, flattest = Infinity;
  for (let d = henside.from + 50; d < Math.max(henside.from + 60, rakes.from - 450); d += 20) {
    let s = 0;
    for (let k = 0; k < 400; k += 20) s += Math.abs(route.gradient(d + k));
    if (s < flattest) [flattest, trap] = [s, d];
  }
  // Timed segments: each one a few minutes for a steady rider (about 190 W, 80 kg, on the starter bike).
  // The climb is the steepest bit of Cove Road that fits in about four minutes at that pace, past the Cove.
  const ramp = steepestWithin(route, foot, top, SEGMENT_TARGET.climbSeconds);
  // The top of Malham Rakes: where the road starts its steep drop off the moor after Street Gate.
  const gateAt = streetGate?.at ?? rakes.from + 80;
  let rakesTop = rakes.from + 0.5 * (rakes.to - rakes.from);
  for (let d = gateAt + 200; d < rakes.to - 400; d += 10) {
    if (route.elevation(d) - route.elevation(d + 200) > 16) {
      rakesTop = d;
      break;
    }
  }
  const bridge = street('New Bridge')?.from ?? L - 40;
  const timed = [
    { id: 'cove-ramp', name: 'Cove Road Ramp', kind: 'segment', from: ramp.from, to: ramp.to, about: 'The steepest part of Cove Road, past the Cove' },
    { id: 'tarn-road', name: 'Moor Road to Malham Tarn', kind: 'segment', from: top, to: tarn?.at ?? henside.to - 200, about: 'From the top of Cove Road across the moor to the tarn' },
    { id: 'street-gate', name: 'Street Gate to the Rakes', kind: 'segment', from: gateAt, to: rakesTop, about: 'From Street Gate to the top of Malham Rakes' },
    { id: 'rakes', name: 'Down Malham Rakes', kind: 'segment', from: rakesTop, to: bridge, about: 'The descent off the moor into Malham' },
  ];
  return withCourse(route, {
    world: 'dales',
    title: 'Yorkshire Dales',
    blurb: `Malham: up Cove Road past the Cove, over the moor by Malham Tarn and down Malham Rakes. ${(L / 1000).toFixed(1)} km, ${Math.round(route.climb)} m of climbing.`,
    attribution: data.attribution,
    village: { from: L - 320, to: 140, name: 'Malham' },
    landmarks,
    streets: data.route.streets ?? [],
    climb: { foot, top, gain: climbGain },
    segments: [
      { id: 'village-sprint', name: 'Malham Village Sprint', kind: 'zone', from: 20, to: Math.min(340, komFrom - 40) },
      { id: 'cove', name: 'Cove Road', kind: 'kom', from: komFrom, to: komTo },
      { id: 'moor-trap', name: 'Malham Moor Speed Trap', kind: 'zone', from: trap, to: trap + 400 },
      ...timed,
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
  // York's real relief (from LIDAR, see scripts/build-york-terrain.mjs): street level by the Ouse is the
  // game's 12 m and the ground rises gently away from the river (the Minster stands ~6 m higher). Bridges over
  // the Ouse get a gentle hump.
  const relief = data.relief ? new HeightGrid(data.relief) : null;
  const base = (x, z) => 12 + (relief ? relief.at(x, -z) : 0);
  const bridges = ['lendalBridge', 'skeldergateBridge'].map((k) => data.landmarks?.[k]).filter(Boolean).map((b) => ({ x: b.x, z: -b.y }));
  const elevation = (_d, x, z) => {
    let h = base(x, z);
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
  // Timed segments between York's bars (the gates in the walls), placed from where the real streets meet.
  const runs = streetRuns(route, data.roads ?? [], data.route.streets ?? []);
  const startOf = (n, fb) => runs.find((r) => r.n === n)?.from ?? fb;
  const endOf = (n, fb) => runs.find((r) => r.n === n)?.to ?? fb;
  const monkBar = endOf("St. Maurice's Road", 0.958 * L);
  const boothamBar = endOf('Gillygate', 0.11 * L);
  const micklegateBar = endOf('Queen Street', 0.358 * L);
  const tower = near(data.landmarks?.cliffordsTower) ?? 0.553 * L;
  const timed = [
    { id: 'monk-bootham', name: 'Monk Bar to Bootham Bar', kind: 'segment', from: monkBar, to: L + boothamBar, about: "Lord Mayor's Walk and Gillygate, under the walls by the Minster" },
    { id: 'lendal-micklegate', name: 'Lendal Bridge to Micklegate Bar', kind: 'segment', from: startOf('Lendal Bridge', 0.19 * L), to: micklegateBar, about: 'Over the Ouse and up Station Road to the walls' },
    { id: 'micklegate-tower', name: "Micklegate Bar to Clifford's Tower", kind: 'segment', from: micklegateBar, to: tower + 100, about: "Down Nunnery Lane and over Skeldergate Bridge to the castle" },
    { id: 'fishergate-monk', name: 'Fishergate Bar to Monk Bar', kind: 'segment', from: startOf('Paragon Street', 0.618 * L), to: monkBar, about: 'Foss Islands Road round to Monk Bar' },
  ];
  return withCourse(route, {
    world: 'york',
    title: 'York',
    blurb: "Real streets: the city walls, the Minster, the Ouse bridges and Clifford's Tower.",
    landmarks: marks.sort((a, b) => a.at - b.at),
    streets: data.route.streets ?? [],
    baseElevation: base,
    segments: [
      { id: 'walls-sprint', name: 'City Walls Sprint', kind: 'zone', from: 0.12 * L, to: 0.12 * L + 400 },
      { id: 'ouse-sprint', name: 'Ouse Speed Trap', kind: 'zone', from: 0.45 * L, to: 0.45 * L + 350 },
      { id: 'tower-sprint', name: 'Tower Dash', kind: 'zone', from: 0.72 * L, to: 0.72 * L + 300 },
      ...timed,
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
  route.segments = [{ id: 'lap', name: `${course.title} lap`, kind: 'lap', from: 0, to: L }, ...course.segments.map((s) => ({ ...s, ...(s.kind === 'segment' ? {} : medalThresholds(route, s)) }))]
    .map((s) => ({ ...s, length: s.to - s.from, grade: (route.elevation(s.to) - route.elevation(s.from)) / (s.to - s.from) }));
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
  return { medals };
}

// ---- Timed segments ---------------------------------------------------------------------------------

/** The rider the timed segments are sized for: steady ~190 W, 80 kg, on the starter bike and wheels. */
export const SEGMENT_TARGET = { power: 190, mass: 80, maxSeconds: 300, climbSeconds: 240 };

/** Physics parameters for the segment reference rider (or another weight). */
export function referenceParams(mass = SEGMENT_TARGET.mass) {
  return riderParams({ riderMass: mass, bike: BIKES[0], wheels: WHEELS[0] });
}

/** Seconds to ride from `from` to `to` at a steady power, by the game's own physics (arriving at speed). */
export function rideTime(route, from, to, power = SEGMENT_TARGET.power, p = referenceParams(), dt = 0.1) {
  let v = steadySpeed(power, route.gradient(from - 30), p), d = from, t = 0;
  while (d < to && t < 7200) {
    v = stepSpeed(v, power, route.gradient(d), dt, p);
    const step = v * dt;
    if (d + step >= to) return t + (to - d) / Math.max(0.01, v);
    d += step;
    t += dt;
  }
  return t;
}

/**
 * The stretch between `lo` and `hi` that gains the most height while taking no more than `seconds` at the
 * reference pace (worked out from steady speeds on 10 m cells, which is close to riding it).
 */
function steepestWithin(route, lo, hi, seconds) {
  const p = referenceParams();
  const cell = 10;
  const n = Math.max(1, Math.floor((hi - lo) / cell));
  const cost = [];
  for (let i = 0; i < n; i++) cost.push(cell / Math.max(0.3, steadySpeed(SEGMENT_TARGET.power, route.gradient(lo + (i + 0.5) * cell), p)));
  let best = { from: lo, to: Math.min(hi, lo + 400), gain: -Infinity };
  let j = 0, t = 0;
  for (let i = 0; i < n; i++) {
    while (j < n && t + cost[j] <= seconds) t += cost[j++];
    const from = lo + i * cell, to = lo + j * cell;
    const gain = route.elevation(to) - route.elevation(from);
    if (to - from >= 200 && gain > best.gain) best = { from, to, gain };
    t -= cost[i];
    if (j === i) j++;
    if (t < 0) t = 0;
  }
  return best;
}

/**
 * Where each named street runs along the route: [{n, from, to}] in order, from the OpenStreetMap roads
 * (each route point takes the name of the nearest listed street within 12 m).
 */
function streetRuns(route, roads, names) {
  const wanted = new Set(names);
  const segs = [];
  for (const road of roads) {
    if (!wanted.has(road.n)) continue;
    for (let i = 0; i + 3 < road.p.length; i += 2) segs.push([road.p[i], -road.p[i + 1], road.p[i + 2], -road.p[i + 3], road.n]);
  }
  const runs = [];
  for (let d = 0; d < route.length; d += 10) {
    const p = route.rawPoint(d);
    let name = null, bd = 12;
    for (const [ax, az, bx, bz, n] of segs) {
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / (dx * dx + dz * dz || 1)));
      const dd = Math.hypot(p.x - ax - t * dx, p.z - az - t * dz);
      if (dd < bd) [bd, name] = [dd, n];
    }
    const last = runs[runs.length - 1];
    if (last && last.n === name) last.to = d + 10;
    else runs.push({ n: name, from: d, to: d + 10 });
  }
  return runs.filter((r) => r.n);
}

/** Medal for a time through a zone, or null. */
export function medalFor(seg, time) {
  if (!seg.medals) return null;
  if (time <= seg.medals.gold) return 'gold';
  if (time <= seg.medals.silver) return 'silver';
  if (time <= seg.medals.bronze) return 'bronze';
  return null;
}
