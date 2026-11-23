// Builds the people of Spindown World from MakeHuman 1.1 assets (all CC0; see
// src/renderer/game3d/people/LICENSE.md): the cyclist, posed on the bike, and the spectators.
// Development-time only; the outputs in src/renderer/game3d/people/ are committed.
//
//   node scripts/people/build-people.mjs --mh <dir> [--debug <dir>]
//
// <dir> holds the MakeHuman data: 3dobjs/base.obj, rigs/default.mhskel + default_weights.mhw and targets/ from
// https://github.com/makehumancommunity/makehuman (makehuman/data), plus the system asset pack
// (http://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip)
// unzipped into <dir>/system (proxymeshes/, skins/, hair/, eyebrows/, clothes/ ...).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readObj, readTarget, applyTarget, readJSON, readFitting, fitCoords } from './mh.mjs';
import { Skeleton, toGame, vertexWeights, fittedWeights, V3 } from './skeleton.mjs';
import { cyclingPose } from './pose.mjs';
import { assemble, vertexNormals, pack } from './meshkit.mjs';
import * as FIT from '../../src/renderer/game3d/people/fit.js';
import { riderGear } from './gear.mjs';
import { buildCrowd } from './crowd-build.mjs';
import { VoxelGrid, bakeAO } from './ao.mjs';
import { simplify, compactMesh } from './simplify.mjs';
import { buildBike } from '../../src/renderer/game3d/bike.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'src/renderer/game3d/people');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MH = opt('--mh', null);
const DEBUG = opt('--debug', null);
if (!MH) throw new Error('--mh <dir> is required');
const SYS = path.join(MH, 'system');

const base = readObj(path.join(MH, '3dobjs/base.obj'));
const NB = base.v.length / 3;
const bodyFaces = base.faces.filter((f) => base.groups[f.g] === 'body');
const target = (n) => readTarget(path.join(MH, 'targets', n + '.target'));
const skelDef = readJSON(path.join(MH, 'rigs/default.mhskel'));
const mhWeights = vertexWeights(readJSON(path.join(MH, 'rigs/default_weights.mhw')), NB);

/** Shaped base-mesh coordinates (MakeHuman frame) for a set of target weights. */
function shaped(weights) {
  const c = Float64Array.from(base.v);
  for (const [n, w] of Object.entries(weights)) applyTarget(c, target(n), w);
  return c;
}

// ---- Runtime skeleton: MakeHuman's 163 bones folded into the few the game animates --------------------------
export const RIDER_BONES = ['root', 'pelvis', 'spine', 'chest', 'neck', 'head',
  'clavicle.R', 'upperarm.R', 'forearm.R', 'hand.R', 'clavicle.L', 'upperarm.L', 'forearm.L', 'hand.L',
  'thigh.R', 'shin.R', 'foot.R', 'thigh.L', 'shin.L', 'foot.L'];
const PARENT = { pelvis: 'root', spine: 'pelvis', chest: 'spine', neck: 'chest', head: 'neck', 'clavicle.R': 'chest', 'upperarm.R': 'clavicle.R', 'forearm.R': 'upperarm.R', 'hand.R': 'forearm.R', 'clavicle.L': 'chest', 'upperarm.L': 'clavicle.L', 'forearm.L': 'upperarm.L', 'hand.L': 'forearm.L', 'thigh.R': 'pelvis', 'shin.R': 'thigh.R', 'foot.R': 'shin.R', 'thigh.L': 'pelvis', 'shin.L': 'thigh.L', 'foot.L': 'shin.L' };
// Where each runtime bone pivots: the head of this MakeHuman bone.
const PIVOT = { spine: 'spine05', chest: 'spine02', neck: 'neck01', head: 'head', 'clavicle.R': 'clavicle.R', 'upperarm.R': 'upperarm01.R', 'forearm.R': 'lowerarm01.R', 'hand.R': 'wrist.R', 'clavicle.L': 'clavicle.L', 'upperarm.L': 'upperarm01.L', 'forearm.L': 'lowerarm01.L', 'hand.L': 'wrist.L', 'thigh.R': 'upperleg01.R', 'shin.R': 'lowerleg01.R', 'foot.R': 'foot.R', 'thigh.L': 'upperleg01.L', 'shin.L': 'lowerleg01.L', 'foot.L': 'foot.L' };

function runtimeBone(mh) {
  if (mh === 'root' || mh.startsWith('pelvis.')) return 'pelvis';
  if (/^spine0[345]$/.test(mh)) return 'spine';
  if (/^spine0[12]$/.test(mh) || mh.startsWith('breast.')) return 'chest';
  if (mh.startsWith('neck')) return 'neck';
  const side = mh.endsWith('.R') ? 'R' : 'L';
  if (mh.startsWith('clavicle') || mh.startsWith('shoulder01')) return `clavicle.${side}`;
  if (mh.startsWith('upperarm')) return `upperarm.${side}`;
  if (mh.startsWith('lowerarm')) return `forearm.${side}`;
  if (mh.startsWith('wrist') || mh.startsWith('metacarpal') || mh.startsWith('finger')) return `hand.${side}`;
  if (mh.startsWith('upperleg')) return `thigh.${side}`;
  if (mh.startsWith('lowerleg')) return `shin.${side}`;
  if (mh.startsWith('foot') || mh.startsWith('toe')) return `foot.${side}`;
  return 'head';
}
const boneIndex = Object.fromEntries(RIDER_BONES.map((b, i) => [b, i]));

/** MakeHuman weight lists -> runtime [[boneIndex, w]] lists. */
function mapWeights(lists, bones = boneIndex) {
  return lists.map((ws) => {
    const acc = new Map();
    for (const [b, w] of ws) {
      const r = bones[runtimeBone(b)];
      acc.set(r, (acc.get(r) ?? 0) + w);
    }
    return [...acc.entries()];
  });
}

/** Kit fields per vertex from the weights: [arm, leg, head+neck, hand] (0..1). */
function kitFields(lists) {
  return lists.map((ws) => {
    const f = [0, 0, 0, 0];
    for (const [b, w] of ws) {
      const r = runtimeBone(b);
      if (/^(upperarm|forearm|hand)/.test(r)) f[0] += w;
      if (/^(thigh|shin|foot)/.test(r)) f[1] += w;
      if (r === 'head' || r === 'neck') f[2] += w;
      if (r.startsWith('hand')) f[3] += w;
    }
    return f;
  });
}

// ---- The cyclist -----------------------------------------------------------------------------------------
const RIDER_SHAPE = {
  'macrodetails/caucasian-male-young': 0.6,
  'macrodetails/african-male-young': 0.2,
  'macrodetails/asian-male-young': 0.2,
  'macrodetails/universal-male-young-averagemuscle-minweight': 0.15 * 0.35,
  'macrodetails/universal-male-young-maxmuscle-averageweight': 0.85 * 0.65,
  'macrodetails/universal-male-young-maxmuscle-minweight': 0.85 * 0.35,
  'macrodetails/universal-male-young-averagemuscle-averageweight': 0.15 * 0.65,
  'macrodetails/proportions/male-young-maxmuscle-averageweight-idealproportions': 0.6,
  'stomach/stomach-pregnant-decr': 0.5,
  'pelvis/bulge-decr': 1,
  'buttocks/buttocks-volume-decr': 0.3,
  'armslegs/r-lowerleg-muscle-incr': 0.5,
  'armslegs/l-lowerleg-muscle-incr': 0.5,
  'armslegs/r-upperleg-muscle-incr': 0.45,
  'armslegs/l-upperleg-muscle-incr': 0.45,
  'armslegs/r-upperarm-muscle-incr': 0.45,
  'armslegs/l-upperarm-muscle-incr': 0.45,
  'armslegs/r-upperarm-shoulder-muscle-incr': 0.4,
  'armslegs/l-upperarm-shoulder-muscle-incr': 0.4,
  'torso/torso-muscle-dorsi-incr': 0.3,
  'torso/torso-muscle-pectoral-incr': 0.25,
};

const RIDER_SHAPE_F = {
  'macrodetails/caucasian-female-young': 0.6,
  'macrodetails/african-female-young': 0.2,
  'macrodetails/asian-female-young': 0.2,
  'macrodetails/universal-female-young-maxmuscle-averageweight': 0.6 * 0.7,
  'macrodetails/universal-female-young-maxmuscle-minweight': 0.6 * 0.3,
  'macrodetails/universal-female-young-averagemuscle-averageweight': 0.4 * 0.7,
  'macrodetails/universal-female-young-averagemuscle-minweight': 0.4 * 0.3,
  'macrodetails/proportions/female-young-maxmuscle-averageweight-idealproportions': 0.5,
  'macrodetails/height/female-young-maxmuscle-averageweight-maxheight': 0.17 * 0.6 * 0.7,
  'macrodetails/height/female-young-maxmuscle-minweight-maxheight': 0.17 * 0.6 * 0.3,
  'macrodetails/height/female-young-averagemuscle-averageweight-maxheight': 0.17 * 0.4 * 0.7,
  'macrodetails/height/female-young-averagemuscle-minweight-maxheight': 0.17 * 0.4 * 0.3,
  'stomach/stomach-pregnant-decr': 0.4,
  'buttocks/buttocks-volume-decr': 0.2,
  'armslegs/r-lowerleg-muscle-incr': 0.35,
  'armslegs/l-lowerleg-muscle-incr': 0.35,
  'armslegs/r-upperleg-muscle-incr': 0.3,
  'armslegs/l-upperleg-muscle-incr': 0.3,
};

export const RIDER_FIT = {
  hip: FIT.HIP,
  pelvisTilt: 0.56,
  shoulderY: 1.24,
  protract: 0.12,
  shrug: 0.0,
  headPitch: 0.3,
  hood: FIT.HOOD,
  handOut: 0.06,
  handDown: 0.3,
  palmIn: 0.55,
  palmBack: 0.062,
  palmLift: 0.03,
  pronateShare: 0.7,
  elbowOut: 0.6,
  curl: [0.75, 0.95, 0.6],
  thumb: 0.5,
  thumbDown: 0.5,
  kneeOut: 0.1,
  pedal: (s) => {
    const a = FIT.BIND_CRANK + (s === 'R' ? 0 : Math.PI);
    return { ankle: FIT.anklePosition(a, s === 'R' ? 1 : -1), pitch: FIT.footPitch(a) };
  },
};

function fitted(file, restMH, skel) {
  const fit = readFitting(file);
  const obj = readObj(path.join(path.dirname(file), fit.objFile));
  const rest = toGame(fitCoords(fit, restMH));
  const w = fittedWeights(fit, mhWeights);
  const posed = skel.skin(rest, w);
  return { fit, obj, rest, posed, w };
}

const REF = {};
/** Face shapes, stored as morph targets on the near body (the game mixes them per rider). */
const FACE_MORPHS = [
  { 'head/head-square': 0.7, 'chin/chin-width-incr': 0.6, 'chin/chin-prominent-incr': 0.5, 'nose/nose-scale-horiz-incr': 0.4, 'cheek/l-cheek-bones-incr': 0.4, 'cheek/r-cheek-bones-incr': 0.4, 'mouth/mouth-scale-horiz-incr': 0.3 },
  { 'head/head-oval': 0.7, 'head/head-scale-vert-incr': 0.35, 'nose/nose-scale-vert-incr': 0.5, 'nose/nose-hump-incr': 0.6, 'chin/chin-height-incr': 0.4, 'nose/nose-point-width-incr': 0.3 },
  { 'head/head-age-incr': 0.8, 'cheek/l-cheek-volume-decr': 0.5, 'cheek/r-cheek-volume-decr': 0.5, 'eyebrows/eyebrows-trans-down': 0.5 },
];
function buildRider({ shape = RIDER_SHAPE, body = 'm', proxyFile = 'proxymeshes/male1591/male1591.proxy', hairFile = 'hair/short02/short02.mhclo' } = {}) {
  const restMH = shaped(shape);
  const rest = toGame(restMH);
  const skel = new Skeleton(skelDef, rest);
  const restBones = Object.fromEntries(Object.entries(skel.bones).map(([n, b]) => [n, { head: b.head, tail: b.tail }]));
  const thigh = V3.len(V3.sub(skel.bones['lowerleg01.R'].head, skel.bones['upperleg01.R'].head));
  const shin = V3.len(V3.sub(skel.bones['foot.R'].head, skel.bones['lowerleg01.R'].head));
  const arm = V3.len(V3.sub(skel.bones['lowerarm01.R'].head, skel.bones['upperarm01.R'].head)) + V3.len(V3.sub(skel.bones['wrist.R'].head, skel.bones['lowerarm01.R'].head));
  const torso = V3.len(V3.sub(skel.bones['upperarm01.R'].head, skel.bones['upperleg01.R'].head));
  // Bike fit for this body: hips high enough for a 32 degree knee bend at the bottom of the stroke; saddle and
  // hoods move with them (the male figure is the reference the frame was drawn for).
  let bf = FIT.BODY.m;
  if (body !== 'm') {
    const ank = FIT.anklePosition(0, 1), hz = 0.19;
    const d = Math.sqrt(thigh ** 2 + shin ** 2 - 2 * thigh * shin * Math.cos(Math.PI - (32 * Math.PI) / 180));
    const hy = ank[1] + Math.sqrt(d * d - (hz - ank[2]) ** 2);
    const ref = REF.m;
    const drop = FIT.HIP[1] - hy;
    bf = {
      HIP: [0, hy, hz],
      SADDLE: [0, FIT.SADDLE[1] - drop, FIT.SADDLE[2] - (FIT.HIP[2] - hz)],
      HOOD: [0.19, FIT.HOOD[1] - drop * 0.9, FIT.HOOD[2] + (ref.arm - arm) * 0.95 + (ref.torso - torso) * 0.6],
    };
  }
  REF[body] = { arm, torso };
  const fit = { ...RIDER_FIT, hip: bf.HIP, hood: bf.HOOD, shoulderY: bf.HIP[1] + (RIDER_FIT.shoulderY - FIT.HIP[1]) * (torso / (REF.m?.torso ?? torso)) };
  {
    const ank = FIT.anklePosition(0, 1), hip = [FIT.LEG_X, bf.HIP[1], bf.HIP[2]];
    const d = V3.len(V3.sub(ank, hip));
    const inner = Math.acos(Math.max(-1, Math.min(1, (thigh ** 2 + shin ** 2 - d * d) / (2 * thigh * shin))));
    console.log(`rider ${body}: thigh ${thigh.toFixed(3)} shin ${shin.toFixed(3)} arm ${arm.toFixed(3)} torso ${torso.toFixed(3)}; knee flexion at the bottom ${(180 - inner * 180 / Math.PI).toFixed(1)} deg; fit ${JSON.stringify(bf)}`);
  }
  const pts = cyclingPose(skel, fit);
  const posed = skel.skin(rest, mhWeights);
  const B = skel.bones;

  // Runtime bone pivots in the bind (riding) pose.
  const hipMid = V3.scale(V3.add(B['upperleg01.R'].pos, B['upperleg01.L'].pos), 0.5);
  const bones = RIDER_BONES.map((name) => ({
    name,
    parent: PARENT[name] ? boneIndex[PARENT[name]] : -1,
    pos: name === 'root' ? [0, 0, 0] : name === 'pelvis' ? hipMid : B[PIVOT[name]].pos,
  }));

  // Gear (shoes, helmets, glasses) fitted to this head and these feet; parts of the body they cover are dropped.
  const gear = riderGear(skel, { bones: boneIndex });
  const hidden = gear.hides; // (x, y, z) => true if a posed point is inside a shoe

  const W = mapWeights(mhWeights);
  const K = kitFields(mhWeights);
  // Below the shoe collar a face goes if any corner is inside the shoe (so the sock never pokes through).
  const keep = (f) => !(f.v.every((v) => hidden(rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2])) || f.v.some((v) => gear.hidesDeep(rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2])));
  // Face morphs: the same pose applied to the body shaped with extra face targets; only the head moves.
  const morphs = FACE_MORPHS.map((extra) => {
    const restM = toGame(shaped({ ...shape, ...Object.fromEntries(Object.entries(extra).map(([k, w]) => [k, (shape[k] ?? 0) + w])) }));
    const posedM = skel.skin(restM, mhWeights);
    const d = new Float64Array(posed.length);
    for (let i = 0; i < d.length; i++) d[i] = posedM[i] - posed[i];
    return d;
  });
  const near = assemble({ faces: bodyFaces, vt: base.vt, posed, rest, weights: W, kit: K, keep, morphs });

  // Far: the 1591-vertex male proxy, fitted to the same shaped body and pose.
  const proxy = fitted(path.join(SYS, proxyFile), restMH, skel);
  const farW = mapWeights(proxy.w);
  const farK = kitFields(proxy.w);
  const far = assemble({ faces: proxy.obj.faces, vt: proxy.obj.vt, posed: proxy.posed, rest: proxy.rest, weights: farW, kit: farK, keep: (f) => !f.v.every((v) => hidden(proxy.rest[v * 3], proxy.rest[v * 3 + 1], proxy.rest[v * 3 + 2])) });

  // Eyebrows and short hair (trimmed to what shows below a helmet), all on the head bone.
  const brows = fitted(path.join(SYS, 'eyebrows/eyebrow001/eyebrow001.mhclo'), restMH, skel);
  const browMesh = assemble({ faces: brows.obj.faces, vt: brows.obj.vt, posed: brows.posed, weights: mapWeights(brows.w) });
  const hair = fitted(path.join(SYS, hairFile), restMH, skel);
  const underHelmet = gear.underHelmet; // (x, y, z) => true if hidden by the helmet
  const hairMesh = assemble({ faces: hair.obj.faces, vt: hair.obj.vt, posed: hair.posed, weights: mapWeights(hair.w), keep: (f) => !f.v.every((v) => underHelmet(hair.rest[v * 3], hair.rest[v * 3 + 1], hair.rest[v * 3 + 2])) });

  // Baked ambient occlusion: body, helmet, shoes and the bike (saddle, bars) occlude the body.
  {
    const grid = new VoxelGrid([-0.5, 0.0, -1.0], [0.5, 1.8, 0.7], 0.01);
    grid.addTriangles(near.position, near.index);
    for (const k of ['helmet', 'shoes']) grid.addTriangles(gear.meshes[k].position, gear.meshes[k].index);
    const bike = buildBike({ bike: { color: '#888888' }, wheels: { id: 'x', depth: 0.03 }, jersey: { accent: '#ffffff' } }, { frame: 0, rear: 0, front: 0, crank: 0 }, 'near', bf);
    const bp = bike.attributes.position.array;
    grid.addTriangles(bp, Uint32Array.from({ length: bp.length / 3 }, (_, i) => i));
    for (const m of [near, far]) {
      const nrm = Float32Array.from(m.normal, (x) => x / 127);
      const ao = bakeAO(grid, m.position, nrm, m.index, { strength: 0.95 });
      m.ao = Uint8Array.from(ao, (x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
    }
  }

  // Mid: the near body simplified to about a third (for riders 9-28 m away); every attribute rides along.
  const ms = simplify(near.position, Array.from(near.index), Math.round((near.index.length / 3) * 0.34));
  const mid = compactMesh(near, ms.index, ms.keep);

  // Landmarks in the rest pose for the kit shader.
  const R = (n, k = 'head') => restBones[n][k];
  const landmarks = {
    shoulderR: R('upperarm01.R'), elbowR: R('lowerarm01.R'), wristR: R('wrist.R'), knuckleR: R('finger3-1.R'),
    hipR: R('upperleg01.R'), kneeR: R('lowerleg01.R'), ankleR: R('foot.R'),
    neck: R('neck01'), chest: R('spine02'), waist: R('spine04'), pelvis: R('spine05'), headTop: R('head', 'tail'),
  };
  return { skel, pts, bones, near, mid, far, browMesh, hairMesh, gear, landmarks, posed, rest, proxy, fit: bf };
}

const rider = buildRider();
const riderF = buildRider({ shape: RIDER_SHAPE_F, body: 'f', proxyFile: 'proxymeshes/female1605/female1605.proxy', hairFile: 'hair/ponytail01/ponytail01.mhclo' });
const r6 = (v) => (typeof v === 'number' ? +v.toFixed(4) : v);
const meta = {
  source: 'MakeHuman 1.1 base mesh hm08, default skeleton and weights, male1591 and female1605 proxies, short02 and ponytail01 hair (CC0)',
  bodies: {
    m: { bones: rider.bones, landmarks: rider.landmarks, suffix: '', fit: rider.fit },
    f: { bones: riderF.bones, landmarks: riderF.landmarks, suffix: 'F', fit: riderF.fit },
  },
  gear: rider.gear.meta,
};
const sfx = (o, x) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k + x, v]));
const meshes = {
  body: rider.near, bodyMid: rider.mid, bodyFar: rider.far, hair: rider.hairMesh, ...rider.gear.meshes,
  ...sfx({ body: riderF.near, bodyMid: riderF.mid, bodyFar: riderF.far, hair: riderF.hairMesh, ...riderF.gear.meshes }, 'F'),
};
const bin = pack(JSON.parse(JSON.stringify(meta, (k, v) => r6(v))), meshes);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'rider.bin'), bin);
console.log('rider.bin', (bin.length / 1024).toFixed(0), 'KB;', Object.entries(meshes).map(([k, m]) => `${k} ${m.count}v ${m.index.length / 3}t`).join(', '));

// ---- Spectators -------------------------------------------------------------------------------------------
if (!args.includes('--no-crowd')) {
  const crowd = buildCrowd({ base, shaped, skelDef, mhWeights, SYS });
  const cbin = pack({ source: 'MakeHuman 1.1 bodies, clothes, shoes, hair and eyes (CC0)', ...crowd.meta }, crowd.meshes);
  fs.writeFileSync(path.join(OUT, 'crowd.bin'), cbin);
  fs.writeFileSync(path.join(ROOT, 'scripts/people/crowd-atlas.json'), JSON.stringify(crowd.atlasLayout, null, 1));
  console.log('crowd.bin', (cbin.length / 1024).toFixed(0), 'KB');
  if (DEBUG) {
    for (const [k, m] of Object.entries(crowd.meshes)) {
      fs.writeFileSync(path.join(DEBUG, 'crowd-' + k.replace(':', '-') + '.json'), JSON.stringify({ position: Array.from(m.position), index: Array.from(m.index), uv: Array.from(m.uv, (x) => x / 65535) }));
    }
  }
}

if (DEBUG) {
  fs.mkdirSync(DEBUG, { recursive: true });
  const PAL = { 1: [0.92, 0.92, 0.9], 2: [0.05, 0.05, 0.05], 3: [0.8, 0.1, 0.1], 4: [0.1, 0.1, 0.1], 5: [0.6, 0.1, 0.1], 6: [0.2, 0.2, 0.2],
    10: [0.9, 0.9, 0.88], 11: [0.15, 0.15, 0.16], 12: [0.03, 0.03, 0.03], 13: [0.12, 0.12, 0.12], 14: [0.05, 0.05, 0.05], 15: [0.3, 0.3, 0.3], 20: [0.05, 0.08, 0.1], 21: [0.02, 0.02, 0.02] };
  const dump = (name, m) => {
    const position = Array.from(m.position), index = Array.from(m.index);
    const uv = m.uv ? Array.from(m.uv, (x) => x / 65535) : undefined;
    const normal = m.normal ? Array.from(m.normal, (x) => x / 127) : undefined;
    const color = m.region ? Array.from(m.region).flatMap((r) => PAL[r] ?? [1, 0, 1]) : m.ao ? Array.from(m.ao).flatMap((a) => [a / 255, a / 255, a / 255]) : undefined;
    fs.writeFileSync(path.join(DEBUG, name + '.json'), JSON.stringify({ position, index, uv, normal, color }));
  };
  dump('rider-near', rider.near);
  dump('rider-mid', rider.mid);
  dump('riderF-near', riderF.near);
  dump('riderF-hair', riderF.hairMesh);
  for (const [k, m] of Object.entries(riderF.gear.meshes)) dump('gearF-' + k, m);
  dump('rider-far', rider.far);
  dump('rider-hair', rider.hairMesh);
  for (const [k, m] of Object.entries(rider.gear.meshes)) dump('gear-' + k, m);
  console.log('debug meshes written');
}
