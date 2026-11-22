// Dev-time data pipeline for the Yorkshire Dales course: OpenStreetMap (Overpass API) + Mapzen/AWS Terrarium
// elevation tiles -> compact map JSON for the 3D ride.
//
//   node scripts/build-dales.mjs            # uses scripts/dales-cache/ if present
//   node scripts/build-dales.mjs --refresh  # refetch OpenStreetMap from Overpass (terrain tiles stay cached)
//
// Output: src/renderer/game3d/data/dales.json. Coordinates are local metres (x east, y north) from an
// equirectangular projection about ORIGIN, rounded to 0.1 m; polylines/polygons are flat [x,y,x,y,...].
// Heightmaps are base64 little-endian Int16 decimetres, row by row from the south-west corner.
//
// The loop: Malham village -> Cove Road (the climb past Malham Cove) -> Henside Road across the limestone
// plateau south of Malham Tarn -> the lane to Street Gate -> down Malham Rakes -> Finkle Street -> Malham.
// Map data © OpenStreetMap contributors, ODbL. Terrain: Mapzen Terrain Tiles on AWS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overpass, Terrarium, sentinelImage } from './dales-fetch.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(root, 'scripts/dales-cache');
const OUT = path.join(root, 'src/renderer/game3d/data/dales.json');
const REFRESH = process.argv.includes('--refresh');
const FETCH_ONLY = process.argv.includes('--fetch-only');

const ORIGIN = { lat: 54.075, lon: -2.16 };
// Detail box: the loop plus ~1.2 km (walls, buildings, roads, trees). Far box: what can be seen (terrain,
// woods, water, landcover, power lines, masts, places).
const DETAIL = { s: 54.049, w: -2.205, n: 54.106, e: -2.122 };
const FAR = { s: 54.02, w: -2.27, n: 54.135, e: -2.05 };
const FINE_CELL = 10, FINE_MARGIN = 1400, COARSE_CELL = 40;

function osmQuery() {
  const d = `(${DETAIL.s},${DETAIL.w},${DETAIL.n},${DETAIL.e})`;
  const f = `(${FAR.s},${FAR.w},${FAR.n},${FAR.e})`;
  return `[out:json][timeout:300];
(
  way["highway"]${d};
  way["barrier"~"^(wall|hedge|retaining_wall|city_wall)$"]${d};
  way["building"]${d};
  relation["building"]${d};
  node["natural"="tree"]${d};
  way["natural"="tree_row"]${d};
  nwr["amenity"~"^(pub|cafe|place_of_worship|toilets|parking|telephone)$"]${d};
  nwr["tourism"~"^(viewpoint|attraction|information|hotel|guest_house|hostel|camp_site)$"]${d};
  way["natural"~"^(wood|water|heath|moor|grassland|scree|bare_rock|wetland|cliff|scrub|fell|shingle|rock|limestone_pavement)$"]${f};
  relation["natural"~"^(wood|water|heath|moor|grassland|scree|bare_rock|wetland|scrub|fell)$"]${f};
  way["landuse"~"^(forest|meadow|farmland|grass|farmyard|quarry|residential)$"]${f};
  relation["landuse"~"^(forest|meadow|farmland|grass|quarry|residential)$"]${f};
  way["waterway"]${f};
  way["power"]${f};
  node["power"~"^(tower|pole|portal|transformer|substation)$"]${f};
  nwr["man_made"~"^(mast|tower|communications_tower|water_tower)$"]${f};
  node["place"]${f};
  nwr["natural"~"^(peak|hill|cave_entrance|spring|saddle|ridge|valley)$"]${f};
  nwr["waterway"="waterfall"]${f};
);
out geom;`;
}

const t0 = Date.now();
const osm = await overpass(osmQuery(), path.join(CACHE_DIR, 'overpass.json'), { refresh: REFRESH });
const fine = new Terrarium(14, CACHE_DIR);
await fine.prefetch(DETAIL);
const coarse = new Terrarium(12, CACHE_DIR);
await coarse.prefetch(FAR);
if (FETCH_ONLY) process.exit(0);

// ---------------------------------------------------------------------------------------------
// Geometry helpers

const KX = Math.cos((ORIGIN.lat * Math.PI) / 180) * 111320;
const KY = 110540;
const project = (lat, lon) => [(lon - ORIGIN.lon) * KX, (lat - ORIGIN.lat) * KY];
const unproject = (x, y) => [ORIGIN.lat + y / KY, ORIGIN.lon + x / KX];
const r1 = (v) => Math.round(v * 10) / 10;
const rectOf = (b) => {
  const [x0, y0] = project(b.s, b.w);
  const [x1, y1] = project(b.n, b.e);
  return { x0, y0, x1, y1 };
};
const DRECT = rectOf(DETAIL), FRECT = rectOf(FAR);

const projGeom = (geom) => (geom || []).filter(Boolean).map((g) => project(g.lat, g.lon));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const samePt = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2;
}

function ringCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return ring[0];
  return [cx / (3 * a), cy / (3 * a)];
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function lineDist(p, pts) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, segDist(p, pts[i], pts[i + 1]));
  return best;
}

function simplifyLine(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let maxD = -1, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k], pts[i], pts[j]);
      if (d > maxD) {
        maxD = d;
        idx = k;
      }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyRing(ring, tol) {
  if (ring.length > 1 && samePt(ring[0], ring[ring.length - 1])) ring = ring.slice(0, -1);
  if (ring.length < 4) return ring;
  let far = 0, farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = dist(ring[0], ring[i]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tol);
  const b = simplifyLine([...ring.slice(far), ring[0]], tol);
  const out = [...a, ...b.slice(1, -1)];
  return out.length >= 3 ? out : ring;
}

function clipRing(ring, rect) {
  const edges = [(p) => p[0] >= rect.x0, (p) => p[0] <= rect.x1, (p) => p[1] >= rect.y0, (p) => p[1] <= rect.y1];
  const inter = [
    (a, b) => [rect.x0, a[1] + ((rect.x0 - a[0]) / (b[0] - a[0])) * (b[1] - a[1])],
    (a, b) => [rect.x1, a[1] + ((rect.x1 - a[0]) / (b[0] - a[0])) * (b[1] - a[1])],
    (a, b) => [a[0] + ((rect.y0 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), rect.y0],
    (a, b) => [a[0] + ((rect.y1 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), rect.y1],
  ];
  let out = ring;
  for (let e = 0; e < 4 && out.length; e++) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      const ci = edges[e](cur), pi = edges[e](prev);
      if (ci) {
        if (!pi) out.push(inter[e](prev, cur));
        out.push(cur);
      } else if (pi) out.push(inter[e](prev, cur));
    }
  }
  return out;
}

function clipLine(pts, rect) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const ps = [-dx, dx, -dy, dy];
    const qs = [a[0] - rect.x0, rect.x1 - a[0], a[1] - rect.y0, rect.y1 - a[1]];
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (ps[k] === 0) {
        if (qs[k] < 0) {
          ok = false;
          break;
        }
        continue;
      }
      const t = qs[k] / ps[k];
      if (ps[k] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (!ok || t0 > t1) {
      if (cur) {
        pieces.push(cur);
        cur = null;
      }
      continue;
    }
    const pa = [a[0] + t0 * dx, a[1] + t0 * dy], pb = [a[0] + t1 * dx, a[1] + t1 * dy];
    if (!cur) cur = [pa];
    else if (!samePt(cur[cur.length - 1], pa)) {
      pieces.push(cur);
      cur = [pa];
    }
    cur.push(pb);
    if (t1 < 1) {
      pieces.push(cur);
      cur = null;
    }
  }
  if (cur) pieces.push(cur);
  return pieces.filter((p) => p.length >= 2);
}

const inRect = (p, rect) => p[0] >= rect.x0 && p[0] <= rect.x1 && p[1] >= rect.y0 && p[1] <= rect.y1;

function polyLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

function assembleRings(lines) {
  const pool = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  const out = [];
  while (pool.length) {
    let ring = pool.pop();
    let guard = 0;
    while (!samePt(ring[0], ring[ring.length - 1]) && guard++ < 10000) {
      const end = ring[ring.length - 1];
      const i = pool.findIndex((l) => samePt(l[0], end) || samePt(l[l.length - 1], end));
      if (i < 0) break;
      let next = pool.splice(i, 1)[0];
      if (!samePt(next[0], end)) next = next.reverse();
      ring = ring.concat(next.slice(1));
    }
    if (ring.length >= 4 && samePt(ring[0], ring[ring.length - 1])) out.push(ring.slice(0, -1));
  }
  return out;
}

/** Outer rings (projected, unclosed) of a closed way or multipolygon relation. */
function outerRings(el) {
  if (el.type === 'way') {
    const pts = projGeom(el.geometry);
    if (pts.length < 4 || !samePt(pts[0], pts[pts.length - 1])) return [];
    return [pts.slice(0, -1)];
  }
  if (el.type === 'relation') {
    const mem = (el.members || []).filter((m) => m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === ''));
    return assembleRings(mem.map((m) => projGeom(m.geometry)));
  }
  return [];
}

const flat = (pts) => {
  const out = [];
  for (const p of pts) out.push(r1(p[0]), r1(p[1]));
  return out;
};

const num = (v) => {
  if (v == null) return NaN;
  const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};

/** Terrain height (m) at local coordinates, from the z14 tiles where loaded, else z12. */
function demAt(x, y) {
  const [lat, lon] = unproject(x, y);
  try {
    return fine.at(lat, lon);
  } catch {
    return coarse.at(lat, lon);
  }
}

const els = osm.elements;

// ---------------------------------------------------------------------------------------------
// Route: shortest paths between waypoints on the public road graph.

const CAR = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'road']);
const hwWays = els.filter((e) => e.type === 'way' && e.tags?.highway && e.geometry && e.nodes);
const nodePos = new Map(); // id -> [x,y]
const adj = new Map(); // id -> [{to, len, cost, way}]
for (const w of hwWays) {
  const pts = projGeom(w.geometry);
  if (pts.length !== w.nodes.length) continue;
  for (let i = 0; i < w.nodes.length; i++) nodePos.set(w.nodes[i], pts[i]);
  if (!CAR.has(w.tags.highway) || w.tags.access === 'private' || w.tags.access === 'no') continue;
  for (let i = 0; i + 1 < w.nodes.length; i++) {
    const a = w.nodes[i], b = w.nodes[i + 1];
    const len = dist(pts[i], pts[i + 1]);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ to: b, len, cost: len, way: w });
    adj.get(b).push({ to: a, len, cost: len, way: w });
  }
}

class Heap {
  constructor() {
    this.a = [];
  }
  push(k, v) {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

function dijkstra(src, dst, penalty) {
  const best = new Map([[src, 0]]);
  const prev = new Map();
  const h = new Heap();
  h.push(0, src);
  while (h.size) {
    const [d, u] = h.pop();
    if (u === dst) break;
    if (d > best.get(u)) continue;
    for (const e of adj.get(u) || []) {
      const nd = d + e.cost * penalty(u, e.to);
      if (nd < (best.get(e.to) ?? Infinity)) {
        best.set(e.to, nd);
        prev.set(e.to, { from: u, edge: e });
        h.push(nd, e.to);
      }
    }
  }
  if (!prev.has(dst) && src !== dst) throw new Error(`No path ${src} -> ${dst}`);
  const nodes = [dst], edges = [];
  let cur = dst;
  while (cur !== src) {
    const p = prev.get(cur);
    edges.push(p.edge);
    nodes.push(p.from);
    cur = p.from;
  }
  return { nodes: nodes.reverse(), edges: edges.reverse() };
}

// Waypoints in riding order: a road (OSM name, or null for the unnamed lane) and a rough position on it.
const WAYPOINTS = [
  { name: 'Cove Road', at: [-450, -50] },
  { name: 'Henside Road', at: [-850, 1650] },
  { name: null, at: [250, 1450] }, // the lane from Henside Road to Street Gate
  { name: 'Malham Rakes', at: [1150, 150] },
  { name: 'Finkle Street', at: [550, -1400] },
];

function waypointNode(wp) {
  let best = null, bestD = Infinity;
  for (const w of hwWays) {
    if (!CAR.has(w.tags.highway) || (wp.name !== null && w.tags.name !== wp.name)) continue;
    for (const id of w.nodes) {
      const p = nodePos.get(id);
      if (!p || !adj.has(id)) continue;
      const d = dist(p, wp.at);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
  }
  if (best == null) throw new Error(`Waypoint road not found: ${wp.name}`);
  return best;
}

const wpNodes = WAYPOINTS.map(waypointNode);
const usedEdges = new Set();
const ekey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
let routeNodes = [wpNodes[0]];
let routeEdges = [];
for (let i = 0; i < wpNodes.length; i++) {
  const a = wpNodes[i], b = wpNodes[(i + 1) % wpNodes.length];
  const leg = dijkstra(a, b, (u, v) => (usedEdges.has(ekey(u, v)) ? 8 : 1));
  for (let k = 0; k < leg.edges.length; k++) usedEdges.add(ekey(leg.nodes[k], leg.nodes[k + 1]));
  routeNodes.push(...leg.nodes.slice(1));
  routeEdges.push(...leg.edges);
}
routeNodes.pop(); // the loop returns to its first node
{
  // Remove out-and-back spurs (A -> B -> A).
  let changed = true;
  while (changed) {
    changed = false;
    const n = routeNodes.length;
    for (let i = 0; i < n; i++) {
      if (routeNodes[(i + 2) % n] === routeNodes[i]) {
        const drop = new Set([(i + 1) % n, (i + 2) % n]);
        routeNodes = routeNodes.filter((_, k) => !drop.has(k));
        routeEdges = routeEdges.filter((_, k) => !drop.has(k));
        changed = true;
        break;
      }
    }
  }
}

// Start/finish: in Malham village, by The Buck Inn.
const buck = els.find((e) => e.tags?.amenity === 'pub' && /Buck/i.test(e.tags.name || ''));
const startHint = buck ? (buck.type === 'node' ? project(buck.lat, buck.lon) : project((buck.bounds.minlat + buck.bounds.maxlat) / 2, (buck.bounds.minlon + buck.bounds.maxlon) / 2)) : nodePos.get(wpNodes[4]);
{
  let bi = 0, bd = Infinity;
  routeNodes.forEach((id, i) => {
    const d = dist(nodePos.get(id), startHint);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  });
  routeNodes = [...routeNodes.slice(bi), ...routeNodes.slice(0, bi)];
  routeEdges = [...routeEdges.slice(bi), ...routeEdges.slice(0, bi)];
}

const runs = [];
for (const e of routeEdges) {
  const nm = e.way.tags.name || null;
  if (runs.length && runs[runs.length - 1].name === nm) runs[runs.length - 1].len += e.len;
  else runs.push({ name: nm, len: e.len });
}

// Geometry: node positions -> Chaikin corner cuts (<= 2 m) -> resampled every 4 m, closed.
let pts = routeNodes.map((id) => nodePos.get(id));
pts = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 0.05);

function chaikinClosed(p, maxDev) {
  const out = [];
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const prev = p[(i + n - 1) % n], cur = p[i], next = p[(i + 1) % n];
    const l1 = dist(prev, cur), l2 = dist(cur, next);
    if (l1 < 1e-6 || l2 < 1e-6) {
      out.push(cur);
      continue;
    }
    const u1 = [(prev[0] - cur[0]) / l1, (prev[1] - cur[1]) / l1];
    const u2 = [(next[0] - cur[0]) / l2, (next[1] - cur[1]) / l2];
    const half = Math.hypot(u1[0] + u2[0], u1[1] + u2[1]) / 2;
    let d = Math.min(l1, l2) / 4;
    if (half * d > maxDev) d = maxDev / half;
    if (half < 1e-3) {
      out.push(cur);
      continue;
    }
    out.push([cur[0] + u1[0] * d, cur[1] + u1[1] * d], [cur[0] + u2[0] * d, cur[1] + u2[1] * d]);
  }
  return out;
}
pts = chaikinClosed(chaikinClosed(pts, 2), 1);

function resampleClosed(p, step) {
  const ring = [...p, p[0]];
  const L = polyLength(ring);
  const n = Math.max(3, Math.round(L / step));
  const s = L / n;
  const out = [];
  let seg = 0, segStart = 0;
  for (let k = 0; k < n; k++) {
    const target = k * s;
    while (seg < ring.length - 2 && segStart + dist(ring[seg], ring[seg + 1]) < target) {
      segStart += dist(ring[seg], ring[seg + 1]);
      seg++;
    }
    const d = dist(ring[seg], ring[seg + 1]) || 1;
    const f = Math.min(1, Math.max(0, (target - segStart) / d));
    out.push([ring[seg][0] + f * (ring[seg + 1][0] - ring[seg][0]), ring[seg][1] + f * (ring[seg + 1][1] - ring[seg][1])]);
  }
  return { pts: out, length: L, step: s };
}
const rs = resampleClosed(pts, 4);
const RP = rs.pts; // distinct samples; the closing point is added on output
const RN = RP.length;
const along = (i) => i * rs.step;

/** Index of the route sample nearest to p. */
function nearestIndex(p) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < RN; i++) {
    const d = (RP[i][0] - p[0]) ** 2 + (RP[i][1] - p[1]) ** 2;
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return bi;
}

// Street runs as distances along the loop.
const streets = [];
{
  let acc = 0;
  const nodeAlong = [0];
  for (let i = 0; i < routeNodes.length; i++) {
    acc += dist(nodePos.get(routeNodes[i]), nodePos.get(routeNodes[(i + 1) % routeNodes.length]));
    nodeAlong.push(acc);
  }
  let k = 0;
  for (const r of runs) {
    const fromNode = routeNodes[k];
    let len = 0;
    while (k < routeEdges.length && len < r.len - 1e-6) len += routeEdges[k++].len;
    const toNode = routeNodes[k % routeNodes.length];
    const from = along(nearestIndex(nodePos.get(fromNode)));
    let to = along(nearestIndex(nodePos.get(toNode)));
    if (to <= from) to = rs.length;
    streets.push({ n: r.name, from: Math.round(from), to: Math.round(to) });
  }
}

// Self-intersection check (non-adjacent segments).
function segsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
let crossings = 0;
for (let i = 0; i < RN; i++) {
  for (let j = i + 2; j < RN; j++) {
    if (i === 0 && j === RN - 1) continue;
    if (segsCross(RP[i], RP[(i + 1) % RN], RP[j], RP[(j + 1) % RN])) crossings++;
  }
}

// ---- Road height: the DEM along the road, bridged over becks, smoothed to a rideable profile ----
const bridgeLines = [];
{
  const seen = new Set();
  for (const e of routeEdges) {
    const t = e.way.tags;
    if (!t.bridge || t.bridge === 'no' || seen.has(e.way.id)) continue;
    seen.add(e.way.id);
    bridgeLines.push(projGeom(e.way.geometry));
  }
}
const raw = RP.map((p) => demAt(p[0], p[1]));
const onBridge = RP.map((p) => bridgeLines.some((l) => lineDist(p, l) < 3));
// Straight line across each bridge (and 8 m either side) so the deck does not dip into the beck.
for (let i = 0; i < RN; i++) {
  if (!onBridge[i] || onBridge[(i - 1 + RN) % RN]) continue;
  let j = i;
  while (onBridge[j % RN]) j++;
  const a = (i - 2 + RN) % RN, b = (j + 2) % RN;
  const span = j + 2 - (i - 2);
  for (let k = 1; k < span; k++) raw[(i - 2 + k + RN) % RN] = raw[a] + ((raw[b] - raw[a]) * k) / span;
}
function smoothClosed(arr, sigma) {
  const r = Math.ceil(sigma * 3);
  const w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const sw = w.reduce((s, x) => s + x, 0);
  return arr.map((_, i) => {
    let s = 0;
    for (let k = -r; k <= r; k++) s += arr[(i + k + arr.length) % arr.length] * w[k + r];
    return s / sw;
  });
}
const elev = smoothClosed(raw, 12 / rs.step);
// What the game's Route does on top (two ±20 m moving averages), for the stats below.
let gameElev = elev;
for (let pass = 0; pass < 2; pass++) {
  const w = Math.round(20 / rs.step);
  gameElev = gameElev.map((_, i) => {
    let s = 0;
    for (let k = -w; k <= w; k++) s += gameElev[(i + k + RN) % RN];
    return s / (2 * w + 1);
  });
}
let climb = 0, maxGrad = 0, maxGradAt = 0;
for (let i = 0; i < RN; i++) {
  climb += Math.max(0, gameElev[(i + 1) % RN] - gameElev[i]);
  const k = Math.round(10 / rs.step);
  const g = (gameElev[(i + k) % RN] - gameElev[(i - k + RN) % RN]) / (2 * k * rs.step);
  if (Math.abs(g) > Math.abs(maxGrad)) {
    maxGrad = g;
    maxGradAt = along(i);
  }
}

// ---------------------------------------------------------------------------------------------
// Heightmaps

const rb = RP.reduce((b, p) => ({ x0: Math.min(b.x0, p[0]), y0: Math.min(b.y0, p[1]), x1: Math.max(b.x1, p[0]), y1: Math.max(b.y1, p[1]) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

function grid(rect, cell) {
  const x0 = Math.ceil(rect.x0 / cell) * cell, y0 = Math.ceil(rect.y0 / cell) * cell;
  const nx = Math.floor((rect.x1 - x0) / cell) + 1, ny = Math.floor((rect.y1 - y0) / cell) + 1;
  const a = new Int16Array(nx * ny);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const h = demAt(x0 + i * cell, y0 + j * cell);
      a[j * nx + i] = Math.round(h * 10);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  return { x0, y0, nx, ny, cell, min: r1(min), max: r1(max), data: Buffer.from(a.buffer).toString('base64') };
}
const inset = (r, m) => ({ x0: r.x0 + m, y0: r.y0 + m, x1: r.x1 - m, y1: r.y1 - m });
const fineRect = {
  x0: Math.max(rb.x0 - FINE_MARGIN, DRECT.x0 + 30), y0: Math.max(rb.y0 - FINE_MARGIN, DRECT.y0 + 30),
  x1: Math.min(rb.x1 + FINE_MARGIN, DRECT.x1 - 30), y1: Math.min(rb.y1 + FINE_MARGIN, DRECT.y1 - 30),
};
const terrain = { fine: grid(fineRect, FINE_CELL), coarse: grid(inset(FRECT, 60), COARSE_CELL) };

// ---------------------------------------------------------------------------------------------
// Aerial imagery (Sentinel-2 cloudless 2016, EOX, CC BY 4.0): a sharp image over the fine heightmap and a
// wider one out to the horizon, saved as JPEGs next to the JSON. Each covers a local rectangle {x0,y0,x1,y1}.
const imagery = { credit: 'Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0' };
for (const [key, rect, mpp] of [['near', terrain.fine, 9.5546], ['far', terrain.coarse, 19.1093]]) {
  const r = { x0: rect.x0, y0: rect.y0, x1: rect.x0 + (rect.nx - 1) * rect.cell, y1: rect.y0 + (rect.ny - 1) * rect.cell };
  const [s, w] = unproject(r.x0, r.y0), [n, e] = unproject(r.x1, r.y1);
  const img = await sentinelImage({ s, w, n, e }, mpp, CACHE_DIR);
  const file = `dales-${key}.jpg`;
  fs.writeFileSync(path.join(path.dirname(OUT), file), img.buf);
  imagery[key] = { file, ...r, w: img.width, h: img.height, kb: Math.round(img.buf.length / 1024) };
}

// ---------------------------------------------------------------------------------------------
// Features

const tagged = (pred) => els.filter((e) => e.tags && pred(e.tags, e));
const lines = (list, rect, tol, minLen = 2) => {
  const out = [];
  for (const w of list) {
    if (w.type !== 'way') continue;
    for (const piece of clipLine(projGeom(w.geometry), rect)) {
      const s = simplifyLine(piece, tol);
      if (polyLength(s) >= minLen) out.push({ el: w, pts: s });
    }
  }
  return out;
};
const polys = (list, rect, tol, minArea) => {
  const out = [];
  for (const el of list) {
    for (const ring of outerRings(el)) {
      const c = clipRing(ring, rect);
      if (c.length < 3) continue;
      const s = simplifyRing(c, tol);
      if (s.length >= 3 && Math.abs(ringArea(s)) >= minArea) out.push({ el, pts: s });
    }
  }
  return out;
};

// Dry-stone walls (and the odd hedge).
const walls = lines(tagged((t) => t.barrier === 'wall' || t.barrier === 'city_wall'), DRECT, 0.5, 3).map((l) => flat(l.pts));
const hedges = lines(tagged((t) => t.barrier === 'hedge'), DRECT, 0.5, 3).map((l) => flat(l.pts));

// Buildings: stone houses in Malham and the farms, field barns ("laithes") everywhere else.
const bPolys = polys(tagged((t) => t.building && t.building !== 'no'), DRECT, 0.3, 8);
const bCentres = bPolys.map((b) => ringCentroid(b.pts));
const buildings = bPolys.map((b, i) => {
  const t = b.el.tags;
  const area = Math.abs(ringArea(b.pts));
  const c = bCentres[i];
  const neighbours = bCentres.filter((o, k) => k !== i && dist(o, c) < 45).length;
  let k;
  if (['ruin', 'ruins'].includes(t.building) || t.ruins === 'yes') k = 'ruin';
  else if (['church', 'chapel', 'religious'].includes(t.building) || t.amenity === 'place_of_worship') k = 'chapel';
  else if (['barn', 'farm_auxiliary', 'cowshed', 'stable', 'shed', 'garage', 'garages', 'hut', 'agricultural', 'greenhouse', 'roof', 'boathouse'].includes(t.building)) k = 'barn';
  else if (['house', 'detached', 'semidetached_house', 'terrace', 'residential', 'farm', 'cottage', 'bungalow', 'pub', 'hotel', 'commercial', 'public', 'school', 'accommodation', 'retail'].includes(t.building) || t.amenity || t.tourism) k = 'house';
  else k = neighbours >= 2 || area > 400 ? 'house' : 'barn';
  if (/barn|lathe|laithe/i.test(t.name || '')) k = 'barn';
  const lv = num(t['building:levels']);
  const hgt = num(t.height);
  const h = hgt > 0 ? hgt : lv > 0 ? lv * 2.8 + 0.6 : k === 'chapel' ? 7.5 : k === 'barn' ? 5 : k === 'ruin' ? 2.5 : 5.8;
  const o = { p: flat(b.pts), h: r1(h), k };
  if (t.name) o.n = t.name;
  return o;
});

// Woods (with leaf type) and single trees.
const woods = polys(tagged((t) => t.natural === 'wood' || t.landuse === 'forest'), FRECT, 1.5, 60).map((w) => {
  const lt = w.el.tags.leaf_type;
  const o = { p: flat(w.pts), t: lt === 'needleleaved' ? 'conifer' : lt === 'mixed' ? 'mixed' : lt === 'broadleaved' ? 'broad' : /plantation/i.test(w.el.tags.name || '') ? 'mixed' : 'broad' };
  if (w.el.tags.name) o.n = w.el.tags.name;
  return o;
});
const trees = [];
for (const e of tagged((t) => t.natural === 'tree')) {
  if (e.type !== 'node') continue;
  const p = project(e.lat, e.lon);
  if (inRect(p, DRECT)) trees.push(r1(p[0]), r1(p[1]));
}
const treeRows = lines(tagged((t) => t.natural === 'tree_row'), DRECT, 1, 5).map((l) => flat(l.pts));

// Water: Malham Tarn, ponds and the wider rivers as areas; becks and streams as lines.
const water = polys(tagged((t) => t.natural === 'water' || t.waterway === 'riverbank' || t.water === 'river'), FRECT, 1, 15).map((w) => {
  const o = { p: flat(w.pts) };
  if (w.el.tags.name) o.n = w.el.tags.name;
  return o;
});
const STREAM_W = { river: 7, stream: 2.2, canal: 6, ditch: 0.9, drain: 0.9 };
const streams = lines(tagged((t) => STREAM_W[t.waterway] && t.tunnel !== 'culvert' && t.tunnel !== 'yes' && t.intermittent !== 'yes'), DRECT, 1, 8).map((l) => {
  const t = l.el.tags;
  const w = num(t.width) > 0 ? num(t.width) : STREAM_W[t.waterway];
  const o = { p: flat(l.pts), w: r1(Math.min(14, w)) };
  if (t.name) o.n = t.name;
  return o;
});

// Ground cover classes for colouring the terrain.
function coverClass(t) {
  if (t.natural === 'bare_rock' || t.natural === 'rock' || t.natural === 'limestone_pavement') return /pavement/i.test(t.name || '') || t.rock === 'limestone' || t.natural === 'limestone_pavement' ? 'pavement' : 'rock';
  if (t.natural === 'scree' || t.natural === 'shingle') return 'scree';
  if (t.natural === 'heath' || t.natural === 'moor' || t.natural === 'fell') return 'heath';
  if (t.natural === 'wetland') return 'wet';
  if (t.natural === 'scrub') return 'scrub';
  if (t.natural === 'grassland') return 'grass';
  if (t.landuse === 'meadow' || t.landuse === 'grass' || t.landuse === 'farmland') return 'meadow';
  if (t.landuse === 'farmyard') return 'yard';
  if (t.landuse === 'quarry') return 'quarry';
  if (t.landuse === 'residential') return 'village';
  return null;
}
const cover = [];
for (const el of tagged((t) => coverClass(t))) {
  const c = coverClass(el.tags);
  for (const pg of polys([el], DRECT, c === 'pavement' || c === 'rock' ? 1.2 : 3, c === 'pavement' || c === 'rock' ? 40 : 300)) cover.push({ p: flat(pg.pts), c });
}
// Draw big classes first so small patches (rock, pavement) land on top.
cover.sort((a, b) => Math.abs(ringArea(unflat(b.p))) - Math.abs(ringArea(unflat(a.p))));
function unflat(f) {
  const out = [];
  for (let i = 0; i < f.length; i += 2) out.push([f[i], f[i + 1]]);
  return out;
}

// Limestone scars and cliffs: Malham Cove, Gordale Scar and the rest.
const cliffs = lines(tagged((t) => t.natural === 'cliff'), FRECT, 0.8, 4).map((l) => {
  const o = { p: flat(l.pts) };
  if (l.el.tags.name) o.n = l.el.tags.name;
  return o;
});

// Other roads, lanes, tracks and footpaths (just the parts the loop does not use).
const otherRoads = [];
{
  const KIND = (hw) => (CAR.has(hw) ? 'road' : hw === 'service' ? 'lane' : hw === 'track' ? 'track' : ['footway', 'path', 'bridleway', 'steps', 'cycleway'].includes(hw) ? 'path' : null);
  const W = { road: 4, lane: 3, track: 2.6, path: 1.2 };
  for (const w of hwWays) {
    const k = KIND(w.tags.highway);
    if (!k || w.tags.area === 'yes' || w.tags.tunnel === 'yes') continue;
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        for (const piece of clipLine(run, DRECT)) {
          const s = simplifyLine(piece, 0.5);
          if (polyLength(s) >= 3) otherRoads.push({ p: flat(s), k, w: num(w.tags.width) > 0 ? r1(Math.min(8, num(w.tags.width))) : W[k] });
        }
      }
      run = [];
    };
    for (let i = 0; i < w.nodes.length; i++) {
      const p = nodePos.get(w.nodes[i]);
      if (!p) {
        flush();
        continue;
      }
      if (i > 0 && usedEdges.has(ekey(w.nodes[i - 1], w.nodes[i])) && routeNodes.includes(w.nodes[i - 1])) {
        flush();
        run = [p];
        continue;
      }
      run.push(p);
    }
    flush();
  }
}

// Power: 11 kV / 33 kV wooden pole lines (and any steel-tower lines), poles at the line's vertices.
const powerLines = [];
for (const w of tagged((t) => ['line', 'minor_line'].includes(t.power))) {
  if (w.type !== 'way') continue;
  for (const piece of clipLine(projGeom(w.geometry), FRECT)) {
    if (piece.length < 2) continue;
    powerLines.push({ p: flat(piece), k: w.tags.power === 'line' ? 'line' : 'minor', v: num(w.tags.voltage) || undefined });
  }
}
const towers = [];
for (const e of tagged((t) => ['tower', 'pole', 'portal', 'transformer'].includes(t.power))) {
  if (e.type !== 'node') continue;
  const p = project(e.lat, e.lon);
  if (inRect(p, FRECT)) towers.push(r1(p[0]), r1(p[1]), e.tags.power === 'tower' || e.tags.power === 'portal' ? 1 : 0);
}
const masts = [];
for (const e of tagged((t) => ['mast', 'communications_tower'].includes(t.man_made) || (t.man_made === 'tower' && /communication|transmission/.test(t['tower:type'] || '')))) {
  const p = e.type === 'node' ? project(e.lat, e.lon) : e.bounds ? project((e.bounds.minlat + e.bounds.maxlat) / 2, (e.bounds.minlon + e.bounds.maxlon) / 2) : null;
  if (p && inRect(p, FRECT)) masts.push({ x: r1(p[0]), y: r1(p[1]), h: r1(num(e.tags.height) || 25) });
}

// Named places and features (for landmarks, signposts and the minimap).
const names = [];
{
  const centreOf = (e) => {
    if (e.type === 'node') return project(e.lat, e.lon);
    const g = projGeom(e.geometry);
    if (g.length) {
      if (g.length > 3 && samePt(g[0], g[g.length - 1])) return ringCentroid(g.slice(0, -1));
      return g[Math.floor(g.length / 2)];
    }
    if (e.bounds) return project((e.bounds.minlat + e.bounds.maxlat) / 2, (e.bounds.minlon + e.bounds.maxlon) / 2);
    return null;
  };
  const kindOf = (t) => t.place || (['peak', 'hill', 'cliff', 'cave_entrance', 'water', 'wood', 'bare_rock', 'spring', 'valley'].includes(t.natural) && t.natural) || (t.waterway === 'waterfall' && 'waterfall') || (['pub', 'cafe', 'place_of_worship', 'parking'].includes(t.amenity) && t.amenity) || (['attraction', 'viewpoint', 'hotel', 'hostel', 'guest_house'].includes(t.tourism) && t.tourism) || null;
  const seen = new Set();
  for (const e of els) {
    const t = e.tags;
    if (!t?.name || t.highway || t.barrier || t.power) continue;
    const k = kindOf(t);
    if (!k) continue;
    const key = `${k}:${t.name}`;
    if (seen.has(key)) continue;
    const p = centreOf(e);
    if (!p || !inRect(p, FRECT)) continue;
    seen.add(key);
    const o = { n: t.name, k, x: r1(p[0]), y: r1(p[1]) };
    if (num(t.ele) > 0) o.ele = Math.round(num(t.ele));
    names.push(o);
  }
}

// ---------------------------------------------------------------------------------------------
// Write

const routePts = [...RP, RP[0]];
const out = {
  attribution: 'Map data © OpenStreetMap contributors (ODbL). Terrain: Mapzen Terrain Tiles on AWS.',
  origin: ORIGIN,
  bounds: { minX: r1(FRECT.x0), minY: r1(FRECT.y0), maxX: r1(FRECT.x1), maxY: r1(FRECT.y1) },
  route: {
    name: 'Malham Cove and Tarn loop',
    points: flat(routePts),
    elev: [...elev, elev[0]].map((h) => Math.round(h * 10)),
    length: Math.round(rs.length),
    streets,
  },
  terrain,
  imagery,
  walls,
  hedges,
  buildings,
  woods,
  trees,
  treeRows,
  water,
  streams,
  cover,
  cliffs,
  roads: otherRoads,
  power: powerLines,
  towers,
  masts,
  names,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(OUT, json);

const size = (k) => `${k} ${(JSON.stringify(out[k]).length / 1024).toFixed(0)} KB`;
console.log(`\nWrote ${path.relative(root, OUT)}: ${(json.length / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`  ${['route', 'terrain', 'walls', 'buildings', 'woods', 'cover', 'roads', 'streams', 'power', 'names'].map(size).join(', ')}`);
console.log(`  route: ${Math.round(rs.length)} m, ${RN} samples, ${crossings} self-crossings, climb ${Math.round(climb)} m, ${Math.round(Math.min(...gameElev))}–${Math.round(Math.max(...gameElev))} m, max gradient ${(maxGrad * 100).toFixed(1)}% at ${Math.round(maxGradAt)} m`);
console.log(`  streets: ${streets.map((s) => `${s.n ?? '(lane)'} ${s.from}–${s.to}`).join(' -> ')}`);
console.log(`  imagery: near ${imagery.near.w}×${imagery.near.h} (${imagery.near.kb} KB), far ${imagery.far.w}×${imagery.far.h} (${imagery.far.kb} KB)`);
console.log(`  bridges on the route: ${bridgeLines.length}`);
console.log(`  terrain: fine ${terrain.fine.nx}×${terrain.fine.ny} @${FINE_CELL} m (${terrain.fine.min}–${terrain.fine.max} m), coarse ${terrain.coarse.nx}×${terrain.coarse.ny} @${COARSE_CELL} m (${terrain.coarse.min}–${terrain.coarse.max} m)`);
console.log(`  walls ${walls.length} (${Math.round(walls.reduce((s, w) => s + polyLength(unflat(w)), 0) / 1000)} km), hedges ${hedges.length}, buildings ${buildings.length}, woods ${woods.length}, trees ${trees.length / 2}, water ${water.length}, streams ${streams.length}, cover ${cover.length}, cliffs ${cliffs.length}, roads ${otherRoads.length}, power lines ${powerLines.length}, poles/towers ${towers.length / 3}, masts ${masts.length}, names ${names.length}`);
if (crossings) console.warn('  WARNING: the loop crosses itself');
if (json.length > 4 * 1024 * 1024) console.warn('  WARNING: output exceeds 4 MB');
