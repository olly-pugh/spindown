// Dev-time: adds the fine detail of the Malham landscape to src/renderer/game3d/data/dales.json, from the
// Environment Agency 1 m LIDAR DTM (Open Government Licence v3.0, © Environment Agency copyright and/or database
// right), fetched into scripts/dales-cache/ (git-ignored):
//
//  - dales-relief.jpg: the ground's shape at 2 m (a world-space normal map with a hollow/ridge channel), so the
//    terrain is lit by the real relief (scars, shake holes, lynchets, wall banks) whatever its mesh detail.
//  - detail.cliffs: every limestone cliff and scar near the loop (Malham Cove, Gordale Scar, the scars along Cove
//    Road and the Rakes): a line along each face and the 1 m ground around it, from which the renderer builds
//    real vertical rock faces (game3d/cliffs.js).
//
//   node scripts/build-dales-detail.mjs        (build-dales.mjs runs it at the end too)
//   node scripts/build-dales-detail.mjs --debug   (also writes debug images to scripts/dales-cache/debug/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lidar1m } from './dales-lidar1m.mjs';
import { encodeJpeg } from './jpeg-encode.mjs';
import { HeightGrid } from '../src/core/world/heightgrid.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(root, 'scripts/dales-cache');
const DATA_DIR = path.join(root, 'src/renderer/game3d/data');
const FILE = path.join(DATA_DIR, 'dales.json');
const DEBUG = process.argv.includes('--debug');
const DEBUG_DIR = path.join(CACHE_DIR, 'debug');
if (DEBUG) fs.mkdirSync(DEBUG_DIR, { recursive: true });

const t0 = Date.now();
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const grids = ['near', 'mid', 'far'].map((k) => new HeightGrid(data.terrain[k]));
const inside = (g, x, y) => x >= g.x0 && x <= g.x1 && y >= g.y0 && y <= g.y1;
const coarse = (x, y) => grids.find((g) => inside(g, x, y))?.at(x, y) ?? grids[2].at(x, y);
const G = await lidar1m(CACHE_DIR, coarse);
const { nx, ny } = G;
const H = G.h;
console.log(`1 m grid ${nx}×${ny} ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

/** Grid index helpers: (i, j) column/row from the south-west corner. */
const idx = (i, j) => j * nx + i;
const hAt = (i, j) => H[idx(Math.min(nx - 1, Math.max(0, i)), Math.min(ny - 1, Math.max(0, j)))];

// ---------------------------------------------------------------------------------------------
// Relief: a world-space normal map at 2 m from the 1 m DTM (box-filtered to 2 m first), with a curvature channel.

const RELIEF_CELL = 2;
{
  const rx = Math.floor((nx - 1) / RELIEF_CELL), ry = Math.floor((ny - 1) / RELIEF_CELL);
  // 2 m heights: mean of each 2×2 block of 1 m samples.
  const h2 = new Float32Array(rx * ry);
  for (let j = 0; j < ry; j++) {
    for (let i = 0; i < rx; i++) {
      const a = i * 2, b = j * 2;
      h2[j * rx + i] = (hAt(a, b) + hAt(a + 1, b) + hAt(a, b + 1) + hAt(a + 1, b + 1)) / 4;
    }
  }
  const h2At = (i, j) => h2[Math.min(ry - 1, Math.max(0, j)) * rx + Math.min(rx - 1, Math.max(0, i))];
  // Image rows run north to south (row 0 = the north edge) so the texture is the right way up with flipY.
  const px = new Uint8Array(rx * ry * 3);
  for (let j = 0; j < ry; j++) {
    for (let i = 0; i < rx; i++) {
      // Sobel gradient over 2 m cells.
      const dzdx = ((h2At(i + 1, j - 1) + 2 * h2At(i + 1, j) + h2At(i + 1, j + 1)) - (h2At(i - 1, j - 1) + 2 * h2At(i - 1, j) + h2At(i - 1, j + 1))) / (8 * RELIEF_CELL);
      const dzdy = ((h2At(i - 1, j + 1) + 2 * h2At(i, j + 1) + h2At(i + 1, j + 1)) - (h2At(i - 1, j - 1) + 2 * h2At(i, j - 1) + h2At(i + 1, j - 1))) / (8 * RELIEF_CELL);
      // World space: x east, y up, z south. The surface normal is (-dz/dx, 1, +dz/dy) normalised (z = -north).
      let wx = -dzdx, wy = 1, wz = dzdy;
      const len = Math.hypot(wx, wy, wz);
      wx /= len;
      wz /= len;
      // Curvature (Laplacian over 4 m): negative in hollows and grikes, positive on ridges and edges.
      const lap = (h2At(i - 2, j) + h2At(i + 2, j) + h2At(i, j - 2) + h2At(i, j + 2) - 4 * h2At(i, j)) / 16;
      const o = ((ry - 1 - j) * rx + i) * 3;
      px[o] = Math.round(Math.min(255, Math.max(0, 127.5 + wx * 127.5)));
      px[o + 1] = Math.round(Math.min(255, Math.max(0, 127.5 + wz * 127.5)));
      px[o + 2] = Math.round(Math.min(255, Math.max(0, 128 - lap * 160)));
    }
  }
  const jpg = encodeJpeg({ width: rx, height: ry, channels: 3, data: px }, 88);
  fs.writeFileSync(path.join(DATA_DIR, 'dales-relief.jpg'), jpg);
  data.relief = {
    file: 'dales-relief.jpg',
    // Texel centres: pixel i covers x0 + i·cell .. +cell (the image spans the rect exactly).
    x0: G.x0, y0: G.y0, x1: G.x0 + rx * RELIEF_CELL, y1: G.y0 + ry * RELIEF_CELL,
    w: rx, h: ry, kb: Math.round(jpg.length / 1024),
    credit: 'Relief: Environment Agency LIDAR Composite DTM 1 m, Open Government Licence v3.0',
  };
  console.log(`relief ${rx}×${ry} @${RELIEF_CELL} m: ${(jpg.length / 1024).toFixed(0)} KB`);
}

// ---------------------------------------------------------------------------------------------
// Cliffs: faces steeper than ~50° and at least a few metres high, near enough the loop to be seen.

const STEEP = 50; // degrees
const MIN_RELIEF = 4; // metres of face
const ROUTE_RANGE = 1700; // metres from the road
const routePts = data.route.points;
function routeDistance(x, y) {
  let best = Infinity;
  for (let i = 0; i + 3 < routePts.length; i += 2) {
    const ax = routePts[i], ay = routePts[i + 1], bx = routePts[i + 2], by = routePts[i + 3];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

const steep = new Uint8Array(nx * ny);
const gradX = new Float32Array(nx * ny), gradY = new Float32Array(nx * ny);
{
  const tanS = Math.tan((STEEP * Math.PI) / 180);
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const gx = ((hAt(i + 1, j - 1) + 2 * hAt(i + 1, j) + hAt(i + 1, j + 1)) - (hAt(i - 1, j - 1) + 2 * hAt(i - 1, j) + hAt(i - 1, j + 1))) / 8;
      const gy = ((hAt(i - 1, j + 1) + 2 * hAt(i, j + 1) + hAt(i + 1, j + 1)) - (hAt(i - 1, j - 1) + 2 * hAt(i, j - 1) + hAt(i + 1, j - 1))) / 8;
      gradX[idx(i, j)] = gx;
      gradY[idx(i, j)] = gy;
      if (gx * gx + gy * gy > tanS * tanS) steep[idx(i, j)] = 1;
    }
  }
}

/** Connected components of the steep mask (8-neighbour), with their cells, box and height range. */
const comps = [];
{
  const label = new Int32Array(nx * ny);
  const stack = [];
  for (let s = 0; s < nx * ny; s++) {
    if (!steep[s] || label[s]) continue;
    const id = comps.length + 1;
    const cells = [];
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop();
      cells.push(c);
      const ci = c % nx, cj = (c - ci) / nx;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di, jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const k = jj * nx + ii;
          if (steep[k] && !label[k]) {
            label[k] = id;
            stack.push(k);
          }
        }
      }
    }
    let i0 = nx, i1 = 0, j0 = ny, j1 = 0, zLo = Infinity, zHi = -Infinity, sx = 0, sy = 0;
    for (const c of cells) {
      const ci = c % nx, cj = (c - ci) / nx;
      i0 = Math.min(i0, ci); i1 = Math.max(i1, ci); j0 = Math.min(j0, cj); j1 = Math.max(j1, cj);
      sx += ci;
      sy += cj;
    }
    // Height range of the face: around the steep cells (the lip and the foot lie just outside them).
    for (const c of cells) {
      const ci = c % nx, cj = (c - ci) / nx;
      for (const [di, dj] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) {
        const v = hAt(ci + di, cj + dj);
        zLo = Math.min(zLo, v);
        zHi = Math.max(zHi, v);
      }
    }
    comps.push({ id, cells, i0, i1, j0, j1, relief: zHi - zLo, cx: G.x0 + sx / cells.length, cy: G.y0 + sy / cells.length });
  }
}
// Real rock is far steeper than the smooth ramps LIDAR interpolates under trees: keep a component only if some
// of it is near-vertical.
for (const c of comps) {
  let mx = 0, n60 = 0;
  for (const k of c.cells) {
    const s = Math.atan(Math.hypot(gradX[k], gradY[k])) * 57.2958;
    mx = Math.max(mx, s);
    if (s > 60) n60++;
  }
  c.maxSlope = mx;
  c.frac60 = n60 / c.cells.length;
}
const kept = comps.filter((c) => c.cells.length >= 12 && c.relief >= MIN_RELIEF && c.maxSlope >= 63 && c.frac60 > 0.12 && routeDistance(c.cx, c.cy) < ROUTE_RANGE);
console.log(`steep components: ${comps.length}, kept ${kept.length} (${kept.reduce((s, c) => s + c.cells.length, 0)} cells)`);

/** Zhang–Suen thinning of a component's cells to a one-cell-wide skeleton; returns flat [i, j, ...] cells. */
function skeleton(comp) {
  const pad = 2;
  const w = comp.i1 - comp.i0 + 1 + 2 * pad, h = comp.j1 - comp.j0 + 1 + 2 * pad;
  const m = new Uint8Array(w * h);
  for (const c of comp.cells) {
    const ci = c % nx, cj = (c - ci) / nx;
    m[(cj - comp.j0 + pad) * w + (ci - comp.i0 + pad)] = 1;
  }
  // Close one-cell holes first so the skeleton does not loop around them.
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) if (!m[j * w + i] && m[j * w + i - 1] + m[j * w + i + 1] + m[(j - 1) * w + i] + m[(j + 1) * w + i] >= 3) m[j * w + i] = 1;
  const P = (i, j) => m[j * w + i];
  let changed = true;
  const del = [];
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let j = 1; j < h - 1; j++) {
        for (let i = 1; i < w - 1; i++) {
          if (!P(i, j)) continue;
          const p2 = P(i, j + 1), p3 = P(i + 1, j + 1), p4 = P(i + 1, j), p5 = P(i + 1, j - 1), p6 = P(i, j - 1), p7 = P(i - 1, j - 1), p8 = P(i - 1, j), p9 = P(i - 1, j + 1);
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
          if (A !== 1) continue;
          if (pass === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(j * w + i);
        }
      }
      for (const k of del) m[k] = 0;
      if (del.length) changed = true;
    }
  }
  const out = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (m[j * w + i]) out.push(i - pad + comp.i0, j - pad + comp.j0);
  return out;
}

/** Skeleton cells to polylines (grid i, j), pruning spurs shorter than `minSpur` cells. */
function tracePaths(cells, minSpur = 6) {
  const key = (i, j) => `${i},${j}`;
  const set = new Map();
  for (let k = 0; k < cells.length; k += 2) set.set(key(cells[k], cells[k + 1]), [cells[k], cells[k + 1]]);
  const nb = (i, j) => {
    const out = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && set.has(key(i + di, j + dj))) out.push([i + di, j + dj]);
    return out;
  };
  // Repeatedly remove short spurs ending at a free end.
  for (let round = 0; round < 3; round++) {
    const ends = [...set.values()].filter(([i, j]) => nb(i, j).length === 1);
    for (const e of ends) {
      const path = [e];
      let prev = null, cur = e;
      while (path.length <= minSpur) {
        const n = nb(cur[0], cur[1]).filter((p) => !prev || p[0] !== prev[0] || p[1] !== prev[1]);
        if (n.length !== 1) break;
        prev = cur;
        cur = n[0];
        if (nb(cur[0], cur[1]).length > 2) break;
        path.push(cur);
      }
      const tip = path[path.length - 1];
      if (path.length <= minSpur && nb(tip[0], tip[1]).length > 2 - (path.length === 1 ? 1 : 0)) for (const p of path) set.delete(key(p[0], p[1]));
    }
  }
  // Walk paths: from free ends first, then whatever loops remain.
  const used = new Set();
  const paths = [];
  const walk = (start) => {
    const line = [start];
    used.add(key(start[0], start[1]));
    let cur = start;
    for (;;) {
      const n = nb(cur[0], cur[1]).filter((p) => !used.has(key(p[0], p[1])));
      if (!n.length) break;
      // Prefer the straightest continuation.
      n.sort((a, b) => Math.abs(a[0] - cur[0]) + Math.abs(a[1] - cur[1]) - (Math.abs(b[0] - cur[0]) + Math.abs(b[1] - cur[1])));
      cur = n[0];
      used.add(key(cur[0], cur[1]));
      line.push(cur);
    }
    return line;
  };
  const starts = () => [...set.values()].filter(([i, j]) => !used.has(key(i, j)) && nb(i, j).filter((p) => !used.has(key(p[0], p[1]))).length <= 1);
  for (let guard = 0; guard < 1000; guard++) {
    const s = starts()[0] ?? [...set.values()].find(([i, j]) => !used.has(key(i, j)));
    if (!s) break;
    const line = walk(s);
    if (line.length >= 4) paths.push(line);
  }
  return paths;
}

/** Moving-average smoothing then resampling every `step` metres; points in local metres. */
function smoothResample(pts, step = 1, win = 3) {
  const sm = pts.map((_, k) => {
    let sx = 0, sy = 0, n = 0;
    for (let d = -win; d <= win; d++) {
      const q = pts[Math.min(pts.length - 1, Math.max(0, k + d))];
      sx += q[0];
      sy += q[1];
      n++;
    }
    return [sx / n, sy / n];
  });
  sm[0] = pts[0];
  sm[sm.length - 1] = pts[pts.length - 1];
  const out = [sm[0]];
  let acc = 0;
  for (let k = 1; k < sm.length; k++) {
    let [ax, ay] = sm[k - 1];
    const [bx, by] = sm[k];
    let seg = Math.hypot(bx - ax, by - ay);
    while (acc + seg >= step) {
      const t = (step - acc) / seg;
      ax += (bx - ax) * t;
      ay += (by - ay) * t;
      out.push([ax, ay]);
      seg = Math.hypot(bx - ax, by - ay);
      acc = 0;
    }
    acc += seg;
  }
  return out;
}

const spines = [];
for (const c of kept) {
  for (const path of tracePaths(skeleton(c))) {
    const pts = smoothResample(path.map(([i, j]) => [G.x0 + i, G.y0 + j]), 1, 3);
    if (pts.length < 6) continue;
    spines.push({ comp: c.id, relief: c.relief, pts });
  }
}
console.log(`cliff spines: ${spines.length}, ${Math.round(spines.reduce((s, p) => s + p.pts.length, 0))} m`);

// ---- Face profiles: for every metre along each spine, the face from its foot to its lip --------------------
//
// A ray across the face (horizontal, pointing downhill) is sampled every 0.5 m. The lip and the foot are where the
// ground stops being a face (gentler than 40° for 3 m), and t(z) is how far along the ray the face is at each
// height, every metre from the foot up to the lip.
const bil = (x, y) => {
  const fx = x - G.x0, fy = y - G.y0;
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  return (hAt(i, j) * (1 - u) + hAt(i + 1, j) * u) * (1 - v) + (hAt(i, j + 1) * (1 - u) + hAt(i + 1, j + 1) * u) * v;
};
const RAY = 24, DT = 0.5, NS = (2 * RAY) / DT + 1;
const tanGentle = Math.tan((40 * Math.PI) / 180);
const CELL = 20; // apron cells (world metres), aligned to the terrain tiles' grid at every detail level up to 20 m
const cellSet = new Map(); // "cx,cz" -> [cx, cz]
const markCell = (x, y) => {
  const cx = Math.floor(x / CELL), cz = Math.floor(-y / CELL);
  cellSet.set(`${cx},${cz}`, [cx, cz]);
};
let colCount = 0, faceArea = 0;
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])));
for (const s of spines) {
  const P = s.pts, n = P.length;
  // Normals: perpendicular to the spine, turned to face downhill, smoothed along it.
  let N = P.map((_, k) => {
    const a = P[Math.max(0, k - 1)], b = P[Math.min(n - 1, k + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1;
    return [ty / l, -tx / l];
  });
  let down = 0;
  for (let k = 0; k < n; k++) {
    const [x, y] = P[k];
    const gx = (bil(x + 1, y) - bil(x - 1, y)) / 2, gy = (bil(x, y + 1) - bil(x, y - 1)) / 2;
    down -= N[k][0] * gx + N[k][1] * gy;
  }
  if (down < 0) N = N.map(([a, b]) => [-a, -b]);
  N = N.map((_, k) => {
    let sx = 0, sy = 0;
    for (let d = -4; d <= 4; d++) {
      const q = N[Math.min(n - 1, Math.max(0, k + d))];
      sx += q[0];
      sy += q[1];
    }
    const l = Math.hypot(sx, sy) || 1;
    return [sx / l, sy / l];
  });
  s.normals = N;
  // Skeleton ends often hook round: no face where the direction swings by more than 35° within 6 m of an end.
  const skip = new Uint8Array(n);
  for (let k = 0; k + 6 < n && angle(N[k], N[k + 6]) > 0.61; k++) skip[k] = 1;
  for (let k = n - 1; k - 6 >= 0 && angle(N[k], N[k - 6]) > 0.61; k--) skip[k] = 1;
  s.cols = [];
  const h = new Float32Array(NS);
  for (let k = 0; k < n; k++) {
    if (skip[k]) {
      s.cols.push(null);
      continue;
    }
    const [px, py] = P[k], [nxv, nyv] = N[k];
    for (let q = 0; q < NS; q++) {
      const t = -RAY + q * DT;
      h[q] = bil(px + nxv * t, py + nyv * t);
    }
    // Downhill slope between samples q and q+1.
    const slope = (q) => (h[q] - h[q + 1]) / DT;
    // The steepest point within 3 m of the spine is the core of the face.
    const mid = RAY / DT;
    let core = mid;
    for (let q = mid - 6; q <= mid + 6; q++) if (slope(q) > slope(core)) core = q;
    const runGentle = 6; // 3 m
    let lip = core, foot = core;
    for (let q = core; q > 0; q--) {
      let gentle = true;
      for (let r = 0; r < runGentle && q - r >= 0; r++) if (slope(q - r) > tanGentle) gentle = false;
      if (gentle) break;
      lip = q - 1;
    }
    for (let q = core; q < NS - 2; q++) {
      let gentle = true;
      for (let r = 0; r < runGentle && q + r < NS - 1; r++) if (slope(q + r) > tanGentle) gentle = false;
      if (gentle) break;
      foot = q + 2;
    }
    lip = Math.max(0, lip);
    foot = Math.min(NS - 1, foot);
    const zTop = h[lip], zFoot = h[foot];
    if (zTop - zFoot < 2.5) {
      s.cols.push(null);
      continue;
    }
    // t(z): the outermost point of the face at or above each height (scanning in from the foot).
    const prof = [];
    const levels = Math.floor(zTop - zFoot);
    for (let i = 0; i <= levels + 1; i++) {
      const z = i <= levels ? zFoot + i : zTop;
      let t = -RAY + lip * DT;
      for (let q = foot; q > lip; q--) {
        if (h[q - 1] >= z) {
          const f = h[q - 1] === h[q] ? 0 : (z - h[q]) / (h[q - 1] - h[q]);
          t = -RAY + (q - Math.min(1, Math.max(0, f))) * DT;
          break;
        }
      }
      prof.push(t);
    }
    // The real ground 3 m and 7 m behind the lip, for the cap the renderer lays over the top of the face.
    const tLip = -RAY + lip * DT;
    const back3 = bil(px + nxv * (tLip - 3), py + nyv * (tLip - 3)) - zTop, back7 = bil(px + nxv * (tLip - 7), py + nyv * (tLip - 7)) - zTop;
    s.cols.push({ zFoot, zTop, prof, back3, back7, tLip, tFoot: -RAY + foot * DT });
  }
  // A lip or foot far from its neighbours' (the lip search stopping at a ledge, a gully) makes a spike in the
  // face: such columns take the nearest good neighbour's profile instead.
  const med = (vals) => vals.slice().sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  const good = s.cols.map((c, k) => {
    if (!c) return false;
    const near = [];
    for (let d = -3; d <= 3; d++) if (d && s.cols[k + d]) near.push(s.cols[k + d]);
    if (near.length < 2) return true;
    return Math.abs(c.zTop - med(near.map((q) => q.zTop))) < 2.5 && Math.abs(c.zFoot - med(near.map((q) => q.zFoot))) < 3 && Math.abs(c.tLip - med(near.map((q) => q.tLip))) < 3;
  });
  s.cols = s.cols.map((c, k) => {
    if (!c || good[k]) return c;
    for (let d = 1; d < 4; d++) {
      if (good[k - d]) return s.cols[k - d];
      if (good[k + d]) return s.cols[k + d];
    }
    return null;
  });
  for (let k = 0; k < n; k++) {
    const c = s.cols[k];
    if (!c) continue;
    colCount++;
    faceArea += c.zTop - c.zFoot;
    // Apron cells: everything from 8 m behind the lip to 3 m beyond the foot, ±6 m along the spine.
    const [px, py] = P[k], [nxv, nyv] = N[k];
    for (let t = c.tLip - 8; t <= c.tFoot + 3; t += 2) {
      for (const l of [-6, 0, 6]) markCell(px + nxv * t - nyv * l, py + nyv * t + nxv * l);
    }
  }
}
console.log(`face columns: ${colCount}, face area ~${Math.round(faceArea / 1000)}k m², cells ${cellSet.size}`);

// Names for the big faces (Malham Cove, Gordale Scar...), from the nearest named OSM cliff or feature.
const named = [...(data.cliffs ?? []).filter((c) => c.n).flatMap((c) => {
  const out = [];
  for (let i = 0; i < c.p.length; i += 2) out.push({ n: c.n, x: c.p[i], y: c.p[i + 1] });
  return out;
}), ...(data.names ?? []).filter((n) => ['cliff', 'attraction', 'bare_rock'].includes(n.k)).map((n) => ({ n: n.n, x: n.x, y: n.y }))];
const nameFor = (pts) => {
  let best = null, bd = 60;
  for (let k = 0; k < pts.length; k += 5) for (const f of named) {
    const d = Math.hypot(f.x - pts[k][0], f.y - pts[k][1]);
    if (d < bd) [bd, best] = [d, f.n];
  }
  return best;
};

/**
 * A face as bytes, one column every 2 m along it: int16 x, y of the first point (0.1 m), then per column int8 dx, dy
 * from the previous point (0.05 m), uint8 normal direction (256ths of a turn), int16 foot height (dm; -32768 = no
 * face here), and if there is a face: int16 lip height (dm), uint8 (count | z-step 2 m flag 0x80), int8 t (0.2 m)
 * for each height from the foot up (every 1 m, or 2 m for faces over 16 m), the last being the lip; then int8 heights of
 * the ground 3 m and 7 m behind the lip relative to it (0.1 m).
 */
const encodeFace = (s) => {
  const bytes = [];
  const i16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
  let qx = Math.round(s.pts[0][0] * 10) / 10, qy = Math.round(s.pts[0][1] * 10) / 10;
  i16(Math.round(qx * 10));
  i16(Math.round(qy * 10));
  for (let k = 0; k < s.pts.length; k += 2) {
    const [x, y] = s.pts[k];
    const dx = Math.max(-127, Math.min(127, Math.round((x - qx) * 20))), dy = Math.max(-127, Math.min(127, Math.round((y - qy) * 20)));
    qx += dx / 20;
    qy += dy / 20;
    bytes.push(dx & 255, dy & 255);
    const [a, b] = s.normals[k];
    bytes.push(Math.round(((Math.atan2(b, a) / (2 * Math.PI)) * 256 + 256) % 256) & 255);
    const c = s.cols[k];
    if (!c) {
      i16(-32768);
      continue;
    }
    const tall = c.zTop - c.zFoot > 16;
    const prof = tall ? c.prof.filter((_, i) => i % 2 === 0 || i === c.prof.length - 1) : c.prof;
    i16(Math.round(c.zFoot * 10));
    i16(Math.round(c.zTop * 10));
    bytes.push(Math.min(127, prof.length) | (tall ? 0x80 : 0));
    for (const t of prof.slice(0, 127)) bytes.push(Math.max(-127, Math.min(127, Math.round(t / 0.2))) & 255);
    for (const v of [c.back3, c.back7]) bytes.push(Math.max(-127, Math.min(127, Math.round(v * 10))) & 255);
  }
  return Buffer.from(bytes).toString('base64');
};
data.scars = {
  credit: 'Cliffs and scars: Environment Agency LIDAR Composite DTM 1 m, Open Government Licence v3.0',
  cell: CELL,
  cells: [...cellSet.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).flat(),
  faces: spines.filter((s) => s.cols.some(Boolean)).map((s) => {
    const o = { b: encodeFace(s) };
    const nm = nameFor(s.pts);
    if (nm) o.n = nm;
    return o;
  }),
};
console.log(`scars: ${data.scars.faces.length} faces, ${data.scars.cells.length / 2} cells, ${(JSON.stringify(data.scars).length / 1024).toFixed(0)} KB`);

if (DEBUG) {
  // Hillshade of a box with steep cells (red) and spines (blue).
  const dbg = (name, bx0, by0, bx1, by1, scale = 1) => {
    const w = Math.round((bx1 - bx0) * scale), h = Math.round((by1 - by0) * scale);
    const px = new Uint8Array(w * h * 3);
    for (let r = 0; r < h; r++) {
      for (let q = 0; q < w; q++) {
        const i = Math.round(bx0 - G.x0 + q / scale), j = Math.round(by1 - G.y0 - r / scale);
        const k = idx(Math.min(nx - 1, Math.max(0, i)), Math.min(ny - 1, Math.max(0, j)));
        const gx = gradX[k], gy = gradY[k];
        const l = Math.max(0, (1 + 0.7 * gx - 0.7 * gy) / Math.sqrt(1 + gx * gx + gy * gy)) * 200;
        const o = (r * w + q) * 3;
        px[o] = Math.min(255, steep[k] ? 255 : l);
        px[o + 1] = steep[k] ? l * 0.4 : l;
        px[o + 2] = steep[k] ? l * 0.4 : l;
      }
    }
    const dot = (x, y, col) => {
      const q = Math.round((x - bx0) * scale), r = Math.round((by1 - y) * scale);
      if (q < 0 || r < 0 || q >= w || r >= h) return;
      const o = (r * w + q) * 3;
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2];
    };
    for (const s of spines) {
      s.cols?.forEach((c, k) => {
        if (!c) return;
        const [x, y] = s.pts[k], [a, b] = s.normals[k];
        const tl = c.prof[c.prof.length - 1], tf = c.prof[0];
        dot(x + a * tl, y + b * tl, [0, 220, 0]);
        dot(x + a * tf, y + b * tf, [255, 220, 0]);
      });
    }
    for (const s of spines) {
      for (const [x, y] of s.pts) {
        const q = Math.round((x - bx0) * scale), r = Math.round((by1 - y) * scale);
        for (let dr = -1; dr <= 1; dr++) for (let dq = -1; dq <= 1; dq++) {
          const qq = q + dq, rr = r + dr;
          if (qq < 0 || rr < 0 || qq >= w || rr >= h) continue;
          const o = (rr * w + qq) * 3;
          px[o] = 0; px[o + 1] = 90; px[o + 2] = 255;
        }
      }
    }
    fs.writeFileSync(path.join(DEBUG_DIR, `${name}.jpg`), encodeJpeg({ width: w, height: h, channels: 3, data: px }, 90));
  };
  dbg('cove', -200, -560, 400, -60, 1.5);
  dbg('gordale', 1500, -800, 2200, 300, 1);
  dbg('coveroad', -1500, -800, 600, 1500, 0.45);
}

fs.writeFileSync(FILE, JSON.stringify(data));
console.log(`Wrote ${path.relative(root, FILE)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
