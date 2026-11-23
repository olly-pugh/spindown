// Limestone cliffs and scars as real 3D rock faces: Malham Cove, Gordale Scar, Watlowes and the scars along Cove
// Road and the Rakes. Built from face profiles the map build measures in the Environment Agency 1 m LIDAR
// (scripts/build-dales-detail.mjs; Open Government Licence v3.0): for every 2 m along each face, where the face is
// at each height from its foot to its lip.
//
// Each face becomes a curtain of rock rows and columns: true vertical faces (not stretched terrain triangles),
// displaced into horizontal beds of Carboniferous limestone with bedding-plane grooves, vertical joints, ledges and
// overhangs near the lip of the big faces. The terrain is cut away under the faces in 20 m cells (all detail levels
// up to 20 m share that grid) and replaced there by an apron at 2 m that is pushed down out of sight under each
// face, with a cap laid over the ground behind each lip so the top edge meets the land cleanly.
import * as THREE from 'three';
import { rng, hash2, valueNoise } from '../../core/world/noise.js';
const CAP = [0, 1.5, 3, 5, 7, 7.7]; // cap rows: metres behind the lip
const PUSH_BACK = 3.2; // the apron is pushed down from this far behind the lip to the foot
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Decodes one face (see encodeFace in scripts/build-dales-detail.mjs) to world-space columns. */
export function decodeFace(face) {
  const bin = atob(face.b);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  let o = 0;
  const i16 = () => {
    const v = b[o] | (b[o + 1] << 8);
    o += 2;
    return (v << 16) >> 16;
  };
  const i8 = () => (b[o++] << 24) >> 24;
  let x = i16() / 10, y = i16() / 10;
  const cols = [];
  while (o < b.length) {
    x += i8() / 20;
    y += i8() / 20;
    const ang = (b[o++] / 256) * Math.PI * 2;
    // Data coords (x east, y north) to world (x east, z south): the normal (a, b) becomes (a, -b).
    const col = { x, z: -y, nx: Math.cos(ang), nz: -Math.sin(ang), face: false };
    const zf = i16();
    if (zf !== -32768) {
      const zt = i16() / 10;
      const head = b[o++];
      const n = head & 0x7f, step = head & 0x80 ? 2 : 1;
      const prof = [];
      for (let k = 0; k < n; k++) prof.push({ z: k === n - 1 ? zt : zf / 10 + k * step, t: i8() * 0.2 });
      const back3 = i8() / 10, back7 = i8() / 10;
      Object.assign(col, { face: true, zFoot: zf / 10, zTop: zt, prof, back3, back7, tFoot: prof[0].t, tLip: prof[n - 1].t });
    }
    cols.push(col);
  }
  return cols;
}

/** Drops columns whose lip or foot is more than 6 m from the median of their four nearest neighbours. */
function dropOutliers(cols) {
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const bad = cols.map((c, k) => {
    if (!c.face) return false;
    const nt = [], nf = [];
    for (const d of [-2, -1, 1, 2]) {
      const q = cols[k + d];
      if (q?.face) {
        nt.push(q.zTop);
        nf.push(q.zFoot);
      }
    }
    if (nt.length < 2) return false;
    return Math.abs(c.zTop - med(nt)) > 6 || Math.abs(c.zFoot - med(nf)) > 6;
  });
  bad.forEach((b, k) => {
    if (b) cols[k].face = false;
  });
}

/**
 * Smooths the lip and foot heights along a face (a median of five, then never more than a little above the
 * neighbours' mean): a column's lip is only ever lowered, its foot only raised, and its profile cut to match.
 */
function smoothEnds(cols) {
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const n = cols.length;
  const zt = cols.map((c) => (c.face ? c.zTop : NaN)), zf = cols.map((c) => (c.face ? c.zFoot : NaN));
  for (let k = 0; k < n; k++) {
    const c = cols[k];
    if (!c.face) continue;
    const nt = [], nf = [];
    for (let d = -2; d <= 2; d++) {
      const q = cols[k + d];
      if (q?.face) {
        nt.push(zt[k + d]);
        nf.push(zf[k + d]);
      }
    }
    let top = Math.min(c.zTop, med(nt) + 0.8), foot = Math.max(c.zFoot, med(nf) - 0.8);
    if (top - foot < 1.5) {
      c.face = false;
      continue;
    }
    if (top < c.zTop) {
      const t = profileT(c, top);
      c.prof = [...c.prof.filter((p) => p.z < top - 0.05), { z: top, t }];
      c.back3 += c.zTop - top;
      c.back7 += c.zTop - top;
      c.zTop = top;
      c.tLip = t;
    }
    if (foot > c.zFoot) {
      const t = profileT(c, foot);
      c.prof = [{ z: foot, t }, ...c.prof.filter((p) => p.z > foot + 0.05)];
      c.zFoot = foot;
      c.tFoot = t;
    }
  }
}

/** For each column, the length (in columns) of the run of faces it belongs to. */
function runLengths(cols) {
  const out = new Array(cols.length).fill(0);
  for (let k = 0; k < cols.length;) {
    if (!cols[k].face) {
      k++;
      continue;
    }
    let e = k;
    while (e < cols.length && cols[e].face) e++;
    for (let m = k; m < e; m++) out[m] = e - k;
    k = e;
  }
  return out;
}

/** Drops runs shorter than 4 columns, and runs under 8 columns whose faces are nowhere over 4 m high. */
function dropSmallRuns(cols) {
  const len = runLengths(cols);
  for (let k = 0; k < cols.length;) {
    if (!cols[k].face) {
      k++;
      continue;
    }
    const n = len[k];
    let tallest = 0;
    for (let m = k; m < k + n; m++) tallest = Math.max(tallest, cols[m].zTop - cols[m].zFoot);
    if (n < 4 || (n < 8 && tallest < 4)) for (let m = k; m < k + n; m++) cols[m].face = false;
    k += n;
  }
}

/** The face's offset along the ray at height z (the profile is monotone: t falls as z rises). */
function profileT(col, z) {
  const p = col.prof;
  if (z <= p[0].z) return p[0].t;
  for (let k = 1; k < p.length; k++) {
    if (z <= p[k].z) {
      const f = (z - p[k - 1].z) / Math.max(1e-6, p[k].z - p[k - 1].z);
      return p[k - 1].t + (p[k].t - p[k - 1].t) * f;
    }
  }
  return p[p.length - 1].t;
}

/** Height of the cap behind a column's lip, `back` metres back. */
function capHeight(col, back) {
  const b3 = col.back3, b7 = col.back7;
  if (back <= 3) return col.zTop + (b3 * back) / 3;
  return col.zTop + b3 + ((b7 - b3) * Math.min(1, (back - 3) / 4));
}

/**
 * The limestone's beds, the same everywhere (the Great Scar Limestone lies nearly flat across the district):
 * thickness, how far each bed stands out, its tint, and whether it tends to overhang.
 */
function makeBeds() {
  const r = rng(1729);
  const beds = [];
  let z = 120;
  while (z < 700) {
    const massive = r() < 0.14;
    const thick = massive ? 4 + r() * 4 : 0.9 + Math.pow(r(), 1.4) * 3.4;
    beds.push({
      z0: z, thick,
      base: -0.35 + Math.pow(r(), 1.5) * 1.7,
      lambda: 9 + r() * 30,
      phase: r() * 100,
      tint: 0.84 + r() * 0.26,
      warm: r() - 0.5,
      over: r() < 0.3 ? 0.6 + r() : 0,
      joint: 3 + r() * 5,
      jointPhase: r() * 10,
    });
    z += thick;
  }
  return beds;
}

export class Scars {
  /**
   * scars: the map's `scars` block. opts: {baseHeight(x, z) (the terrain the tiles draw), roadDistance(x, z), q
   * (quality preset), detailAt(x, z, roadD) -> [rock, moor, verge], ground (terrain material), rock (face material)}.
   */
  constructor(scars, opts) {
    this.opts = opts;
    this.cell = scars?.cell ?? 20;
    this.cells = new Set();
    const list = scars?.cells ?? [];
    for (let i = 0; i < list.length; i += 2) this.cells.add(this.key(list[i], list[i + 1]));
    this.beds = makeBeds();
    this.faces = [];
    // Faces right next to the road would fight the road bed: leave those to the terrain.
    for (const f of scars?.faces ?? []) {
      const cols = decodeFace(f);
      for (const c of cols) {
        if (!c.face) continue;
        const reach = Math.max(Math.abs(c.tFoot), Math.abs(c.tLip)) + 8;
        if (opts.roadDistance(c.x, c.z) < 16 + reach) c.face = false;
      }
      // A column whose lip or foot is far out of line with its neighbours' is a fault in the survey: drop it.
      // (Lips are never lowered: the cap would have to climb back up to the real ground as a wall of turf.)
      dropOutliers(cols);
      // Runs of a few columns that are only a couple of metres high are rubble or noise in the survey: drop them.
      dropSmallRuns(cols);
      if (cols.some((c) => c.face)) this.faces.push({ name: f.n ?? null, cols, seed: this.faces.length });
    }
    // Spatial hash of face columns (16 m cells) for the apron and for "is this under a face?" questions.
    this.hash = new Map();
    for (const f of this.faces) {
      f.cols.forEach((c, k) => {
        if (!c.face) return;
        const prev = f.cols[Math.max(0, k - 1)], next = f.cols[Math.min(f.cols.length - 1, k + 1)];
        let tx = next.x - prev.x, tz = next.z - prev.z;
        const l = Math.hypot(tx, tz) || 1;
        c.tx = tx / l;
        c.tz = tz / l;
        // Half the gap to each neighbour (columns are ~2 m apart; a gap where the face is broken).
        c.halfW = 1.15;
        const key = this.key(Math.floor(c.x / 16), Math.floor(c.z / 16));
        if (!this.hash.has(key)) this.hash.set(key, []);
        this.hash.get(key).push(c);
      });
    }
    this.columnCount = this.faces.reduce((s, f) => s + f.cols.filter((c) => c.face).length, 0);
    // 16 m cells within reach of any column: most of the map has none, and is answered with one lookup.
    this.reach = new Set();
    for (const key of this.hash.keys()) {
      const cx = Math.round(key / 100003), cz = key - cx * 100003;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) this.reach.add(this.key(cx + dx, cz + dz));
    }
  }

  key(cx, cz) {
    return cx * 100003 + cz;
  }

  /** Is the 20 m cell containing world (x, z) cut out of the terrain for a face? */
  isCliffCell(x, z) {
    return this.cells.has(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
  }

  /** Columns whose footprint might include (x, z) (a shared array: use it before the next call). */
  near(x, z) {
    const out = this.nearOut ?? (this.nearOut = []);
    out.length = 0;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    if (!this.reach.has(this.key(cx, cz))) return out;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const l = this.hash.get(this.key(cx + dx, cz + dz));
      if (l) for (let i = 0; i < l.length; i++) out.push(l[i]);
    }
    return out;
  }

  /**
   * The apron's height at (x, z) given the terrain's height h there: pushed down out of sight under a face, kept
   * under the cap behind a lip, and kept from rising in front of a foot (where the coarse terrain ramps up the
   * face). Also says whether the point is under a face (for keeping trees and sheep off cliffs).
   */
  adjust(x, z, h, out = {}) {
    let y = h;
    let under = false;
    for (const c of this.near(x, z)) {
      const vx = x - c.x, vz = z - c.z;
      const l = vx * c.tx + vz * c.tz;
      if (Math.abs(l) > c.halfW) continue;
      const d = vx * c.nx + vz * c.nz;
      if (d < c.tLip - CAP[CAP.length - 1] || d > c.tFoot + 4) continue;
      if (d >= c.tLip - PUSH_BACK && d <= c.tFoot) {
        y = Math.min(y, c.zFoot - 0.7);
        under = true;
      } else if (d < c.tLip - PUSH_BACK) {
        y = Math.min(y, capHeight(c, c.tLip - d) - 0.3);
      } else {
        y = Math.min(y, c.zFoot - 0.3 + (d - c.tFoot) * 0.75);
      }
    }
    out.under = under;
    out.y = y;
    return out;
  }

  /** Is (x, z) under a rock face or its cap (no trees, sheep or boulders here)? */
  underFace(x, z) {
    for (const c of this.near(x, z)) {
      const vx = x - c.x, vz = z - c.z;
      if (Math.abs(vx * c.tx + vz * c.tz) > c.halfW + 0.5) continue;
      const d = vx * c.nx + vz * c.nz;
      if (d >= c.tLip - 1.5 && d <= c.tFoot + 4) return true;
    }
    return false;
  }

  /** Strata: how far the rock stands out from the LIDAR face at (s along the face, height z). */
  displacement(face, s, z, col, fz) {
    const beds = this.beds;
    // Find the bed (beds are in order of height).
    let lo = 0, hi = beds.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (beds[mid].z0 <= z) lo = mid;
      else hi = mid;
    }
    const bed = beds[lo];
    const f = Math.min(1, Math.max(0, (z - bed.z0) / bed.thick));
    const prot = bed.base + 0.45 * Math.sin(s / bed.lambda + bed.phase) + 0.22 * Math.sin(s / (bed.lambda * 0.37) + bed.phase * 2.1);
    const edge = Math.pow(Math.abs(2 * f - 1), 6);
    let d = prot * (1 - 0.7 * edge) - 0.32 * edge;
    // Vertical joints, staggered every few beds.
    const set = Math.floor(lo / 3);
    const spacing = beds[set * 3]?.joint ?? 4;
    const u = (((s + (beds[set * 3]?.jointPhase ?? 0)) % spacing) + spacing) % spacing;
    const dj = Math.min(u, spacing - u);
    d -= 0.6 * Math.exp(-(dj * dj) / 0.2);
    d += 0.22 * (valueNoise(s * 0.45 + face.seed * 13.1, z * 0.6) - 0.5) + 0.12 * (valueNoise(s * 1.7, z * 1.9 + face.seed) - 0.5);
    // The big faces lean out near the top (Malham Cove's overhanging upper tier).
    const height = col.zTop - col.zFoot;
    if (height > 25 && fz > 0.68) d += (0.8 + bed.over * 1.6) * smoothstep(0.68, 0.82, fz) * (0.6 + 0.4 * Math.sin(s / 23 + face.seed));
    // Small faces are mostly one or two beds: keep them tight to the LIDAR.
    d *= smoothstep(2, 9, height) * 0.7 + 0.3;
    return { d, tint: bed.tint, warm: bed.warm, edge, joint: Math.exp(-(dj * dj) / 0.3), z0: bed.z0, thick: bed.thick };
  }

  /** Rows (absolute heights) for a run of columns: every bed boundary, plus rows within the thicker beds. */
  rows(z0, z1) {
    const per = this.opts.q.terrainStep <= 10 ? [0, 0.16, 0.5, 0.8, 0.94] : this.opts.q.terrainStep >= 16 ? [0, 0.5, 0.94] : [0, 0.2, 0.6, 0.94];
    const out = [];
    for (const bed of this.beds) {
      if (bed.z0 + bed.thick < z0) continue;
      if (bed.z0 > z1) break;
      const fr = bed.thick < 0.9 ? [0, 0.5] : per;
      for (const f of fr) {
        const z = bed.z0 + f * bed.thick;
        if (z > z0 && z < z1) out.push(z);
      }
      // Very thick beds get extra rows so their faces can bulge and joint.
      if (bed.thick > 3) for (let z = bed.z0 + 1.2; z < bed.z0 + bed.thick - 0.9; z += 1.2) if (z > z0 && z < z1) out.push(z);
    }
    out.sort((a, b) => a - b);
    return [z0, ...out, z1];
  }

  /**
   * Builds the rock faces and caps for the columns inside a world rectangle (a terrain tile), as two meshes, or
   * null if there are none.
   */
  buildTile(x0, z0, x1, z1) {
    const facePos = [], faceUv = [], faceInfo = [], faceIdx = [];
    const capPos = [], capDet = [], capIdx = [];
    const { detailAt, roadDistance } = this.opts;
    for (const face of this.faces) {
      const cols = face.cols;
      // Along-face distance for every column.
      let s = 0;
      const sAt = cols.map((c, k) => (k ? (s += Math.hypot(c.x - cols[k - 1].x, c.z - cols[k - 1].z)) : 0));
      // Runs of consecutive face columns, split where they leave this tile: a column belongs to the tile its spine
      // point is in, and each piece starts one column early so the pieces of neighbouring tiles join.
      const inside = (c) => c.x >= x0 && c.x < x1 && c.z >= z0 && c.z < z1;
      let k = 0;
      while (k < cols.length) {
        while (k < cols.length && !cols[k].face) k++;
        const start = k;
        while (k < cols.length && cols[k].face) k++;
        const end = k; // exclusive
        for (let m = start; m < end;) {
          while (m < end && !inside(cols[m])) m++;
          if (m >= end) break;
          const a = m;
          while (m < end && inside(cols[m])) m++;
          this.buildRun(face, cols, sAt, Math.max(start, a - 1), m - 1, { facePos, faceUv, faceInfo, faceIdx, capPos, capDet, capIdx }, detailAt, roadDistance);
        }
      }
    }
    if (!facePos.length) return null;
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(facePos, 3));
    fg.setAttribute('uv', new THREE.Float32BufferAttribute(faceUv, 2));
    fg.setAttribute('rockInfo', new THREE.Float32BufferAttribute(faceInfo, 4));
    fg.setIndex(faceIdx);
    fg.computeVertexNormals();
    fg.computeBoundingSphere();
    const faceMesh = new THREE.Mesh(fg, this.opts.rock);
    faceMesh.castShadow = this.opts.q.shadows;
    faceMesh.receiveShadow = true;
    let capMesh = null;
    if (capPos.length) {
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(capPos, 3));
      cg.setAttribute('detail', new THREE.Float32BufferAttribute(capDet, 3));
      cg.setIndex(capIdx);
      cg.computeVertexNormals();
      cg.computeBoundingSphere();
      capMesh = new THREE.Mesh(cg, this.opts.ground);
      capMesh.receiveShadow = true;
    }
    return { face: faceMesh, cap: capMesh };
  }

  buildRun(face, cols, sAt, a, b, out, detailAt, roadDistance) {
    if (b - a < 1) return;
    const run = cols.slice(a, b + 1);
    let zLo = Infinity, zHi = -Infinity;
    for (const c of run) {
      zLo = Math.min(zLo, c.zFoot);
      zHi = Math.max(zHi, c.zTop);
    }
    const rows = this.rows(zLo, zHi);
    const R = rows.length + 1; // + the buried skirt row under the foot
    const base = out.facePos.length / 3;
    const tmpPos = [];
    run.forEach((c, ci) => {
      const s = sAt[a + ci];
      const height = c.zTop - c.zFoot;
      // Skirt: under the ground just in front of the foot.
      tmpPos.push([c.x + c.nx * (c.tFoot + 0.6), c.zFoot - 1.2, c.z + c.nz * (c.tFoot + 0.6), s, 0, 1, 1, height, 0]);
      for (const z of rows) {
        const zc = Math.min(c.zTop, Math.max(c.zFoot - 0.4, z));
        const fz = (zc - c.zFoot) / Math.max(0.5, height);
        let t = profileT(c, zc);
        let info = { d: 0, tint: 1, warm: 0, edge: 0, joint: 0 };
        if (zc > c.zFoot - 0.3 && zc < c.zTop - 0.05) {
          info = this.displacement(face, s, zc, c, fz);
          // Where the face is a slope rather than a wall, the beds step back: vertical risers and grassy treads,
          // the "scar and slope" of Dales limestone.
          const zb0 = Math.max(c.zFoot, info.z0), zb1 = Math.min(c.zTop, info.z0 + info.thick);
          const run = (profileT(c, zb0) - profileT(c, zb1)) / Math.max(0.3, zb1 - zb0);
          const wStep = smoothstep(0.3, 0.9, run);
          if (wStep > 0) t += (profileT(c, (zb0 + zb1) / 2) - t) * wStep;
          // Taper to nothing at the lip (it meets the cap) and the foot (it meets the ground).
          const k = smoothstep(0, 0.6, c.zTop - zc) * smoothstep(-0.3, 0.8, zc - c.zFoot);
          t += info.d * k * (1 - 0.4 * wStep);
        }
        // Runs end where the face dies away: pull the end columns back into the hill.
        tmpPos.push([c.x + c.nx * t, zc, c.z + c.nz * t, s, zc, info.tint, 1 - 0.45 * info.edge - 0.35 * info.joint, c.zTop - zc, info.warm]);
      }
    });
    for (const v of tmpPos) {
      out.facePos.push(v[0], v[1], v[2]);
      out.faceUv.push(v[3], v[4]);
      out.faceInfo.push(v[5], v[6], v[7], v[8]);
    }
    // Winding: the face must look along the columns' normal (downhill), whichever way the face runs.
    let sgn = 0;
    for (const c of run) sgn += c.tz * c.nx - c.tx * c.nz;
    const out1 = sgn > 0;
    for (let ci = 0; ci + 1 < run.length; ci++) {
      for (let r = 0; r + 1 < R; r++) {
        const p = base + ci * R + r, q = base + (ci + 1) * R + r;
        if (out1) out.faceIdx.push(p, p + 1, q, q, p + 1, q + 1);
        else out.faceIdx.push(p, q, p + 1, q, q + 1, p + 1);
      }
    }
    // Cap over the top: from the lip back over the ground, in the terrain material.
    const cb = out.capPos.length / 3;
    run.forEach((c) => {
      CAP.forEach((back, i) => {
        const t = c.tLip - back;
        const x = c.x + c.nx * t, z = c.z + c.nz * t;
        let y = capHeight(c, back) + 0.06;
        if (i === CAP.length - 1) y -= 0.5;
        out.capPos.push(x, y, z);
        const det = detailAt(x, z, roadDistance(x, z));
        out.capDet.push(Math.max(det[0], i === 0 ? 0.8 : i === 1 ? 0.45 : 0), det[1], det[2]);
      });
    });
    const C = CAP.length;
    for (let ci = 0; ci + 1 < run.length; ci++) {
      for (let r = 0; r + 1 < C; r++) {
        const p = cb + ci * C + r, q = cb + (ci + 1) * C + r;
        if (!out1) out.capIdx.push(p, q, p + 1, q, q + 1, p + 1);
        else out.capIdx.push(p, p + 1, q, q, p + 1, q + 1);
      }
    }
  }
}

/** Is the winding of the face triangles outward? (Used by tests of the geometry; the normal points downhill.) */
export function faceOutward(col) {
  return { x: col.nx, z: col.nz };
}

export { hash2 };
