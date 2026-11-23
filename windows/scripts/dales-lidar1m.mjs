// The Environment Agency 1 m LIDAR DTM (Open Government Licence v3.0) over the detailed part of the Malham map,
// resampled once onto the map's local metre grid (x east, y north from the origin) and cached as a raw
// Float32 file, so the detail build (build-dales-detail.mjs) can work on it quickly.
import fs from 'node:fs';
import path from 'node:path';
import { Lidar } from './dales-fetch.mjs';

export const ORIGIN = { lat: 54.075, lon: -2.16 };
const KX = Math.cos((ORIGIN.lat * Math.PI) / 180) * 111320, KY = 110540;
export const unproject = (x, y) => [ORIGIN.lat + y / KY, ORIGIN.lon + x / KX];

/** The box the 1 m grid covers (local metres). */
export const BOX1M = { x0: -2310, y0: -2110, x1: 2200, y1: 2570 };

const latLonBox = (r) => {
  const [s, w] = unproject(r.x0, r.y0), [n, e] = unproject(r.x1, r.y1);
  return { s, w, n, e };
};

/**
 * Bilinear height from whichever tile holds the point furthest from its edge (the WCS tiles' outermost
 * half-pixels cannot be interpolated, which shows as seams if the first tile that covers a point is used).
 */
function sample(rasters, lat, lon) {
  let best = null, bestM = -Infinity;
  for (const r of rasters) {
    if (lat < r.s || lat > r.n || lon < r.west || lon > r.east) continue;
    const x = ((lon - r.west) / (r.east - r.west)) * r.nx - 0.5, y = ((r.n - lat) / (r.n - r.s)) * r.ny - 0.5;
    const m = Math.min(x, y, r.nx - 1 - x, r.ny - 1 - y);
    if (m > bestM) [best, bestM] = [{ r, x, y }, m];
  }
  if (!best) return NaN;
  const { r, x, y } = best;
  const i = Math.max(0, Math.min(r.nx - 2, Math.floor(x))), j = Math.max(0, Math.min(r.ny - 2, Math.floor(y)));
  const u = Math.min(1, Math.max(0, x - i)), v = Math.min(1, Math.max(0, y - j));
  const a = r.data[j * r.nx + i], b = r.data[j * r.nx + i + 1], c = r.data[(j + 1) * r.nx + i], d = r.data[(j + 1) * r.nx + i + 1];
  const h = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  if (Number.isFinite(h)) return h;
  // Next to a gap (open water): the mean of the valid corners.
  let s = 0, n = 0;
  for (const q of [a, b, c, d]) if (Number.isFinite(q)) [s, n] = [s + q, n + 1];
  return n ? s / n : NaN;
}

/**
 * Returns {x0, y0, nx, ny, cell: 1, h: Float32Array} (row 0 = y0, i.e. south). `fill(x, y)` supplies heights
 * where there is no LIDAR (open water).
 */
export async function lidar1m(cacheDir, fill) {
  const b = BOX1M;
  const nx = b.x1 - b.x0 + 1, ny = b.y1 - b.y0 + 1;
  const file = path.join(cacheDir, `grid1m_v4_${b.x0}_${b.y0}_${nx}x${ny}.f32`);
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    return { x0: b.x0, y0: b.y0, nx, ny, cell: 1, h: new Float32Array(buf.buffer, buf.byteOffset, nx * ny) };
  }
  const lidar = new Lidar(cacheDir);
  // The same box as it was fetched with (the cache is keyed by the request), see scripts/dales-fetch.mjs.
  await lidar.fetch(latLonBox({ x0: -2320, y0: -2120, x1: 2220, y1: 2580 }), 1, 1400);
  const h = new Float32Array(nx * ny);
  let gaps = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [lat, lon] = unproject(b.x0 + i, b.y0 + j);
      let v = sample(lidar.rasters, lat, lon);
      if (!Number.isFinite(v)) {
        v = fill ? fill(b.x0 + i, b.y0 + j) : NaN;
        gaps++;
      }
      h[j * nx + i] = v;
    }
  }
  // The WCS tiles' outermost pixels are unreliable (a step of up to a metre shows where tiles meet): across each
  // internal tile edge, replace an 8 m band with a straight line between clean samples either side.
  const xs = new Set(), ys = new Set();
  const KXl = Math.cos((ORIGIN.lat * Math.PI) / 180) * 111320, KYl = 110540;
  for (const r of lidar.rasters) {
    for (const lon of [r.west, r.east]) xs.add(Math.round((lon - ORIGIN.lon) * KXl * 10) / 10);
    for (const lat of [r.s, r.n]) ys.add(Math.round((lat - ORIGIN.lat) * KYl * 10) / 10);
  }
  let patched = 0;
  for (const xb of xs) {
    const ib = xb - b.x0;
    if (ib < 4 || ib > nx - 5) continue;
    const a = Math.floor(ib) - 4, c = Math.ceil(ib) + 4;
    for (let j = 0; j < ny; j++) {
      const ha = h[j * nx + a], hc = h[j * nx + c];
      for (let i = a + 1; i < c; i++) h[j * nx + i] = ha + ((hc - ha) * (i - a)) / (c - a);
    }
    patched++;
  }
  for (const yb of ys) {
    const jb = yb - b.y0;
    if (jb < 4 || jb > ny - 5) continue;
    const a = Math.floor(jb) - 4, c = Math.ceil(jb) + 4;
    for (let i = 0; i < nx; i++) {
      const ha = h[a * nx + i], hc = h[c * nx + i];
      for (let j = a + 1; j < c; j++) h[j * nx + i] = ha + ((hc - ha) * (j - a)) / (c - a);
    }
    patched++;
  }
  fs.writeFileSync(file, Buffer.from(h.buffer));
  console.log(`LIDAR 1 m grid: ${nx}×${ny}, ${gaps} gaps filled, ${patched} tile seams patched`);
  return { x0: b.x0, y0: b.y0, nx, ny, cell: 1, h };
}
