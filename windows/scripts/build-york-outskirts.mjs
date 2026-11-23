// Dev-time: York beyond the modelled city, from OpenStreetMap (ODbL): the suburbs' building footprints, land use,
// roads, railways, rivers, ponds, woods, trees and hedges out to ~4.3 km, packed compactly into
// src/renderer/game3d/data/york.json as `outskirts` (drawn by game3d/outskirts.js as low-cost housing blocks,
// painted streets and fields over the real relief).
//
//   node scripts/build-york-outskirts.mjs            (after build-york.mjs and build-york-terrain.mjs; cached in
//                                                     scripts/dales-cache/, git-ignored)
//   node scripts/build-york-outskirts.mjs --refresh  (refetch from Overpass)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overpass } from './dales-fetch.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(root, 'scripts/dales-cache/york-outskirts-overpass.json');
const FILE = path.join(root, 'src/renderer/game3d/data/york.json');
const EXT = 4300; // metres either side of the origin
const t0 = Date.now();

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const O = data.origin;
const KX = Math.cos((O.lat * Math.PI) / 180) * 111320, KY = 110540;
const project = (lat, lon) => [(lon - O.lon) * KX, (lat - O.lat) * KY];
const box = { s: O.lat - EXT / KY, n: O.lat + EXT / KY, w: O.lon - EXT / KX, e: O.lon + EXT / KX };
const bb = `(${box.s.toFixed(5)},${box.w.toFixed(5)},${box.n.toFixed(5)},${box.e.toFixed(5)})`;
const query = `[out:json][timeout:600][maxsize:1073741824];
(
  way["building"]${bb};
  way["landuse"]${bb};
  relation["landuse"]${bb};
  way["natural"~"^(wood|water|scrub|heath|grassland|wetland)$"]${bb};
  relation["natural"~"^(wood|water|wetland)$"]${bb};
  way["leisure"~"^(park|golf_course|pitch|nature_reserve|recreation_ground|garden|common|sports_centre|stadium|track)$"]${bb};
  relation["leisure"~"^(park|golf_course|nature_reserve|recreation_ground)$"]${bb};
  way["amenity"~"^(school|university|college|hospital|parking|grave_yard)$"]${bb};
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|cycleway|track)$"]${bb};
  way["railway"~"^(rail|light_rail|disused|siding)$"]${bb};
  way["waterway"~"^(river|stream|canal|drain|ditch)$"]${bb};
  way["water"]${bb};
  relation["water"]${bb};
  node["natural"="tree"]${bb};
  way["natural"="tree_row"]${bb};
  way["barrier"="hedge"]${bb};
);
out geom;`;
const osm = await overpass(query, CACHE, { refresh: process.argv.includes('--refresh') });
console.log(`OSM: ${osm.elements.length} elements`);

// ---- Geometry helpers ----
const city = data.bounds; // the modelled city (x east, y north)
const inCity = (p, m = 0) => p[0] > city.minX - m && p[0] < city.maxX + m && p[1] > city.minY - m && p[1] < city.maxY + m;
const inBox = (p) => Math.abs(p[0]) <= EXT && Math.abs(p[1]) <= EXT;
const proj = (geom) => (geom || []).filter(Boolean).map((g) => project(g.lat, g.lon));
const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
function simplify(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let md = -1, mi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k], pts[i], pts[j]);
      if (d > md) [md, mi] = [d, k];
    }
    if (md > tol) {
      keep[mi] = 1;
      stack.push([i, mi], [mi, j]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
const area = (r) => {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return a / 2;
};
const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
function rings(el) {
  if (el.type === 'way') {
    const p = proj(el.geometry);
    return p.length >= 4 && same(p[0], p[p.length - 1]) ? [p.slice(0, -1)] : [];
  }
  if (el.type !== 'relation') return [];
  // Outer rings, assembled from member ways.
  const pool = (el.members || []).filter((m) => m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === '')).map((m) => proj(m.geometry));
  const out = [];
  while (pool.length) {
    let r = pool.pop();
    for (let guard = 0; !same(r[0], r[r.length - 1]) && guard < 5000; guard++) {
      const end = r[r.length - 1];
      const i = pool.findIndex((l) => same(l[0], end) || same(l[l.length - 1], end));
      if (i < 0) break;
      let nx = pool.splice(i, 1)[0];
      if (!same(nx[0], end)) nx = nx.reverse();
      r = r.concat(nx.slice(1));
    }
    if (r.length >= 4 && same(r[0], r[r.length - 1])) out.push(r.slice(0, -1));
  }
  return out;
}
const num = (v) => {
  const m = String(v ?? '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};

// ---- Packing: Int16 in half metres ----
const coords = [];
const lineOf = (pts) => {
  const start = coords.length / 2;
  for (const p of pts) coords.push(Math.round(p[0] * 2), Math.round(p[1] * 2));
  return [start, pts.length];
};
const b64 = (arr, Type) => Buffer.from(new Type(arr).buffer).toString('base64');

// ---- Buildings: oriented rectangles ----
const H_HOUSE = 5.4;
const buildings = [];
let skippedCity = 0;
for (const el of osm.elements) {
  if (el.type !== 'way' || !el.tags?.building || el.tags.building === 'no') continue;
  const r = proj(el.geometry);
  if (r.length < 4) continue;
  const ring = same(r[0], r[r.length - 1]) ? r.slice(0, -1) : r;
  if (ring.some((p) => inCity(p))) {
    skippedCity++;
    continue;
  }
  if (!ring.every(inBox)) continue;
  const a = Math.abs(area(ring));
  if (a < 8) continue;
  // Principal axis from the longest edge.
  let best = 0, ux = 1, uy = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const dx = ring[j][0] - ring[i][0], dy = ring[j][1] - ring[i][1], l = Math.hypot(dx, dy);
    if (l > best) [best, ux, uy] = [l, dx / l, dy / l];
  }
  let mx = 0, my = 0;
  for (const p of ring) {
    mx += p[0];
    my += p[1];
  }
  mx /= ring.length;
  my /= ring.length;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of ring) {
    const dx = p[0] - mx, dy = p[1] - my;
    const s = dx * ux + dy * uy, t = -dx * uy + dy * ux;
    a0 = Math.min(a0, s);
    a1 = Math.max(a1, s);
    b0 = Math.min(b0, t);
    b1 = Math.max(b1, t);
  }
  const cs = (a0 + a1) / 2, ct = (b0 + b1) / 2;
  const cx = mx + ux * cs - uy * ct, cy = my + uy * cs + ux * ct;
  let L = a1 - a0, Wd = b1 - b0, ang = Math.atan2(uy, ux);
  if (Wd > L) {
    [L, Wd] = [Wd, L];
    ang += Math.PI / 2;
  }
  // Fill: a rectangle much bigger than the footprint (an L or U shape) is shrunk to the same area.
  const fill = a / (L * Wd);
  if (fill < 0.75) {
    const k = Math.sqrt(Math.max(0.35, fill));
    L *= k;
    Wd *= k;
  }
  ang = ((ang % Math.PI) + Math.PI) % Math.PI;
  const t = el.tags;
  const kind = t.building;
  const lv = num(t['building:levels']), ht = num(t.height);
  const house = ['house', 'detached', 'semidetached_house', 'terrace', 'residential', 'bungalow', 'cottage', 'farm'].includes(kind);
  const shed = ['garage', 'garages', 'shed', 'hut', 'carport', 'greenhouse', 'roof', 'kiosk'].includes(kind);
  const big = ['industrial', 'warehouse', 'retail', 'commercial', 'supermarket', 'office', 'school', 'university', 'college', 'hospital', 'sports_hall', 'hangar', 'factory', 'manufacture', 'storage_tank', 'transportation', 'train_station', 'public', 'civic', 'stadium', 'barn', 'farm_auxiliary', 'church'].includes(kind);
  let h, roof;
  if (ht > 0) h = ht;
  else if (lv > 0) h = lv * 2.8 + 0.4;
  else if (kind === 'apartments' || kind === 'flats') h = 9.5;
  else if (kind === 'bungalow') h = 2.9;
  else if (shed || a < 30) h = 2.5;
  else if (house) h = H_HOUSE;
  else if (big || a > 600) h = a > 3000 ? 9 : 7;
  else h = a > 220 ? 7 : H_HOUSE;
  // Roofs: 0 gable, 1 hipped, 2 flat.
  if (shed || big || a > 600 || kind === 'apartments' || kind === 'flats') roof = 2;
  else roof = (Math.round(cx * 7 + cy * 13) & 3) === 0 ? 1 : 0;
  if (kind === 'church') roof = 0;
  buildings.push(Math.round(cx * 2), Math.round(cy * 2), Math.round(L * 10), Math.round(Wd * 10), Math.round((ang / Math.PI) * 32767), Math.round(h * 10), roof | (kind === 'church' ? 4 : 0) | (big ? 8 : 0));
}
console.log(`buildings: ${buildings.length / 7} (${skippedCity} in the modelled city left to it)`);

// ---- Land use areas (class ids, see outskirts.js) ----
const AREA = {
  residential: 1, garages: 1,
  industrial: 2, commercial: 2, retail: 2, railway: 2, construction: 2, brownfield: 2, depot: 2,
  farmland: 3, meadow: 3, farmyard: 3, orchard: 3, plant_nursery: 3, greenhouse_horticulture: 3,
  grass: 4, recreation_ground: 4, village_green: 4, park: 4, garden: 4, common: 4, pitch: 4, golf_course: 4, nature_reserve: 4, grassland: 4, sports_centre: 4, stadium: 4, track: 4, playground: 4,
  forest: 5, wood: 5, scrub: 6, heath: 6, wetland: 6,
  allotments: 7, cemetery: 8, grave_yard: 8, school: 9, university: 9, college: 9, hospital: 9, parking: 10,
  water: 11, basin: 11, reservoir: 11,
};
const areas = [];
for (const el of osm.elements) {
  const t = el.tags || {};
  const key = t.landuse ?? (t.natural === 'water' || t.water ? 'water' : t.natural) ?? t.leisure ?? t.amenity;
  const cls = AREA[key] ?? AREA[t.leisure] ?? AREA[t.amenity];
  if (!cls) continue;
  for (const r of rings(el)) {
    const ring = simplify([...r, r[0]], cls === 11 ? 1 : 2.5).slice(0, -1);
    if (ring.length < 3 || Math.abs(area(ring)) < (cls === 11 ? 60 : 300)) continue;
    if (!ring.some(inBox)) continue;
    areas.push({ cls, a: Math.abs(area(ring)), ring });
  }
}
// Big first, so small areas (a park in an estate) are painted over them.
areas.sort((a, b) => b.a - a.a);
const areaIdx = areas.map((ar) => [...lineOf(ar.ring), ar.cls]);
console.log(`areas: ${areas.length}`);

// ---- Lines: roads, rail, waterways, hedges, tree rows (class ids, see outskirts.js) ----
const ROAD = { motorway: 1, trunk: 1, primary: 2, secondary: 2, tertiary: 3, unclassified: 4, residential: 4, living_street: 4, service: 5, motorway_link: 2, trunk_link: 2, primary_link: 3, secondary_link: 3, tertiary_link: 4, cycleway: 6, track: 7 };
const lines = [];
for (const el of osm.elements) {
  if (el.type !== 'way') continue;
  const t = el.tags || {};
  let cls = 0;
  if (t.highway && ROAD[t.highway] && t.tunnel !== 'yes') cls = ROAD[t.highway];
  else if (t.railway && t.tunnel !== 'yes') cls = t.railway === 'disused' ? 0 : 10;
  else if (t.waterway === 'river' || t.waterway === 'canal') cls = 20;
  else if (t.waterway === 'stream') cls = 21;
  else if (t.waterway === 'drain' || t.waterway === 'ditch') cls = 22;
  else if (t.barrier === 'hedge') cls = 30;
  else if (t.natural === 'tree_row') cls = 31;
  if (!cls) continue;
  const p = proj(el.geometry);
  if (p.length < 2 || !p.some(inBox)) continue;
  // Roads inside the modelled city are drawn by york.js.
  if (cls < 10 && p.every((q) => inCity(q, -5))) continue;
  const s = simplify(p, cls >= 30 ? 2 : 1.2);
  lines.push([...lineOf(s), cls]);
}
console.log(`lines: ${lines.length}`);

// ---- Single trees ----
const trees = [];
for (const el of osm.elements) {
  if (el.type !== 'node' || el.tags?.natural !== 'tree') continue;
  const p = project(el.lat, el.lon);
  if (inBox(p) && !inCity(p)) trees.push(Math.round(p[0] * 2), Math.round(p[1] * 2));
}
console.log(`trees: ${trees.length / 2}`);

const toI16 = (a) => {
  for (const v of a) if (v < -32768 || v > 32767) throw new Error(`out of Int16 range: ${v}`);
  return a;
};
data.outskirts = {
  credit: 'Map data © OpenStreetMap contributors (ODbL)',
  ext: EXT,
  unit: 0.5,
  coords: b64(toI16(coords), Int16Array),
  buildings: b64(toI16(buildings), Int16Array),
  areas: b64(areaIdx.flat(), Int32Array),
  lines: b64(lines.flat(), Int32Array),
  trees: b64(toI16(trees), Int16Array),
};
const json = JSON.stringify(data);
fs.writeFileSync(FILE, json);
const kb = (k) => (data.outskirts[k].length / 1024).toFixed(0);
console.log(`Wrote york.json (${(json.length / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)} s: coords ${kb('coords')} KB, buildings ${kb('buildings')} KB, areas ${kb('areas')} KB, lines ${kb('lines')} KB, trees ${kb('trees')} KB`);
