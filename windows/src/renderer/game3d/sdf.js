// Smooth organic meshes from signed-distance shapes, for people.
//
// A body is described as a list of simple shapes (tapered capsules, ellipsoids, planes) blended together with
// a smooth minimum, so shoulders, elbows, knees and the neck flow into each other the way skin does instead of
// being separate tubes and balls. The field is sampled on a grid (each shape only touches the voxels near it),
// turned into a mesh with surface nets, then every vertex is pulled exactly onto the surface and given a
// normal from the field gradient, so the shading is smooth at any resolution.
//
// Each shape carries the bone it moves with and a colour region; vertices take their region from the
// nearest shape and their skin weights from nearby bones, blended across joints so knees and hips bend
// smoothly when the mesh is skinned.
import * as THREE from 'three';

const smin = (a, b, k) => {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a < b ? a : b) - h * h * k * 0.25;
};

// ---- Shapes ------------------------------------------------------------------------------------------

class Shape {
  constructor({ bone = 0, region = 0, k = 0.02, op = 'union', ladder = null }) {
    this.ladder = ladder;
    this.bone = bone;
    this.region = region; // number, or (shape, x, y, z) => number
    this.k = k;
    this.op = op; // 'union' | 'sub' | 'intersect'
  }
  combine(f, d) {
    if (this.op === 'union') return smin(f, d, this.k);
    if (this.op === 'sub') return -smin(-f, d, this.k);
    return -smin(-f, -d, this.k); // intersect
  }
  regionAt(x, y, z) {
    return typeof this.region === 'function' ? this.region(this, x, y, z) : this.region;
  }
}

/** A capsule from a (radius r1) to b (radius r2) with a smooth taper (Inigo Quilez's round cone). */
class RoundCone extends Shape {
  constructor(a, b, r1, r2, opts) {
    super(opts);
    this.a = a.clone();
    this.b = b.clone();
    this.r1 = r1;
    this.r2 = r2;
    this.prepare();
  }
  prepare() {
    const { a, b } = this;
    this.bax = b.x - a.x; this.bay = b.y - a.y; this.baz = b.z - a.z;
    this.l2 = this.bax * this.bax + this.bay * this.bay + this.baz * this.baz;
    this.rr = this.r1 - this.r2;
    this.a2 = this.l2 - this.rr * this.rr;
    this.il2 = 1 / this.l2;
  }
  transform(m) {
    this.a.applyMatrix4(m);
    this.b.applyMatrix4(m);
    this.prepare();
    return this;
  }
  bounds() {
    const r = Math.max(this.r1, this.r2);
    return [Math.min(this.a.x, this.b.x) - r, Math.min(this.a.y, this.b.y) - r, Math.min(this.a.z, this.b.z) - r, Math.max(this.a.x, this.b.x) + r, Math.max(this.a.y, this.b.y) + r, Math.max(this.a.z, this.b.z) + r];
  }
  /** 0 at a, 1 at b. */
  t(x, y, z) {
    const v = ((x - this.a.x) * this.bax + (y - this.a.y) * this.bay + (z - this.a.z) * this.baz) * this.il2;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  dist(x, y, z) {
    const { bax, bay, baz, l2, rr, a2, il2 } = this;
    const pax = x - this.a.x, pay = y - this.a.y, paz = z - this.a.z;
    const yy = pax * bax + pay * bay + paz * baz;
    const zz = yy - l2;
    const xvx = pax * l2 - bax * yy, xvy = pay * l2 - bay * yy, xvz = paz * l2 - baz * yy;
    const x2 = xvx * xvx + xvy * xvy + xvz * xvz;
    const y2 = yy * yy * l2;
    const z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - this.r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - this.r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - this.r1;
  }
}

/** An ellipsoid with semi-axes r along its local x/y/z, rotated by `basis` (a Matrix4 whose columns are the axes). */
class Ellipsoid extends Shape {
  constructor(c, r, opts = {}) {
    super(opts);
    this.c = c.clone();
    this.r = r.clone();
    this.axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    if (opts.basis) opts.basis.extractBasis(this.axes[0], this.axes[1], this.axes[2]);
    this.prepare();
  }
  prepare() {
    for (const a of this.axes) a.normalize();
    this.m = this.axes.flatMap((a) => [a.x, a.y, a.z]);
  }
  transform(m) {
    this.c.applyMatrix4(m);
    for (const a of this.axes) a.transformDirection(m);
    this.prepare();
    return this;
  }
  bounds() {
    // Extent along each world axis of a rotated ellipsoid.
    const e = [0, 1, 2].map((w) => Math.sqrt(this.axes.reduce((s, a, i) => s + (a.getComponent(w) * this.r.getComponent(i)) ** 2, 0)));
    return [this.c.x - e[0], this.c.y - e[1], this.c.z - e[2], this.c.x + e[0], this.c.y + e[1], this.c.z + e[2]];
  }
  local(x, y, z, out) {
    const dx = x - this.c.x, dy = y - this.c.y, dz = z - this.c.z, m = this.m;
    out[0] = dx * m[0] + dy * m[1] + dz * m[2];
    out[1] = dx * m[3] + dy * m[4] + dz * m[5];
    out[2] = dx * m[6] + dy * m[7] + dz * m[8];
    return out;
  }
  dist(x, y, z) {
    const m = this.m, dx = x - this.c.x, dy = y - this.c.y, dz = z - this.c.z;
    const lx = (dx * m[0] + dy * m[1] + dz * m[2]) / this.r.x;
    const ly = (dx * m[3] + dy * m[4] + dz * m[5]) / this.r.y;
    const lz = (dx * m[6] + dy * m[7] + dz * m[8]) / this.r.z;
    const k0 = Math.sqrt(lx * lx + ly * ly + lz * lz);
    const k1 = Math.sqrt((lx / this.r.x) ** 2 + (ly / this.r.y) ** 2 + (lz / this.r.z) ** 2);
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(this.r.x, this.r.y, this.r.z);
  }
}

/** Half-space through `point`: inside (negative) on the side away from the normal. Used to cut (intersect). */
class Plane extends Shape {
  constructor(n, point, opts) {
    super({ op: 'intersect', ...opts });
    this.n = n.clone().normalize();
    this.d = this.n.dot(point);
  }
  transform(m) {
    const p = this.n.clone().multiplyScalar(this.d).applyMatrix4(m);
    this.n.transformDirection(m);
    this.d = this.n.dot(p);
    return this;
  }
  bounds() {
    return null;
  }
  dist(x, y, z) {
    return this.n.x * x + this.n.y * y + this.n.z * z - this.d;
  }
}

export const cone = (a, b, r1, r2, opts) => new RoundCone(a, b, r1, r2 ?? r1, opts);
export const ellipsoid = (c, r, opts) => new Ellipsoid(c, r, opts);
export const plane = (n, point, opts) => new Plane(n, point, opts);

/** A basis whose y axis points along `dir` and whose x axis stays as close to world x as possible. */
export function alongBasis(dir, side = new THREE.Vector3(1, 0, 0)) {
  const y = dir.clone().normalize();
  const x = side.clone().addScaledVector(y, -side.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z);
}

// ---- Field and mesh -------------------------------------------------------------------------------------

function fieldAt(shapes, x, y, z) {
  let f = 1e3;
  for (const s of shapes) {
    const b = s._bb;
    if (b && (x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5])) continue;
    f = s.combine(f, s.dist(x, y, z));
  }
  return f;
}

/**
 * Meshes a set of shapes. box: [minX, minY, minZ, maxX, maxY, maxZ]; h: grid spacing (m).
 * bones: {neighbours: {bone: [bones]}, blend: metres over which weights blend across a joint}.
 * Returns {geometry (position, normal, skinIndex, skinWeight, index), regions: Uint8Array per vertex}.
 */
export function meshShapes(shapes, box, h, { neighbours = {}, blend = 0.04 } = {}) {
  for (const s of shapes) {
    const b = s.bounds();
    const m = s.k + 2.5 * h;
    s._bb = b && [b[0] - m, b[1] - m, b[2] - m, b[3] + m, b[4] + m, b[5] + m];
  }
  const [ox, oy, oz] = box;
  const nx = Math.ceil((box[3] - ox) / h) + 1, ny = Math.ceil((box[4] - oy) / h) + 1, nz = Math.ceil((box[5] - oz) / h) + 1;
  const sxy = nx * ny;
  const F = new Float32Array(nx * ny * nz).fill(1e3);

  // Sample: each shape only visits the voxels inside its bounds (planes visit everything).
  for (const s of shapes) {
    const b = s._bb;
    const i0 = b ? Math.max(0, Math.floor((b[0] - ox) / h)) : 0, i1 = b ? Math.min(nx - 1, Math.ceil((b[3] - ox) / h)) : nx - 1;
    const j0 = b ? Math.max(0, Math.floor((b[1] - oy) / h)) : 0, j1 = b ? Math.min(ny - 1, Math.ceil((b[4] - oy) / h)) : ny - 1;
    const k0 = b ? Math.max(0, Math.floor((b[2] - oz) / h)) : 0, k1 = b ? Math.min(nz - 1, Math.ceil((b[5] - oz) / h)) : nz - 1;
    for (let k = k0; k <= k1; k++) {
      const z = oz + k * h;
      for (let j = j0; j <= j1; j++) {
        const y = oy + j * h;
        let idx = k * sxy + j * nx + i0;
        for (let i = i0; i <= i1; i++, idx++) F[idx] = s.combine(F[idx], s.dist(ox + i * h, y, z));
      }
    }
  }

  // Surface nets: one vertex per cell the surface passes through, at the mean of its edge crossings.
  const cell = new Int32Array(nx * ny * nz).fill(-1);
  const pos = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [a, b, d] = corner[c];
          cv[c] = F[(k + d) * sxy + (j + b) * nx + i + a];
          if (cv[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [e0, e1] of edges) {
          const f0 = cv[e0], f1 = cv[e1];
          if ((f0 < 0) === (f1 < 0)) continue;
          const t = f0 / (f0 - f1);
          sx += corner[e0][0] + (corner[e1][0] - corner[e0][0]) * t;
          sy += corner[e0][1] + (corner[e1][1] - corner[e0][1]) * t;
          sz += corner[e0][2] + (corner[e1][2] - corner[e0][2]) * t;
          n++;
        }
        cell[k * sxy + j * nx + i] = pos.length / 3;
        pos.push(ox + (i + sx / n) * h, oy + (j + sy / n) * h, oz + (k + sz / n) * h);
      }
    }
  }

  // Faces: a quad for every grid edge the surface crosses, joining the four cells around it.
  const index = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) [b, d] = [d, b];
    // Split along the shorter diagonal.
    const dac = (pos[a * 3] - pos[c * 3]) ** 2 + (pos[a * 3 + 1] - pos[c * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[c * 3 + 2]) ** 2;
    const dbd = (pos[b * 3] - pos[d * 3]) ** 2 + (pos[b * 3 + 1] - pos[d * 3 + 1]) ** 2 + (pos[b * 3 + 2] - pos[d * 3 + 2]) ** 2;
    if (dac <= dbd) index.push(a, b, c, a, c, d);
    else index.push(a, b, d, b, c, d);
  };
  const C = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1 ? -1 : cell[k * sxy + j * nx + i]);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f0 = F[k * sxy + j * nx + i];
        const inside = f0 < 0;
        if (i < nx - 1 && inside !== (F[k * sxy + j * nx + i + 1] < 0)) quad(C(i, j - 1, k - 1), C(i, j, k - 1), C(i, j, k), C(i, j - 1, k), !inside);
        if (j < ny - 1 && inside !== (F[k * sxy + (j + 1) * nx + i] < 0)) quad(C(i - 1, j, k - 1), C(i - 1, j, k), C(i, j, k), C(i, j, k - 1), !inside);
        if (k < nz - 1 && inside !== (F[(k + 1) * sxy + j * nx + i] < 0)) quad(C(i - 1, j - 1, k), C(i, j - 1, k), C(i, j, k), C(i - 1, j, k), !inside);
      }
    }
  }

  // Pull each vertex onto the true surface and take its normal from the field gradient.
  const count = pos.length / 3;
  const normal = new Float32Array(count * 3);
  const e = h * 0.2;
  const grad = (x, y, z, out) => {
    out[0] = fieldAt(shapes, x + e, y, z) - fieldAt(shapes, x - e, y, z);
    out[1] = fieldAt(shapes, x, y + e, z) - fieldAt(shapes, x, y - e, z);
    out[2] = fieldAt(shapes, x, y, z + e) - fieldAt(shapes, x, y, z - e);
    return out;
  };
  const g = [0, 0, 0];
  for (let v = 0; v < count; v++) {
    let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    for (let it = 0; it < 3; it++) {
      const f = fieldAt(shapes, x, y, z);
      grad(x, y, z, g);
      const gl2 = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) / (4 * e * e);
      if (gl2 < 1e-8) break;
      let step = f / gl2 / (2 * e);
      const len = Math.abs(step) * Math.sqrt(gl2) * 2 * e;
      if (len > h * 0.6) step *= (h * 0.6) / len;
      x -= g[0] * step;
      y -= g[1] * step;
      z -= g[2] * step;
      if (Math.abs(f) < h * 0.002) break;
    }
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    grad(x, y, z, g);
    const l = Math.hypot(g[0], g[1], g[2]) || 1;
    normal[v * 3] = g[0] / l; normal[v * 3 + 1] = g[1] / l; normal[v * 3 + 2] = g[2] / l;
  }

  // Check the winding against the normals once, and flip everything if it came out inside out.
  let agree = 0;
  for (let t = 0; t < index.length; t += 3 * 7) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    agree += fx * normal[a * 3] + fy * normal[a * 3 + 1] + fz * normal[a * 3 + 2] > 0 ? 1 : -1;
  }
  if (agree < 0) for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];

  // Regions from the nearest coloured shape; skin weights from the nearest shape of each nearby bone.
  const regions = new Uint8Array(count);
  const skinIndex = new Uint16Array(count * 4), skinWeight = new Float32Array(count * 4);
  const coloured = shapes.filter((s) => s.op === 'union' || s.paintsCut);
  const boneIds = [...new Set(shapes.filter((s) => s.op === 'union').map((s) => s.bone))];
  const boneDist = new Map();
  const nearest = new Array(count);
  for (let v = 0; v < count; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let best = Infinity, near = null;
    boneDist.clear();
    for (const b of boneIds) boneDist.set(b, Infinity);
    for (const s of coloured) {
      const d = s.dist(x, y, z);
      if (s.op !== 'union') {
        // A cut that paints its own faces (helmet vents): claim the vertex if it lies on the cut.
        if (Math.abs(d) < h * 0.75) { best = -Infinity; near = s; }
        continue;
      }
      if (d < boneDist.get(s.bone)) boneDist.set(s.bone, d);
      if (d < best) { best = d; near = s; }
    }
    regions[v] = near ? near.regionAt(x, y, z) : 0;
    nearest[v] = near && near.op === 'union' ? near : null;
    const home = near && near.op === 'union' ? near.bone : boneIds.reduce((a, b) => (boneDist.get(b) < boneDist.get(a) ? b : a), boneIds[0]);
    const cand = [home, ...(neighbours[home] ?? [])];
    const dHome = boneDist.get(home);
    const ws = cand.map((b) => {
      const d = boneDist.get(b) ?? Infinity;
      const t = Math.max(0, 1 - (d - dHome) / blend);
      return [b, b === home ? 1 : t * t * (3 - 2 * t) * 0.5];
    }).filter(([, w]) => w > 0.001).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = ws.reduce((s, [, w]) => s + w, 0);
    ws.forEach(([b, w], i) => {
      skinIndex[v * 4 + i] = b;
      skinWeight[v * 4 + i] = w / sum;
    });
  }

  // Colour ladders: a shape may carry {row, at(x, y, z) -> [a, b]}, a smooth coordinate (e.g. how far along the
  // arm) that the shader turns into colour per pixel, so kit edges are crisp lines rather than following the
  // mesh. Every triangle must use one ladder, so vertices where two meet are duplicated, one copy per ladder.
  const ladders = [];
  const ladderOf = new Int16Array(count).fill(-1);
  for (let v = 0; v < count; v++) {
    const s = nearest[v];
    if (!s || !s.ladder) continue;
    let li = ladders.indexOf(s.ladder);
    if (li < 0) li = ladders.push(s.ladder) - 1;
    ladderOf[v] = li;
  }
  const P = Array.from(pos), N = Array.from(normal), SI = Array.from(skinIndex), SW = Array.from(skinWeight), RG = Array.from(regions), LI = Array.from(ladderOf);
  const dup = new Map();
  for (let t = 0; t < index.length; t += 3) {
    const a = LI[index[t]], b = LI[index[t + 1]], c = LI[index[t + 2]];
    if (a === b && b === c) continue;
    const k = a === b || a === c ? a : b === c ? b : a;
    for (let j = 0; j < 3; j++) {
      const v = index[t + j];
      if (LI[v] === k) continue;
      const key = v * 64 + (k + 1);
      let nv = dup.get(key);
      if (nv === undefined) {
        nv = P.length / 3;
        P.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
        N.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
        for (let q = 0; q < 4; q++) { SI.push(SI[v * 4 + q]); SW.push(SW[v * 4 + q]); }
        RG.push(RG[v]);
        LI.push(k);
        dup.set(key, nv);
      }
      index[t + j] = nv;
    }
  }
  const total = P.length / 3;
  const row = new Float32Array(total), lad = new Float32Array(total * 2);
  for (let v = 0; v < total; v++) {
    const L = LI[v] >= 0 ? ladders[LI[v]] : null;
    if (!L) continue;
    row[v] = L.row;
    const [a, b] = L.at(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    lad[v * 2] = a;
    lad[v * 2 + 1] = b ?? 0;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(Uint16Array.from(SI), 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(Float32Array.from(SW), 4));
  if (ladders.length) {
    geometry.setAttribute('ladderRow', new THREE.BufferAttribute(row, 1));
    geometry.setAttribute('ladder', new THREE.BufferAttribute(lad, 2));
  }
  geometry.setIndex(total > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  for (const s of shapes) delete s._bb;
  return { geometry, regions: Uint8Array.from(RG) };
}

/** A copy of a template sharing its vertex data, with its own colour per vertex from colourOf(region, i). */
export function painted(template, colourOf) {
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'skinIndex', 'skinWeight', 'ladderRow', 'ladder']) if (template.geometry.attributes[k]) g.setAttribute(k, template.geometry.attributes[k]);
  g.setIndex(template.geometry.index);
  const n = template.regions.length;
  const col = new Uint8Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    colourOf(template.regions[i], i, c);
    // THREE.Color holds linear values, which is what the shader expects from vertex colours.
    col[i * 3] = Math.round(c.r * 255);
    col[i * 3 + 1] = Math.round(c.g * 255);
    col[i * 3 + 2] = Math.round(c.b * 255);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  g.boundingSphere = template.geometry.boundingSphere;
  return g;
}
