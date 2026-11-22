// Dev-time: adds York's real (gentle) relief and aerial imagery to src/renderer/game3d/data/york.json.
//
//   node scripts/build-york-terrain.mjs     (build-york.mjs runs it at the end too)
//
// Relief: Environment Agency LIDAR Composite DTM (Open Government Licence v3.0) around the city, with bumps
// narrower than ~60 m removed (the city wall ramparts and Clifford's Tower's motte are modelled by york.js) and
// smoothed. It is stored as `relief`: metres above York's street level by the river (the game's 12 m), fading
// to zero beside the Ouse and the Foss so their quays, water and bridges keep their modelled heights.
// Imagery: Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016),
// CC BY 4.0, saved as york-near.jpg / york-far.jpg next to the JSON. Caches under scripts/dales-cache/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lidar, Terrarium, sentinelImage } from './dales-fetch.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(root, 'scripts/dales-cache');
const FILE = path.join(root, 'src/renderer/game3d/data/york.json');
const EXTENT = 4500; // metres either side of the origin
const CELL = 10, OUT_CELL = 20;

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const O = data.origin;
const KX = Math.cos((O.lat * Math.PI) / 180) * 111320, KY = 110540;
const unproject = (x, y) => [O.lat + y / KY, O.lon + x / KX];
const box = (x0, y0, x1, y1) => {
  const [s, w] = unproject(x0, y0), [n, e] = unproject(x1, y1);
  return { s, w, n, e };
};
const r1 = (v) => Math.round(v * 10) / 10;

const lidar = new Lidar(CACHE_DIR);
await lidar.fetch(box(-EXTENT - 50, -EXTENT - 50, EXTENT + 50, EXTENT + 50), CELL);
const tiles = new Terrarium(12, CACHE_DIR);
await tiles.prefetch(box(-EXTENT - 300, -EXTENT - 300, EXTENT + 300, EXTENT + 300));

// ---- Sample at 10 m, water masked out ----
const N = Math.round((2 * EXTENT) / CELL) + 1;
const at = (i, j) => [-EXTENT + i * CELL, -EXTENT + j * CELL];
const h = new Float64Array(N * N);
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const [x, y] = at(i, j);
    const [lat, lon] = unproject(x, y);
    const v = lidar.at(lat, lon);
    h[j * N + i] = Number.isFinite(v) ? v : tiles.at(lat, lon);
  }
}
const water = new Uint8Array(N * N);
for (const ring of data.water) {
  let y0 = Infinity, y1 = -Infinity;
  for (let k = 1; k < ring.length; k += 2) {
    y0 = Math.min(y0, ring[k]);
    y1 = Math.max(y1, ring[k]);
  }
  for (let j = Math.max(0, Math.floor((y0 + EXTENT) / CELL)); j <= Math.min(N - 1, Math.ceil((y1 + EXTENT) / CELL)); j++) {
    const y = -EXTENT + j * CELL;
    const xs = [];
    for (let a = 0, b = ring.length - 2; a < ring.length; b = a, a += 2) {
      if ((ring[a + 1] > y) !== (ring[b + 1] > y)) xs.push(ring[a] + ((y - ring[a + 1]) / (ring[b + 1] - ring[a + 1])) * (ring[b] - ring[a]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let i = Math.max(0, Math.ceil((xs[k] + EXTENT) / CELL)); i <= Math.min(N - 1, Math.floor((xs[k + 1] + EXTENT) / CELL)); i++) water[j * N + i] = 1;
  }
}
for (let k = 0; k < N * N; k++) if (water[k]) h[k] = NaN;

// ---- Remove narrow bumps (opening: min then max over a 70 m square), then smooth (σ 25 m) ----
function filter1d(src, r, pick, horizontal) {
  const out = new Float64Array(N * N);
  for (let a = 0; a < N; a++) {
    for (let b = 0; b < N; b++) {
      let v = NaN;
      for (let k = -r; k <= r; k++) {
        const c = b + k;
        if (c < 0 || c >= N) continue;
        const s = horizontal ? src[a * N + c] : src[c * N + a];
        if (Number.isFinite(s)) v = Number.isFinite(v) ? pick(v, s) : s;
      }
      out[horizontal ? a * N + b : b * N + a] = v;
    }
  }
  return out;
}
let g = filter1d(filter1d(h, 3, Math.min, true), 3, Math.min, false);
g = filter1d(filter1d(g, 3, Math.max, true), 3, Math.max, false);
function gauss(src, sigma) {
  const r = Math.ceil(sigma * 3), w = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const pass = (s, horizontal) => {
    const out = new Float64Array(N * N);
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        let sum = 0, ws = 0;
        for (let k = -r; k <= r; k++) {
          const c = Math.min(N - 1, Math.max(0, b + k));
          const v = horizontal ? s[a * N + c] : s[c * N + a];
          if (Number.isFinite(v)) {
            sum += v * w[k + r];
            ws += w[k + r];
          }
        }
        out[horizontal ? a * N + b : b * N + a] = ws > 0 ? sum / ws : NaN;
      }
    }
    return out;
  };
  return pass(pass(src, true), false);
}
const S = gauss(g, 2.5);

// ---- Distance to water (chamfer), the riverside reference level and the relief ----
const dw = new Float64Array(N * N).fill(1e9);
for (let k = 0; k < N * N; k++) if (water[k]) dw[k] = 0;
for (let pass = 0; pass < 2; pass++) {
  const fwd = pass === 0;
  for (let jj = 0; jj < N; jj++) {
    const j = fwd ? jj : N - 1 - jj;
    for (let ii = 0; ii < N; ii++) {
      const i = fwd ? ii : N - 1 - ii;
      for (const [di, dj, c] of fwd ? [[-1, 0, 1], [0, -1, 1], [-1, -1, 1.414], [1, -1, 1.414]] : [[1, 0, 1], [0, 1, 1], [1, 1, 1.414], [-1, 1, 1.414]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= N || b >= N) continue;
        dw[j * N + i] = Math.min(dw[j * N + i], dw[b * N + a] + c * CELL);
      }
    }
  }
}
const B = data.bounds;
const bank = [];
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const [x, y] = at(i, j), k = j * N + i;
    if (x > B.minX && x < B.maxX && y > B.minY && y < B.maxY && dw[k] >= 20 && dw[k] <= 50 && Number.isFinite(S[k])) bank.push(S[k]);
  }
}
bank.sort((p, q) => p - q);
const ref = bank[Math.floor(bank.length / 2)];
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const step = OUT_CELL / CELL;
const M = Math.floor((N - 1) / step) + 1;
const out = new Int16Array(M * M);
let min = Infinity, max = -Infinity;
for (let j = 0; j < M; j++) {
  for (let i = 0; i < M; i++) {
    const k = j * step * N + i * step;
    let d = Number.isFinite(S[k]) ? S[k] - ref : 0;
    d = Math.max(-3, Math.min(30, d)) * smooth(15, 80, dw[k]);
    out[j * M + i] = Math.round(d * 10);
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
}
const relief = { x0: -EXTENT, y0: -EXTENT, nx: M, ny: M, cell: OUT_CELL, ref: r1(ref), min: r1(min), max: r1(max), data: Buffer.from(out.buffer).toString('base64') };
const reliefAt = (x, y) => {
  const i = Math.round((x + EXTENT) / OUT_CELL), j = Math.round((y + EXTENT) / OUT_CELL);
  return out[j * M + i] / 10;
};

// ---- Imagery ----
const imagery = { credit: 'Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0' };
for (const [key, r, mpp] of [['near', { x0: B.minX - 700, y0: B.minY - 700, x1: B.maxX + 700, y1: B.maxY + 700 }, 9.5546], ['far', { x0: -EXTENT, y0: -EXTENT, x1: EXTENT, y1: EXTENT }, 19.1093]]) {
  const img = await sentinelImage(box(r.x0, r.y0, r.x1, r.y1), mpp, CACHE_DIR);
  const file = `york-${key}.jpg`;
  fs.writeFileSync(path.join(path.dirname(FILE), file), img.buf);
  imagery[key] = { file, x0: r1(r.x0), y0: r1(r.y0), x1: r1(r.x1), y1: r1(r.y1), w: img.width, h: img.height, kb: Math.round(img.buf.length / 1024) };
}

data.relief = relief;
data.imagery = imagery;
data.attribution = 'Map data © OpenStreetMap contributors (ODbL). Relief: Environment Agency LIDAR Composite DTM (© Environment Agency copyright and/or database right, Open Government Licence v3.0). Imagery: Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0.';
const json = JSON.stringify(data);
fs.writeFileSync(FILE, json);
const lm = data.landmarks;
console.log(`York relief: riverside level ${relief.ref} m, relief ${relief.min}…${relief.max} m (${M}×${M} @${OUT_CELL} m); york.json now ${(json.length / 1024).toFixed(0)} KB`);
if (lm.minster) console.log(`  Minster +${reliefAt(lm.minster.x, lm.minster.y).toFixed(1)} m, Clifford's Tower +${reliefAt(lm.cliffordsTower.x, lm.cliffordsTower.y).toFixed(1)} m, Lendal Bridge +${reliefAt(lm.lendalBridge.x, lm.lendalBridge.y).toFixed(1)} m`);
console.log(`  imagery near ${imagery.near.w}×${imagery.near.h} (${imagery.near.kb} KB), far ${imagery.far.w}×${imagery.far.h} (${imagery.far.kb} KB)`);
