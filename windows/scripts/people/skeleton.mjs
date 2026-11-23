// The MakeHuman default skeleton (163 bones) on a shaped base mesh, posed by aiming bones in world space and
// skinned with the default weights (linear blend). Coordinates are in the game's frame (metres, +y up, facing
// -z, +x the figure's right) after `toGame`.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => scale(a, 1 / (len(a) || 1));
export const V3 = { sub, add, scale, dot, cross, len, norm };

// 3x3 matrices as arrays of 9, row-major: m[r*3+c].
export const M3 = {
  I: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
  mul(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
  },
  T: (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]],
  apply: (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]],
  /** Columns x, y, z. */
  fromCols: (x, y, z) => [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]],
  col: (m, c) => [m[c], m[3 + c], m[6 + c]],
  /** Rotation about a unit axis by angle (rad). */
  axisAngle(axis, a) {
    const [x, y, z] = norm(axis), c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  },
  /** The shortest rotation taking unit vector a to unit vector b. */
  between(a, b) {
    a = norm(a);
    b = norm(b);
    const c = dot(a, b);
    if (c > 0.999999) return M3.I();
    if (c < -0.999999) {
      const perp = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]);
      return M3.axisAngle(perp, Math.PI);
    }
    return M3.axisAngle(cross(a, b), Math.acos(Math.max(-1, Math.min(1, c))));
  },
};

/** MakeHuman coordinates (decimetres, facing +z, +x = figure's left) to the game's (metres, facing -z). */
export function toGame(coords) {
  const out = new Float64Array(coords.length);
  for (let i = 0; i < coords.length; i += 3) {
    out[i] = -coords[i] * 0.1;
    out[i + 1] = coords[i + 1] * 0.1;
    out[i + 2] = -coords[i + 2] * 0.1;
  }
  return out;
}

export class Skeleton {
  /** skel: parsed .mhskel; coords: shaped base-mesh coordinates in the game frame. */
  constructor(skel, coords) {
    this.names = Object.keys(skel.bones);
    const joint = (name) => {
      const vs = skel.joints[name];
      const p = [0, 0, 0];
      for (const v of vs) for (let a = 0; a < 3; a++) p[a] += coords[v * 3 + a] / vs.length;
      return p;
    };
    // Order parents before children.
    const order = [], seen = new Set();
    const visit = (n) => {
      if (seen.has(n)) return;
      const p = skel.bones[n].parent;
      if (p) visit(p);
      seen.add(n);
      order.push(n);
    };
    for (const n of this.names) visit(n);
    this.order = order;
    this.bones = {};
    for (const n of order) {
      const b = skel.bones[n];
      const head = joint(b.head), tail = joint(b.tail);
      // Roll from the bone's plane (three joints), as MakeHuman does.
      let normal = [0, 0, 1];
      const plane = skel.planes[b.rotation_plane];
      if (plane) {
        const [p1, p2, p3] = plane.map(joint);
        const n1 = cross(norm(sub(p3, p2)), norm(sub(p2, p1)));
        if (len(n1) > 1e-6) normal = norm(n1);
      }
      const y = norm(sub(tail, head));
      let z = cross(normal, y);
      if (len(z) < 1e-6) z = cross([1, 0, 0], y);
      z = norm(z);
      const x = norm(cross(y, z));
      this.bones[n] = { name: n, parent: b.parent, head, tail, length: len(sub(tail, head)), rest: M3.fromCols(x, y, z) };
    }
    this.reset();
  }

  /** Back to the rest pose. */
  reset() {
    for (const n of this.order) {
      const b = this.bones[n];
      b.local = M3.I(); // pose rotation in the bone's rest frame
    }
    this.solve();
  }

  /** Posed world rotation (rot, columns = posed axes) and head position (pos) of every bone, from the local rotations. */
  solve() {
    for (const n of this.order) {
      const b = this.bones[n];
      if (!b.parent) {
        b.rot = M3.mul(b.rest, b.local);
        b.pos = b.rootPos ?? b.head;
      } else {
        const p = this.bones[b.parent];
        // Rest offset of the head and rest orientation, both expressed in the parent's rest frame.
        const relRot = M3.mul(M3.T(p.rest), b.rest);
        const relPos = M3.apply(M3.T(p.rest), sub(b.head, p.head));
        b.rot = M3.mul(M3.mul(p.rot, relRot), b.local);
        b.pos = add(p.pos, M3.apply(p.rot, relPos));
      }
      b.tailPos = add(b.pos, scale(M3.col(b.rot, 1), b.length));
    }
  }

  /** Rotates a bone (and so its children) by a world-space rotation about its head. */
  rotateWorld(name, R) {
    this.solve();
    const b = this.bones[name];
    // new rot = R * rot  =>  local' = local * rot^-1 * R * rot
    const want = M3.mul(R, b.rot);
    const parentRot = b.parent ? M3.mul(this.bones[b.parent].rot, M3.mul(M3.T(this.bones[b.parent].rest), b.rest)) : b.rest;
    b.local = M3.mul(M3.T(parentRot), want);
    this.solve();
  }

  /** Aims a bone's axis (head to tail) along a world direction, with the smallest turn. */
  aim(name, dir) {
    this.solve();
    const b = this.bones[name];
    this.rotateWorld(name, M3.between(M3.col(b.rot, 1), dir));
  }

  /** Twists a bone about its own axis. */
  twist(name, angle) {
    this.solve();
    this.rotateWorld(name, M3.axisAngle(M3.col(this.bones[name].rot, 1), angle));
  }

  /** World position of a point given in a bone's rest pose, carried by that bone. */
  carry(name, p) {
    const b = this.bones[name];
    return add(b.pos, M3.apply(M3.mul(b.rot, M3.T(b.rest)), sub(p, b.head)));
  }

  /** Skinning: rest coords -> posed coords with per-vertex weights [{bone, w}...]. */
  skin(coords, weights) {
    this.solve();
    const mats = {};
    for (const n of this.order) {
      const b = this.bones[n];
      mats[n] = { R: M3.mul(b.rot, M3.T(b.rest)), h: b.head, p: b.pos };
    }
    const n = coords.length / 3, out = new Float64Array(coords.length);
    for (let i = 0; i < n; i++) {
      const v = [coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]];
      const ws = weights[i];
      if (!ws || !ws.length) {
        out.set(v, i * 3);
        continue;
      }
      let x = 0, y = 0, z = 0, tw = 0;
      for (const [bn, w] of ws) {
        const m = mats[bn];
        const q = add(M3.apply(m.R, sub(v, m.h)), m.p);
        x += q[0] * w; y += q[1] * w; z += q[2] * w; tw += w;
      }
      out[i * 3] = x / tw; out[i * 3 + 1] = y / tw; out[i * 3 + 2] = z / tw;
    }
    return out;
  }
}

/** Per-vertex weight lists [[bone, w], ...] from a .mhw file, for nVerts vertices. */
export function vertexWeights(mhw, nVerts) {
  const out = Array.from({ length: nVerts }, () => []);
  for (const [bone, list] of Object.entries(mhw.weights)) {
    for (const [v, w] of list) if (v < nVerts) out[v].push([bone, w]);
  }
  for (const ws of out) {
    const s = ws.reduce((a, [, w]) => a + w, 0);
    if (s > 0) for (const p of ws) p[1] /= s;
  }
  return out;
}

/** Interpolated weights for fitted (proxy/clothes) vertices from their three reference vertices. */
export function fittedWeights(fit, baseWeights) {
  const n = fit.refs.length / 3, out = [];
  for (let i = 0; i < n; i++) {
    const acc = new Map();
    for (let k = 0; k < 3; k++) {
      const w = fit.w[i * 3 + k];
      if (w <= 0) continue;
      for (const [b, bw] of baseWeights[fit.refs[i * 3 + k]] ?? []) acc.set(b, (acc.get(b) ?? 0) + bw * w);
    }
    const list = [...acc.entries()];
    const s = list.reduce((a, [, w]) => a + w, 0);
    out.push(s > 0 ? list.map(([b, w]) => [b, w / s]) : []);
  }
  return out;
}
