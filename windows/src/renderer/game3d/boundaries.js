// Field boundaries, from the segments the worlds pass to C.linear(): Dales dry-stone walls and hawthorn hedges.
//
// Walls are pale grey limestone by default (Malham's Carboniferous limestone; `tone: 'gritstone'` gives the
// darker, browner gritstone walls of the eastern Dales). Every wall is a battered body (both faces lean in
// from a broad foot to a narrow top under its coping) merged into chunks. Within ~60 m of the camera the
// walls are rebuilt in full as you ride: faces that wander and bulge a little, a coping of upright stones,
// throughstones poking out of both faces, now and then a step stile, and grass growing up the foot. Where two
// wall ends face each other across a gateway's width a five-bar gate hangs on stone gateposts; any other free
// end gets a squared wall head.
//
// Hedges are flailed hawthorn whose height and width wander, with a ragged leafy fringe along the top and the
// upper sides so the outline is never a clean line; near the camera, sprigs stick out of them and grass and
// cow parsley grow along the foot.
import * as THREE from 'three';
import { hash2 } from '../../core/world/noise.js';
import * as F from './foliage.js';
import { gateGeometry, gatePost } from './furniture.js';
import { crispCoverage, dullSheen, noSkyReflection } from './vegetation.js';
import { NearDetail, newArrays, toGeometry, tuftGeometry, plantMaterial, pushMatrix, qualityLevel } from './neardetail.js';

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const smooth = (t) => t * t * (3 - 2 * t);

/** Smooth 1D value noise in [−1, 1] along a line (seeded). */
function noise1(s, seed) {
  const i = Math.floor(s), f = s - i;
  const a = hash2(i, seed, 501) * 2 - 1, b = hash2(i + 1, seed, 501) * 2 - 1;
  return a + (b - a) * smooth(f);
}

// ---- Polylines ---------------------------------------------------------------------------------------

/**
 * Joins segments that share end points into polylines: [{pts: [{x, y, z}], free: [bool, bool]}] where
 * `free` says whether each end is a loose wall end (not joined to anything) rather than a junction.
 */
export function chainSegments(segments) {
  const nodes = new Map();
  const node = (x, y, z) => {
    const k = `${Math.round(x * 20)},${Math.round(z * 20)}`;
    let n = nodes.get(k);
    if (!n) nodes.set(k, (n = { x, y, z, edges: [] }));
    return n;
  };
  const ends = segments.map((s, i) => {
    const a = node(s.x1, s.y1, s.z1), b = node(s.x2, s.y2, s.z2);
    if (a === b) return null;
    a.edges.push(i);
    b.edges.push(i);
    return [a, b];
  });
  const used = new Uint8Array(segments.length);
  const lines = [];
  const walk = (start, first) => {
    const pts = [start];
    let cur = start, si = first;
    while (si !== undefined && !used[si]) {
      used[si] = 1;
      const [a, b] = ends[si];
      cur = a === cur ? b : a;
      pts.push(cur);
      if (cur.edges.length !== 2) break;
      si = cur.edges.find((e) => !used[e]);
    }
    return { pts, free: [start.edges.length === 1, cur.edges.length === 1] };
  };
  for (const n of nodes.values()) if (n.edges.length !== 2) for (const e of n.edges) if (!used[e] && ends[e]) lines.push(walk(n, e));
  for (let i = 0; i < segments.length; i++) if (!used[i] && ends[i]) lines.push(walk(ends[i][0], i));
  return lines.filter((l) => l.pts.length > 1);
}

/** Douglas–Peucker on {x, y, z} points (tolerance in metres, height counted too). */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], Bp = pts[b];
    const dx = Bp.x - A.x, dz = Bp.z - A.z, dy = Bp.y - A.y, L2 = dx * dx + dz * dz || 1e-9;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.z - A.z) * dz) / L2));
      const ex = A.x + dx * t - P.x, ez = A.z + dz * t - P.z, ey = A.y + dy * t - P.y;
      const e = Math.hypot(ex, ez) + Math.abs(ey) * 0.7;
      if (e > worst) {
        worst = e;
        wi = i;
      }
    }
    if (worst > tol) {
      keep[wi] = 1;
      stack.push([a, wi], [wi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Cumulative distances and mitred left-to-right normals (unit, in xz) at each polyline point. */
function frames(pts) {
  const n = pts.length;
  const along = new Float32Array(n), nx = new Float32Array(n), nz = new Float32Array(n), miter = new Float32Array(n);
  const seg = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z, l = Math.hypot(dx, dz) || 1e-6;
    seg.push([dx / l, dz / l]);
    along[i + 1] = along[i] + l;
  }
  for (let i = 0; i < n; i++) {
    const a = seg[Math.max(0, i - 1)], b = seg[Math.min(n - 2, i)];
    let tx = a[0] + b[0], tz = a[1] + b[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    nx[i] = -tz;
    nz[i] = tx;
    // Lengthen the offsets at a bend so both faces keep their width (capped for hairpins).
    miter[i] = Math.min(1.6, 1 / Math.max(0.3, tx * b[0] + tz * b[1]));
  }
  return { along, nx, nz, miter };
}

/** Frames of points s…e of a polyline (sharing the whole line's distances and mitres). */
function sliceFrames(fr, s, e) {
  return { along: fr.along.subarray(s, e + 1), nx: fr.nx.subarray(s, e + 1), nz: fr.nz.subarray(s, e + 1), miter: fr.miter.subarray(s, e + 1) };
}

/** Sweeps a profile [[offset, height, v, shade]...] along a polyline into arrays (each strip its own vertices). */
function sweep(out, pts, fr, profile, { uRepeat, wobble = null, tint = [1, 1, 1] }) {
  const n = pts.length;
  for (let j = 0; j < profile.length - 1; j++) {
    const [o1, h1, v1, s1] = profile[j], [o2, h2, v2, s2] = profile[j + 1];
    // Strip normal from the profile edge (in the cross-section plane), pointing out of the profile.
    let cnx = -(h2 - h1), cny = o2 - o1;
    const cl = Math.hypot(cnx, cny) || 1;
    cnx /= cl;
    cny /= cl;
    const base = out.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const p = pts[i], m = fr.miter[i];
      const w = wobble ? wobble(fr.along[i], i) : null;
      for (const [o, h, v, s] of [[o1, h1, v1, s1], [o2, h2, v2, s2]]) {
        const oo = (w ? o * w.width + w.shift : o) * m, hh = h > 0.05 ? h * (w ? w.height : 1) : h;
        out.pos.push(p.x + fr.nx[i] * oo, p.y + hh, p.z + fr.nz[i] * oo);
        out.nrm.push(fr.nx[i] * cnx, cny, fr.nz[i] * cnx);
        out.uv.push(fr.along[i] / uRepeat, v);
        const k = s * (w ? w.tone : 1);
        out.col.push(k * tint[0], k * tint[1], k * tint[2]);
      }
      if (i > 0) {
        // Counter-clockwise seen from outside.
        const a = base + (i - 1) * 2, b = base + i * 2;
        out.idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
}


/** A mesh per square chunk from per-chunk arrays, with the usual culling userData. */
function chunkMeshes(cells, mat, { shadows, maxDistance, minDistance = 0, receive = true }) {
  const group = new THREE.Group();
  for (const a of cells.values()) {
    if (!a.pos.length) continue;
    const g = toGeometry(a);
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = receive;
    mesh.userData.centre = g.boundingSphere.center.clone();
    mesh.userData.radius = g.boundingSphere.radius;
    mesh.userData.maxDistance = maxDistance;
    mesh.userData.minDistance = minDistance;
    group.add(mesh);
  }
  return group;
}

// ---- Gateways ----------------------------------------------------------------------------------------

/**
 * Pairs of loose ends that face each other across a field-gate's width (2.4–4.8 m, roughly in line): the
 * gap between them is a gateway. Returns [{x, y, z, rot, width}] with rot turning +x across the gap.
 */
function gateways(lines) {
  const ends = [];
  for (const l of lines) {
    for (const e of [0, 1]) {
      if (!l.free[e]) continue;
      const p = e === 0 ? l.pts[0] : l.pts[l.pts.length - 1], q = e === 0 ? l.pts[1] : l.pts[l.pts.length - 2];
      const dx = p.x - q.x, dz = p.z - q.z, len = Math.hypot(dx, dz) || 1;
      ends.push({ p, dx: dx / len, dz: dz / len, used: false });
    }
  }
  const grid = new Map();
  const key = (x, z) => `${Math.floor(x / 6)},${Math.floor(z / 6)}`;
  ends.forEach((e) => (grid.get(key(e.p.x, e.p.z)) ?? grid.set(key(e.p.x, e.p.z), []).get(key(e.p.x, e.p.z))).push(e));
  const out = [];
  for (const a of ends) {
    if (a.used) continue;
    let best = null, bd = Infinity;
    const gx = Math.floor(a.p.x / 6), gz = Math.floor(a.p.z / 6);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const b of grid.get(`${gx + i},${gz + j}`) ?? []) {
      if (b === a || b.used) continue;
      const gxv = b.p.x - a.p.x, gzv = b.p.z - a.p.z, d = Math.hypot(gxv, gzv);
      if (d < 2.4 || d > 4.8) continue;
      // Facing each other, and the gap runs on along the wall.
      if (a.dx * b.dx + a.dz * b.dz > -0.8) continue;
      if ((gxv * a.dx + gzv * a.dz) / d < 0.85) continue;
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    if (best) {
      a.used = best.used = true;
      out.push({ x: (a.p.x + best.p.x) / 2, y: Math.min(a.p.y, best.p.y), z: (a.p.z + best.p.z) / 2, rot: Math.atan2(-(best.p.z - a.p.z), best.p.x - a.p.x), width: bd, a: a.p, b: best.p });
    }
  }
  return { gates: out, ends };
}

// ---- Stone textures ----------------------------------------------------------------------------------

const TONES = {
  // Malham: pale grey Carboniferous limestone, blocky and light, white and yellow lichen, dark voids.
  // (Drawn mid-grey: under the game's bright sky a true limestone white burns out.)
  limestone: { stones: ['#8a8882', '#7d7b75', '#949189', '#6f6d67', '#86827a', '#9b9890', '#78756f', '#8d8a80', '#68665f', '#8a8172', '#7f7a6e'], voids: '#22211d', lichen: ['#c4c2b8', '#b6b4a8', '#a3954f', '#71806a'], moss: '#4a5a32' },
  // Gritstone: brown-grey, darker, rougher, with green-black weathering.
  gritstone: { stones: ['#6f695f', '#625d54', '#7a7367', '#58544c', '#6c665b', '#7f776a'], voids: '#24221e', lichen: ['#9a9a88', '#848a6e', '#a8a284'], moss: '#43502c' },
};

// Texture layout (512 × 512): face stones from v 0.30 (the foot) to v 0.86, a band of upright coping stones
// painted above them to v 1.0 (seen on the far walls, which have no separate coping); the coping band's
// side (v 0.16–0.26) and top (v 0.03–0.13) for the near walls' coping.
const UV = { foot: 0.3, faceTop: 0.86, copeTop: 1.0, bandLo: 0.16, bandHi: 0.26, topLo: 0.03, topHi: 0.13, uRepeat: 2.05 };

/** Dry-stone wall colour and normal textures for a tone. */
export function wallTextures(tone = 'limestone') {
  const T = TONES[tone] ?? TONES.limestone;
  const key = `wall-${tone}`;
  if (wallTextures.cache?.[key]) return wallTextures.cache[key];
  const [c, g] = F.canvas2d(512, 512);
  const [hc, hg] = F.canvas2d(512, 512);
  const r = mulberry(tone === 'limestone' ? 11 : 12);
  g.fillStyle = T.voids;
  g.fillRect(0, 0, 512, 512);
  hg.fillStyle = '#000';
  hg.fillRect(0, 0, 512, 512);
  // One stone: an angular slab with a lit top, a shaded underside, grain and lichen; wraps in x.
  const stone = (cx, cy, w, h, col, sides = 5 + Math.floor(r() * 4)) => {
    const pts = [];
    const a0 = r() * TAU;
    const sqr = r() * 0.6;
    for (let i = 0; i < sides; i++) {
      const a = a0 + (i / sides) * TAU + (r() - 0.5) * 0.8;
      // Somewhere between round and squarish, each stone its own.
      const sq = 1 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const k = (0.8 + r() * 0.26) * (1 + (Math.min(1.3, sq) - 1) * sqr);
      pts.push([cx + Math.cos(a) * w * 0.5 * k, cy + Math.sin(a) * h * 0.5 * k]);
    }
    for (const ox of cx < 60 ? [0, 512] : cx > 452 ? [0, -512] : [0]) {
      const path = () => {
        g.beginPath();
        pts.forEach(([x, y], i) => (i ? g.lineTo(x + ox, y) : g.moveTo(x + ox, y)));
        g.closePath();
      };
      path();
      const grd = g.createLinearGradient(cx - w * 0.2, cy - h / 2, cx + w * 0.2, cy + h / 2);
      grd.addColorStop(0, shadeCss(col, 1.14));
      grd.addColorStop(0.4, col);
      grd.addColorStop(1, shadeCss(col, 0.5));
      g.fillStyle = grd;
      g.fill();
      g.save();
      g.clip();
      // Grain, pitting and the odd lichen crust.
      for (let k = 0; k < (w * h) / 26; k++) {
        g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.14)';
        g.fillRect(cx + ox + (r() - 0.5) * w, cy + (r() - 0.5) * h, 1 + r() * 2.2, 1 + r() * 1.6);
      }
      if (r() < 0.32) {
        g.fillStyle = T.lichen[Math.floor(r() * T.lichen.length)];
        g.globalAlpha = 0.45;
        const lx = cx + ox + (r() - 0.5) * w * 0.6, ly = cy + (r() - 0.5) * h * 0.5;
        for (let k = 0; k < 7; k++) {
          g.beginPath();
          g.arc(lx + (r() - 0.5) * w * 0.3, ly + (r() - 0.5) * h * 0.3, 1.5 + r() * 3.5, 0, TAU);
          g.fill();
        }
        g.globalAlpha = 1;
      }
      // A dark rim just inside the edge: the shadowed lip of each stone.
      path();
      g.strokeStyle = 'rgba(20,20,18,0.35)';
      g.lineWidth = 2;
      g.stroke();
      g.restore();
      // Height: domed, highest in the middle.
      hg.beginPath();
      pts.forEach(([x, y], i) => (i ? hg.lineTo(x + ox, y) : hg.moveTo(x + ox, y)));
      hg.closePath();
      const hgr = hg.createRadialGradient(cx + ox, cy - h * 0.15, 0, cx + ox, cy, Math.max(w, h) * 0.6);
      hgr.addColorStop(0, '#ffffff');
      hgr.addColorStop(1, '#6a6a6a');
      hg.fillStyle = hgr;
      hg.fill();
    }
  };
  const pick = () => T.stones[Math.floor(r() * T.stones.length)];
  // Face: courses of stones, bigger at the foot, between y 72 (top of the face) and 358 (the foot).
  let y = 358;
  while (y > 72) {
    const big = y > 300;
    const h = big ? 28 + r() * 18 : 14 + r() * 22;
    let x = r() * 30;
    while (x < 512 + 10) {
      // Limestone breaks into slabs: mostly wider than tall, now and then a long throughstone face.
      const w = r() < 0.06 ? 110 + r() * 60 : (big ? 46 : 24) + r() * (big ? 52 : 50);
      stone(x + w / 2, y - h / 2, w * 1.1, h * 1.16, pick());
      // Small pinning stones in the gaps.
      if (r() < 0.25) stone(x + w + 1, y - h * (0.3 + r() * 0.4), 6 + r() * 6, 4 + r() * 5, pick(), 5);
      x += w + 1 + r() * 2;
    }
    y -= h + 0.5 + r() * 1.5;
  }
  const dark = () => shadeCss(pick(), 0.82);
  // Painted coping on top of the face (far walls): upright stones on edge, weathered darker.
  for (let x = 0; x < 512; ) {
    const w = 11 + r() * 12;
    stone(x + w / 2, 38 + (r() - 0.5) * 6, w * 1.06, 60 + r() * 12, dark(), 5);
    x += w + 0.5;
  }
  // Coping band side (v 0.16–0.26 → canvas y 379–430) and top (v 0.03–0.13 → y 445–497).
  for (let x = 0; x < 512; ) {
    const w = 11 + r() * 12;
    stone(x + w / 2, 404, w * 1.06, 54, dark(), 5);
    stone(x + w / 2, 471, w * 1.1, 58, dark(), 5);
    x += w + 0.5;
  }
  // Damp and moss low down on the face.
  const grd = g.createLinearGradient(0, 300, 0, 360);
  grd.addColorStop(0, 'rgba(60,70,40,0)');
  grd.addColorStop(1, 'rgba(60,70,40,0.45)');
  g.fillStyle = grd;
  g.fillRect(0, 300, 512, 60);
  const map = F.foliageTexture(c, { threshold: 0, wrapS: THREE.RepeatWrapping });
  const normalMap = F.normalMapFrom(hc, { strength: 5, wrapY: false });
  // A plain weathered stone surface (no joints) for the separate coping stones and throughstones.
  const [sc, sg] = F.canvas2d(128, 128);
  sg.fillStyle = T.stones[0];
  sg.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 70; i++) {
    const x = r() * 128, y = r() * 128, rad = 6 + r() * 22;
    for (const ox of [-128, 0, 128]) for (const oy of [-128, 0, 128]) {
      const grd2 = sg.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
      grd2.addColorStop(0, shadeCss(pick(), r() < 0.5 ? 0.85 : 1.1));
      grd2.addColorStop(1, 'rgba(0,0,0,0)');
      sg.globalAlpha = 0.5;
      sg.fillStyle = grd2;
      sg.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
    }
  }
  sg.globalAlpha = 1;
  for (let i = 0; i < 1600; i++) {
    sg.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.16)';
    sg.fillRect(r() * 128, r() * 128, 1 + r() * 1.5, 1 + r() * 1.5);
  }
  for (let i = 0; i < 10; i++) {
    sg.fillStyle = T.lichen[Math.floor(r() * T.lichen.length)];
    sg.globalAlpha = 0.4;
    sg.beginPath();
    sg.arc(r() * 128, r() * 128, 2 + r() * 5, 0, TAU);
    sg.fill();
  }
  sg.globalAlpha = 1;
  const stoneMap = F.foliageTexture(sc, { threshold: 0, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
  const stoneNormal = F.normalMapFrom(sc, { strength: 3 });
  const out = { map, normalMap, stoneMap, stoneNormal };
  (wallTextures.cache ??= {})[key] = out;
  return out;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shadeCss(hex, k) {
  const c = new THREE.Color(hex);
  c.setRGB(Math.min(1, c.r * k), Math.min(1, c.g * k), Math.min(1, c.b * k));
  return `#${c.getHexString()}`;
}

/** A rough stone: a box with its top split into a low ridge and every vertex nudged (unit size). */
function stoneGeometry(seed) {
  const g = new THREE.BoxGeometry(1, 1, 1, 1, 2, 1);
  const p = g.attributes.position;
  const r = mulberry(seed);
  const moved = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(2)},${p.getY(i).toFixed(2)},${p.getZ(i).toFixed(2)}`;
    if (!moved.has(k)) moved.set(k, [(r() - 0.5) * 0.14, (r() - 0.5) * 0.1 + (p.getY(i) > 0.4 ? -Math.abs(p.getX(i)) * 0.15 : 0), (r() - 0.5) * 0.1]);
    const [dx, dy, dz] = moved.get(k);
    p.setXYZ(i, p.getX(i) + dx, p.getY(i) + dy, p.getZ(i) + dz);
  }
  g.computeVertexNormals();
  return g;
}


/** Which cell each polyline segment belongs to (by its midpoint): Map key -> [[line, i]...]. */
function cellIndex(lines, C) {
  const cells = new Map();
  lines.forEach((l, li) => {
    for (let i = 0; i < l.pts.length - 1; i++) {
      const a = l.pts[i], b = l.pts[i + 1];
      const key = `${Math.floor((a.x + b.x) / 2 / C)},${Math.floor((a.z + b.z) / 2 / C)}`;
      (cells.get(key) ?? cells.set(key, []).get(key)).push([li, i]);
    }
  });
  return cells;
}

// ---- Dry-stone walls ---------------------------------------------------------------------------------

// The wall: 0.84 m across the foot, 0.46 m under the coping, the body 1.1 m high and the coping on top to
// about 1.4 m. (Offsets across, heights; the far body sits just inside the near one.)
const FAR_WALL = [[-0.37, -0.3, UV.foot, 0.8], [-0.19, 1.1, UV.copeTop, 1.05], [0.19, 1.1, UV.copeTop, 1.05], [0.37, -0.3, UV.foot, 0.8]];
const NEAR_WALL = [
  [-0.43, -0.3, UV.foot, 0.78], [-0.245, 1.1, UV.faceTop, 1.0],
  [-0.245, 1.1, UV.topLo, 0.95], [-0.19, 1.12, UV.topHi, 0.95],
  [-0.19, 1.12, UV.bandLo, 0.9], [-0.19, 1.27, UV.bandHi, 0.95],
  [-0.19, 1.27, UV.topLo, 1.0], [0.19, 1.27, UV.topHi, 1.0],
  [0.19, 1.27, UV.bandHi, 0.95], [0.19, 1.12, UV.bandLo, 0.9],
  [0.19, 1.12, UV.topHi, 0.95], [0.245, 1.1, UV.topLo, 0.95],
  [0.245, 1.1, UV.faceTop, 1.0], [0.43, -0.3, UV.foot, 0.78],
];

/** Sweeps a profile given as pairs of points (each pair one strip). */
function sweepPairs(out, pts, fr, pairs, opts) {
  for (let j = 0; j < pairs.length; j += 2) sweep(out, pts, fr, [pairs[j], pairs[j + 1]], opts);
}

/** A flat cap over the end of a wall (its head), facing along `dir` out of the wall. */
function wallHead(out, p, nx, nz, dir, profile, shade = 0.95) {
  const base = out.pos.length / 3;
  const ring = [];
  for (const [o, h, , s] of profile) ring.push([o, h, s]);
  for (const [o, h] of ring) {
    out.pos.push(p.x + nx * o, p.y + h, p.z + nz * o);
    out.nrm.push(dir[0], 0, dir[1]);
    out.uv.push(o / UV.uRepeat + 0.37, UV.foot + ((h + 0.3) / 1.44) * (UV.faceTop - UV.foot));
    out.col.push(shade, shade, shade);
  }
  for (let i = 1; i < ring.length - 1; i++) out.idx.push(base, base + i, base + i + 1);
  // Wind the cap to face outwards.
  const a = new V3(out.pos[base * 3], out.pos[base * 3 + 1], out.pos[base * 3 + 2]);
  const b = new V3(out.pos[(base + 1) * 3], out.pos[(base + 1) * 3 + 1], out.pos[(base + 1) * 3 + 2]);
  const c = new V3(out.pos[(base + 2) * 3], out.pos[(base + 2) * 3 + 1], out.pos[(base + 2) * 3 + 2]);
  const n = b.sub(a).cross(c.sub(a));
  if (n.x * dir[0] + n.z * dir[1] < 0) for (let i = out.idx.length - (ring.length - 2) * 3; i < out.idx.length; i += 3) [out.idx[i + 1], out.idx[i + 2]] = [out.idx[i + 2], out.idx[i + 1]];
}

/**
 * Dry-stone walls along segments [{x1, z1, y1, x2, z2, y2}] (on the ground). opts: {shadows, maxDistance,
 * chunk, q, tone}.
 */
export function walls(segments, opts = {}) {
  const group = new THREE.Group();
  group.name = 'walls';
  const level = qualityLevel(opts);
  const shadows = opts.shadows !== false && level !== 'low';
  const maxDistance = opts.maxDistance ?? 700;
  const tex = wallTextures(opts.tone ?? 'limestone');
  const mat = new THREE.MeshStandardMaterial({ map: tex.map, normalMap: level === 'low' ? null : tex.normalMap, normalScale: new THREE.Vector2(1, 1), vertexColors: true, roughness: 0.95, metalness: 0 });
  const lines = chainSegments(segments);
  if (!lines.length) return group;
  // opts.gates === false: the caller hangs its own (mapped) gates, so gaps are not guessed at.
  const { gates, ends } = opts.gates === false ? { gates: [], ends: gateways(lines).ends } : gateways(lines);

  // Far bodies: simplified polylines, one mesh per chunk.
  const chunk = opts.chunk ?? 250;
  const far = new Map();
  const cellFor = (x, z) => {
    const k = `${Math.floor(x / chunk)},${Math.floor(z / chunk)}`;
    return far.get(k) ?? far.set(k, newArrays()).get(k);
  };
  for (const l of lines) {
    // Only drop points that are as good as in line: the far body must stay inside the near one.
    const pts = simplify(l.pts, 0.03);
    const frAll = frames(pts);
    // Long lines are split so each piece lands in its own chunk (frames from the whole line: no seams).
    for (let s = 0; s < pts.length - 1; ) {
      const e = Math.min(pts.length - 1, s + 24);
      const piece = pts.slice(s, e + 1);
      const mid = piece[Math.floor(piece.length / 2)];
      sweep(cellFor(mid.x, mid.z), piece, sliceFrames(frAll, s, e), FAR_WALL, { uRepeat: UV.uRepeat });
      s = e;
    }
    // Wall heads at loose ends.
    const fr = frames(l.pts);
    for (const e of [0, 1]) {
      if (!l.free[e]) continue;
      const i = e === 0 ? 0 : l.pts.length - 1, j = e === 0 ? 1 : l.pts.length - 2;
      const p = l.pts[i], dx = p.x - l.pts[j].x, dz = p.z - l.pts[j].z, len = Math.hypot(dx, dz) || 1;
      wallHead(cellFor(p.x, p.z), p, fr.nx[i], fr.nz[i], [dx / len, dz / len], FAR_WALL);
    }
  }
  group.add(chunkMeshes(far, mat, { shadows, maxDistance }));

  // Gates in the gateways, on stone gateposts.
  if (gates.length) group.add(gateMeshes(gates, { shadows, level, posts: 'stone', tone: opts.tone ?? 'limestone' }));

  // Near detail: full bodies, coping and throughstones, stiles and grass at the foot.
  if (level !== 'low' || opts.nearOnLow) {
    const C = 50;
    const index = cellIndex(lines, C);
    const fr = lines.map((l) => frames(l.pts));
    const atlas = F.leafAtlas(1024);
    const stoneMat = new THREE.MeshStandardMaterial({ map: tex.stoneMap, normalMap: tex.stoneNormal, roughness: 0.95, metalness: 0 });
    const capacity = level === 'high' ? 22000 : 14000;
    const stones = new THREE.InstancedMesh(stoneGeometry(7), stoneMat, capacity);
    stones.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    stones.castShadow = shadows;
    stones.receiveShadow = true;
    const grassMat = plantMaterial(atlas.texture, level);
    const tufts = new THREE.InstancedMesh(tuftGeometry(atlas.rect('grass')), grassMat, level === 'high' ? 12000 : 8000);
    tufts.userData.radius = level === 'high' ? 45 : 32;
    const seedTufts = new THREE.InstancedMesh(tuftGeometry(atlas.rect('grassSeed')), grassMat, 2000);
    seedTufts.userData.radius = tufts.userData.radius;
    const near = new NearDetail({
      cell: C,
      radius: level === 'high' ? 80 : 60,
      meshes: { stones, tufts, seedTufts },
      bodyMat: mat,
      shadows,
      make: (key) => makeWallCell(index.get(key) ?? [], lines, fr),
    });
    for (const k of index.keys()) near.cells.add(k);
    near.hook(stones);
    group.add(near.group);
  }
  group.userData.wallLines = lines.length;
  group.userData.gates = gates.length;
  group.userData.looseEnds = ends.length;
  return group;
}

/** Near detail for one cell of walls: the full body, coping, throughstones, stiles and grass. */
function makeWallCell(items, lines, frs) {
  const body = newArrays();
  const stones = [], stoneCols = [], tufts = [], seedTufts = [];
  for (const [li, i] of items) {
    const l = lines[li], fr = frs[li];
    const a = l.pts[i], b = l.pts[i + 1];
    const s0 = fr.along[i], s1 = fr.along[i + 1], len = s1 - s0;
    if (len < 0.01) continue;
    const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len, yaw = Math.atan2(-dz, dx);
    // Body, resampled about every metre with a little wander, so the faces are not ruler-straight.
    const n = Math.max(1, Math.round(len / 1.0));
    const pts = [], sub = { along: new Float32Array(n + 1), nx: new Float32Array(n + 1), nz: new Float32Array(n + 1), miter: new Float32Array(n + 1) };
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
      sub.along[k] = s0 + len * t;
      // Interpolate the mitred normals at the two ends so neighbouring segments meet cleanly.
      let nx = fr.nx[i] * (1 - t) + fr.nx[i + 1] * t, nz = fr.nz[i] * (1 - t) + fr.nz[i + 1] * t;
      const nl = Math.hypot(nx, nz) || 1;
      sub.nx[k] = nx / nl;
      sub.nz[k] = nz / nl;
      sub.miter[k] = fr.miter[i] * (1 - t) + fr.miter[i + 1] * t;
    }
    const seed = li * 7 + 3;
    const wobble = (s) => ({
      shift: noise1(s / 3.1, seed) * 0.012,
      width: 1 + noise1(s / 2.3, seed + 1) * 0.035,
      height: 1 + noise1(s / 4.7, seed + 2) * 0.02,
      tone: 0.92 + 0.1 * (noise1(s / 1.7, seed + 3) * 0.5 + 0.5),
    });
    sweepPairs(body, pts, sub, NEAR_WALL, { uRepeat: UV.uRepeat, wobble });
    // Coping: thin stones set on edge, packed tight and leaning on each other like books on a shelf (runs of
    // a few leaning one way, then the other), uneven in height, weathered darker than the face.
    const SP = 0.125;
    for (let k = Math.ceil(s0 / SP); k * SP < s1; k++) {
      const s = k * SP, t = (s - s0) / len;
      const h = hash2(k, seed, 7), h2 = hash2(k, seed, 8), h3 = hash2(k, seed, 9);
      const w = wobble(s);
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
      const ht = 0.21 + h * 0.14 + (h2 > 0.93 ? 0.08 : 0);
      const lean = noise1(s / 1.1, seed + 5) * 0.32 + (h2 - 0.5) * 0.12;
      pushMatrix(stones, x + fr.nx[i] * w.shift, y + 1.1 * w.height + ht / 2 - 0.04, z + fr.nz[i] * w.shift, yaw + (h3 - 0.5) * 0.14, (h - 0.5) * 0.1, lean, 0.07 + h2 * 0.08, ht, 0.4 + h3 * 0.1);
      const k2 = 0.72 + 0.3 * h3;
      stoneCols.push(k2, k2, k2 * (0.97 + 0.05 * h));
    }
    // Throughstones: long flat stones right through the wall, poking out of both faces.
    for (let k = Math.ceil(s0 / 1.35); k * 1.35 < s1; k++) {
      const s = k * 1.35 + (hash2(k, seed, 10) - 0.5) * 0.4, t = (s - s0) / len;
      if (t < 0 || t > 1) continue;
      const h = hash2(k, seed, 11);
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
      const yy = 0.55 + h * 0.15;
      const across = 2 * (0.43 - (yy + 0.3) * (0.185 / 1.4)) + 0.18 + h * 0.14;
      pushMatrix(stones, x, y + yy, z, yaw + (h - 0.5) * 0.1, 0, (h - 0.5) * 0.08, 0.22 + h * 0.12, 0.08 + h * 0.03, across);
      const k2 = 0.85 + 0.2 * h;
      stoneCols.push(k2, k2, k2);
    }
    // A step stile now and then: three stones a side jutting out as steps.
    {
      const slot = Math.floor(s0 / 160);
      if (hash2(slot, seed, 12) < 0.25) {
        const s = slot * 160 + 40 + hash2(slot, seed, 13) * 80;
        if (s >= s0 && s < s1) {
          const t = (s - s0) / len;
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
          for (let st = 0; st < 3; st++) {
            const yy = 0.25 + st * 0.3;
            const across = 2 * (0.43 - (yy + 0.3) * (0.185 / 1.4)) + 0.62;
            pushMatrix(stones, x + dx * (st - 1) * 0.28, y + yy, z + dz * (st - 1) * 0.28, yaw, 0, 0, 0.26, 0.09, across);
            stoneCols.push(0.9, 0.9, 0.9);
          }
        }
      }
    }
    // Grass growing up both feet of the wall.
    for (let k = Math.ceil(s0 / 0.24); k * 0.24 < s1; k++) {
      const s = k * 0.24, t = (s - s0) / len;
      for (const side of [-1, 1]) {
        const h = hash2(k, seed * 2 + side, 14), h2 = hash2(k, seed * 2 + side, 15);
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
        const off = side * (0.41 + h2 * 0.16);
        const sc = 0.32 + h * 0.45;
        pushMatrix(h2 < 0.18 ? seedTufts : tufts, x + fr.nx[i] * off, y - 0.06, z + fr.nz[i] * off, yaw + (h - 0.5) * 1.5, side * 0.3, (h2 - 0.5) * 0.3, sc * 1.4, sc * (h2 < 0.18 ? 1.5 : 1), sc * 1.4);
      }
    }
  }
  return {
    body,
    inst: {
      stones: { matrices: new Float32Array(stones), colours: new Float32Array(stoneCols) },
      tufts: { matrices: new Float32Array(tufts) },
      seedTufts: { matrices: new Float32Array(seedTufts) },
    },
  };
}

const GATE_WIDTHS = [2.0, 2.6, 3.2, 3.8];

/**
 * Gates hung in gateways [{x, y, z, rot, width, a, b}]: a post just inside each wall end and a timber
 * five-bar or galvanised gate between them (about one in seven left standing open), instanced in chunks.
 */
function gateMeshes(list, { shadows, level, posts = 'stone', tone = 'limestone' }) {
  const group = new THREE.Group();
  const sets = new Map(); // name -> {geo, mat, items: [matrix]}
  const mats = {
    timber: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.55 }),
    post: posts === 'stone'
      ? new THREE.MeshStandardMaterial({ map: wallTextures(tone).stoneMap, normalMap: wallTextures(tone).stoneNormal, vertexColors: true, roughness: 0.95, metalness: 0 })
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
  };
  const add = (name, make, mat, m) => {
    let s = sets.get(name);
    if (!s) sets.set(name, (s = { geo: make(), mat, items: [] }));
    s.items.push(m);
  };
  const up = new V3(0, 1, 0);
  for (const g of list) {
    const ux = (g.b.x - g.a.x) / g.width, uz = (g.b.z - g.a.z) / g.width;
    const y = (g.a.y + g.b.y) / 2;
    const q = new THREE.Quaternion().setFromAxisAngle(up, g.rot);
    for (const [p, s] of [[g.a, 0.2], [g.b, -0.2]]) add(`post-${posts}`, () => gatePost(posts), mats.post, new THREE.Matrix4().compose(new V3(p.x + ux * s, y, p.z + uz * s), q, new V3(1, 1, 1)));
    const lw = g.width - 0.62;
    const cls = GATE_WIDTHS.reduce((best, w) => (Math.abs(w - lw) < Math.abs(best - lw) ? w : best), GATE_WIDTHS[0]);
    const h = hash2(Math.round(g.x * 3), Math.round(g.z * 3), 41);
    const kind = posts === 'timber' || h < 0.6 ? 'timber' : 'metal';
    const open = hash2(Math.round(g.x * 3), Math.round(g.z * 3), 42) < 0.14;
    const swing = open ? (hash2(Math.round(g.x), Math.round(g.z), 43) < 0.5 ? 1 : -1) * (1.1 + hash2(Math.round(g.z), Math.round(g.x), 44) * 0.5) : 0;
    const ql = new THREE.Quaternion().setFromAxisAngle(up, g.rot + swing);
    add(`${kind}-${cls}`, () => gateGeometry(kind, { width: cls }), mats[kind], new THREE.Matrix4().compose(new V3(g.a.x + ux * 0.34, y, g.a.z + uz * 0.34), ql, new V3(lw / cls, 1, 1)));
  }
  for (const s of sets.values()) {
    const cells = new Map();
    const v = new V3();
    for (const m of s.items) {
      v.setFromMatrixPosition(m);
      const k = `${Math.floor(v.x / 300)},${Math.floor(v.z / 300)}`;
      (cells.get(k) ?? cells.set(k, []).get(k)).push(m);
    }
    for (const list2 of cells.values()) {
      const mesh = new THREE.InstancedMesh(s.geo, s.mat, list2.length);
      list2.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.computeBoundingSphere();
      mesh.castShadow = shadows;
      mesh.receiveShadow = level !== 'low';
      mesh.userData.centre = mesh.boundingSphere.center.clone();
      mesh.userData.radius = mesh.boundingSphere.radius;
      mesh.userData.maxDistance = 350;
      mesh.userData.minDistance = 0;
      group.add(mesh);
    }
  }
  return group;
}

// ---- Hedges ------------------------------------------------------------------------------------------

/**
 * Hawthorn hedges along segments [{x1, z1, y1, x2, z2, y2}]: a lumpy body with a ragged leafy fringe, and
 * sprigs and verge plants near the camera. opts: {shadows, maxDistance, chunk, q}.
 */
export function hedges(segments, opts = {}) {
  const group = new THREE.Group();
  group.name = 'hedges';
  const level = qualityLevel(opts);
  const shadows = opts.shadows !== false && level !== 'low';
  const maxDistance = opts.maxDistance ?? 700;
  const tex = F.hedgeTextures();
  const bodyMat = new THREE.MeshStandardMaterial({ map: tex.body, normalMap: level === 'low' ? null : tex.bodyNormal, normalScale: new THREE.Vector2(1.2, 1.2), vertexColors: true, roughness: 0.9, metalness: 0 });
  softFoliage(bodyMat);
  const fringeMat = new THREE.MeshStandardMaterial({ map: tex.fringe, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 0.9, metalness: 0, alphaToCoverage: level !== 'low' });
  softFoliage(fringeMat, true);
  const lines = chainSegments(segments);
  if (!lines.length) return group;
  const { gates } = gateways(lines);
  const chunk = opts.chunk ?? 200;
  const bodies = new Map(), fringes = new Map();
  const cellFor = (map, x, z) => {
    const k = `${Math.floor(x / chunk)},${Math.floor(z / chunk)}`;
    return map.get(k) ?? map.set(k, newArrays()).get(k);
  };
  // Profile: [offset, height, v, shade] round the hedge (v runs round the perimeter, 2 m per repeat).
  const P = [[-0.62, -0.25, 0, 0.55], [-0.74, 0.55, 0.4, 0.72], [-0.66, 1.25, 0.76, 0.9], [-0.42, 1.62, 1.0, 1.04], [0.0, 1.7, 1.21, 1.1], [0.42, 1.62, 1.42, 1.04], [0.66, 1.25, 1.66, 0.9], [0.74, 0.55, 2.02, 0.72], [0.62, -0.25, 2.42, 0.55]];
  // The fringe: two fins standing up out of the top, ragged at their upper edge, so the skyline of a hedge
  // is never a clean line (near the camera, sprigs do the same for its sides).
  const FINS = [[[-0.32, 1.48, 0, 0.9], [-0.38, 2.0, 1, 1.0]], [[0.32, 1.48, 0, 0.9], [0.38, 2.0, 1, 1.0]]];
  lines.forEach((l, li) => {
    // Resampled to about every 1.5 m so the hedge's height and width can wander along it.
    const pts = resample(l.pts, 1.5);
    const frAll = frames(pts);
    const wobble = hedgeWobble(li * 13 + 5);
    for (let s = 0; s < pts.length - 1; ) {
      const e = Math.min(pts.length - 1, s + 30);
      const piece = pts.slice(s, e + 1), fr = sliceFrames(frAll, s, e);
      const mid = piece[Math.floor(piece.length / 2)];
      sweep(cellFor(bodies, mid.x, mid.z), piece, fr, P, { uRepeat: 2, wobble });
      const out = cellFor(fringes, mid.x, mid.z);
      for (const fin of FINS) sweep(out, piece, fr, fin, { uRepeat: 2.2, wobble });
      s = e;
    }
  });
  group.add(chunkMeshes(bodies, bodyMat, { shadows, maxDistance }));
  group.add(chunkMeshes(fringes, fringeMat, { shadows, maxDistance: Math.min(maxDistance, 450) }));
  if (gates.length) group.add(gateMeshes(gates, { shadows, level, posts: 'timber' }));

  // Near detail: grass and cow parsley along the foot.
  if (level !== 'low') {
    const C = 50;
    const index = cellIndex(lines, C);
    const fr = lines.map((l) => frames(l.pts));
    const atlas = F.leafAtlas(1024);
    const plantMat = plantMaterial(atlas.texture, level);
    const tufts = new THREE.InstancedMesh(tuftGeometry(atlas.rect('grass')), plantMat, 5000);
    tufts.userData.radius = 35;
    const parsley = new THREE.InstancedMesh(tuftGeometry(atlas.rect('parsley')), plantMat, 2500);
    parsley.userData.radius = 35;
    const sprigMat = plantMaterial(atlas.texture, level);
    const sprigs = new THREE.InstancedMesh(tuftGeometry(atlas.rect('hedge')), sprigMat, level === 'high' ? 9000 : 6000);
    sprigs.castShadow = shadows;
    sprigs.receiveShadow = true;
    const near = new NearDetail({ cell: C, radius: level === 'high' ? 60 : 45, meshes: { tufts, parsley, sprigs }, make: (key) => makeHedgeCell(index.get(key) ?? [], lines, fr) });
    for (const k of index.keys()) near.cells.add(k);
    near.hook(tufts);
    group.add(near.group);
  }
  return group;
}

/** A hedge's wandering height, width, sideways drift and tone along its length (s in metres). */
function hedgeWobble(seed) {
  return (s) => ({
    height: 1 + noise1(s / 4.3, seed) * 0.16 + noise1(s / 1.3, seed + 9) * 0.05,
    width: 1 + noise1(s / 5.1, seed + 1) * 0.14,
    shift: noise1(s / 6.7, seed + 2) * 0.12,
    tone: 0.9 + 0.2 * (noise1(s / 3.3, seed + 3) * 0.5 + 0.5),
  });
}

/** Points about every `step` metres along a polyline (keeping the originals). */
function resample(pts, step) {
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.round(len / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

function makeHedgeCell(items, lines, frs) {
  const tufts = [], parsley = [], sprigs = [];
  for (const [li, i] of items) {
    const l = lines[li], fr = frs[li];
    const a = l.pts[i], b = l.pts[i + 1];
    const s0 = fr.along[i], s1 = fr.along[i + 1], len = s1 - s0;
    if (len < 0.01) continue;
    const seed = li * 13 + 5;
    const wobble = hedgeWobble(seed);
    const yaw = Math.atan2(-(b.z - a.z), b.x - a.x);
    // Sprigs: leafy shoots sticking out of the sides and the top, so the hedge is bushy, not a wall.
    for (let k = Math.ceil(s0 / 0.3); k * 0.3 < s1; k++) {
      const s = k * 0.3, t = (s - s0) / len, w = wobble(s);
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
      for (const where of [-1, 0, 1]) {
        const h = hash2(k, seed * 3 + where, 23), h2 = hash2(k, seed * 3 + where, 24), h3 = hash2(k, seed * 3 + where, 25);
        if (where === 0 && h3 < 0.35) continue;
        let off, yy, pitch;
        if (where === 0) {
          // Shoots out of the top splay out to either side, so the top is shaggy seen from above too.
          off = (h - 0.5) * 0.7;
          yy = 1.55 * w.height;
          pitch = Math.sign(h - 0.5) * (0.35 + Math.abs(h - 0.5) * 1.6);
        } else {
          // Up the side, following the profile's bulge.
          yy = (0.35 + h * 1.15) * w.height;
          off = where * (0.66 + 0.08 * Math.sin((yy / 1.7) * Math.PI)) * w.width;
          pitch = where * (0.9 + h2 * 0.5);
        }
        const sc = 0.45 + h2 * 0.35;
        pushMatrix(sprigs, x + fr.nx[i] * (off + w.shift), y + yy - 0.1, z + fr.nz[i] * (off + w.shift), yaw + (h3 - 0.5) * 1.2, pitch, (h - 0.5) * 0.6, sc, sc, sc);
      }
    }
    for (let k = Math.ceil(s0 / 0.4); k * 0.4 < s1; k++) {
      const t = (k * 0.4 - s0) / len;
      for (const side of [-1, 1]) {
        const h = hash2(k, seed * 2 + side, 21), h2 = hash2(k, seed * 2 + side, 22);
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
        const off = side * (0.72 + h2 * 0.25);
        const sc = 0.35 + h * 0.4;
        const isParsley = h2 > 0.8;
        pushMatrix(isParsley ? parsley : tufts, x + fr.nx[i] * off, y - 0.05, z + fr.nz[i] * off, h * TAU, 0, side * 0.2, sc * 1.5, sc * (isParsley ? 2.2 : 1.1), sc * 1.5);
      }
    }
  }
  return { inst: { tufts: { matrices: new Float32Array(tufts) }, parsley: { matrices: new Float32Array(parsley) }, sprigs: { matrices: new Float32Array(sprigs) } } };
}

/** Softer, translucent-looking light on a foliage material (and no back-face normal flip on cards). */
function softFoliage(m, cards = false) {
  m.onBeforeCompile = (sh) => {
    let f = sh.fragmentShader.replace('#include <alphatest_fragment>', crispCoverage);
    if (cards) f = f.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    f = f.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${dullSheen}`).replace('#include <lights_fragment_maps>', noSkyReflection);
    sh.fragmentShader = f;
  };
  m.customProgramCacheKey = () => (cards ? 'spindown-hedge-cards' : 'spindown-hedge');
}
