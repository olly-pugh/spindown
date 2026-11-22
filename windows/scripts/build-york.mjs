// Dev-time data pipeline: OpenStreetMap (Overpass API) -> compact York map JSON for the 3D ride.
//
//   node scripts/build-york.mjs            # uses scripts/york-cache/overpass.json if present
//   node scripts/build-york.mjs --refresh  # refetch from Overpass
//
// Output: src/renderer/game3d/data/york.json. Coordinates are local metres (x east, y north) from an
// equirectangular projection about ORIGIN, rounded to 0.1 m; polylines/polygons are flat [x,y,x,y,...].
// Map data © OpenStreetMap contributors, ODbL. Afterwards run scripts/build-york-terrain.mjs (relief + imagery).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(root, 'scripts/york-cache');
const CACHE = path.join(CACHE_DIR, 'overpass.json');
const OUT = path.join(root, 'src/renderer/game3d/data/york.json');
const REFRESH = process.argv.includes('--refresh');

const BBOX = { s: 53.95, w: -1.098, n: 53.968, e: -1.07 };
const ORIGIN = { lat: 53.96, lon: -1.082 };
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const USER_AGENT = 'spindown-map-build/1.0';

// ---------------------------------------------------------------------------------------------
// Fetch (with cache)

function overpassQuery() {
  const b = `(${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e})`;
  return `[out:json][timeout:180];
(
  way["building"]${b};
  relation["building"]["type"="multipolygon"]${b};
  way["highway"]${b};
  way["natural"="water"]${b};
  relation["natural"="water"]${b};
  way["waterway"~"^(riverbank|river)$"]${b};
  relation["waterway"="riverbank"]${b};
  way["water"="river"]${b};
  relation["water"="river"]${b};
  way["leisure"~"^(park|garden|pitch)$"]${b};
  relation["leisure"~"^(park|garden|pitch)$"]${b};
  way["landuse"~"^(grass|recreation_ground|cemetery|forest)$"]${b};
  relation["landuse"~"^(grass|recreation_ground|cemetery|forest)$"]${b};
  way["natural"="wood"]${b};
  relation["natural"="wood"]${b};
  way["barrier"="city_wall"]${b};
  way["historic"="citywalls"]${b};
  nwr["amenity"="place_of_worship"]${b};
  nwr["historic"="castle"]${b};
);
out geom;`;
}

async function loadOsm() {
  if (!REFRESH && fs.existsSync(CACHE)) {
    console.log(`Using cached ${path.relative(root, CACHE)} (pass --refresh to refetch)`);
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  }
  const body = new URLSearchParams({ data: overpassQuery() }).toString();
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      console.log(`Fetching ${url} ...`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const text = await res.text();
      const json = JSON.parse(text);
      if (!Array.isArray(json.elements) || json.elements.length === 0) throw new Error('empty response');
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE, text);
      console.log(`Cached ${json.elements.length} elements (${(text.length / 1e6).toFixed(1)} MB)`);
      return json;
    } catch (err) {
      lastErr = err;
      console.warn(`  failed: ${err.message}`);
    }
  }
  throw new Error(`All Overpass endpoints failed: ${lastErr?.message}`);
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

const KX = Math.cos((ORIGIN.lat * Math.PI) / 180) * 111320;
const KY = 110540;
const project = (lat, lon) => [(lon - ORIGIN.lon) * KX, (lat - ORIGIN.lat) * KY];
const r1 = (v) => Math.round(v * 10) / 10;
const RECT = (() => {
  const [x0, y0] = project(BBOX.s, BBOX.w);
  const [x1, y1] = project(BBOX.n, BBOX.e);
  return { x0, y0, x1, y1 };
})();

const projGeom = (geom) => geom.filter(Boolean).map((g) => project(g.lat, g.lon));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const samePt = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return a / 2; // sign depends on winding
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

// Douglas-Peucker on an open polyline (iterative).
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
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Douglas-Peucker on a closed ring (no repeated closing point in input or output).
function simplifyRing(ring, tol) {
  if (ring.length > 1 && samePt(ring[0], ring[ring.length - 1])) ring = ring.slice(0, -1);
  if (ring.length < 4) return ring;
  let far = 0, farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = dist(ring[0], ring[i]);
    if (d > farD) { farD = d; far = i; }
  }
  const a = simplifyLine(ring.slice(0, far + 1), tol);
  const b = simplifyLine([...ring.slice(far), ring[0]], tol);
  const out = [...a, ...b.slice(1, -1)];
  return out.length >= 3 ? out : ring;
}

// Sutherland-Hodgman clip of a ring against the bbox rectangle.
function clipRing(ring, rect = RECT) {
  const edges = [
    (p) => p[0] >= rect.x0, (p) => p[0] <= rect.x1, (p) => p[1] >= rect.y0, (p) => p[1] <= rect.y1,
  ];
  const inter = [
    (a, b) => { const t = (rect.x0 - a[0]) / (b[0] - a[0]); return [rect.x0, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (rect.x1 - a[0]) / (b[0] - a[0]); return [rect.x1, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (rect.y0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), rect.y0]; },
    (a, b) => { const t = (rect.y1 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), rect.y1]; },
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

// Clip a polyline to the rect; returns a list of pieces (Liang-Barsky per segment).
function clipLine(pts, rect = RECT) {
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
      if (ps[k] === 0) { if (qs[k] < 0) { ok = false; break; } continue; }
      const t = qs[k] / ps[k];
      if (ps[k] < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (!ok || t0 > t1) { if (cur) { pieces.push(cur); cur = null; } continue; }
    const pa = [a[0] + t0 * dx, a[1] + t0 * dy], pb = [a[0] + t1 * dx, a[1] + t1 * dy];
    if (!cur) cur = [pa];
    else if (!samePt(cur[cur.length - 1], pa)) { pieces.push(cur); cur = [pa]; }
    cur.push(pb);
    if (t1 < 1) { pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  return pieces.filter((p) => p.length >= 2);
}

const inRect = (p, rect = RECT) => p[0] >= rect.x0 && p[0] <= rect.x1 && p[1] >= rect.y0 && p[1] <= rect.y1;

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

// Join open member ways (arrays of points) into closed rings by matching endpoints.
function assembleRings(lines) {
  const pool = lines.filter((l) => l.length >= 2).map((l) => l.slice());
  const rings = [];
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
    if (ring.length >= 4 && samePt(ring[0], ring[ring.length - 1])) rings.push(ring.slice(0, -1));
  }
  return rings;
}

// Outer rings (projected, unclosed) of a closed way or multipolygon relation.
function outerRings(el) {
  if (el.type === 'way') {
    const pts = projGeom(el.geometry || []);
    if (pts.length < 4 || !samePt(pts[0], pts[pts.length - 1])) return [];
    return [pts.slice(0, -1)];
  }
  if (el.type === 'relation') {
    const outers = (el.members || []).filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === '') && m.geometry);
    return assembleRings(outers.map((m) => projGeom(m.geometry)));
  }
  return [];
}

// Buffer a polyline into a polygon of the given total width (simple mitred offset).
function bufferLine(pts, width) {
  const h = width / 2;
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l; dy /= l;
    left.push([pts[i][0] - dy * h, pts[i][1] + dx * h]);
    right.push([pts[i][0] + dy * h, pts[i][1] - dx * h]);
  }
  return [...left, ...right.reverse()];
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

// Prefer the apostrophe'd spelling when OSM keeps it only as alt_name (e.g. "Lord Mayors Walk").
function displayName(t) {
  if (!t?.name) return undefined;
  const strip = (s) => s.replace(/['’]/g, '').toLowerCase();
  if (t.alt_name && strip(t.alt_name) === strip(t.name)) return t.alt_name;
  return t.name;
}

// Merge polylines that share endpoint node ids into longer chains.
function mergeChains(items) {
  // items: {ids:[nodeIds], pts:[[x,y]]}
  const pool = items.map((i) => ({ ids: i.ids.slice(), pts: i.pts.slice() }));
  const out = [];
  while (pool.length) {
    const c = pool.pop();
    let grown = true;
    while (grown) {
      grown = false;
      for (let i = 0; i < pool.length; i++) {
        const o = pool[i];
        const cs = c.ids[0], ce = c.ids[c.ids.length - 1], os = o.ids[0], oe = o.ids[o.ids.length - 1];
        if (cs === ce) break;
        let joined = true;
        if (ce === os) { c.ids.push(...o.ids.slice(1)); c.pts.push(...o.pts.slice(1)); }
        else if (ce === oe) { c.ids.push(...o.ids.slice(0, -1).reverse()); c.pts.push(...o.pts.slice(0, -1).reverse()); }
        else if (cs === oe) { c.ids.unshift(...o.ids.slice(0, -1)); c.pts.unshift(...o.pts.slice(0, -1)); }
        else if (cs === os) { c.ids.unshift(...o.ids.slice(1).reverse()); c.pts.unshift(...o.pts.slice(1).reverse()); }
        else joined = false;
        if (joined) { pool.splice(i, 1); grown = true; break; }
      }
    }
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Build

const osm = await loadOsm();
const els = osm.elements;

// --- Buildings
const HOUSE = new Set(['house', 'terrace', 'detached', 'semidetached_house', 'residential', 'apartments', 'bungalow', 'dormitory', 'flats']);
const COMMERCIAL = new Set(['commercial', 'retail', 'office', 'shop', 'supermarket', 'hotel', 'kiosk', 'warehouse', 'industrial']);
const CHURCH = new Set(['church', 'chapel', 'religious', 'abbey', 'temple', 'mosque', 'synagogue']);
const DEFAULT_H = { house: 7.5, commercial: 10, church: 14, cathedral: 30, castle: 15, other: 8 };

function buildingKind(t) {
  const b = t.building;
  if (b === 'cathedral') return 'cathedral';
  if (b === 'castle' || t.historic === 'castle') return 'castle';
  if (CHURCH.has(b) || t.amenity === 'place_of_worship') return 'church';
  if (HOUSE.has(b)) return 'house';
  if (COMMERCIAL.has(b) || t.shop) return 'commercial';
  return 'other';
}

function buildingHeight(t, kind) {
  const h = num(t.height);
  // OSM tags York Minster height=12 (eaves?); the nave is ~30 m, so never let a cathedral drop below the default.
  if (h > 0) return kind === 'cathedral' ? Math.max(h, DEFAULT_H.cathedral) : h;
  const lv = num(t['building:levels']);
  if (lv > 0) return lv * 3.1 + 1.5;
  if (t.building === 'terrace') return 7.5;
  return DEFAULT_H[kind];
}

const buildings = [];
const buildingEls = els.filter((e) => e.tags?.building && e.tags.building !== 'no' && (e.type === 'way' || e.type === 'relation'));
for (const el of buildingEls) {
  const t = el.tags;
  const kind = buildingKind(t);
  const height = r1(buildingHeight(t, kind));
  for (const ring0 of outerRings(el)) {
    if (!inRect(ringCentroid(ring0))) continue;
    const ring = simplifyRing(ring0, 0.4);
    if (ring.length < 3 || Math.abs(ringArea(ring)) < 6) continue;
    const b = { p: flat(ring), h: height, k: kind };
    if (t.name) b.n = t.name;
    buildings.push(b);
  }
}

// --- Roads
const ROAD_KIND = {
  primary: 'primary', primary_link: 'primary', trunk: 'primary', trunk_link: 'primary',
  secondary: 'secondary', secondary_link: 'secondary',
  tertiary: 'tertiary', tertiary_link: 'tertiary',
  residential: 'residential', unclassified: 'residential', living_street: 'residential', road: 'residential',
  service: 'service', track: 'service',
  pedestrian: 'pedestrian',
  footway: 'footway', path: 'footway', bridleway: 'footway', steps: 'footway',
  cycleway: 'cycleway',
};
const ROAD_W = { primary: 9, secondary: 8, tertiary: 7, residential: 6, service: 4, pedestrian: 5, footway: 2.5, cycleway: 2.5, other: 4 };
const SKIP_HW = new Set(['construction', 'proposed', 'platform', 'bus_stop', 'elevator', 'corridor', 'raceway', 'abandoned', 'razed']);

function roadKind(t) {
  return ROAD_KIND[t.highway] || 'other';
}
function roadWidth(t, kind) {
  const w = num(t.width);
  if (w > 0 && w < 40) return w;
  const lanes = num(t.lanes);
  if (lanes > 0) return lanes * 3.2;
  return ROAD_W[kind];
}

const hwWays = els.filter((e) => e.type === 'way' && e.tags?.highway && !SKIP_HW.has(e.tags.highway) && e.geometry);
const roads = [];
let droppedSidewalks = 0;
for (const w of hwWays) {
  const t = w.tags;
  // Sidewalks and crossings are drawn parallel to / on top of the carriageway already in the data;
  // rendering them as separate ribbons only z-fights with the road surface.
  if (t.footway === 'sidewalk' || t.footway === 'crossing' || t.cycleway === 'crossing' || t.path === 'crossing') { droppedSidewalks++; continue; }
  if (t.area === 'yes') continue;
  const kind = roadKind(t);
  const width = r1(roadWidth(t, kind));
  const name = displayName(t);
  for (const piece of clipLine(projGeom(w.geometry))) {
    const s = simplifyLine(piece, 0.4);
    if (polyLength(s) < 1) continue;
    const r = { p: flat(s), w: width, k: kind };
    if (name) r.n = name;
    roads.push(r);
  }
}

// --- Water
const isWaterArea = (t) =>
  t.amenity !== 'fountain' && (t.natural === 'water' || t.waterway === 'riverbank' || t.water === 'river');
const waterRings = [];
for (const el of els) {
  const t = el.tags;
  if (!t || !isWaterArea(t) || (el.type !== 'way' && el.type !== 'relation')) continue;
  for (const ring of outerRings(el)) {
    const c = clipRing(ring);
    if (c.length >= 3 && Math.abs(ringArea(c)) >= 4) waterRings.push(c);
  }
}
// River centrelines: buffer any river whose centreline isn't already mostly covered by a water area.
const RIVER_W = { 'River Ouse': 45, 'River Foss': 12 };
const riverLines = els.filter((e) => e.type === 'way' && e.tags?.waterway === 'river' && e.geometry);
const byRiver = new Map();
for (const w of riverLines) {
  const name = w.tags.name || 'River Ouse';
  if (!byRiver.has(name)) byRiver.set(name, []);
  byRiver.get(name).push(w);
}
const bufferedRivers = [];
for (const [name, ways] of byRiver) {
  const width = RIVER_W[name] ?? 12;
  for (const w of ways) {
    for (const piece of clipLine(projGeom(w.geometry))) {
      // sample coverage along the piece
      let total = 0, covered = 0;
      for (let i = 0; i + 1 < piece.length; i++) {
        const seg = dist(piece[i], piece[i + 1]);
        const n = Math.max(1, Math.ceil(seg / 10));
        for (let k = 0; k < n; k++) {
          const f = (k + 0.5) / n;
          const p = [piece[i][0] + f * (piece[i + 1][0] - piece[i][0]), piece[i][1] + f * (piece[i + 1][1] - piece[i][1])];
          total++;
          if (waterRings.some((r) => pointInRing(p, r))) covered++;
        }
      }
      if (total && covered / total >= 0.6) continue;
      const poly = clipRing(bufferLine(piece, width));
      if (poly.length >= 3) { waterRings.push(poly); bufferedRivers.push(name); }
    }
  }
}
const water = waterRings.map((r) => flat(simplifyRing(r, 0.4))).filter((r) => r.length >= 6);

// --- Green
const isGreen = (t) =>
  ['park', 'garden', 'pitch'].includes(t.leisure) ||
  ['grass', 'recreation_ground', 'cemetery', 'forest'].includes(t.landuse) ||
  t.natural === 'wood';
const green = [];
for (const el of els) {
  if (!el.tags || !isGreen(el.tags) || (el.type !== 'way' && el.type !== 'relation')) continue;
  for (const ring of outerRings(el)) {
    const c = clipRing(ring);
    if (c.length < 3) continue;
    const s = simplifyRing(c, 0.4);
    if (s.length >= 3 && Math.abs(ringArea(s)) >= 10) green.push(flat(s));
  }
}

// --- City walls
const wallWays = els.filter((e) => e.type === 'way' && e.geometry && (e.tags?.barrier === 'city_wall' || e.tags?.historic === 'citywalls'));
const wallChains = mergeChains(wallWays.map((w) => ({ ids: w.nodes, pts: projGeom(w.geometry) })));
const walls = [];
for (const c of wallChains) {
  for (const piece of clipLine(c.pts)) {
    const s = simplifyLine(piece, 0.4);
    if (polyLength(s) >= 2) walls.push(flat(s));
  }
}

// --- Landmarks
function findEl(pred) {
  return els.find((e) => e.tags && pred(e.tags, e));
}
const landmarks = {};
{
  const minster = findEl((t) => t.building === 'cathedral' && /York Minster/i.test(t.name || ''));
  if (minster) {
    const ring = simplifyRing(outerRings(minster)[0], 0.4);
    const [cx, cy] = ringCentroid(ring);
    landmarks.minster = { x: r1(cx), y: r1(cy), footprint: flat(ring), h: r1(buildingHeight(minster.tags, 'cathedral')) };
  }
  const tower = findEl((t) => t.historic === 'castle' && /Clifford/i.test(t.name || ''));
  if (tower) {
    const ring = simplifyRing(outerRings(tower)[0], 0.4);
    const [cx, cy] = ringCentroid(ring);
    landmarks.cliffordsTower = { x: r1(cx), y: r1(cy), footprint: flat(ring) };
  }
  for (const [key, name] of [['lendalBridge', 'Lendal Bridge'], ['skeldergateBridge', 'Skeldergate Bridge']]) {
    const ways = hwWays.filter((w) => w.tags.name === name);
    if (!ways.length) continue;
    const chain = mergeChains(ways.map((w) => ({ ids: w.nodes, pts: projGeom(w.geometry) })))
      .sort((a, b) => polyLength(b.pts) - polyLength(a.pts))[0];
    const len = polyLength(chain.pts);
    let acc = 0, mid = chain.pts[0];
    for (let i = 1; i < chain.pts.length; i++) {
      const d = dist(chain.pts[i - 1], chain.pts[i]);
      if (acc + d >= len / 2) {
        const f = (len / 2 - acc) / d;
        mid = [chain.pts[i - 1][0] + f * (chain.pts[i][0] - chain.pts[i - 1][0]), chain.pts[i - 1][1] + f * (chain.pts[i][1] - chain.pts[i - 1][1])];
        break;
      }
      acc += d;
    }
    const a = chain.pts[0], b = chain.pts[chain.pts.length - 1];
    const w = ways[0].tags;
    landmarks[key] = {
      x: r1(mid[0]), y: r1(mid[1]),
      p: flat(chain.pts),
      length: r1(len),
      heading: r1((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI), // degrees clockwise from north
      w: r1(roadWidth(w, roadKind(w))),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Route: York inner ring, Dijkstra between waypoints on the highway graph.

const ROUTABLE = new Set([
  'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'trunk', 'trunk_link',
  'residential', 'unclassified', 'living_street', 'service', 'pedestrian', 'cycleway', 'footway', 'path', 'track', 'road',
]);
const CAR = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'trunk', 'trunk_link', 'residential', 'unclassified', 'living_street', 'road']);
function costFactor(t) {
  let f;
  if (['primary', 'primary_link', 'secondary', 'secondary_link', 'trunk', 'trunk_link'].includes(t.highway)) f = 1;
  else if (['tertiary', 'tertiary_link'].includes(t.highway)) f = 1.1;
  else if (['residential', 'unclassified', 'living_street', 'road'].includes(t.highway)) f = 1.4;
  else if (t.highway === 'service') f = 2.5;
  else if (t.highway === 'cycleway' || t.highway === 'pedestrian') f = 3;
  else f = 5; // footway, path, track
  if (t.access === 'private' || t.access === 'no') f *= 3;
  return f;
}

const nodePos = new Map(); // id -> [x,y]
const adj = new Map(); // id -> [{to, len, cost, way}]
const routeWays = hwWays.filter((w) => ROUTABLE.has(w.tags.highway) && w.tags.area !== 'yes' && w.nodes);
for (const w of routeWays) {
  const pts = projGeom(w.geometry);
  if (pts.length !== w.nodes.length) continue;
  const f = costFactor(w.tags);
  // Direction rules don't matter in the game, but a soft contraflow penalty keeps the route on one
  // carriageway of a dual carriageway instead of zig-zagging between the two.
  const ow = w.tags.oneway;
  const fwdOnly = ow === 'yes' || ow === 'true' || ow === '1' || (w.tags.junction === 'roundabout' && ow !== 'no');
  const fwdPen = ow === '-1' ? 3 : 1, backPen = fwdOnly ? 3 : 1;
  for (let i = 0; i < w.nodes.length; i++) nodePos.set(w.nodes[i], pts[i]);
  for (let i = 0; i + 1 < w.nodes.length; i++) {
    const a = w.nodes[i], b = w.nodes[i + 1];
    const len = dist(pts[i], pts[i + 1]);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push({ to: b, len, cost: len * f * fwdPen, way: w });
    adj.get(b).push({ to: a, len, cost: len * f * backPen, way: w });
  }
}

class Heap {
  constructor() { this.a = []; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
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
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
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
      const pen = penalty(u, e.to);
      const nd = d + e.cost * pen;
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

// Waypoints: a street (OSM name) plus a rough position hint (local metres) along it. The node of a
// car-road way with that name nearest to the hint is used.
const WAYPOINTS = [
  { name: 'Lord Mayors Walk', at: [90, 450] },
  { name: 'Gillygate', at: [-150, 445] },
  { name: "St Leonard's Place", at: [-220, 240] }, // Bootham Bar sits at its north end
  { name: 'Museum Street', at: [-265, 90] },
  { name: 'Lendal Bridge', at: [-356, -10] },
  { name: 'Station Road', at: [-560, -220] },
  { name: 'Queen Street', at: [-690, -440] },
  // (Blossom Street at Micklegate Bar is crossed between Queen Street and Nunnery Lane; a waypoint on it adds a spur.)
  { name: 'Nunnery Lane', at: [-380, -670] },
  { name: "Price's Lane", at: [-220, -750] },
  { name: 'Bishopgate Street', at: [-60, -700] },
  { name: 'Skeldergate Bridge', at: [50, -640] },
  { name: 'Tower Street', at: [170, -600] }, // south of Clifford's Tower, toward Castle Mills Bridge
  { name: 'Paragon Street', at: [500, -670] },
  { name: 'Foss Islands Road', at: [650, -200] },
  // (Peasholme Green branches off at the Layerthorpe Bridge junction; a waypoint on it adds a spur.)
  { name: 'Jewbury', at: [440, 190] },
  { name: 'Monkgate', at: [255, 335] }, // the short stretch outside Monk Bar
];

function waypointNode(wp) {
  let best = null, bestD = Infinity;
  for (const w of routeWays) {
    if (w.tags.name !== wp.name || !CAR.has(w.tags.highway)) continue;
    for (const id of w.nodes) {
      const p = nodePos.get(id);
      const d = dist(p, wp.at);
      if (d < bestD) { bestD = d; best = id; }
    }
  }
  if (best == null) throw new Error(`Waypoint street not found: ${wp.name}`);
  return best;
}

const wpNodes = WAYPOINTS.map(waypointNode);
// Penalise re-using edges already on the route so legs don't double back over each other.
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
// Remove out-and-back spurs (A -> B -> A) that appear where a waypoint sits just off the line.
{
  const n = [], e = [];
  for (let i = 0; i < routeNodes.length; i++) {
    if (n.length >= 2 && routeNodes[i] === n[n.length - 2]) { n.pop(); e.pop(); continue; }
    n.push(routeNodes[i]);
    if (i > 0) e.push(routeEdges[i - 1]);
  }
  routeNodes = n;
  routeEdges = e;
}

// Ordered distinct street names (ignore names we only clip for < 10 m, e.g. crossing a junction).
const runs = [];
for (const e of routeEdges) {
  const nm = displayName(e.way.tags) || null;
  if (runs.length && runs[runs.length - 1].name === nm) runs[runs.length - 1].len += e.len;
  else runs.push({ name: nm, len: e.len });
}
const streets = [];
const seenNames = new Set();
for (const r of runs) {
  const key = r.name?.toLowerCase().replace(/[^a-z]/g, ''); // "BIshopgate Street" is a typo'd duplicate in OSM
  if (r.name && r.len >= 10 && !seenNames.has(key)) { seenNames.add(key); streets.push(r.name); }
}

// Geometry: node positions -> dedupe -> Chaikin (once, corner cut capped at 2 m deviation) -> resample 4 m.
let pts = routeNodes.map((id) => nodePos.get(id));
pts = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 0.05);
if (dist(pts[0], pts[pts.length - 1]) < 0.05) pts.pop(); // closed loop: drop duplicate closing point

function chaikinClosed(p, maxDev) {
  const out = [];
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const prev = p[(i + n - 1) % n], cur = p[i], next = p[(i + 1) % n];
    const l1 = dist(prev, cur), l2 = dist(cur, next);
    if (l1 < 1e-6 || l2 < 1e-6) { out.push(cur); continue; }
    const u1 = [(prev[0] - cur[0]) / l1, (prev[1] - cur[1]) / l1];
    const u2 = [(next[0] - cur[0]) / l2, (next[1] - cur[1]) / l2];
    // Symmetric cut distance d from the corner; the chord midpoint lies d*|u1+u2|/2 from it.
    const half = Math.hypot(u1[0] + u2[0], u1[1] + u2[1]) / 2;
    let d = Math.min(l1, l2) / 4;
    if (half * d > maxDev) d = maxDev / half;
    if (half < 1e-3) { out.push(cur); continue; } // straight: nothing to cut
    out.push([cur[0] + u1[0] * d, cur[1] + u1[1] * d], [cur[0] + u2[0] * d, cur[1] + u2[1] * d]);
  }
  return out;
}
pts = chaikinClosed(pts, 2);

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
  return { pts: out, length: L };
}
const rs = resampleClosed(pts, 4);
// Close the loop explicitly: last point == first point.
const routePts = [...rs.pts, rs.pts[0]];

// Self-intersection check (non-adjacent segments).
function segsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
const crossings = [];
for (let i = 0; i + 1 < routePts.length; i++) {
  for (let j = i + 2; j + 1 < routePts.length; j++) {
    if (i === 0 && j === routePts.length - 2) continue;
    if (segsCross(routePts[i], routePts[i + 1], routePts[j], routePts[j + 1])) crossings.push([i, j]);
  }
}

const route = { name: 'York Inner Ring', points: flat(routePts), streets, length: Math.round(rs.length) };

// ---------------------------------------------------------------------------------------------
// Write

const out = {
  attribution: 'Map data © OpenStreetMap contributors (ODbL)',
  origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
  bounds: { minX: r1(RECT.x0), minY: r1(RECT.y0), maxX: r1(RECT.x1), maxY: r1(RECT.y1) },
  buildings,
  roads,
  water,
  green,
  walls,
  route,
  landmarks,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(OUT, json);

const startEnd = dist(routePts[0], routePts[routePts.length - 1]);
const gap = dist(routePts[0], routePts[routePts.length - 2]);
console.log(`\nWrote ${path.relative(root, OUT)}: ${(json.length / 1024).toFixed(0)} KB`);
console.log(`  buildings ${buildings.length}, roads ${roads.length} (dropped ${droppedSidewalks} sidewalks/crossings), water ${water.length}${bufferedRivers.length ? ` (buffered centrelines: ${[...new Set(bufferedRivers)].join(', ')})` : ''}, green ${green.length}, walls ${walls.length}`);
console.log(`  route: ${route.length} m, ${routePts.length} points, ${crossings.length} self-crossing segment pairs`);
console.log(`  streets: ${streets.join(' -> ')}`);
console.log(`  start/end distance ${startEnd.toFixed(1)} m (last distinct sample ${gap.toFixed(1)} m from start) ${startEnd <= 10 ? 'OK' : 'FAIL'}`);
if (landmarks.minster) console.log(`  Minster footprint centre (${landmarks.minster.x}, ${landmarks.minster.y}), h ${landmarks.minster.h} m`);
if (landmarks.cliffordsTower) console.log(`  Clifford's Tower (${landmarks.cliffordsTower.x}, ${landmarks.cliffordsTower.y})`);
for (const k of ['lendalBridge', 'skeldergateBridge']) if (landmarks[k]) console.log(`  ${k} (${landmarks[k].x}, ${landmarks[k].y}) len ${landmarks[k].length} m`);
if (crossings.length) console.log('  crossings at sample indices:', JSON.stringify(crossings.slice(0, 10)));
if (buildings.length < 500) throw new Error(`Only ${buildings.length} buildings (need >= 500)`);
if (json.length > 1.5 * 1024 * 1024) console.warn('  WARNING: output exceeds 1.5 MB');
