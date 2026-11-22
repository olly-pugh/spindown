// The courses: Malham in the Yorkshire Dales and York, both built from OpenStreetMap and open terrain data.
// Each course has segments (speed zones, climbs, the lap), checkpoints for live PR deltas, power-up spots
// and landmarks for on-screen banners.
import { Route } from './route.js';
import { riderParams, stepSpeed, steadySpeed } from './physics.js';

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
