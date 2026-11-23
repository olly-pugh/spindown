// Trees with real species silhouettes, generated at start-up: English oak (broad, rugged, clumped crown on
// crooked limbs), ash (tall, open and upswept), sycamore (a dense dome), hawthorn (small and twisted, bent
// away from the prevailing wind on exposed ground), silver birch (slender, white, weeping tips), lime (a tall
// oval crown on a clean trunk, for York's streets and parks), Scots pine (a bare orange-barked trunk under a
// flat-topped crown of needle pads) and spruce (dark plantation cones with drooping whorls).
//
// Each tree is a branching skeleton grown into its species' crown envelope, bark tubes round the skeleton,
// and leaf-spray cards (alpha-tested, see foliage.js) gathered in clusters at the ends of the branches, so the
// crown breaks up into clumps with sky and limbs showing between them. The cards' normals are bent towards
// "outwards from the crown", so a crown lights as one soft mass with a sunny top and a shaded underside.
//
// Each tree is drawn at one of three levels of detail chosen per tree, every frame, from its distance to the
// camera: the full tree; a lighter one (trunk and main limbs, a third as many cards, each bigger); and a
// painted impostor that turns to face the camera. All the trees given to one buildTrees() call share three
// BatchedMeshes (bark, leaves, impostors): the whole treescape is three draw calls, plus two for the shadows.
import * as THREE from 'three';
import { rng, hash2 } from '../../core/world/noise.js';
import * as F from './foliage.js';

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;

/** Seconds, for the leaves' sway in the wind (shared by every leaf material). */
export const WIND = { value: 0 };

// ---- Crown envelopes ---------------------------------------------------------------------------------

/** An ellipsoid (or cone) crown with a lumpy surface; f(p) is 0 at its centre and 1 on its surface. */
class Crown {
  constructor(c, rx, ry, rz, r, lump = 0.25, { bottom = null, top = null, windward = 1, cone = null } = {}) {
    this.c = c;
    this.rx = rx;
    this.ry = ry;
    this.rz = rz;
    this.windward = windward; // > 1 squashes the crown on its −x (upwind) side
    this.cone = cone; // {base, top, r}: a cone instead of the ellipsoid
    this.bottom = bottom ?? c.y - ry;
    this.top = top ?? c.y + ry;
    this.bumps = [];
    for (let i = 0; i < 9; i++) {
      const z = r() * 2 - 1, a = r() * TAU, s = Math.sqrt(1 - z * z);
      this.bumps.push({ x: Math.cos(a) * s, y: z, z: Math.sin(a) * s, a: (r() - 0.45) * 2 * lump });
    }
  }
  f(p) {
    if (this.cone) {
      const { base, top, r } = this.cone;
      const k = (top - p.y) / (top - base);
      if (k <= 0) return 2;
      return Math.max(Math.hypot(p.x, p.z) / Math.max(0.15, r * Math.min(1, k)), p.y < base ? 1 + (base - p.y) : 0);
    }
    let dx = (p.x - this.c.x) / this.rx;
    const dy = (p.y - this.c.y) / this.ry, dz = (p.z - this.c.z) / this.rz;
    if (dx < 0) dx *= this.windward;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) return 0;
    let k = 1;
    for (const b of this.bumps) {
      const t = (dx * b.x + dy * b.y + dz * b.z) / l;
      if (t > 0) k += b.a * t * t * t * t;
    }
    return l / Math.max(0.3, k);
  }
  /** Outward normal of the envelope at (or near) p. */
  normal(p, out = new V3()) {
    if (this.cone) {
      const { base, top, r } = this.cone;
      const h = Math.hypot(p.x, p.z) || 1e-3;
      return out.set(p.x / h, r / (top - base), p.z / h).normalize();
    }
    let dx = (p.x - this.c.x) / (this.rx * this.rx);
    if (dx < 0) dx *= this.windward * this.windward;
    return out.set(dx, (p.y - this.c.y) / (this.ry * this.ry), (p.z - this.c.z) / (this.rz * this.rz)).normalize();
  }
  /** Distance from o along the unit vector dir to the envelope surface (at most max). */
  fit(o, dir, max) {
    const p = new V3();
    let t = 0;
    while (t < max) {
      p.copy(o).addScaledVector(dir, t + 0.2);
      if (this.f(p) > 1) break;
      t += 0.2;
    }
    return t;
  }
}

// ---- Skeleton builder --------------------------------------------------------------------------------

class Builder {
  constructor(seed) {
    this.r = rng(seed);
    this.branches = [];
    this.clusters = [];
    this.cards = [];
    this.anchors = [];
    this.grid = new Map();
  }
  rand(a, b) {
    return a + (b - a) * this.r();
  }
  int(a, b) {
    return a + Math.floor(this.r() * (b - a + 1));
  }
  unit() {
    const z = this.r() * 2 - 1, a = this.r() * TAU, s = Math.sqrt(1 - z * z);
    return new V3(Math.cos(a) * s, z, Math.sin(a) * s);
  }
  /** A branch: a polyline from o along dir that wanders (gnarl) and bends up or down (up per step). */
  grow(o, dir, len, r0, r1, depth, segs, { gnarl = 0.2, up = 0, taper = 1 } = {}) {
    const pts = [o.clone()], rad = [r0];
    const d = dir.clone().normalize(), p = o.clone(), step = len / segs;
    for (let i = 1; i <= segs; i++) {
      d.x += (this.r() - 0.5) * gnarl;
      d.y += (this.r() - 0.5) * gnarl * 0.6 + up;
      d.z += (this.r() - 0.5) * gnarl;
      d.normalize();
      p.addScaledVector(d, step);
      pts.push(p.clone());
      rad.push(r0 + (r1 - r0) * Math.pow(i / segs, taper));
    }
    const b = { pts, rad, depth, len };
    this.branches.push(b);
    return b;
  }
  /** Point, direction and radius a fraction t along a branch. */
  at(b, t) {
    const n = b.pts.length - 1;
    const f = Math.min(n - 1e-6, Math.max(0, t * n)), i = Math.floor(f), k = f - i;
    return {
      p: b.pts[i].clone().lerp(b.pts[i + 1], k),
      d: b.pts[i + 1].clone().sub(b.pts[i]).normalize(),
      r: b.rad[i] + (b.rad[i + 1] - b.rad[i]) * k,
    };
  }
  /** The direction at angle `ang` from d, turned `az` round it. */
  deviate(d, ang, az) {
    const a = Math.abs(d.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
    const u = new V3().crossVectors(d, a).normalize(), v = new V3().crossVectors(d, u);
    return d.clone().multiplyScalar(Math.cos(ang)).addScaledVector(u, Math.sin(ang) * Math.cos(az)).addScaledVector(v, Math.sin(ang) * Math.sin(az)).normalize();
  }
  /** Points every `step` metres along the branches of at least minDepth, for twigs to grow from. */
  anchorsFrom(minDepth = 1, step = 0.5) {
    this.anchors = [];
    for (const b of this.branches) {
      if (b.depth < minDepth || b.depth > 2) continue;
      const n = Math.max(1, Math.round(b.len / step));
      for (let i = 1; i <= n; i++) this.anchors.push(this.at(b, i / n).p);
    }
  }
  nearestAnchor(p) {
    let best = null, bd = Infinity;
    for (const a of this.anchors) {
      const d = a.distanceToSquared(p);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best ?? new V3(0, p.y, 0);
  }
  /** True if no cluster lies within `spacing` of p (a hash grid keeps this quick). */
  free(p, spacing) {
    const k = (x, y, z) => `${x},${y},${z}`;
    const gx = Math.floor(p.x / spacing), gy = Math.floor(p.y / spacing), gz = Math.floor(p.z / spacing);
    const s2 = spacing * spacing;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let l = -1; l <= 1; l++) {
      const list = this.grid.get(k(gx + i, gy + j, gz + l));
      if (list) for (const q of list) if (q.distanceToSquared(p) < s2) return false;
    }
    return true;
  }
  addToGrid(p, spacing) {
    const key = `${Math.floor(p.x / spacing)},${Math.floor(p.y / spacing)},${Math.floor(p.z / spacing)}`;
    (this.grid.get(key) ?? this.grid.set(key, []).get(key)).push(p);
  }
  /**
   * Fills a foliage mass (a Crown) with up to `count` leaf clusters lying in its outer shell (shell = range
   * of the mass's normalised radius), at least `spacing` apart from every cluster so far. cl: the clusters'
   * {n (cards), radius: [min, max], size (card half-size), cells, flat, hang, lift, outBias}.
   */
  fill(mass, count, spacing, cl, shell = [0.45, 1], minY = -Infinity) {
    let placed = 0;
    for (let tries = count * 40; tries > 0 && placed < count; tries--) {
      const p = new V3(this.rand(-1, 1) * mass.rx, this.rand(-1, 1) * mass.ry, this.rand(-1, 1) * mass.rz).add(mass.c);
      if (p.y < minY) continue;
      const f = mass.f(p);
      if (f > shell[1] || f < shell[0]) continue;
      if (!this.free(p, spacing)) continue;
      this.addToGrid(p, spacing);
      this.clusters.push({ ...cl, c: p, base: this.nearestAnchor(p), mass, radius: this.rand(cl.radius[0], cl.radius[1]) });
      placed++;
    }
    return placed;
  }
  /** Turns the clusters into cards (and twigs), and returns the finished tree. */
  finish(crown, H, bark, extra = {}) {
    for (const cl of this.clusters) {
      // A twig (or, if the clump is far from any branch, a thin branch) from the skeleton into the clump.
      const len = cl.base.distanceTo(cl.c);
      if (len > 0.3 && !cl.noTwig) {
        const dir = cl.c.clone().sub(cl.base);
        if (len > 1.3) this.grow(cl.base, dir, len, 0.035, 0.012, 2, 3, { gnarl: 0.25 });
        else this.grow(cl.base, dir, len, 0.02, 0.008, 3, 2, { gnarl: 0.3 });
      }
      const tw = cl.c.clone().sub(cl.base).normalize();
      for (let k = 0; k < cl.n; k++) {
        const d = this.unit();
        if (cl.flat) d.y *= 0.3;
        d.addScaledVector(tw, cl.outBias ?? 0.5);
        d.y += cl.lift ?? 0.12;
        d.normalize();
        const centre = cl.c.clone().addScaledVector(d, cl.radius * this.rand(0.1, 0.65));
        let n;
        if (cl.flat) n = this.deviate(new V3(0, 1, 0), this.rand(0.3, 1.0), this.rand(0, TAU));
        else n = this.deviate(d, this.rand(0.1, 0.85), this.rand(0, TAU));
        // The card's up axis runs out along its twig (or hangs down), in the card's plane.
        const v = cl.hang ? new V3(this.rand(-0.35, 0.35), -1, this.rand(-0.35, 0.35)) : centre.clone().sub(cl.base);
        v.addScaledVector(n, -v.dot(n));
        if (v.lengthSq() < 1e-6) v.copy(this.deviate(n, Math.PI / 2, this.rand(0, TAU)));
        v.normalize();
        const u = new V3().crossVectors(v, n).normalize();
        const s = cl.size * this.rand(0.8, 1.2);
        centre.addScaledVector(v, s * 0.3);
        const cell = cl.cells[Math.floor(this.r() * cl.cells.length)];
        this.cards.push({ c: centre, u: u.multiplyScalar(s), v: v.multiplyScalar(s), n, cluster: cl, cell });
      }
    }
    return { branches: this.branches, cards: this.cards, crown, H, bark, ...extra };
  }
}

/** Polar direction: azimuth az, elevation el above the horizontal. */
const polar = (az, el) => new V3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));

/**
 * The common broadleaf plan: a trunk, limbs out to the crown envelope, side branches, then foliage either
 * filling the crown's outer shell (dense crowns: sycamore, lime) or gathered in masses round the ends of the
 * limbs and branches (clumped or open crowns: oak, ash).
 */
function broadleaf(seed, P) {
  const B = new Builder(seed);
  const H = P.H * B.rand(0.92, 1.08);
  const C = P.crown;
  const crown = new Crown(new V3(B.rand(-C.off, C.off), H * C.cy, B.rand(-C.off, C.off)), H * C.rx, H * C.ry, H * C.rz, B.r, C.lump, { bottom: H * C.bottom, top: H });
  const T = P.trunk;
  const trunk = B.grow(new V3(0, -0.5, 0), new V3(B.rand(-T.lean, T.lean), 1, B.rand(-T.lean, T.lean)), H * T.len + 0.5, T.r, T.r1, 0, T.segs, { gnarl: T.gnarl });
  const Lp = P.limbs, Bp = P.branches;
  const nL = B.int(Lp.n[0], Lp.n[1]);
  const az0 = B.rand(0, TAU);
  const ends = [];
  for (let i = 0; i < nL; i++) {
    const a = B.at(trunk, Lp.t[0] + (Lp.t[1] - Lp.t[0]) * ((i + B.r() * 0.8) / nL));
    const dir = polar(az0 + i * 2.39996 + B.rand(-0.3, 0.3), B.rand(Lp.elev[0], Lp.elev[1]) + (i === 0 ? (Lp.lead ?? 0) : 0));
    const L = Math.max(Lp.min ?? 1.5, crown.fit(a.p, dir, H) * B.rand(Lp.fit[0], Lp.fit[1]));
    const limb = B.grow(a.p, dir, L, Math.max(0.04, a.r * Lp.r), 0.03, 1, Lp.segs, { gnarl: Lp.gnarl, up: Lp.up ?? 0 });
    const e = B.at(limb, 1);
    ends.push({ p: e.p, d: e.d, size: L });
    const nB = B.int(Bp.n[0], Bp.n[1]);
    for (let k = 0; k < nB; k++) {
      const b = B.at(limb, Bp.t[0] + (Bp.t[1] - Bp.t[0]) * ((k + B.r() * 0.7) / nB));
      const d2 = B.deviate(b.d, B.rand(Bp.ang[0], Bp.ang[1]), B.rand(0, TAU));
      d2.y = d2.y * (Bp.flatten ?? 1) + (Bp.lift ?? 0);
      d2.normalize();
      const L2 = Math.min(crown.fit(b.p, d2, H * 0.6), limb.len * Bp.maxFrac) * B.rand(Bp.fit[0], Bp.fit[1]);
      if (L2 < (Bp.min ?? 0.5)) continue;
      const br = B.grow(b.p, d2, L2, Math.max(0.025, b.r * 0.55), 0.015, 2, Bp.segs ?? 3, { gnarl: Bp.gnarl, up: Bp.up ?? 0 });
      const e2 = B.at(br, 1);
      ends.push({ p: e2.p, d: e2.d, size: L2 });
    }
  }
  B.anchorsFrom(1, 0.5);
  const M = P.masses, cl = P.cluster;
  if (M.mode === 'crown') B.fill(crown, M.count, M.spacing, cl, M.shell);
  else {
    ends.sort((a, b) => b.size - a.size);
    for (const e of ends) {
      const r = B.rand(M.r[0], M.r[1]) * Math.min(1.15, 0.65 + e.size / 7);
      const c = e.p.clone().addScaledVector(e.d, r * 0.3);
      c.y += r * (M.lift ?? 0.2);
      B.fill(new Crown(c, r, r * M.ry, r, B.r, 0.3), M.count, M.spacing, cl, M.shell);
    }
  }
  return B.finish(crown, H, P.bark);
}

const BROADLEAF = {
  // English oak: a short, stout bole splitting into crooked limbs that spread wide; foliage in distinct clumps.
  oak: {
    H: 13, bark: 'oak',
    crown: { cy: 0.57, rx: 0.6, ry: 0.4, rz: 0.56, lump: 0.4, bottom: 0.22, off: 0.5 },
    trunk: { r: 0.44, r1: 0.3, len: 0.3, lean: 0.06, gnarl: 0.14, segs: 5 },
    limbs: { n: [5, 7], t: [0.55, 1], elev: [0.32, 0.95], lead: 0.5, fit: [0.75, 0.92], r: 0.66, segs: 7, gnarl: 0.55, up: -0.004, min: 2.5 },
    branches: { n: [4, 6], t: [0.3, 0.98], ang: [0.5, 1.1], flatten: 0.6, lift: 0.3, maxFrac: 0.5, fit: [0.6, 0.95], gnarl: 0.6, min: 0.8 },
    masses: { mode: 'ends', r: [1.9, 2.6], ry: 0.85, lift: 0.3, count: 8, spacing: 1.08, shell: [0.45, 1] },
    cluster: { n: 3, radius: [0.8, 1.1], size: 0.85, cells: ['oak', 'oak2'] },
  },
  // Sycamore: ascending limbs under a dense, rounded dome.
  sycamore: {
    H: 13, bark: 'sycamore',
    crown: { cy: 0.57, rx: 0.5, ry: 0.43, rz: 0.48, lump: 0.22, bottom: 0.17, off: 0.3 },
    trunk: { r: 0.42, r1: 0.22, len: 0.45, lean: 0.05, gnarl: 0.08, segs: 5 },
    limbs: { n: [5, 7], t: [0.45, 1], elev: [0.55, 1.15], fit: [0.8, 0.92], r: 0.62, segs: 6, gnarl: 0.3, up: 0.006, min: 2.5 },
    branches: { n: [5, 8], t: [0.25, 0.98], ang: [0.45, 0.95], lift: 0.15, maxFrac: 0.55, fit: [0.6, 0.9], gnarl: 0.35, min: 0.6 },
    masses: { mode: 'crown', count: 175, spacing: 1.08, shell: [0.62, 1] },
    cluster: { n: 3, radius: [0.9, 1.2], size: 0.86, cells: ['sycamore', 'sycamore2'] },
  },
  // Ash: a tall leader with upswept limbs; an open, airy crown of tufts at the branch ends.
  ash: {
    H: 15, bark: 'ash',
    crown: { cy: 0.6, rx: 0.4, ry: 0.4, rz: 0.38, lump: 0.45, bottom: 0.24, off: 0.4 },
    trunk: { r: 0.36, r1: 0.12, len: 0.62, lean: 0.08, gnarl: 0.1, segs: 6 },
    limbs: { n: [7, 10], t: [0.32, 0.95], elev: [0.55, 1.15], fit: [0.8, 0.95], r: 0.6, segs: 6, gnarl: 0.25, up: 0.035, min: 2 },
    branches: { n: [4, 6], t: [0.35, 1], ang: [0.4, 0.85], lift: 0.35, maxFrac: 0.45, fit: [0.6, 0.9], gnarl: 0.3, up: 0.04, min: 0.6 },
    masses: { mode: 'ends', r: [1.6, 2.2], ry: 0.9, lift: 0.15, count: 8, spacing: 1.05, shell: [0.4, 1] },
    cluster: { n: 3, radius: [0.8, 1.0], size: 0.92, cells: ['ash'] },
  },
  // Lime: a clean, straight trunk carrying a tall, dense oval crown (York's streets and parks).
  lime: {
    H: 14, bark: 'lime',
    crown: { cy: 0.6, rx: 0.33, ry: 0.42, rz: 0.31, lump: 0.2, bottom: 0.2, off: 0 },
    trunk: { r: 0.4, r1: 0.1, len: 0.8, lean: 0.03, gnarl: 0.05, segs: 6 },
    limbs: { n: [9, 12], t: [0.3, 0.95], elev: [0.65, 1.15], fit: [0.82, 0.94], r: 0.5, segs: 5, gnarl: 0.25, min: 1.5 },
    branches: { n: [3, 5], t: [0.3, 0.98], ang: [0.4, 0.9], maxFrac: 0.5, fit: [0.6, 0.9], gnarl: 0.3, min: 0.5 },
    masses: { mode: 'crown', count: 150, spacing: 1.02, shell: [0.62, 1] },
    cluster: { n: 3, radius: [0.85, 1.1], size: 0.8, cells: ['lime', 'lime2'] },
  },
};

const SPECIES = {
  oak: (seed) => broadleaf(seed, BROADLEAF.oak),
  sycamore: (seed) => broadleaf(seed, BROADLEAF.sycamore),
  ash: (seed) => broadleaf(seed, BROADLEAF.ash),
  lime: (seed) => broadleaf(seed, BROADLEAF.lime),

  // Hawthorn: one to three twisted stems; `wind` bends it along +x (turned downwind when placed) into the
  // dense, streamlined wedge of the lone thorns on open Dales hillsides.
  hawthorn(seed, { wind = true } = {}) {
    const B = new Builder(seed);
    const H = 5.5 * B.rand(0.9, 1.1);
    const lean = wind ? B.rand(0.5, 0.8) : B.rand(0, 0.15);
    const crown = new Crown(new V3(wind ? H * 0.36 : 0, H * (wind ? 0.55 : 0.6), 0), H * (wind ? 0.66 : 0.52), H * (wind ? 0.3 : 0.38), H * 0.48, B.r, 0.3, { bottom: H * 0.28, top: H, windward: wind ? 1.9 : 1 });
    const stems = B.int(1, 3);
    for (let s = 0; s < stems; s++) {
      const o = new V3(B.rand(-0.2, 0.2), -0.4, B.rand(-0.2, 0.2));
      const stem = B.grow(o, new V3(lean + B.rand(-0.15, 0.15), 1, B.rand(-0.3, 0.3)), H * B.rand(0.5, 0.65), s === 0 ? 0.17 : 0.11, 0.06, 0, 4, { gnarl: 0.35 });
      for (let i = 0, n = B.int(3, 4); i < n; i++) {
        const a = B.at(stem, B.rand(0.45, 1));
        const dir = polar(wind && B.r() < 0.75 ? B.rand(-1.3, 1.3) : B.rand(0, TAU), B.rand(0.05, 0.6));
        const L = Math.max(0.8, crown.fit(a.p, dir, 6) * B.rand(0.8, 0.95));
        const limb = B.grow(a.p, dir, L, Math.max(0.035, a.r * 0.6), 0.02, 1, 4, { gnarl: 0.6 });
        for (let k = 0, m = B.int(3, 5); k < m; k++) {
          const b = B.at(limb, 0.35 + 0.65 * ((k + B.r() * 0.5) / m));
          const d2 = B.deviate(b.d, B.rand(0.5, 1.1), B.rand(0, TAU));
          const L2 = Math.min(crown.fit(b.p, d2, 3), 1.3) * B.rand(0.6, 0.95);
          if (L2 > 0.3) B.grow(b.p, d2, L2, 0.02, 0.01, 2, 2, { gnarl: 0.7 });
        }
      }
    }
    B.anchorsFrom(1, 0.35);
    B.fill(crown, 120, 0.55, { n: 3, radius: [0.45, 0.6], size: 0.48, cells: ['hawthorn', 'hawthorn2'] }, [0.5, 1]);
    return B.finish(crown, H, 'hawthorn', { windswept: wind });
  },

  // Silver birch: a slender white trunk to the top, thin branches arching out, foliage hanging from them.
  birch(seed) {
    const B = new Builder(seed);
    const H = 12 * B.rand(0.9, 1.1);
    const crown = new Crown(new V3(0, H * 0.6, 0), H * 0.27, H * 0.4, H * 0.26, B.r, 0.3, { bottom: H * 0.22, top: H });
    const trunk = B.grow(new V3(0, -0.4, 0), new V3(B.rand(-0.06, 0.06), 1, B.rand(-0.06, 0.06)), H * 0.94, 0.2, 0.03, 0, 7, { gnarl: 0.07 });
    const n = B.int(16, 22);
    const az0 = B.rand(0, TAU);
    const branches = [];
    for (let i = 0; i < n; i++) {
      const a = B.at(trunk, 0.26 + (0.66 * (i + B.r() * 0.6)) / n);
      const dir = polar(az0 + i * 2.39996, B.rand(0.5, 0.95));
      const L = Math.max(1.0, crown.fit(a.p, dir, 6) * B.rand(0.85, 1.0));
      branches.push(B.grow(a.p, dir, L, Math.max(0.03, a.r * 0.35), 0.01, 1, 5, { gnarl: 0.2, up: -0.06 }));
    }
    B.anchorsFrom(1, 0.4);
    for (const br of branches) {
      for (const t of [0.4, 0.6, 0.8, 1]) {
        const q = B.at(br, t);
        const r = B.rand(0.8, 1.1);
        B.fill(new Crown(q.p.clone().add(new V3(0, -r * 0.6, 0)), r, r * 1.5, r, B.r, 0.2), 3, 0.72, { n: 3, radius: [0.5, 0.65], size: 0.54, cells: ['birch'], hang: true, lift: -0.3, outBias: 0.2 }, [0, 1]);
      }
    }
    return B.finish(crown, H, 'birch');
  },

  // Scots pine: a tall bare trunk (orange-red higher up) under a flat-topped crown of heavy, sinuous branches
  // ending in pads of needles.
  pine(seed) {
    const B = new Builder(seed);
    const H = 16 * B.rand(0.9, 1.1);
    const base = H * B.rand(0.55, 0.66);
    const crown = new Crown(new V3(B.rand(-0.6, 0.6), H * 0.83, B.rand(-0.6, 0.6)), H * 0.28, H * 0.16, H * 0.26, B.r, 0.4, { bottom: base, top: H });
    const trunk = B.grow(new V3(0, -0.5, 0), new V3(B.rand(-0.06, 0.06), 1, B.rand(-0.06, 0.06)), H * 0.93, 0.34, 0.05, 0, 8, { gnarl: 0.05 });
    for (let i = 0, n = B.int(5, 9); i < n; i++) {
      const a = B.at(trunk, B.rand(0.18, (base / H) * 0.95));
      B.grow(a.p, polar(B.rand(0, TAU), B.rand(-0.4, 0.1)), B.rand(0.25, 0.7), 0.035, 0.012, 2, 1, { gnarl: 0 });
    }
    const n = B.int(11, 14);
    const az0 = B.rand(0, TAU);
    const pads = [];
    for (let i = 0; i < n; i++) {
      const t = base / H + ((0.97 - base / H) * (i + B.r() * 0.5)) / n;
      const a = B.at(trunk, t);
      const k = (t - base / H) / (1 - base / H);
      const dir = polar(az0 + i * 2.39996, -0.15 + k * 0.6 + B.rand(-0.1, 0.1));
      const L = Math.max(1.0, crown.fit(a.p, dir, 8) * B.rand(0.85, 1.0));
      const br = B.grow(a.p, dir, L, 0.1 - k * 0.05, 0.03, 1, 5, { gnarl: 0.4, up: 0.025 });
      pads.push(B.at(br, 1).p);
      for (let s = 0, m = B.int(1, 3); s < m; s++) {
        const b = B.at(br, B.rand(0.45, 0.85));
        const d2 = B.deviate(b.d, B.rand(0.6, 1.1), B.rand(0, TAU));
        d2.y = d2.y * 0.3 + 0.1;
        d2.normalize();
        const sb = B.grow(b.p, d2, B.rand(0.8, 1.5), 0.04, 0.02, 2, 2, { gnarl: 0.4, up: 0.05 });
        pads.push(B.at(sb, 1).p);
      }
    }
    B.anchorsFrom(1, 0.4);
    for (const p of pads) {
      const r = B.rand(1.8, 2.5);
      B.fill(new Crown(p.clone().add(new V3(0, 0.3, 0)), r, r * 0.4, r, B.r, 0.3), 9, 0.72, { n: 4, radius: [0.8, 1.0], size: 0.74, cells: ['pine'], flat: true, noTwig: true }, [0, 1]);
    }
    return B.finish(crown, H, 'pine', { pineBark: base });
  },

  // Spruce: a straight stem to a spire, whorls of drooping branches that shorten to the top, dense sprays.
  spruce(seed) {
    const B = new Builder(seed);
    const H = 16 * B.rand(0.9, 1.1);
    const base = H * B.rand(0.08, 0.2);
    const R = H * 0.21;
    const crown = new Crown(new V3(0, base + (H - base) * 0.35, 0), R, (H - base) * 0.55, R, B.r, 0, { bottom: base, top: H, cone: { base, top: H, r: R } });
    const trunk = B.grow(new V3(0, -0.5, 0), new V3(B.rand(-0.02, 0.02), 1, B.rand(-0.02, 0.02)), H + 0.4, 0.31, 0.02, 0, 10, { gnarl: 0.02 });
    for (let y = base; y < H - 0.35; y += B.rand(0.42, 0.55)) {
      const frac = (y - base) / (H - base);
      const a = B.at(trunk, (y + 0.5) / (H + 0.4));
      const n = frac > 0.85 ? 3 : B.int(4, 6);
      const az0 = B.rand(0, TAU);
      for (let i = 0; i < n; i++) {
        const len = (1 - frac) * R * B.rand(0.88, 1.12) + 0.3;
        const dir = polar(az0 + (i / n) * TAU + B.rand(-0.3, 0.3), -0.4 + 0.55 * frac);
        const br = B.grow(a.p, dir, len, 0.012 + 0.035 * (1 - frac), 0.006, 1, 3, { gnarl: 0.1, up: 0.07 });
        const sprays = Math.max(1, Math.round(len / 0.45));
        for (let s = 0; s < sprays; s++) {
          const q = B.at(br, 0.2 + (0.8 * (s + 1)) / sprays);
          const size = 0.5 + 0.28 * Math.min(1, len / 3);
          // Sprays droop off the branch, tilted well away from flat so they cover the tree seen from the side.
          for (let c = 0; c < 2; c++) {
            const nrm = B.deviate(new V3(0, 1, 0), B.rand(0.5, 1.2), B.rand(0, TAU));
            const v = q.d.clone().addScaledVector(nrm, -q.d.dot(nrm)).normalize();
            const u = new V3().crossVectors(v, nrm).normalize();
            const centre = q.p.clone().addScaledVector(v, size * 0.3).add(new V3(0, -0.15 * c, 0));
            B.cards.push({ c: centre, u: u.multiplyScalar(size), v: v.multiplyScalar(size), n: nrm, cluster: { c: q.p }, cell: 'spruce' });
          }
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      const nrm = new V3(Math.cos((i / 3) * TAU), 0, Math.sin((i / 3) * TAU));
      const v = new V3(0, 1, 0), u = new V3().crossVectors(v, nrm);
      B.cards.push({ c: new V3(0, H - 0.2, 0), u: u.multiplyScalar(0.35), v: v.multiplyScalar(0.5), n: nrm, cluster: { c: new V3(0, H - 0.5, 0) }, cell: 'spruce' });
    }
    return B.finish(crown, H, 'spruce');
  },
};

// ---- Geometry ----------------------------------------------------------------------------------------

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Bark tubes round the branches up to maxDepth, with `sides[depth]` sides; every `stride`-th ring. */
function barkGeometry(tree, column, { maxDepth, sides, stride = 1 }) {
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const { u0, u1 } = column;
  const T = new V3(), N = new V3(), Bn = new V3(), tmp = new V3();
  for (const b of tree.branches) {
    if (b.depth > maxDepth) continue;
    const S = sides[b.depth];
    const pts = [], rad = [];
    for (let i = 0; i < b.pts.length; i += stride) {
      pts.push(b.pts[i]);
      rad.push(b.rad[i]);
    }
    if ((b.pts.length - 1) % stride) {
      pts.push(b.pts[b.pts.length - 1]);
      rad.push(b.rad[b.rad.length - 1]);
    }
    // Extra rings where the trunk meets the ground, so the root flare curves in smoothly.
    if (b.depth === 0 && pts.length > 1) {
      const extra = stride === 1 ? [0.12, 0.26, 0.42, 0.62] : [0.3];
      const p0 = pts[0], p1 = pts[1], r0 = rad[0], r1 = rad[1];
      pts.splice(1, 0, ...extra.map((t) => p0.clone().lerp(p1, t)));
      rad.splice(1, 0, ...extra.map((t) => r0 + (r1 - r0) * t));
    }
    let started = false, v = 0;
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      if (i < pts.length - 1) T.subVectors(pts[i + 1], pts[i]).normalize();
      if (i > 0 && i < pts.length - 1) T.add(tmp.subVectors(pts[i], pts[i - 1]).normalize()).normalize();
      if (!started) {
        N.crossVectors(T, Math.abs(T.y) < 0.9 ? tmp.set(0, 1, 0) : tmp.set(1, 0, 0)).normalize();
        started = true;
      } else N.addScaledVector(T, -N.dot(T)).normalize();
      Bn.crossVectors(T, N);
      if (i > 0) v += pts[i].distanceTo(pts[i - 1]) / (TAU * Math.max(0.025, (rad[i] + rad[i - 1]) / 2) * 4);
      const y = pts[i].y;
      // Root flare and buttresses where the trunk meets the ground.
      const flare = b.depth === 0 ? 1 + 0.6 * Math.pow(1 - smooth(-0.5, 1.0, y), 2) : 1;
      // Bark darkens towards the ground (damp, moss), and the canopy hides most of the sky from the limbs
      // inside it and from the trunk beneath it.
      const crown = tree.crown;
      const canopy = y < crown.bottom ? 0.68 : 0.42 + 0.55 * Math.pow(Math.min(1, crown.f(pts[i])), 1.5);
      let ao = (0.72 + 0.28 * smooth(-0.3, 2.0, y)) * canopy;
      let cr = ao, cg = ao, cb = ao;
      if (tree.pineBark !== undefined) {
        // Scots pine: grey-brown plates low down turning to orange-red higher up the trunk.
        const k = smooth(tree.pineBark * 0.5, tree.pineBark * 0.9, y);
        cr *= 0.55 + 0.5 * k;
        cg *= 0.62 + 0.4 * k;
        cb *= 0.74 + 0.28 * k;
      }
      for (let j = 0; j <= S; j++) {
        const a = (j / S) * TAU;
        const lobes = b.depth === 0 && flare > 1.01 ? 1 + 0.5 * Math.pow(0.5 + 0.5 * Math.cos(a * 4 + 1.3), 2) * (flare - 1) : 1;
        const r = rad[i] * flare * lobes;
        const dx = N.x * Math.cos(a) + Bn.x * Math.sin(a), dy = N.y * Math.cos(a) + Bn.y * Math.sin(a), dz = N.z * Math.cos(a) + Bn.z * Math.sin(a);
        pos.push(pts[i].x + dx * r, pts[i].y + dy * r, pts[i].z + dz * r);
        nor.push(dx, dy, dz);
        uv.push(u0 + (u1 - u0) * (j / S), v);
        col.push(cr, cg, cb);
      }
      if (i > 0) {
        const r0 = base + (i - 1) * (S + 1), r1 = base + i * (S + 1);
        for (let j = 0; j < S; j++) idx.push(r0 + j, r1 + j, r0 + j + 1, r0 + j + 1, r1 + j, r1 + j + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Ambient occlusion of a point in the crown: dark deep inside and underneath, full light at the top edge. */
function crownAO(crown, p) {
  const f = Math.min(1, crown.f(p));
  const h = Math.min(1, Math.max(0, (p.y - crown.bottom) / Math.max(0.5, crown.top - crown.bottom)));
  return (0.36 + 0.64 * Math.pow(f, 1.4)) * (0.72 + 0.28 * h);
}

/** Leaf cards as quads, with normals bent outwards from the crown and AO in the vertex colours. */
function cardGeometry(tree, cards, atlas) {
  // Outermost cards first: seen from outside a crown they are mostly in front, so the inner layers drawn after
  // them fail the depth test before their (expensive) shading.
  cards = cards.slice().sort((a, b) => tree.crown.f(b.c) - tree.crown.f(a.c));
  const n = cards.length;
  const pos = new Float32Array(n * 12), nor = new Float32Array(n * 12), uv = new Float32Array(n * 8), col = new Float32Array(n * 12);
  const idx = new Uint32Array(n * 6);
  const crown = tree.crown;
  const p = new V3(), cn = new V3(), mn = new V3(), ln = new V3(), out = new V3(), nn = new V3();
  cards.forEach((cd, k) => {
    const r = atlas.rect(cd.cell);
    const mass = cd.cluster.mass && cd.cluster.mass !== crown ? cd.cluster.mass : null;
    // The card's own normal, turned to face out of the crown.
    out.copy(cd.n);
    if (out.dot(crown.normal(cd.c, cn)) < 0) out.negate();
    const corners = [[-1, -1, r.u0, r.v0], [1, -1, r.u1, r.v0], [1, 1, r.u1, r.v1], [-1, 1, r.u0, r.v1]];
    corners.forEach(([su, sv, tu, tv], j) => {
      p.copy(cd.c).addScaledVector(cd.u, su).addScaledVector(cd.v, sv);
      const o = (k * 4 + j) * 3;
      pos[o] = p.x;
      pos[o + 1] = p.y;
      pos[o + 2] = p.z;
      // Lit as one soft mass: mostly the crown's (or the clump's) outward normal, some of the leaf cluster's
      // own roundness, a little of the card's real facing.
      crown.normal(p, cn);
      if (mass) cn.multiplyScalar(0.55).addScaledVector(mass.normal(p, mn), 0.45).normalize();
      ln.subVectors(p, cd.cluster.c).normalize();
      nn.copy(cn).multiplyScalar(0.45).addScaledVector(ln, 0.25).addScaledVector(out, 0.3).normalize();
      nor[o] = nn.x;
      nor[o + 1] = nn.y;
      nor[o + 2] = nn.z;
      uv[(k * 4 + j) * 2] = tu;
      uv[(k * 4 + j) * 2 + 1] = tv;
      // AO, a little darker under each clump, and sunlit tops a touch warmer.
      const ao = crownAO(crown, p) * (0.84 + 0.16 * (0.5 + 0.5 * ln.y));
      const h = Math.min(1, Math.max(0, (p.y - crown.bottom) / Math.max(0.5, crown.top - crown.bottom)));
      col[o] = ao * (0.97 + 0.06 * h);
      col[o + 1] = ao;
      col[o + 2] = ao * (0.98 - 0.06 * h);
    });
    const b = k * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], k * 6);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * The middle level of detail's cards: every third card, enlarged a little. Their total area is about half the
 * full set's, so a crown at middle distance is drawn with half the overdraw (foliage cost is all fill: fewer
 * vertices alone would save nothing).
 */
function lighterCards(cards, keep = 3) {
  const out = [];
  for (let i = 0; i < cards.length; i += keep) {
    const c = cards[i];
    const k = 1.28;
    out.push({ ...c, u: c.u.clone().multiplyScalar(k), v: c.v.clone().multiplyScalar(k), c: c.c.clone().addScaledVector(c.v.clone().normalize(), c.v.length() * (k - 1) * 0.3) });
  }
  return out;
}

/** The impostor's quad: w × h metres with its bottom at y0, UVs on its atlas cell. */
function impostorGeometry(cell) {
  const g = new THREE.BufferGeometry();
  const x = cell.w / 2, y0 = cell.y0, y1 = cell.y0 + cell.h;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-x, y0, 0, x, y0, 0, x, y1, 0, -x, y1, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([cell.u0, cell.v0, cell.u1, cell.v0, cell.u1, cell.v1, cell.u0, cell.v1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  // Bounds of the whole tree, whichever way the quad turns.
  g.boundingSphere = new THREE.Sphere(new V3(0, y0 + cell.h / 2, 0), Math.hypot(x, cell.h / 2));
  return g;
}

/** What the impostor painter needs from a tree: its cards and limbs in metres, viewed from +z. */
function impostorItem(tree) {
  const crown = tree.crown;
  const p = new V3();
  let halfW = 0, yMax = 0;
  const cards = tree.cards.map((cd) => {
    const tl = cd.c.clone().sub(cd.u).add(cd.v), tr = cd.c.clone().add(cd.u).add(cd.v), bl = cd.c.clone().sub(cd.u).sub(cd.v), br = cd.c.clone().add(cd.u).sub(cd.v);
    for (const q of [tl, tr, bl, br]) {
      halfW = Math.max(halfW, Math.abs(q.x));
      yMax = Math.max(yMax, q.y);
    }
    p.copy(cd.c);
    return { tl: [tl.x, tl.y], tr: [tr.x, tr.y], bl: [bl.x, bl.y], z: cd.c.z, shade: crownAO(crown, p) * 1.18, cell: cd.cell };
  });
  const branches = tree.branches.filter((b) => b.depth <= 2).map((b) => {
    for (const q of b.pts) {
      halfW = Math.max(halfW, Math.abs(q.x));
      yMax = Math.max(yMax, q.y);
    }
    return { pts: b.pts.map((q) => [q.x, q.y, q.z]), rad: b.rad, shade: b.depth === 0 ? 0.85 : 0.7 };
  });
  return { cards, branches, bark: F.BARK_MEAN[tree.bark], crown: { cx: crown.c.x, cy: crown.c.y, rx: crown.cone ? crown.cone.r * 0.8 : crown.rx, ry: crown.cone ? (crown.top - crown.bottom) * 0.5 : crown.ry }, halfW: halfW + 0.2, yMin: -0.35, yMax: yMax + 0.2 };
}

// ---- Template library --------------------------------------------------------------------------------

const VARIANTS = 3;
export const SPECIES_NAMES = Object.keys(SPECIES);

/** Every species × variant at every level of detail, with the shared textures (made once per session). */
let LIBRARY = null;
export function treeLibrary() {
  if (LIBRARY) return LIBRARY;
  const t0 = performance.now();
  const atlas = F.leafAtlas(1024);
  const bark = F.barkAtlas();
  const list = [];
  for (const sp of SPECIES_NAMES) {
    for (let v = 0; v < VARIANTS; v++) {
      const seed = 1000 + SPECIES_NAMES.indexOf(sp) * 97 + v * 31;
      const tree = sp === 'hawthorn' ? SPECIES.hawthorn(seed, { wind: v !== 2 }) : SPECIES[sp](seed);
      const column = bark.column(tree.bark);
      list.push({
        species: sp,
        variant: v,
        tree,
        H: tree.H,
        windswept: !!tree.windswept,
        bark: [barkGeometry(tree, column, { maxDepth: 3, sides: [10, 6, 4, 3] }), barkGeometry(tree, column, { maxDepth: 1, sides: [6, 4], stride: 2 })],
        leaves: [cardGeometry(tree, tree.cards, atlas), cardGeometry(tree, lighterCards(tree.cards), atlas)],
      });
    }
  }
  const imp = F.impostorAtlas(list.map((t) => impostorItem(t.tree)), atlas);
  list.forEach((t, i) => {
    t.impostor = impostorGeometry(imp.cells[i]);
  });
  const bySpecies = {};
  for (const t of list) (bySpecies[t.species] ??= []).push(t);
  LIBRARY = { list, bySpecies, atlas, bark, imp, ms: Math.round(performance.now() - t0) };
  return LIBRARY;
}

// ---- Materials ---------------------------------------------------------------------------------------

const windChunk = /* glsl */ `
  {
    #ifdef USE_BATCHING
      vec3 wOrigin = batchingMatrix[3].xyz;
    #else
      vec3 wOrigin = vec3(0.0);
    #endif
    float ph = dot(wOrigin.xz, vec2(0.21, 0.37));
    float hgt = max(0.0, transformed.y - 1.0);
    float sway = sin(uWindTime * 1.3 + ph) + 0.5 * sin(uWindTime * 2.1 + ph * 1.3);
    float flut = sin(uWindTime * 5.0 + dot(transformed, vec3(1.7, 2.3, 1.9)) + ph);
    transformed.x += sway * 0.005 * hgt + flut * 0.02;
    transformed.z += sway * 0.0035 * hgt - flut * 0.016;
    transformed.y += flut * 0.012;
  }
`;

// Foliage has only a faint sheen: with the crown-shaped normals, full Fresnel reflection of the bright sky
// would put a milky rim round every tree.
// (Both the direct and the environment terms: three uses specularColorBlended for one, specularColor for the other.)
export const dullSheen = /* glsl */ `
  material.specularColor *= 0.25;
  material.specularColorBlended *= 0.25;
  material.specularF90 = 0.12;
`;
// Alpha to coverage, but with the coverage ramp centred on the cut-off and never wider than a fraction of
// the alpha range: three's own ramp widens with fwidth(alpha), which on distant leaves (many leaves to a
// pixel) turns whole cards half see-through and lets the sky show through the crown.
export const crispCoverage = /* glsl */ `
#ifdef USE_ALPHATEST
  #ifdef ALPHA_TO_COVERAGE
    float coverageWidth = clamp( fwidth( diffuseColor.a ), 0.0001, 0.1 );
    diffuseColor.a = clamp( ( diffuseColor.a - alphaTest ) / coverageWidth + 0.5, 0.0, 1.0 );
    if ( diffuseColor.a == 0.0 ) discard;
  #else
    if ( diffuseColor.a < alphaTest ) discard;
  #endif
#endif
`;

// Foliage reflects no sky: skipping the environment-reflection lookup saves real per-fragment work on many
// overlapping leaf cards (the sheen was damped to almost nothing anyway); the sky's diffuse light stays.
export const noSkyReflection = THREE.ShaderChunk.lights_fragment_maps.replace(
  'vec3 iblRadiance = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );',
  'vec3 iblRadiance = vec3( 0.0 );',
);

// Leaves are thin and translucent: sunlight wraps a little round each clump (a softer edge between the
// sunny and shaded halves of a crown) and glows through the leaves when the sun is behind them.
// (Only the diffuse term changes: the specular keeps the true N·L, or it blows up at grazing light.)
const foliageLight = THREE.ShaderChunk.lights_physical_pars_fragment.replace(
  'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );',
  /* glsl */ `{
    float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + 0.4 ) / 1.4 );
    float through = 0.3 * pow( saturate( dot( - geometryViewDir, directLight.direction ) ), 4.0 );
    reflectedLight.directDiffuse += ( wrapNL + through ) * directLight.color * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
  }`,
);

function leafMaterials(lib, level) {
  const mat = new THREE.MeshStandardMaterial({ map: lib.atlas.texture, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true, roughness: 0.8, metalness: 0, alphaToCoverage: level !== 'low' });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWindTime = WIND;
    sh.vertexShader = `uniform float uWindTime;\n${sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${windChunk}`)}`;
    // Keep each card's crown-shaped normal on both its faces (the default flips it for the back face, which
    // would light half the cards as if they faced into the tree).
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <alphatest_fragment>', crispCoverage)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace('#include <lights_physical_pars_fragment>', foliageLight)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${dullSheen}`).replace('#include <lights_fragment_maps>', noSkyReflection);
  };
  mat.customProgramCacheKey = () => 'spindown-leaves';
  const depth = new THREE.MeshDepthMaterial({ map: lib.atlas.texture, alphaTest: 0.5, side: THREE.DoubleSide });
  depth.onBeforeCompile = (sh) => {
    sh.uniforms.uWindTime = WIND;
    sh.vertexShader = `uniform float uWindTime;\n${sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${windChunk}`)}`;
  };
  depth.customProgramCacheKey = () => 'spindown-leaves-depth';
  return { mat, depth };
}

function impostorMaterial(lib, level) {
  const mat = new THREE.MeshStandardMaterial({ map: lib.imp.map, normalMap: lib.imp.normalMap, alphaTest: 0.5, roughness: 0.85, metalness: 0, alphaToCoverage: level !== 'low' });
  mat.onBeforeCompile = (sh) => {
    // Turn each quad round its trunk to face the camera (scale taken from the instance matrix).
    sh.vertexShader = sh.vertexShader
      .replace('#include <beginnormal_vertex>', /* glsl */ `
        #ifdef USE_BATCHING
          vec3 bbO = batchingMatrix[3].xyz;
          float bbSx = length(batchingMatrix[0].xyz), bbSy = length(batchingMatrix[1].xyz);
        #else
          vec3 bbO = vec3(0.0);
          float bbSx = 1.0, bbSy = 1.0;
        #endif
        vec3 bbTo = cameraPosition - (modelMatrix * vec4(bbO, 1.0)).xyz;
        bbTo.y = 0.0;
        bbTo = dot(bbTo, bbTo) > 1e-6 ? normalize(bbTo) : vec3(0.0, 0.0, 1.0);
        vec3 bbRight = vec3(bbTo.z, 0.0, -bbTo.x);
        vec3 bbPos = bbO + bbRight * (position.x * bbSx) + vec3(0.0, position.y * bbSy, 0.0);
        #ifdef USE_BATCHING
          batchingMatrix = mat4(1.0);
        #endif
        vec3 objectNormal = bbTo;
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif
      `)
      .replace('#include <begin_vertex>', 'vec3 transformed = bbPos;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <alphatest_fragment>', crispCoverage)
      .replace('#include <lights_physical_pars_fragment>', foliageLight)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${dullSheen}`).replace('#include <lights_fragment_maps>', noSkyReflection);
  };
  mat.customProgramCacheKey = () => 'spindown-impostor';
  return mat;
}

/** Fresh materials for the bark, leaves (and their shadow depth) and impostors at a quality level. */
export function treeMaterials(level = 'medium') {
  const lib = treeLibrary();
  const bark = new THREE.MeshStandardMaterial({ map: lib.bark.map, normalMap: level === 'low' ? null : lib.bark.normalMap, vertexColors: true, roughness: 1, metalness: 0 });
  // Bark is matte: no sky sheen down the sides of the trunk.
  bark.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${dullSheen}`).replace('#include <lights_fragment_maps>', noSkyReflection);
  };
  bark.customProgramCacheKey = () => 'spindown-bark';
  const { mat: leaves, depth: leafDepth } = leafMaterials(lib, level);
  return { bark, leaves, leafDepth, impostor: impostorMaterial(lib, level) };
}

// ---- Species choice ----------------------------------------------------------------------------------

/**
 * Which species a placement becomes. p.species wins if given. Otherwise conifers are mostly spruce with some
 * Scots pine; broadleaves follow the setting: ash, sycamore and hawthorn on the limestone dales (in patches,
 * as woods are), oak and sycamore lower down; lime, birch and sycamore in town.
 */
function pickSpecies(p, setting) {
  if (p.species && SPECIES[p.species]) return p.species;
  const h = hash2(Math.round(p.x * 3.1), Math.round(p.z * 3.1), 91);
  const patch = hash2(Math.floor(p.x / 90), Math.floor(p.z / 90), 92);
  if (p.kind === 'conifer') return h < (patch < 0.3 ? 0.45 : 0.85) ? 'spruce' : 'pine';
  if (setting === 'town') {
    const t = (h + patch * 0.5) % 1;
    return t < 0.32 ? 'lime' : t < 0.5 ? 'sycamore' : t < 0.66 ? 'birch' : t < 0.8 ? 'oak' : t < 0.92 ? 'ash' : 'hawthorn';
  }
  const small = (p.s ?? 1) < 0.85;
  if (small && h < 0.55) return 'hawthorn';
  const main = patch < 0.34 ? 'ash' : patch < 0.62 ? 'sycamore' : patch < 0.82 ? 'oak' : 'hawthorn';
  if (h < 0.62) return main;
  return h < 0.74 ? 'ash' : h < 0.86 ? 'sycamore' : h < 0.93 ? 'hawthorn' : 'oak';
}

function qualityLevel(opts) {
  const q = opts.q;
  if (q) return !q.shadows ? 'low' : (q.shadowSize ?? 2048) > 2048 ? 'high' : 'medium';
  return opts.shadows === false ? 'low' : 'medium';
}

// Full detail within R0 and the lighter trees within R1 (metres, for a 13 m tree; bigger trees keep their
// detail further away), impostors beyond.
const LOD_RANGES = { low: [18, 60], medium: [22, 80], high: [32, 115] };
// The prevailing wind (from the west-south-west): windswept trees lean towards +x turned to this heading.
const DOWNWIND = 0.38;

/**
 * Instanced trees at placements [{x, y, z, s (scale), kind: 'broad'|'conifer', species?, hue, sx, sy, rot}].
 * opts: {shadows, maxDistance (m), q (quality preset), setting: 'dales'|'town' (guessed from the height)}.
 */
export function buildTrees(placements, opts = {}) {
  const group = new THREE.Group();
  group.name = 'trees';
  const n = placements.length;
  if (!n) return group;
  const level = qualityLevel(opts);
  const shadows = opts.shadows !== false && level !== 'low';
  const maxDistance = opts.maxDistance ?? 1800;
  const ys = placements.map((p) => p.y).sort((a, b) => a - b);
  const setting = opts.setting ?? (ys[Math.floor(ys.length / 2)] < 60 ? 'town' : 'dales');
  const lib = treeLibrary();

  const { bark: barkMat, leaves: leafMat, leafDepth, impostor: impMat } = treeMaterials(level);

  // Choose each tree's template first, to size the batches to what is used.
  const chosen = placements.map((p) => {
    const sp = pickSpecies(p, setting);
    const list = lib.bySpecies[sp];
    let t = list[Math.floor(hash2(Math.round(p.x * 5), Math.round(p.z * 5), 93) * list.length)];
    // Hawthorns are windswept on open, high ground and grow upright in sheltered valleys and town.
    if (sp === 'hawthorn') {
      const exposed = setting !== 'town' && p.y > 190;
      const want = exposed ? list.filter((x) => x.windswept) : list.filter((x) => !x.windswept);
      if (want.length) t = want[Math.floor(hash2(Math.round(p.x * 5), Math.round(p.z * 5), 94) * want.length)];
    }
    return t;
  });
  const used = [...new Set(chosen)];
  const count = (geo) => [geo.attributes.position.count, geo.index.count];
  const sum = (key, lv) => used.reduce((a, t) => [a[0] + count(t[key][lv])[0], a[1] + count(t[key][lv])[1]], [0, 0]);
  const b0 = sum('bark', 0), b1 = sum('bark', 1), l0 = sum('leaves', 0), l1 = sum('leaves', 1);
  const barkMesh = new THREE.BatchedMesh(n, b0[0] + b1[0], b0[1] + b1[1], barkMat);
  const leafMesh = new THREE.BatchedMesh(n, l0[0] + l1[0], l0[1] + l1[1], leafMat);
  const impMesh = new THREE.BatchedMesh(n, used.length * 4, used.length * 6, impMat);
  const ids = new Map();
  for (const t of used) {
    ids.set(t, {
      bark: [barkMesh.addGeometry(t.bark[0]), barkMesh.addGeometry(t.bark[1])],
      leaves: [leafMesh.addGeometry(t.leaves[0]), leafMesh.addGeometry(t.leaves[1])],
      imp: impMesh.addGeometry(t.impostor),
    });
  }
  const tx = new Float32Array(n), ty = new Float32Array(n), tz = new Float32Array(n), size = new Float32Array(n);
  const lvl = new Int8Array(n).fill(-1);
  const inst = new Int32Array(n * 3);
  const geo = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color(), pv = new V3(), sv = new V3();
  placements.forEach((p, i) => {
    const t = chosen[i], id = ids.get(t);
    const s = p.s ?? 1;
    const sx = s * Math.sqrt(p.sx ?? 1), sy = s * Math.sqrt(p.sy ?? 1);
    const rot = t.windswept ? DOWNWIND + (hash2(Math.round(p.x * 7), Math.round(p.z * 7), 95) - 0.5) * 0.5 : p.rot ?? 0;
    e.set(0, rot, 0);
    q.setFromEuler(e);
    m.compose(pv.set(p.x, p.y - 0.15 * s, p.z), q, sv.set(sx, sy, sx));
    // Leaf colour: a little variety in brightness and hue from tree to tree.
    const hue = p.hue ?? 0;
    c.setRGB(1 + hue * 0.12, 1 + hue * 0.06, 1 - hue * 0.1);
    c.multiplyScalar(0.94 + 0.12 * hash2(Math.round(p.x * 11), Math.round(p.z * 11), 96));
    const bi = barkMesh.addInstance(id.bark[1]);
    barkMesh.setMatrixAt(bi, m);
    barkMesh.setVisibleAt(bi, false);
    const li = leafMesh.addInstance(id.leaves[1]);
    leafMesh.setMatrixAt(li, m);
    leafMesh.setColorAt(li, c);
    leafMesh.setVisibleAt(li, false);
    const ii = impMesh.addInstance(id.imp);
    impMesh.setMatrixAt(ii, m);
    impMesh.setColorAt(ii, c);
    impMesh.setVisibleAt(ii, false);
    inst[i * 3] = bi;
    inst[i * 3 + 1] = li;
    inst[i * 3 + 2] = ii;
    geo.push(id);
    tx[i] = p.x;
    ty[i] = p.y + t.H * sy * 0.5;
    tz[i] = p.z;
    size[i] = Math.sqrt((t.H * Math.max(sx, sy)) / 13);
  });
  barkMesh.castShadow = leafMesh.castShadow = shadows;
  barkMesh.receiveShadow = leafMesh.receiveShadow = level !== 'low';
  leafMesh.customDepthMaterial = leafDepth;
  impMesh.castShadow = false;
  impMesh.receiveShadow = false;
  // Impostors are cheap: draw every one in range without per-tree culling or sorting.
  impMesh.perObjectFrustumCulled = false;
  impMesh.sortObjects = false;
  for (const mesh of [barkMesh, leafMesh, impMesh]) {
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    group.add(mesh);
  }

  // Level of detail per tree from its distance to the camera (with a little hysteresis).
  // The detail ranges live on userData so they can be tuned (or tested) at run time; relod() forces an update.
  const ranges = (group.userData.lodRanges = [...LOD_RANGES[level]]);
  const apply = (i, L) => {
    const id = geo[i];
    const bi = inst[i * 3], li = inst[i * 3 + 1], ii = inst[i * 3 + 2];
    if (L <= 1) {
      barkMesh.setGeometryIdAt(bi, id.bark[L]);
      leafMesh.setGeometryIdAt(li, id.leaves[L]);
    }
    barkMesh.setVisibleAt(bi, L <= 1);
    leafMesh.setVisibleAt(li, L <= 1);
    impMesh.setVisibleAt(ii, L === 2);
    lvl[i] = L;
  };
  let lastFrame = -1;
  const last = new V3(Infinity, 0, 0);
  group.userData.relod = () => last.set(Infinity, 0, 0);
  const update = (cam) => {
    if (cam.distanceToSquared(last) < 0.25) return;
    last.copy(cam);
    const cx = cam.x, cy = cam.y, cz = cam.z;
    const max2 = maxDistance * maxDistance;
    for (let i = 0; i < n; i++) {
      const dx = tx[i] - cx, dy = ty[i] - cy, dz = tz[i] - cz;
      const d2 = dx * dx + dz * dz + dy * dy * 0.5;
      const cur = lvl[i];
      let L;
      if (d2 > max2) L = 3;
      else {
        const d = Math.sqrt(d2) / size[i];
        L = d < ranges[0] * (cur === 0 ? 1.06 : 0.97) ? 0 : d < ranges[1] * (cur <= 1 ? 1.04 : 0.97) ? 1 : 2;
      }
      if (L !== cur) apply(i, L);
    }
  };
  const tick = (renderer, camera) => {
    const f = renderer.info.render.frame;
    if (f === lastFrame) return;
    lastFrame = f;
    WIND.value = performance.now() / 1000;
    update(camera.position);
  };
  for (const mesh of [barkMesh, leafMesh, impMesh]) {
    const before = mesh.onBeforeRender, shadow = mesh.onBeforeShadow;
    mesh.onBeforeRender = function (renderer, scene, camera, geometry, material, grp) {
      if (scene) tick(renderer, camera); // (scene is null when BatchedMesh draws its shadow pass)
      before.call(this, renderer, scene, camera, geometry, material, grp);
    };
    mesh.onBeforeShadow = function (renderer, object, camera, shadowCamera, geometry, depthMaterial, grp) {
      tick(renderer, camera);
      shadow.call(this, renderer, object, camera, shadowCamera, geometry, depthMaterial, grp);
    };
  }
  // Street trees (placements with `pit`) stand in square cast-iron grates set in the pavement.
  const pits = placements.filter((p) => p.pit);
  if (pits.length) group.add(treeGrates(pits));
  group.userData.treeCount = n;
  group.userData.setting = setting;
  group.userData.libraryMs = lib.ms;
  return group;
}

/** Cast-iron tree grates, 1.2 m square with a frame and slots, at placements [{x, y, z, rot}]. */
function treeGrates(list) {
  const parts = [];
  const box = (x0, z0, x1, z1, y1, k) => {
    const g = new THREE.BoxGeometry(x1 - x0, y1, z1 - z0).translate((x0 + x1) / 2, y1 / 2, (z0 + z1) / 2).toNonIndexed();
    const c = new Float32Array(g.attributes.position.count * 3).fill(k);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.deleteAttribute('uv');
    return g;
  };
  // A dark soil square under a frame and slotted bars.
  parts.push(box(-0.6, -0.6, 0.6, 0.6, 0.012, 0.06));
  for (const s of [-1, 1]) {
    parts.push(box(-0.62, s * 0.62 - 0.04, 0.62, s * 0.62 + 0.04, 0.035, 0.16));
    parts.push(box(s * 0.62 - 0.04, -0.62, s * 0.62 + 0.04, 0.62, 0.035, 0.16));
  }
  for (let i = -5; i <= 5; i++) {
    if (Math.abs(i) <= 1) continue; // the hole for the trunk
    parts.push(box(i * 0.1 - 0.018, -0.58, i * 0.1 + 0.018, 0.58, 0.03, 0.13));
  }
  for (const s of [-1, 1]) parts.push(box(-0.15, s * 0.14 - 0.018, 0.15, s * 0.14 + 0.018, 0.03, 0.13));
  const geo = mergeAll(parts);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 });
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new V3(0, 1, 0);
  list.forEach((p, i) => mesh.setMatrixAt(i, m.compose(new V3(p.x, p.y - 0.21, p.z), q.setFromAxisAngle(up, p.rot ?? 0), new V3(1, 1, 1))));
  mesh.computeBoundingSphere();
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

function mergeAll(list) {
  const pos = [], nrm = [], col = [];
  for (const g of list) {
    pos.push(...g.attributes.position.array);
    nrm.push(...g.attributes.normal.array);
    col.push(...g.attributes.color.array);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
