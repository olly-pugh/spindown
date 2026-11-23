// The people of Spindown World, built as smooth blended shapes (see sdf.js): the cyclist's body, head,
// helmet and glasses, and the spectators. Built once per session and shared; each rider or crowd member only
// adds its own colours.
import * as THREE from 'three';
import { cone, ellipsoid, plane, alongBasis, meshShapes } from './sdf.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Colour regions. */
export const R = {
  SKIN: 0, JERSEY: 1, SLEEVE: 2, ACCENT: 3, SHORTS: 4, SOCK: 5, SHOE: 6, SOLE: 7, GLOVE: 8, HAIR: 9, LIPS: 10,
  SHOE_ACCENT: 11, HELMET: 12, HELMET_TRIM: 13, VENT: 14, LENS: 15, FRAME: 16, BROW: 17,
  // Spectators.
  TOP: 20, BOTTOM: 21, HAT: 22,
};

// ---- The cyclist ---------------------------------------------------------------------------------------

/** Rider dimensions shared with rider.js (metres, rider faces −z). */
export const RIDER = {
  HIP: V(0, 1.0, 0.19),
  HEAD: V(0, 1.548, -0.372),
  SHOULDER: V(0.18, 1.355, -0.225),
  ELBOW: V(0.226, 1.156, -0.405),
  WRIST: V(0.204, 1.012, -0.556),
  SPINE: [V(0, 1.0, 0.215), V(0, 1.105, 0.15), V(0, 1.215, 0.055), V(0, 1.31, -0.07), V(0, 1.372, -0.19), V(0, 1.4, -0.268)],
  THIGH: 0.45,
  SHIN: 0.455,
  LEG_X: 0.108,
};
export const BONE = { ROOT: 0, TORSO: 1, THIGH: 5, SHIN: 6, FOOT: 7 }; // left leg: +3
const NEIGHBOURS = { 0: [1, 5, 8], 1: [0], 5: [0, 6], 6: [5, 7], 7: [6], 8: [0, 9], 9: [8, 10], 10: [9] };

/** 0 at the waist, 1 at the collar: how far up the back a point is (for the jersey and its patterns). */
const spineLen = (() => {
  const s = RIDER.SPINE;
  let L = 0;
  const cum = [0];
  for (let i = 1; i < s.length; i++) cum.push((L += s[i].distanceTo(s[i - 1])));
  return { cum, L };
})();
export function spineU(x, y, z) {
  const s = RIDER.SPINE;
  let best = Infinity, u = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1];
    const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z, l2 = bx * bx + by * by + bz * bz;
    const t = Math.max(0, Math.min(1, ((x - a.x) * bx + (y - a.y) * by + (z - a.z) * bz) / l2));
    const d = (x - a.x - bx * t) ** 2 + (y - a.y - by * t) ** 2 + (z - a.z - bz * t) ** 2;
    if (d < best) {
      best = d;
      u = (spineLen.cum[i] + t * Math.sqrt(l2)) / spineLen.L;
    }
  }
  return u;
}
/** Where the jersey hem sits up the spine. */
export const HEM = 0.16;

/** Colour ladder rows (see sdf.js): 1 is the torso (a 2D jersey texture), the rest look up one row each. */
export const ROW = { TORSO: 1, UPPER_ARM: 2, FOREARM: 3, THIGH: 4, SHIN: 5, NECK: 6, HELMET: 7, GLASSES: 8 };
/** Where colours change along each ladder (0…1), shared by the region functions and the shader's colour rows. */
export const BANDS = {
  UPPER_ARM: [0.54, 0.6], // sleeve | cuff band | skin
  FOREARM: 0.9, // skin | glove
  THIGH: [0.6, 0.655], // shorts | leg gripper | skin
  SHIN: 0.76, // skin | sock
  NECK: 0.13, // collar | skin
  HELMET: 0.055, // trim | shell
  GLASSES: 0.67, // lens | frame
};
/** The torso ladder runs on up the neck: 1 is the base of the neck, above that the collar then skin. */
export const UMAX = 1.4;
export const COLLAR = [0.955, 1.045];
const NECK_TOP = V(0, 1.5, -0.35);
function torsoU(x, y, z) {
  const u = spineU(x, y, z);
  if (u < 0.85) return u;
  // Past the base of the neck: carry on along the neck, in the same units.
  const a = RIDER.SPINE[RIDER.SPINE.length - 1], b = NECK_TOP;
  const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z, l2 = bx * bx + by * by + bz * bz;
  const t = ((x - a.x) * bx + (y - a.y) * by + (z - a.z) * bz) / l2;
  return t > 0 ? 1 + (t * Math.sqrt(l2)) / spineLen.L : u;
}
const TORSO_LADDER = { row: ROW.TORSO, at: (x, y, z) => [torsoU(x, y, z) / UMAX, (x + 0.22) / 0.44] };

function torsoRegion(_s, x, y, z) {
  return spineU(x, y, z) < HEM ? R.SHORTS : R.JERSEY;
}

/** The body below the head: torso, arms and legs. legMatrices: bind-pose world matrices [thigh, shin, foot] per leg (right, left). */
function bodyShapes(legMatrices, { withHead = false } = {}) {
  const S = RIDER.SPINE, T = BONE.TORSO, out = [];
  const along = (a, b) => alongBasis(b.clone().sub(a));
  const mid = (a, b, t = 0.5) => a.clone().lerp(b, t);
  // Pelvis and seat (move with the hips).
  out.push(ellipsoid(V(0, 1.0, 0.2), V(0.152, 0.11, 0.13), { basis: along(S[0], S[1]), bone: BONE.ROOT, region: R.SHORTS, ladder: TORSO_LADDER, k: 0.05 }));
  for (const s of [-1, 1]) out.push(ellipsoid(V(0.074 * s, 0.975, 0.252), V(0.084, 0.074, 0.086), { bone: BONE.ROOT, region: R.SHORTS, ladder: TORSO_LADDER, k: 0.04 }));
  // Torso: lower back, rib cage, shoulder girdle, chest and lats.
  out.push(ellipsoid(mid(S[1], S[2]), V(0.142, 0.1, 0.104), { basis: along(S[1], S[2]), bone: T, region: torsoRegion, ladder: TORSO_LADDER, k: 0.06 }));
  const sDir = S[4].clone().sub(S[2]).normalize();
  const front = V(0, -sDir.z, sDir.y).multiplyScalar(-1); // belly side, perpendicular to the spine
  if (front.y > 0) front.negate();
  out.push(ellipsoid(V(0, 1.29, -0.06), V(0.162, 0.138, 0.116), { basis: alongBasis(sDir), bone: T, region: torsoRegion, ladder: TORSO_LADDER, k: 0.06 }));
  out.push(ellipsoid(V(0, 1.352, -0.17), V(0.168, 0.07, 0.092), { basis: along(S[3], S[5]), bone: T, region: R.JERSEY, ladder: TORSO_LADDER, k: 0.05 }));
  const ribs = V(0, 1.29, -0.06);
  for (const s of [-1, 1]) {
    out.push(ellipsoid(ribs.clone().addScaledVector(front, 0.068).addScaledVector(sDir, 0.05).add(V(0.068 * s, 0, 0)), V(0.068, 0.058, 0.044), { basis: alongBasis(sDir), bone: T, region: R.JERSEY, ladder: TORSO_LADDER, k: 0.035 }));
    out.push(ellipsoid(V(0.118 * s, 1.25, -0.035), V(0.058, 0.12, 0.085), { basis: alongBasis(sDir), bone: T, region: R.JERSEY, ladder: TORSO_LADDER, k: 0.045 }));
    // Trapezius sloping up to the neck.
    out.push(cone(V(0.13 * s, 1.372, -0.2), V(0.02 * s, 1.418, -0.284), 0.046, 0.044, { bone: T, region: R.JERSEY, ladder: TORSO_LADDER, k: 0.04 }));
  }
  // Arms: sleeve to mid upper arm with a cuff band, bare forearm, glove on the hood.
  for (const s of [-1, 1]) {
    const m = V(s, 1, 1);
    const sh = RIDER.SHOULDER.clone().multiply(m), el = RIDER.ELBOW.clone().multiply(m), wr = RIDER.WRIST.clone().multiply(m);
    const upper = cone(sh, el, 0.053, 0.041, { bone: T, k: 0.03 });
    const upperL = { row: ROW.UPPER_ARM, at: (x, y, z) => [upper.t(x, y, z), 0] };
    const armRegion = (_x, x, y, z) => {
      const t = upper.t(x, y, z);
      return t < BANDS.UPPER_ARM[0] ? R.SLEEVE : t < BANDS.UPPER_ARM[1] ? R.ACCENT : R.SKIN;
    };
    upper.region = armRegion;
    upper.ladder = upperL;
    out.push(ellipsoid(sh.clone().add(V(0.004 * s, 0.006, 0)), V(0.062, 0.068, 0.068), { basis: along(sh, el), bone: T, region: R.SLEEVE, ladder: upperL, k: 0.035 }));
    out.push(upper);
    out.push(ellipsoid(mid(sh, el, 0.48), V(0.047, 0.095, 0.05), { basis: along(sh, el), bone: T, region: armRegion, ladder: upperL, k: 0.03 }));
    const fore = cone(el, wr, 0.043, 0.028, { bone: T, k: 0.025 });
    const foreL = { row: ROW.FOREARM, at: (x, y, z) => [fore.t(x, y, z), 0] };
    fore.region = (_x, x, y, z) => (fore.t(x, y, z) > BANDS.FOREARM ? R.GLOVE : R.SKIN);
    fore.ladder = foreL;
    out.push(ellipsoid(el, V(0.04, 0.04, 0.04), { bone: T, region: R.SKIN, ladder: foreL, k: 0.02 }));
    out.push(fore);
    out.push(ellipsoid(mid(el, wr, 0.28), V(0.044, 0.075, 0.041), { basis: along(el, wr), bone: T, region: R.SKIN, ladder: foreL, k: 0.025 }));
    // Hand wrapped over the brake hood: palm, fingers curling down the front, thumb inside.
    out.push(ellipsoid(V(0.204 * s, 0.99, -0.598), V(0.033, 0.026, 0.05), { basis: along(wr, V(0.2 * s, 0.97, -0.64)), bone: T, region: R.GLOVE, k: 0.018 }));
    out.push(cone(V(0.205 * s, 0.996, -0.634), V(0.201 * s, 0.958, -0.654), 0.02, 0.017, { bone: T, region: R.GLOVE, k: 0.012 }));
    out.push(cone(V(0.178 * s, 0.99, -0.58), V(0.181 * s, 0.976, -0.62), 0.012, 0.011, { bone: T, region: R.GLOVE, k: 0.01 }));
  }
  // Neck, with the jersey collar at its base.
  const neck = cone(S[5].clone().add(V(0, -0.005, 0.006)), V(0, 1.5, -0.35), 0.057, 0.05, { bone: T, k: 0.03 });
  neck.region = (_x, x, y, z) => (neck.t(x, y, z) < BANDS.NECK ? R.ACCENT : R.SKIN);
  neck.ladder = TORSO_LADDER;
  out.push(neck);
  if (withHead) out.push(...headShapes());

  // Legs, built hanging straight down in each bone's own frame (knee forward is −z), then moved to the bind pose.
  legMatrices.forEach(([mThigh, mShin, mFoot], k) => {
    const o = k * 3, s = k === 0 ? 1 : -1;
    const TH = RIDER.THIGH, SH = RIDER.SHIN;
    const thigh = cone(V(-0.008 * s, 0.03, 0.004), V(0, -TH, 0), 0.088, 0.054, { bone: BONE.THIGH + o, k: 0.04 }).transform(mThigh);
    const byThigh = (_x, x, y, z) => {
      const t = thigh.t(x, y, z);
      return t < BANDS.THIGH[0] ? R.SHORTS : t < BANDS.THIGH[1] ? R.ACCENT : R.SKIN;
    };
    const thighL = { row: ROW.THIGH, at: (x, y, z) => [thigh.t(x, y, z), 0] };
    thigh.region = byThigh;
    thigh.ladder = thighL;
    const TB = { bone: BONE.THIGH + o, region: byThigh, ladder: thighL };
    out.push(thigh);
    out.push(ellipsoid(V(0, -0.2, -0.032), V(0.074, 0.17, 0.068), { ...TB, k: 0.035 }).transform(mThigh)); // quads
    out.push(ellipsoid(V(0, -0.19, 0.03), V(0.068, 0.16, 0.064), { ...TB, k: 0.035 }).transform(mThigh)); // hamstrings
    out.push(ellipsoid(V(0.026 * s, -0.24, -0.012), V(0.048, 0.13, 0.058), { ...TB, k: 0.03 }).transform(mThigh)); // outer quad
    out.push(ellipsoid(V(-0.03 * s, -0.33, -0.03), V(0.04, 0.07, 0.045), { ...TB, k: 0.03 }).transform(mThigh)); // inner quad above the knee
    // Knee and lower leg: kneecap, calf fuller at the back, sock from above the ankle.
    const shin = cone(V(0, -0.01, 0), V(0, -SH + 0.03, 0.004), 0.047, 0.033, { bone: BONE.SHIN + o, k: 0.03 }).transform(mShin);
    const shinL = { row: ROW.SHIN, at: (x, y, z) => [shin.t(x, y, z), 0] };
    shin.region = (_x, x, y, z) => (shin.t(x, y, z) < BANDS.SHIN ? R.SKIN : R.SOCK);
    shin.ladder = shinL;
    const SB = { bone: BONE.SHIN + o, region: shin.region, ladder: shinL };
    out.push(ellipsoid(V(0, 0, -0.004), V(0.049, 0.052, 0.05), { ...SB, k: 0.025 }).transform(mShin));
    out.push(ellipsoid(V(0, -0.005, -0.044), V(0.032, 0.036, 0.018), { ...SB, k: 0.015 }).transform(mShin));
    out.push(shin);
    out.push(ellipsoid(V(0.004 * s, -0.135, 0.028), V(0.05, 0.105, 0.054), { ...SB, k: 0.03 }).transform(mShin)); // calf
    // Shoe on the foot bone (the ankle at its origin; the bone carries the foot's pitch).
    const shoeRegion = (_x, x, y, z) => {
      const l = V(x, y, z).applyMatrix4(mFoot.clone().invert());
      if (l.y > -0.012) return R.SOCK;
      if (l.y < -0.081) return R.SOLE;
      if (l.z > -0.075 && l.z < -0.045 && l.y > -0.07) return R.SHOE_ACCENT;
      return R.SHOE;
    };
    out.push(ellipsoid(V(0, -0.002, 0.004), V(0.036, 0.045, 0.04), { bone: BONE.FOOT + o, region: shoeRegion, k: 0.02 }).transform(mFoot)); // ankle
    out.push(ellipsoid(V(0, -0.045, 0.042), V(0.037, 0.042, 0.046), { bone: BONE.FOOT + o, region: shoeRegion, k: 0.02 }).transform(mFoot)); // heel
    out.push(ellipsoid(V(0, -0.052, -0.045), V(0.044, 0.038, 0.07), { bone: BONE.FOOT + o, region: shoeRegion, k: 0.02 }).transform(mFoot)); // midfoot
    out.push(cone(V(0, -0.058, -0.095), V(0, -0.064, -0.172), 0.04, 0.026, { bone: BONE.FOOT + o, region: shoeRegion, k: 0.02 }).transform(mFoot)); // toe
  });
  return out;
}

/** Head and neck, looking up the road. */
function headShapes() {
  const H = RIDER.HEAD, T = BONE.TORSO, at = (x, y, z) => H.clone().add(V(x, y, z)), out = [];
  const cranium = ellipsoid(at(0, 0.008, 0.008), V(0.074, 0.094, 0.098), { bone: T, k: 0.02 });
  cranium.region = (_s, x, y, z) => {
    const ly = y - H.y, lz = z - H.z, lx = x - H.x;
    if (lz > 0.0 && ly < 0.07) return R.HAIR;
    if (Math.abs(lx) > 0.055 && ly > -0.035 && ly < 0.04 && lz > -0.035) return R.HAIR;
    return R.SKIN;
  };
  out.push(cranium);
  out.push(ellipsoid(at(0, -0.052, -0.032), V(0.06, 0.052, 0.066), { bone: T, region: R.SKIN, k: 0.03 })); // jaw
  out.push(ellipsoid(at(0, -0.087, -0.07), V(0.026, 0.022, 0.022), { bone: T, region: R.SKIN, k: 0.02 })); // chin
  for (const s of [-1, 1]) {
    out.push(ellipsoid(at(0.044 * s, -0.018, -0.066), V(0.026, 0.02, 0.026), { bone: T, region: R.SKIN, k: 0.015 })); // cheekbones
    out.push(ellipsoid(at(0.077 * s, -0.004, 0.008), V(0.011, 0.03, 0.02), { bone: T, region: R.SKIN, k: 0.01 })); // ears
    out.push(ellipsoid(at(0.012 * s, -0.035, -0.103), V(0.01, 0.008, 0.009), { bone: T, region: R.SKIN, k: 0.006 })); // nostrils
  }
  out.push(ellipsoid(at(0, 0.03, -0.083), V(0.062, 0.017, 0.024), { bone: T, region: R.BROW, k: 0.015 })); // brow
  out.push(cone(at(0, 0.017, -0.096), at(0, -0.03, -0.117), 0.008, 0.013, { bone: T, region: R.SKIN, k: 0.01 })); // nose
  out.push(ellipsoid(at(0, -0.061, -0.092), V(0.018, 0.005, 0.008), { bone: T, region: R.LIPS, k: 0.008 }));
  out.push(ellipsoid(at(0, -0.0705, -0.09), V(0.016, 0.0055, 0.008), { bone: T, region: R.LIPS, k: 0.008 }));
  out.push(cone(V(0, 1.43, -0.305), at(0, -0.05, 0.012), 0.055, 0.05, { bone: T, region: R.SKIN, k: 0.03 })); // neck
  return out;
}

/** Helmet shell with vents (aero: long tail, two brow vents). */
function helmetShapes(aero) {
  const H = RIDER.HEAD, T = BONE.TORSO, out = [];
  const c = aero ? H.clone().add(V(0, 0.028, 0.04)) : H.clone().add(V(0, 0.03, 0.012));
  const r = aero ? V(0.108, 0.104, 0.185) : V(0.112, 0.108, 0.148);
  const shell = ellipsoid(c, r, { bone: T, k: 0 });
  const rim = (y, z) => ((y - H.y) - 0.012 + 0.28 * (z - H.z)) / 0.2;
  shell.region = (_s, x, y, z) => (rim(y, z) < BANDS.HELMET ? R.HELMET_TRIM : R.HELMET);
  shell.ladder = { row: ROW.HELMET, at: (x, y, z) => [rim(y, z), 0] };
  out.push(shell);
  out.push(plane(V(0, -1, -0.28), H.clone().add(V(0, 0.012, 0)), { bone: T, k: 0.004 }));
  const surfaceY = (x, z) => c.y + r.y * Math.sqrt(Math.max(0, 1 - (x / r.x) ** 2 - ((z - c.z) / r.z) ** 2));
  const vent = (pts, rad) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const v = cone(pts[i], pts[i + 1], rad, rad, { bone: T, region: R.VENT, k: 0.004, op: 'sub' });
      v.paintsCut = true;
      out.push(v);
    }
  };
  if (!aero) {
    for (const x of [-0.056, -0.019, 0.019, 0.056]) {
      const zs = [-0.1, -0.04, 0.03, 0.1].map((f) => c.z + f);
      vent(zs.map((z) => V(x, surfaceY(x, z - c.z + c.z) - 0.002, z)), 0.0085);
    }
  } else {
    for (const x of [-0.035, 0.035]) vent([V(x, surfaceY(x, c.z - 0.15) - 0.004, c.z - 0.165), V(x, surfaceY(x, c.z - 0.11) - 0.004, c.z - 0.115)], 0.009);
  }
  return out;
}

/** Wrap-round sunglasses: a band of lens hugging the face, with a dark frame along the top. */
function glassesShapes() {
  const H = RIDER.HEAD, T = BONE.TORSO;
  const lens = ellipsoid(H.clone().add(V(0, 0.012, 0)), V(0.087, 0.105, 0.113), { bone: T, k: 0 });
  const band = (y) => (y - H.y + 0.02) / 0.07;
  lens.region = (_s, x, y) => (band(y) > BANDS.GLASSES ? R.FRAME : R.LENS);
  lens.ladder = { row: ROW.GLASSES, at: (x, y) => [band(y), 0] };
  return [
    lens,
    plane(V(0, 1, 0), H.clone().add(V(0, 0.036, 0)), { bone: T, k: 0.004 }),
    plane(V(0, -1, 0), H.clone().add(V(0, -0.012, 0)), { bone: T, k: 0.004 }),
    plane(V(0, 0, 1), H.clone().add(V(0, 0, -0.03)), { bone: T, k: 0.004 }),
  ];
}

const cache = new Map();
function cached(key, make) {
  if (!cache.has(key)) {
    const t0 = performance.now();
    cache.set(key, make());
    const t = cache.get(key);
    t.ms = Math.round(performance.now() - t0);
  }
  return cache.get(key);
}

const OPTS = { neighbours: NEIGHBOURS, blend: 0.045 };
const BODY_BOX = [-0.33, 0.1, -0.72, 0.33, 1.52, 0.4];
const HEAD_BOX = [-0.11, 1.41, -0.52, 0.11, 1.68, -0.23];
const HELMET_BOX = [-0.14, 1.5, -0.58, 0.14, 1.71, -0.12];

/**
 * The rider's meshes for a level of detail ('near' or 'far'). legMatrices from rider.js's bind pose.
 * Returns {body, head (near only), helmet, aeroHelmet, glasses} templates for sdf.painted.
 */
export function riderTemplates(lod, legMatrices) {
  return cached(`rider-${lod}`, () => {
    const near = lod === 'near';
    const body = meshShapes(bodyShapes(legMatrices, { withHead: !near }), BODY_BOX, near ? 0.0125 : 0.028, OPTS);
    const head = near ? meshShapes(headShapes(), HEAD_BOX, 0.0055, OPTS) : null;
    const hh = near ? 0.0055 : 0.013;
    return {
      body,
      head,
      helmet: meshShapes(helmetShapes(false), HELMET_BOX, hh, OPTS),
      aeroHelmet: meshShapes(helmetShapes(true), HELMET_BOX, hh, OPTS),
      glasses: meshShapes(glassesShapes(), HEAD_BOX, near ? 0.0045 : 0.011, OPTS),
    };
  });
}

// ---- Spectators ----------------------------------------------------------------------------------------

/** Spectator shapes standing at the origin facing −z. pose: 'down' | 'cheer' | 'wave'; build: 0 slim … 1 broad; hair: 'short'|'long'|'cap'. */
function personShapes({ pose = 'down', build = 0.5, hair = 'short', longSleeves = true }) {
  const out = [];
  const w = 1 + build * 0.22;
  const BODY = 0, LEFT = 1, RIGHT = 2;
  for (const s of [-1, 1]) {
    const x = 0.1 * s;
    out.push(ellipsoid(V(x, 0.045, -0.04), V(0.05, 0.045, 0.12), { bone: BODY, region: R.SHOE, k: 0.02 }));
    out.push(cone(V(x, 0.07, 0), V(x, 0.49, 0), 0.045, 0.054, { bone: BODY, region: R.BOTTOM, k: 0.03 }));
    out.push(ellipsoid(V(x, 0.34, 0.022), V(0.055, 0.11, 0.055), { bone: BODY, region: R.BOTTOM, k: 0.03 }));
    out.push(cone(V(x, 0.49, 0), V(0.095 * s, 0.9, 0), 0.058, 0.086 * w, { bone: BODY, region: R.BOTTOM, k: 0.035 }));
  }
  out.push(ellipsoid(V(0, 0.95, 0.005), V(0.168 * w, 0.12, 0.118 * w), { bone: BODY, region: R.BOTTOM, k: 0.05 }));
  const top = (_s, x, y) => (y > 0.99 ? R.TOP : R.BOTTOM);
  out.push(ellipsoid(V(0, 1.1, 0.0), V(0.15 * w, 0.14, 0.108 * w * (1 + build * 0.15)), { bone: BODY, region: top, k: 0.06 }));
  out.push(ellipsoid(V(0, 1.3, 0.005), V(0.168 * w, 0.15, 0.112 * w), { bone: BODY, region: R.TOP, k: 0.06 }));
  for (const s of [-1, 1]) out.push(ellipsoid(V(0.07 * s, 1.31, -0.075), V(0.065, 0.055, 0.04), { bone: BODY, region: R.TOP, k: 0.03 }));
  // Arms.
  const arm = (s, bone) => {
    const sh = V(0.19 * s * w, 1.425, 0);
    const [el, wr] = pose === 'cheer' || (pose === 'wave' && s > 0)
      ? [V(0.3 * s * w, 1.66, -0.02), V(0.33 * s * w, 1.92, -0.05)]
      : [V(0.235 * s * w, 1.15, 0.01), V(0.25 * s * w, 0.91, -0.03)];
    out.push(ellipsoid(sh, V(0.062, 0.06, 0.062), { bone, region: R.TOP, k: 0.035 }));
    out.push(cone(sh, el, 0.05, 0.04, { bone, region: R.TOP, k: 0.03 }));
    const fore = cone(el, wr, 0.04, 0.03, { bone, k: 0.025 });
    fore.region = longSleeves ? (_x, x, y, z) => (fore.t(x, y, z) < 0.86 ? R.TOP : R.SKIN) : R.SKIN;
    out.push(fore);
    const hand = wr.clone().add(wr.clone().sub(el).normalize().multiplyScalar(0.06));
    out.push(ellipsoid(hand, V(0.028, 0.05, 0.04), { basis: alongBasis(wr.clone().sub(el)), bone, region: R.SKIN, k: 0.02 }));
  };
  arm(1, LEFT);
  arm(-1, RIGHT);
  // Neck and head.
  out.push(cone(V(0, 1.42, 0.0), V(0, 1.58, -0.005), 0.056, 0.05, { bone: BODY, region: R.SKIN, k: 0.03 }));
  const head = ellipsoid(V(0, 1.685, -0.002), V(0.074, 0.098, 0.094), { bone: BODY, k: 0.02 });
  head.region = (_s, x, y, z) => (y > 1.712 - Math.max(0, z) * 0.9 || (z > 0.035 && y > 1.6) || (Math.abs(x) > 0.062 && y > 1.66 && z > -0.03) ? R.HAIR : R.SKIN);
  out.push(head);
  out.push(ellipsoid(V(0, 1.632, -0.03), V(0.06, 0.05, 0.062), { bone: BODY, region: R.SKIN, k: 0.03 }));
  out.push(cone(V(0, 1.69, -0.088), V(0, 1.656, -0.106), 0.009, 0.014, { bone: BODY, region: R.SKIN, k: 0.01 }));
  out.push(ellipsoid(V(0, 1.716, -0.08), V(0.058, 0.015, 0.02), { bone: BODY, region: R.SKIN, k: 0.012 }));
  for (const s of [-1, 1]) out.push(ellipsoid(V(0.076 * s, 1.68, 0.006), V(0.011, 0.028, 0.019), { bone: BODY, region: R.SKIN, k: 0.01 }));
  out.push(ellipsoid(V(0, 1.635, -0.087), V(0.02, 0.008, 0.01), { bone: BODY, region: R.LIPS, k: 0.006 }));
  if (hair === 'long') out.push(ellipsoid(V(0, 1.6, 0.045), V(0.078, 0.13, 0.055), { bone: BODY, region: R.HAIR, k: 0.03 }));
  if (hair === 'cap') {
    out.push(ellipsoid(V(0, 1.735, 0.004), V(0.083, 0.06, 0.1), { bone: BODY, region: R.HAT, k: 0.006 }));
    out.push(ellipsoid(V(0, 1.716, -0.1), V(0.07, 0.009, 0.06), { bone: BODY, region: R.HAT, k: 0.004 }));
  }
  return out;
}

const PERSON_BOX = [-0.42, 0, -0.2, 0.42, 2.0, 0.16];
export const PERSON_VARIANTS = [
  { pose: 'cheer', build: 0.3, hair: 'short', longSleeves: false },
  { pose: 'down', build: 0.7, hair: 'cap', longSleeves: true },
  { pose: 'wave', build: 0.4, hair: 'long', longSleeves: true },
  { pose: 'down', build: 0.2, hair: 'long', longSleeves: false },
  { pose: 'cheer', build: 0.8, hair: 'cap', longSleeves: true },
  { pose: 'wave', build: 0.6, hair: 'short', longSleeves: false },
];

/** Spectator templates for a level of detail: [{geometry, regions, arm: Float32Array, variant}]. */
export function personTemplates(lod) {
  return cached(`people-${lod}`, () => PERSON_VARIANTS.map((variant) => {
    const t = meshShapes(personShapes(variant), PERSON_BOX, lod === 'near' ? 0.024 : 0.05, { neighbours: { 0: [1, 2], 1: [0], 2: [0] }, blend: 0.08 });
    // How much each vertex follows the left (+) or right (−) arm, for the waving in the shader.
    const si = t.geometry.attributes.skinIndex.array, sw = t.geometry.attributes.skinWeight.array;
    const n = t.regions.length, arm = new Float32Array(n);
    for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) arm[i] += si[i * 4 + j] === 1 ? sw[i * 4 + j] : si[i * 4 + j] === 2 ? -sw[i * 4 + j] : 0;
    t.geometry.deleteAttribute('skinIndex');
    t.geometry.deleteAttribute('skinWeight');
    t.geometry.setAttribute('arm', new THREE.BufferAttribute(arm, 1));
    t.geometry.computeBoundingSphere();
    return { ...t, variant };
  }));
}
