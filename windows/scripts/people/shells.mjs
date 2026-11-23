// Parametric hard-shell gear: a road (or aero) helmet and wrap-round sunglasses, as explicit meshes so vents and
// edges are crisp and the triangle counts small. Coordinates are in the head's rest frame (game frame: +y up,
// face towards -z, +x the rider's right); `C` is the cranium centre.

/** A mesh builder collecting positions, regions and triangles. */
export class Builder {
  constructor() {
    this.P = [];
    this.R = [];
    this.I = [];
  }
  v(p, region) {
    this.P.push(p[0], p[1], p[2]);
    this.R.push(region);
    return this.P.length / 3 - 1;
  }
  tri(a, b, c) { this.I.push(a, b, c); }
  quad(a, b, c, d) { this.I.push(a, b, c, a, c, d); }
  /** A tube through points with radius r (n sides), capped. */
  tube(pts, r, region, n = 6) {
    const rings = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      const t = norm(sub(q, o));
      const a = norm(Math.abs(t[1]) < 0.9 ? cross(t, [0, 1, 0]) : cross(t, [1, 0, 0])), b = cross(t, a);
      const rr = typeof r === 'function' ? r(i / (pts.length - 1)) : r;
      rings.push(Array.from({ length: n }, (_, k) => {
        const th = (k / n) * Math.PI * 2;
        return this.v(add(p, add(scale(a, Math.cos(th) * rr), scale(b, Math.sin(th) * rr))), region);
      }));
    }
    for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < n; k++) this.quad(rings[i][k], rings[i][(k + 1) % n], rings[i + 1][(k + 1) % n], rings[i + 1][k]);
    const capA = this.v(pts[0], region), capB = this.v(pts[pts.length - 1], region);
    for (let k = 0; k < n; k++) {
      this.tri(capA, rings[0][(k + 1) % n], rings[0][k]);
      this.tri(capB, rings[rings.length - 1][k], rings[rings.length - 1][(k + 1) % n]);
    }
  }
  /** Flips triangles whose winding disagrees with the outward direction from `centre` (for closed-ish shells). */
  orient(centre, from = 0) {
    for (let i = from; i < this.I.length; i += 3) {
      const [a, b, c] = [this.I[i], this.I[i + 1], this.I[i + 2]];
      const pa = this.p(a), pb = this.p(b), pc = this.p(c);
      const n = cross(sub(pb, pa), sub(pc, pa));
      const m = scale(add(add(pa, pb), pc), 1 / 3);
      if (dot(n, sub(m, centre)) < 0) [this.I[i + 1], this.I[i + 2]] = [c, b];
    }
  }
  p(i) { return [this.P[i * 3], this.P[i * 3 + 1], this.P[i * 3 + 2]]; }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Helmet shell. th: angle round the head (0 = front, +pi/2 = right side, pi = back); s: 0 at the rim, 1 at the crown.
 * Returns a Builder with regions: shell, dark lower band, foam (rim and inside), vent walls.
 */
export function helmet(C, R, { aero = false, far = false } = {}) {
  const NT = far ? 36 : 72, NS = far ? 8 : 18;
  const rx = aero ? 0.097 : 0.104;
  const rzF = aero ? 0.136 : 0.14, rzB = aero ? 0.205 : 0.152;
  const ry = aero ? 0.088 : 0.1;
  const y0 = C[1] + 0.004, z0 = C[2] + (aero ? 0.012 : 0.006);
  // Rim height (relative to C) round the head: just above the brow at the front, over the ears, low at the back.
  const rimY = (th) => {
    const back = (1 - Math.cos(th)) / 2; // 0 front, 1 back
    return C[1] + 0.006 - (aero ? 0.022 : 0.012) * Math.sin(th) ** 2 - 0.036 * back ** 1.6 - (aero ? 0.018 * back ** 2 : 0);
  };
  const shape = (th) => {
    // Teardrop from above: longer at the back; a flatter rear quarter for the tail.
    const c = Math.cos(th), s = Math.sin(th);
    const rz = c > 0 ? rzF : rzB;
    // Narrow towards the back.
    const w = rx * (1 - (aero ? 0.34 : 0.12) * smooth(0.0, 1.0, -c) ** (aero ? 1.4 : 1));
    return [w * s, rz * -c];
  };
  const outer = (th, s, inset = 0) => {
    const [ox, oz] = shape(th);
    const r0 = rimY(th);
    // Elevation at the rim from its height; up to the crown at s = 1.
    const e0 = Math.asin(Math.max(-0.95, Math.min(0.95, (r0 - y0) / ry)));
    const e = e0 + (Math.PI / 2 - e0) * s ** 0.92;
    const ce = Math.cos(e), se = Math.sin(e);
    // Tail: the back rim kicks out a little.
    const kick = aero ? 0 : 0.012 * smooth(0.6, 1, (1 - Math.cos(th)) / 2) * (1 - s) ** 2;
    let p = [ox * ce, y0 + ry * se, z0 + oz * ce + kick];
    if (inset) {
      // Inside surface: towards the cranium centre by the foam thickness (thicker on top).
      const t = inset * (0.55 + 0.55 * Math.min(1, s * 1.6));
      const d = norm([p[0] / rx, (p[1] - y0) / ry * 1.1, (p[2] - z0) / (Math.cos(th) > 0 ? rzF : rzB)]);
      p = sub(p, scale(d, t));
    }
    return p;
  };
  // Vents: rectangles in (th, s) cells. Longitudinal slots over the top, intakes at the brow, exhausts at the back.
  const vents = [];
  if (far) {
    for (const [t0, t1, s0, s1] of (aero ? [] : [[-0.12, 0.12, 0.12, 0.62], [0.26, 0.44, 0.12, 0.62], [-0.44, -0.26, 0.12, 0.62], [2.9, 3.4, 0.2, 0.7]])) vents.push([t0, t1, s0, s1]);
  } else if (!aero) {
    for (const [t0, t1, s0, s1] of [[-0.1, 0.1, 0.12, 0.56], [0.2, 0.33, 0.14, 0.62], [-0.33, -0.2, 0.14, 0.62], [0.45, 0.57, 0.18, 0.58], [-0.57, -0.45, 0.18, 0.58],
      [0.72, 0.82, 0.3, 0.6], [-0.82, -0.72, 0.3, 0.6], [2.62, 2.75, 0.2, 0.62], [-2.75, -2.62, 0.2, 0.62], [2.97, 3.31, 0.24, 0.66], [2.3, 2.42, 0.18, 0.5], [-2.42, -2.3, 0.18, 0.5],
      [1.3, 1.45, 0.5, 0.72], [-1.45, -1.3, 0.5, 0.72], [1.75, 1.9, 0.44, 0.68], [-1.9, -1.75, 0.44, 0.68]]) vents.push([t0, t1, s0, s1]);
  } else {
    for (const [t0, t1, s0, s1] of [[-0.24, -0.08, 0.1, 0.28], [0.08, 0.24, 0.1, 0.28], [2.86, 3.0, 0.22, 0.42], [3.28, 3.42, 0.22, 0.42]]) vents.push([t0, t1, s0, s1]);
  }
  const wrap = (a) => {
    let x = a;
    while (x > Math.PI) x -= 2 * Math.PI;
    while (x < -Math.PI) x += 2 * Math.PI;
    return x;
  };
  const inVent = (i, j) => {
    const th = wrap(((i + 0.5) / NT) * Math.PI * 2), s = (j + 0.5) / NS;
    return vents.some(([t0, t1, s0, s1]) => {
      const a = wrap(th - (t0 + t1) / 2), h = (t1 - t0) / 2;
      // Taper slot ends so vents are rounded lozenges.
      return s > s0 && s < s1 && Math.abs(a) < h;
    });
  };
  const b = new Builder();
  const OUT = [], IN = [];
  for (let i = 0; i <= NT; i++) {
    OUT.push([]);
    IN.push([]);
    for (let j = 0; j <= NS; j++) {
      const th = (i / NT) * Math.PI * 2, s = j / NS;
      OUT[i].push(outer(th, s));
      IN[i].push(outer(th, s, aero ? 0.024 : 0.027));
    }
  }
  const dark = (j) => (j < 1 ? R.SHELL_DARK : R.SHELL);
  // Outer and inner surfaces, skipping vent cells; each cell gets its own vertices so regions stay crisp.
  for (let i = 0; i < NT; i++) {
    for (let j = 0; j < NS; j++) {
      const vent = inVent(i, j);
      if (!vent) {
        const rg = dark(j);
        const a = b.v(OUT[i][j], rg), c = b.v(OUT[i + 1][j], rg), d = b.v(OUT[i + 1][j + 1], rg), e = b.v(OUT[i][j + 1], rg);
        b.quad(a, c, d, e);
      } else {
        // Vent floor: a dark channel part-way down through the foam (the liner closes it from inside).
        const F = (p, q) => scale(add(scale(p, 0.4), scale(q, 0.6)), 1);
        const a = b.v(F(OUT[i][j], IN[i][j]), R.VENT), c = b.v(F(OUT[i + 1][j], IN[i + 1][j]), R.VENT), d = b.v(F(OUT[i + 1][j + 1], IN[i + 1][j + 1]), R.VENT), e = b.v(F(OUT[i][j + 1], IN[i][j + 1]), R.VENT);
        b.quad(a, c, d, e);
      }
      const ia = b.v(IN[i][j], R.FOAM), ic = b.v(IN[i + 1][j], R.FOAM), id = b.v(IN[i + 1][j + 1], R.FOAM), ie = b.v(IN[i][j + 1], R.FOAM);
      b.quad(ia, ie, id, ic);
    }
  }
  const surfaceEnd = b.I.length;
  // Wind the surfaces outwards from the cranium centre (inner faces point inwards: they are seen from below).
  const centre = [0, y0 - 0.02, z0];
  for (let k = 0; k < b.I.length; k += 3) {
    const [x, y, z] = [b.I[k], b.I[k + 1], b.I[k + 2]];
    const pa = b.p(x), pb = b.p(y), pc = b.p(z);
    const n = cross(sub(pb, pa), sub(pc, pa));
    const m = scale(add(add(pa, pb), pc), 1 / 3);
    const isInner = b.R[x] === R.FOAM;
    if (k >= surfaceEnd) continue;
    const outward = dot(n, sub(m, centre)) > 0;
    if (outward === isInner) [b.I[k + 1], b.I[k + 2]] = [z, y];
  }
  // Walls round every vent and along the rim, joining outer to inner, facing into the opening (or down at the rim).
  const floor = (p, q) => add(scale(p, 0.4), scale(q, 0.6));
  const wall = (p0, p1, q0, q1, region, toward) => {
    if (region === R.VENT) { q0 = floor(p0, q0); q1 = floor(p1, q1); }
    const a = b.v(p0, region), c = b.v(p1, region), d = b.v(q1, region), e = b.v(q0, region);
    const n = cross(sub(p1, p0), sub(q1, p0));
    const m = scale(add(add(p0, p1), add(q0, q1)), 0.25);
    if (dot(n, sub(toward, m)) >= 0) b.quad(a, c, d, e);
    else b.quad(a, e, d, c);
  };
  const mid = (i, j) => scale(add(add(OUT[i][j], OUT[i + 1][j + 1]), add(IN[i][j], IN[i + 1][j + 1])), 0.25);
  for (let i = 0; i < NT; i++) {
    for (let j = 0; j < NS; j++) {
      const open = inVent(i, j);
      if (j === 0 && !open) {
        const below = scale(add(OUT[i][0], IN[i][0]), 0.5);
        wall(OUT[i][0], OUT[i + 1][0], IN[i][0], IN[i + 1][0], R.FOAM, [below[0], below[1] - 1, below[2]]);
      }
      if (!open) continue;
      const toward = mid(i, j);
      if (!inVent((i + NT - 1) % NT, j)) wall(OUT[i][j], OUT[i][j + 1], IN[i][j], IN[i][j + 1], R.VENT, toward);
      if (!inVent((i + 1) % NT, j)) wall(OUT[i + 1][j], OUT[i + 1][j + 1], IN[i + 1][j], IN[i + 1][j + 1], R.VENT, toward);
      if (j > 0 && !inVent(i, j - 1)) wall(OUT[i][j], OUT[i + 1][j], IN[i][j], IN[i + 1][j], R.VENT, toward);
      if (j < NS - 1 && !inVent(i, j + 1)) wall(OUT[i][j + 1], OUT[i + 1][j + 1], IN[i][j + 1], IN[i + 1][j + 1], R.VENT, toward);
    }
  }
  return b;
}

/** Wrap-round sunglasses: a curved single lens with a nose notch, a slim top frame and arms to the ears. */
export function sunglasses(C, eye, R, { far = false } = {}) {
  const b = new Builder();
  const NU = far ? 14 : 40, NV = far ? 2 : 7;
  const cz = C[2] - 0.012, cy = eye[1] + 0.004;
  const ax = 0.082, az = 0.12; // lens wraps on an ellipse round the face
  const umax = 1.32; // half-angle of the wrap
  const top = (u) => eye[1] + 0.022 - 0.004 * u * u;
  const bottom = (u) => {
    const nose = 0.019 * Math.exp(-((u / 0.16) ** 2)); // notch over the nose
    return eye[1] - 0.019 + 0.01 * u ** 4 + nose;
  };
  const surf = (u, v, off = 0) => {
    const y = bottom(u) + (top(u) - bottom(u)) * v;
    // Slight vertical curve: the lens bulges a little at mid-height.
    const bulge = 0.004 * Math.sin(Math.PI * v);
    const r = 1 + (bulge + off) / az;
    return [Math.sin(u) * ax * r, y, cz - Math.cos(u) * az * r];
  };
  const front = [], back = [];
  for (let i = 0; i <= NU; i++) {
    const u = -umax + (2 * umax * i) / NU;
    front.push([]);
    back.push([]);
    for (let j = 0; j <= NV; j++) {
      front[i].push(b.v(surf(u, j / NV, 0.0015), R.LENS));
      back[i].push(b.v(surf(u, j / NV, -0.0005), R.LENS));
    }
  }
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      b.quad(front[i][j], front[i + 1][j], front[i + 1][j + 1], front[i][j + 1]);
      b.quad(back[i][j], back[i][j + 1], back[i + 1][j + 1], back[i + 1][j]);
    }
  }
  // Orient the lens faces: front outwards, back inwards.
  const centre = [0, cy, cz];
  const half = b.I.length;
  for (let k = 0; k < half; k += 3) {
    const pa = b.p(b.I[k]), pb = b.p(b.I[k + 1]), pc = b.p(b.I[k + 2]);
    const n = cross(sub(pb, pa), sub(pc, pa));
    const m = scale(add(add(pa, pb), pc), 1 / 3);
    const isBack = (k / 6) % 2 === 1;
    const outward = dot(n, sub(m, centre)) > 0;
    if (outward === isBack) [b.I[k + 1], b.I[k + 2]] = [b.I[k + 2], b.I[k + 1]];
  }
  // Rim of the lens: thin edge strips round the outline.
  const edge = (pts, region) => b.tube(pts, 0.0013, region, 4);
  const topPts = [], botPts = [];
  for (let i = 0; i <= NU; i++) {
    const u = -umax + (2 * umax * i) / NU;
    topPts.push(surf(u, 1, 0.0008));
    botPts.push(surf(u, 0, 0.0008));
  }
  // Half-rim frame along the top, a bit thicker, and the lens's own bottom edge.
  b.tube(topPts, 0.0026, R.FRAME, far ? 3 : 6);
  if (!far) edge(botPts, R.LENS);
  // Arms (temples) from the lens ends back over the ears.
  for (const s of [-1, 1]) {
    const end = surf(s * umax, 0.85, 0.001);
    const pts = [end, [s * 0.081, eye[1] + 0.016, C[2] + 0.0], [s * 0.083, eye[1] + 0.012, C[2] + 0.035], [s * 0.077, eye[1] - 0.008, C[2] + 0.062]];
    b.tube(pts, 0.0024, R.FRAME, far ? 3 : 5);
  }
  return b;
}
