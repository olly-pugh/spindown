// The cyclist's gear, fitted to the MakeHuman head and feet in the rest pose, then carried into the riding pose by
// the head and foot bones: road cycling shoes (smooth signed-distance shapes, meshed), a vented road helmet, an
// aero helmet and wrap-round sunglasses (explicit parametric shells, see shells.mjs).
import * as THREE from 'three';
import { cone, ellipsoid, plane, meshShapes } from '../../src/renderer/game3d/sdf.js';
import { M3, V3 } from './skeleton.mjs';
import { quantiseWeights } from './meshkit.mjs';
import { Builder, helmet as helmetShell, sunglasses } from './shells.mjs';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Region ids painted by the game (rider.js). */
export const GEAR = {
  SHOE: 1, SOLE: 2, SHOE_ACCENT: 3, DIAL: 4, CLEAT: 5, HEEL_PAD: 6,
  SHELL: 10, SHELL_DARK: 11, VENT: 12, FOAM: 13, STRAP: 14, BUCKLE: 15, PAD: 16, RIM: 17,
  LENS: 20, FRAME: 21,
};
// Regions whose shared positions are welded into one smooth surface when computing normals.
const SMOOTH_GROUP = { [GEAR.SHELL]: 1, [GEAR.SHELL_DARK]: 1, [GEAR.FOAM]: 2, [GEAR.RIM]: 3, [GEAR.LENS]: 4, [GEAR.FRAME]: 5, [GEAR.STRAP]: 6, [GEAR.BUCKLE]: 7 };

function skinAll(n, runtimeBone) {
  const [si, sw] = quantiseWeights([[runtimeBone, 1]]);
  const skinIndex = new Uint8Array(n * 4), skinWeight = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { skinIndex.set(si, i * 4); skinWeight.set(sw, i * 4); }
  return { skinIndex, skinWeight };
}

/** An explicit Builder mesh (rest coordinates) carried by a bone into the pose, with welded smooth normals. */
function builderMesh(b, skel, carryBone, runtimeBone) {
  const n = b.P.length / 3;
  // Smooth normals: accumulate face normals per (position, smoothing group).
  const key = (i) => `${SMOOTH_GROUP[b.R[i]] ?? `r${b.R[i]}`}:${Math.round(b.P[i * 3] * 1e5)},${Math.round(b.P[i * 3 + 1] * 1e5)},${Math.round(b.P[i * 3 + 2] * 1e5)}`;
  const acc = new Map();
  const faceN = [];
  for (let k = 0; k < b.I.length; k += 3) {
    const pa = b.p(b.I[k]), pb = b.p(b.I[k + 1]), pc = b.p(b.I[k + 2]);
    const nn = V3.cross(V3.sub(pb, pa), V3.sub(pc, pa));
    faceN.push(nn);
    for (const v of [b.I[k], b.I[k + 1], b.I[k + 2]]) {
      const kk = key(v);
      const a = acc.get(kk) ?? [0, 0, 0];
      acc.set(kk, V3.add(a, nn));
    }
  }
  const bone = skel.bones[carryBone];
  const rot = M3.mul(bone.rot, M3.T(bone.rest));
  const P = new Float32Array(n * 3), N = new Int8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = skel.carry(carryBone, b.p(i));
    P.set(p, i * 3);
    const nn = V3.norm(M3.apply(rot, V3.norm(acc.get(key(i)) ?? [0, 1, 0])));
    N[i * 3] = Math.round(nn[0] * 127); N[i * 3 + 1] = Math.round(nn[1] * 127); N[i * 3 + 2] = Math.round(nn[2] * 127);
  }
  return { count: n, position: P, normal: N, region: Uint8Array.from(b.R), ...skinAll(n, runtimeBone), index: n > 65535 ? Uint32Array.from(b.I) : Uint16Array.from(b.I) };
}

/** Meshes SDF shapes (rest coordinates), carries them by a bone into the pose. edge(x, y, z) -> a per-vertex scalar. */
function sdfMesh(shapes, box, h, skel, carryBone, runtimeBone, { mirror = false, edge = null } = {}) {
  const t = meshShapes(shapes, box, h, { neighbours: {}, blend: 0.01 });
  const g = t.geometry;
  const pos = g.attributes.position.array, nrm = g.attributes.normal.array;
  const n = pos.length / 3;
  const P = new Float32Array(n * 3), N = new Int8Array(n * 3), R = new Uint8Array(n), E = new Int16Array(n);
  const b = skel.bones[carryBone];
  const rot = M3.mul(b.rot, M3.T(b.rest));
  for (let i = 0; i < n; i++) {
    let p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], q = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]];
    if (edge) E[i] = Math.round(Math.max(-1, Math.min(1, edge(p[0], p[1], p[2]) * 10)) * 32767);
    if (mirror) { p = [-p[0], p[1], p[2]]; q = [-q[0], q[1], q[2]]; }
    const pp = skel.carry(carryBone, p), nn = V3.norm(M3.apply(rot, q));
    P.set(pp, i * 3);
    N[i * 3] = Math.round(nn[0] * 127); N[i * 3 + 1] = Math.round(nn[1] * 127); N[i * 3 + 2] = Math.round(nn[2] * 127);
    R[i] = t.regions[i];
  }
  const index = Array.from(g.index.array);
  if (mirror) for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
  const out = { count: n, position: P, normal: N, region: R, ...skinAll(n, runtimeBone), index: n > 65535 ? Uint32Array.from(index) : Uint16Array.from(index) };
  if (edge) out.edge = E;
  return out;
}

export function mergeMeshes(meshes) {
  const count = meshes.reduce((a, m) => a + m.count, 0);
  const out = { count };
  for (const k of Object.keys(meshes[0])) {
    if (k === 'count' || k === 'index') continue;
    if (!meshes.every((m) => m[k])) continue;
    const C = meshes[0][k].constructor;
    const arr = new C(meshes.reduce((a, m) => a + m[k].length, 0));
    let o = 0;
    for (const m of meshes) { arr.set(m[k], o); o += m[k].length; }
    out[k] = arr;
  }
  const idx = [];
  let base = 0;
  for (const m of meshes) { for (const i of m.index) idx.push(i + base); base += m.count; }
  out.index = count > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx);
  return out;
}

/**
 * skel: posed MakeHuman skeleton (rest data kept on each bone). Returns {meshes, hides(x, y, z) for rest-pose body
 * points covered by the shoes, underHelmet(x, y, z) for rest points covered by the helmet, meta}.
 */
export function riderGear(skel, { bones }) {
  const B = skel.bones;
  const H = B.head.head; // top of the neck, rest pose
  const eye = B['eye.R'].head;
  const C = [0, H[1] + 0.077, H[2] + 0.002]; // cranium centre

  // ---- Straps: front and rear straps meeting under each ear, then down to the buckle under the chin ----
  const straps = () => {
    const b = new Builder();
    const at = (x, y, z) => [C[0] + x, C[1] + y, C[2] + z];
    for (const s of [-1, 1]) {
      const below = at(0.067 * s, -0.082, -0.036);
      b.tube([at(0.081 * s, -0.004, -0.078), at(0.076 * s, -0.04, -0.06), below], 0.0028, GEAR.STRAP, 5);
      b.tube([at(0.078 * s, -0.012, 0.03), at(0.074 * s, -0.05, 0.0), below], 0.0028, GEAR.STRAP, 5);
      b.tube([below, at(0.056 * s, -0.125, -0.06), at(0.036 * s, -0.158, -0.074), at(0.0, -0.166, -0.072)], 0.003, GEAR.STRAP, 5);
      b.tube([at(0.068 * s, -0.087, -0.037), at(0.066 * s, -0.076, -0.035)], 0.0055, GEAR.BUCKLE, 6);
    }
    b.tube([at(0.004, -0.166, -0.073), at(0.02, -0.164, -0.073)], 0.005, GEAR.BUCKLE, 6);
    return b;
  };

  // ---- Road shoes (right foot, mirrored for the left), in the foot's rest frame ----
  const A = B['foot.R'].head; // ankle joint, rest
  const toeDir = V3.norm([B['toe3-1.R'].head[0] - A[0], 0, B['toe3-1.R'].head[2] - A[2]]);
  let out = V3.norm(V3.cross([0, 1, 0], toeDir));
  if (out[0] < 0) out = V3.scale(out, -1); // the right foot's outside is +x
  // fwd: metres towards the toes; up: above the ankle; lat: towards the outside of the foot.
  const F = (fwd, up, lat) => V(A[0] + toeDir[0] * fwd + out[0] * lat, A[1] + up, A[2] + toeDir[2] * fwd + out[2] * lat);
  const local = (x, y, z) => [(x - A[0]) * toeDir[0] + (z - A[2]) * toeDir[2], y - A[1], (x - A[0]) * out[0] + (z - A[2]) * out[2]];
  const SOLE_Y = -0.0715; // the bare foot's sole below the ankle joint
  const shoeShapes = () => {
    const sh = [];
    const region = (_s, x, y, z) => {
      const [fwd, up, lat] = local(x, y, z);
      if (Math.abs(fwd - 0.06) < 0.013 && lat > 0.018 && up > -0.035) return GEAR.DIAL;
      return GEAR.SHOE;
    };
    // Heel cup, midfoot and a low, pointed toe box, blended; the ankle collar.
    sh.push(ellipsoid(F(-0.032, -0.034, 0.0), V(0.039, 0.046, 0.041), { k: 0.03, region }));
    sh.push(ellipsoid(F(0.055, -0.04, 0.003), V(0.052, 0.036, 0.085), { k: 0.035, region }));
    sh.push(cone(F(0.105, -0.05, 0.003), F(0.195, -0.059, -0.006), 0.031, 0.014, { k: 0.03, region }));
    sh.push(ellipsoid(F(0.0, -0.004, 0.0), V(0.037, 0.038, 0.04), { k: 0.025, region }));
    // Stiff flat sole slab underneath, flat bottom.
    sh.push(cone(F(-0.045, SOLE_Y - 0.0015, 0.0), F(0.195, SOLE_Y - 0.0015, -0.003), 0.029, 0.021, { k: 0.014, region }));
    sh.push(plane(V(0, -1, 0), F(0, SOLE_Y - 0.0085, 0), { k: 0.002 }));
    // Ankle opening: cut away above the collar, lower at the front.
    const collar = plane(V(-toeDir[0] * 0.45, 1, -toeDir[2] * 0.45), F(0, -0.008, 0), { k: 0.006, region: GEAR.HEEL_PAD });
    collar.paintsCut = true;
    sh.push(collar);
    // Dial (BOA) on the outside of the instep.
    sh.push(cone(F(0.06, -0.014, 0.034), F(0.06, -0.008, 0.045), 0.0105, 0.0095, { k: 0.003, region: GEAR.DIAL }));
    // Cleat under the ball of the foot.
    sh.push(ellipsoid(F(0.128, SOLE_Y - 0.0105, 0.0), V(0.025, 0.005, 0.03), { k: 0.003, region: GEAR.CLEAT }));
    return sh;
  };
  const shoe = shoeShapes();
  const soleEdge = (x, y, z) => local(x, y, z)[1] - (SOLE_Y - 0.0085);

  const hb = bones.head, fR = bones['foot.R'], fL = bones['foot.L'];
  const FOOT_BOX = [A[0] - 0.09, A[1] - 0.1, A[2] - 0.25, A[0] + 0.09, A[1] + 0.05, A[2] + 0.1];
  const strapMesh = builderMesh(straps(), skel, 'head', hb);
  const helmet = mergeMeshes([builderMesh(helmetShell(C, GEAR), skel, 'head', hb), strapMesh]);
  const helmetAero = mergeMeshes([builderMesh(helmetShell(C, GEAR, { aero: true }), skel, 'head', hb), strapMesh]);
  const glassesMesh = builderMesh(sunglasses(C, eye, GEAR), skel, 'head', hb);
  const shoesAt = (h) => mergeMeshes([
    sdfMesh(shoe, FOOT_BOX, h, skel, 'foot.R', fR, { edge: soleEdge }),
    sdfMesh(shoe, FOOT_BOX, h, skel, 'foot.L', fL, { mirror: true, edge: soleEdge }),
  ]);
  const shoes = shoesAt(0.0085), shoesFar = shoesAt(0.017);
  const helmetFar = builderMesh(helmetShell(C, GEAR, { far: true }), skel, 'head', hb);
  const helmetAeroFar = builderMesh(helmetShell(C, GEAR, { aero: true, far: true }), skel, 'head', hb);
  const glassesFar = builderMesh(sunglasses(C, eye, GEAR, { far: true }), skel, 'head', hb);

  // Body points (rest) inside a shoe are hidden; hair inside the helmet too.
  const shoeField = (x, y, z) => {
    let f = 1e3;
    for (const s of shoe) f = s.combine(f, s.dist(x, y, z));
    return f;
  };
  const hides = (x, y, z) => y < A[1] + 0.004 && shoeField(Math.abs(x), y, z) < -0.0025;
  const underHelmet = (x, y, z) => {
    // Inside the shell's outer ellipsoid and above its rim (with a margin).
    const dx = x / 0.104, dy = (y - C[1] - 0.004) / 0.1, dz = (z - C[2] - 0.006) / (z < C[2] ? 0.14 : 0.152);
    const back = Math.max(0, Math.min(1, (z - C[2] + 0.14) / 0.29));
    const rim = C[1] + 0.006 - 0.012 * Math.min(1, (Math.abs(x) / 0.1) ** 2) - 0.036 * back ** 1.6;
    return dx * dx + dy * dy + dz * dz < 1.04 && y > rim + 0.002;
  };
  return {
    meshes: { helmet, helmetAero, glasses: glassesMesh, shoes, helmetFar, helmetAeroFar, glassesFar, shoesFar },
    hides,
    underHelmet,
    meta: { regions: GEAR },
  };
}
