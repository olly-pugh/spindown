// A cyclist on an aero road bike. The body is a MakeHuman figure (CC0; built and posed on the bike by
// scripts/people/build-people.mjs) skinned to a small skeleton; the kit is drawn per pixel by people/kit.js.
// The helmet, glasses and shoes are fitted to the same head and feet. The bike (bike.js), the gear and the
// pedals share one geometry and material, so a rider costs three draw calls (body, hair, bike and gear).
//
// Each frame the legs are solved with two-bone IK so the feet stay on the pedals through the stroke (with
// ankling), the hips and shoulders sway a little with each stroke, the arms are solved so the hands stay on the
// hoods, and the head steadies itself and looks about now and then. Three levels of detail: the full figure
// near the camera, a body simplified to a third with a lighter bike in the middle distance, and a 3k-triangle
// body beyond. Units are metres; the rider faces -z.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { blobTexture } from './textures.js';
import { buildBike, bikeAtlas } from './bike.js';
import { riderAssets, hairTexture } from './people/assets.js';
import { kitMaterial } from './people/kit.js';
import * as FIT from './people/fit.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const A = (a) => V(a[0], a[1], a[2]);

// ---- Shared materials ----------------------------------------------------------------------------------------
const shared = new Map();
function sharedMaterial(kind, make) {
  if (!shared.has(kind)) shared.set(kind, make());
  return shared.get(kind);
}
/** Bike and gear: vertex colours, per-vertex roughness/metalness ('surf'), decals from the atlas. */
function bikeMaterial() {
  return sharedMaterial('bike', () => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: bikeAtlas(), roughness: 1, metalness: 1, envMapIntensity: 1.1 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 surf;\nvarying vec2 vSurf;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvSurf = surf;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vSurf;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vSurf.x;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vSurf.y;');
    };
    m.customProgramCacheKey = () => 'spindown-bike-v1';
    return m;
  });
}
function ghostMaterial() {
  return sharedMaterial('ghost', () => new THREE.MeshStandardMaterial({ color: '#bfefff', roughness: 0.5, metalness: 0, transparent: true, opacity: 0.36, depthWrite: false, emissive: new THREE.Color('#5ad1ff'), emissiveIntensity: 0.4 }));
}
/**
 * A pacer's ghost: unlit and see-through in its own colour, glowing brightest at the silhouette (a Fresnel rim),
 * and fading away when the camera is right on top of it so it never hides you. One per colour, shared.
 */
const pacerMaterials = new Map();
function pacerGhostMaterial(hex) {
  if (!pacerMaterials.has(hex)) {
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex), transparent: true, depthWrite: false, toneMapped: false, fog: true });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRimN;\nvarying vec3 vRimV;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvRimN = normalize(transformedNormal);\nvRimV = -mvPosition.xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vRimN;\nvarying vec3 vRimV;')
        .replace('#include <opaque_fragment>', `float rimDist = length(vRimV);
float facing = abs(dot(normalize(vRimN), vRimV / rimDist));
float rim = pow(1.0 - facing, 2.2);
outgoingLight = diffuseColor.rgb * (0.55 + 1.7 * rim) + vec3(rim * rim * 0.5);
diffuseColor.a = (0.2 + 0.75 * rim) * smoothstep(2.0, 6.0, rimDist);
#include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'spindown-pacer-ghost-v1';
    pacerMaterials.set(hex, m);
  }
  return pacerMaterials.get(hex);
}
function shadowMaterial() {
  return sharedMaterial('shadow', () => new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, toneMapped: false, color: '#000000' }));
}
const hairMaterials = new Map();
function hairMaterial(hex, kind) {
  const key = `${hex}|${kind}`;
  if (!hairMaterials.has(key)) {
    hairMaterials.set(key, new THREE.MeshStandardMaterial({ color: new THREE.Color(hex).multiplyScalar(1.6), map: hairTexture(kind), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.65, metalness: 0 }));
  }
  return hairMaterials.get(key);
}
const kitMaterials = new Map();
/** Some men have stubble (0.35) or a beard (1), picked from their looks so a rider keeps his. */
function beardFor(body, skin, hair) {
  if (body !== 'm') return 0;
  const h = [...`${skin}${hair}`].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % 100;
  return h < 30 ? 0.35 : h < 45 ? 1 : 0;
}
function kitMat(kit, skin, landmarks, body, hair) {
  const beard = beardFor(body, skin, hair);
  const key = `${kit.jersey.id}|${skin}|${body}|${hair}|${beard}`;
  if (!kitMaterials.has(key)) kitMaterials.set(key, kitMaterial(kit, skin, landmarks, { beard, hair }));
  return kitMaterials.get(key);
}

// ---- Gear painting --------------------------------------------------------------------------------------------
/** Colours and surfaces of the gear regions (see scripts/people/gear.mjs) for a kit. */
function gearPaint(kit, regions) {
  const G = regions;
  const helmet = new THREE.Color(kit.helmet.color);
  const darkHelmet = helmet.r + helmet.g + helmet.b < 0.25;
  const shoe = new THREE.Color(darkHelmet ? '#ececea' : '#1b1c1f');
  const accent = new THREE.Color(kit.jersey.accent);
  // Lenses: smoke, or a mirror in blue, orange-gold, red or green; frames black, white or the accent.
  const h = [...`${kit.helmet.id}${kit.bike.id}${kit.jersey.id}`].reduce((a, ch) => (a * 33 + ch.charCodeAt(0)) >>> 0, 5);
  const lens = new THREE.Color(['#0d1a24', '#163a6e', '#8a4a12', '#6e1820', '#0f3d2a', '#0d1a24', '#2a2f36'][h % 7]);
  const frame = new THREE.Color(['#101010', '#e9e9e6', '#101010', kit.jersey.accent, '#101010'][(h >> 3) % 5]);
  const P = {
    [G.SHOE]: [shoe, [0.38, 0]], [G.SOLE]: [new THREE.Color('#121212'), [0.45, 0.1]], [G.SHOE_ACCENT]: [accent, [0.4, 0]], [G.DIAL]: [new THREE.Color('#1a1a1a'), [0.3, 0.3]],
    [G.CLEAT]: [new THREE.Color('#b51d1d'), [0.5, 0]], [G.HEEL_PAD]: [new THREE.Color('#222224'), [0.6, 0]],
    [G.SHELL]: [helmet, [0.22, 0.02]], [G.SHELL_DARK]: [helmet.clone().multiplyScalar(0.6), [0.3, 0.0]], [G.VENT]: [new THREE.Color('#111112'), [0.7, 0]],
    [G.FOAM]: [new THREE.Color('#2a2b2d'), [0.85, 0]], [G.RIM]: [new THREE.Color('#2a2b2d'), [0.85, 0]], [G.STRAP]: [new THREE.Color('#141414'), [0.7, 0]],
    [G.BUCKLE]: [new THREE.Color('#2b2b2b'), [0.4, 0.2]], [G.PAD]: [new THREE.Color('#202020'), [0.9, 0]],
    [G.LENS]: [lens, [0.05, 0.9]], [G.FRAME]: [frame, [0.35, 0.1]],
  };
  return P;
}

/** A gear geometry painted for a kit, ready to merge with the bike: colour, surf, uv (white), skin attributes. */
function paintGear(geo, paint, { soleEdge = false } = {}) {
  const n = geo.attributes.position.count;
  const reg = geo.attributes.region.array;
  const edge = soleEdge ? geo.attributes.edge : null;
  const col = new Float32Array(n * 3), surf = new Float32Array(n * 2), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    let r = reg[i];
    if (edge) {
      // Height above the bottom of the sole (metres): sole, then a coloured welt line, then the upper.
      const h = edge.getX(i) / 10;
      if (r === 1 || r === 6) r = h < 0.0062 ? 2 : r;
    }
    const [c, s] = paint[r] ?? paint[1];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    surf[i * 2] = s[0]; surf[i * 2 + 1] = s[1];
    uv[i * 2] = 0.99; uv[i * 2 + 1] = 0.02;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(geo.attributes.position.array, 3));
  const nn = geo.attributes.normal, N = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { N[i * 3] = nn.getX(i); N[i * 3 + 1] = nn.getY(i); N[i * 3 + 2] = nn.getZ(i); }
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('surf', new THREE.BufferAttribute(surf, 2));
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) { SI[i] = si.array[i]; SW[i] = sw.array[i] / 255; }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4));
  g.setIndex(Array.from(geo.index.array));
  return g.toNonIndexed();
}

/** Clipless pedals under the cleats, carried by the feet (modelled at the bind crank angle). */
function pedals(bones) {
  const out = [];
  for (const [s, bone] of [[1, bones.footR], [-1, bones.footL]]) {
    const a = FIT.BIND_CRANK + (s > 0 ? 0 : Math.PI);
    const at = V(FIT.PEDAL_X * s, FIT.BB[1] - Math.cos(a) * FIT.CRANK, FIT.BB[2] + Math.sin(a) * FIT.CRANK);
    const pitch = FIT.footPitch(a);
    const body = new THREE.BoxGeometry(0.066, 0.011, 0.082);
    body.translate(0, -0.004, -0.008).rotateX(-pitch).translate(at.x, at.y, at.z);
    const spindle = new THREE.CylinderGeometry(0.006, 0.006, 0.05, 8).rotateZ(Math.PI / 2).translate(at.x - 0.02 * s, at.y, at.z);
    for (const [geo, colour, surf] of [[body, '#151618', [0.4, 0.1]], [spindle, '#b8bcc0', [0.3, 0.85]]]) {
      const g = geo.toNonIndexed();
      g.deleteAttribute('uv');
      const n = g.attributes.position.count;
      const c = new THREE.Color(colour);
      const col = new Float32Array(n * 3), sf = new Float32Array(n * 2), uv = new Float32Array(n * 2), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        col.set([c.r, c.g, c.b], i * 3);
        sf.set(surf, i * 2);
        uv.set([0.99, 0.02], i * 2);
        si[i * 4] = bone;
        sw[i * 4] = 1;
      }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('surf', new THREE.BufferAttribute(sf, 2));
      g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
      out.push(g);
    }
  }
  return out;
}

/** Bike + gear + pedals for a kit and level of detail, cached (kits repeat across riders). */
const bikeCache = new Map();
/** Riders further than this (m) from the camera, though in the detailed set, use the middle level. */
const MID_FROM = 9;

function bikeAndGear(kit, lod, boneIdx, assets, body) {
  const key = `${body}|${lod}|${kit.bike.id}|${kit.bike.color}|${kit.wheels.id}|${kit.helmet.id}|${kit.jersey.accent}`;
  if (bikeCache.has(key)) return bikeCache.get(key);
  const geos = assets.geometries, regions = assets.meta.gear.regions;
  const B = assets.meta.bodies[body], b = B.suffix;
  const paint = gearPaint(kit, regions);
  const aero = (kit.helmet.aero ?? 1) < 1;
  const lodS = lod === 'near' ? '' : 'Far'; // mid and far share the light helmet, glasses and shoes
  const g = (name) => geos[name + lodS + b] ?? geos[name + b];
  const parts = [
    buildBike(kit, { frame: boneIdx.root, rear: boneIdx.rear, front: boneIdx.front, crank: boneIdx.crank }, lod, B.fit),
    paintGear(g(aero ? 'helmetAero' : 'helmet'), paint),
    paintGear(g('glasses'), paint),
    paintGear(g('shoes'), paint, { soleEdge: true }),
    ...pedals({ footR: boneIdx['foot.R'], footL: boneIdx['foot.L'] }),
  ];
  for (const p of parts) for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'uv', 'color', 'surf', 'skinIndex', 'skinWeight'].includes(k)) p.deleteAttribute(k);
  const merged = compact(mergeVertices(mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false), 1e-5));
  merged.computeBoundingSphere();
  bikeCache.set(key, merged);
  return merged;
}

/** Moves a body geometry's morph attributes (morph0..2) into morphAttributes, once. */
export const MORPH_SCALE = 0.05;
function faceMorphs(geo) {
  if (geo.userData.morphsReady) return geo;
  const list = [];
  for (let k = 0; geo.attributes['morph' + k]; k++) {
    list.push(geo.attributes['morph' + k]);
    geo.deleteAttribute('morph' + k);
  }
  if (list.length) {
    geo.morphAttributes.position = list;
    geo.morphTargetsRelative = true;
  }
  geo.userData.morphsReady = true;
  return geo;
}

/**
 * Smaller vertex data for a merged bike: 16-bit normals and colours, 8-bit surface, bone indices and weights
 * (about 40 bytes a vertex instead of 76; the geometry is also indexed, so 4-5 times fewer vertices).
 */
function compact(g) {
  const q = (name, Type, scale, normalized) => {
    const a = g.attributes[name];
    if (!a) return;
    const out = new Type(a.array.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(a.array[i] * scale);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize, normalized));
  };
  q('normal', Int16Array, 32767, true);
  q('color', Uint16Array, 65535, true);
  q('surf', Uint8Array, 255, true);
  q('skinIndex', Uint8Array, 1, false);
  q('skinWeight', Uint8Array, 255, true);
  return g;
}

// ---- IK helpers ------------------------------------------------------------------------------------------------
const _a = V(0, 0, 0), _b = V(0, 0, 0), _c = V(0, 0, 0);
/** Two-bone IK: the middle joint for root -> joint -> end of lengths a, b reaching target, bending towards pole. */
function ikJoint(root, target, a, b, pole, out) {
  const d = _a.copy(target).sub(root);
  const dist = Math.min(a + b - 1e-5, Math.max(Math.abs(a - b) + 1e-5, d.length()));
  d.normalize();
  const x = (a * a - b * b + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, a * a - x * x));
  const p = _b.copy(pole).addScaledVector(d, -pole.dot(d)).normalize();
  return out.copy(root).addScaledVector(d, x).addScaledVector(p, h);
}
/** Rotation taking unit vector `from` to `to`, applied after `base` (all rider space). */
const between = (from, to, out) => out.setFromUnitVectors(_c.copy(from).normalize(), _a.copy(to).normalize());

/**
 * Builds a rider. kit: {jersey, helmet, bike, wheels} from content.js. options: {ghost, skin, hair, shadows}.
 */
export class RiderModel {
  constructor(kit, { ghost = false, ghostColour = null, skin = '#e0ac8a', hair = '#3a2718', shadows = true, body = 'm' } = {}) {
    const assets = riderAssets();
    const meta = { ...assets.meta, ...(assets.meta.bodies[body] ?? assets.meta.bodies.m) };
    if (!assets.meta.bodies[body]) body = 'm';
    this.body = body;
    const sfx = meta.suffix;
    this.root = new THREE.Group();
    this.lean = new THREE.Group(); // rolls about the tyre contact line
    this.root.add(this.lean);
    this.seed = Math.random() * 100;

    // ---- Skeleton: the body's bones from the pack (bind = riding pose, identity rotations), then the bike's ----
    const bones = [], byName = {};
    meta.bones.forEach((b, i) => {
      const bone = new THREE.Bone();
      bone.name = b.name;
      const parent = b.parent >= 0 ? meta.bones[b.parent] : null;
      bone.position.set(b.pos[0] - (parent ? parent.pos[0] : 0), b.pos[1] - (parent ? parent.pos[1] : 0), b.pos[2] - (parent ? parent.pos[2] : 0));
      if (b.parent >= 0) bones[b.parent].add(bone);
      bones.push(bone);
      byName[b.name] = i;
    });
    const bikeBone = (name, at) => {
      const bone = new THREE.Bone();
      bone.name = name;
      bone.position.copy(at);
      bones[0].add(bone);
      bones.push(bone);
      byName[name] = bones.length - 1;
      return bone;
    };
    bikeBone('rear', A(FIT.REAR));
    bikeBone('front', A(FIT.FRONT));
    bikeBone('crank', A(FIT.BB));
    this.lean.add(bones[0]);
    this.bones = bones;
    this.byName = byName;
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(bones);
    // Bind-pose rider-space positions of every joint (for IK targets and lengths).
    this.bind = meta.bones.map((b) => A(b.pos));
    const P = (n) => this.bind[byName[n]];
    this.legs = ['R', 'L'].map((s) => ({
      side: s === 'R' ? 1 : -1,
      thigh: bones[byName[`thigh.${s}`]], shin: bones[byName[`shin.${s}`]], foot: bones[byName[`foot.${s}`]],
      hip: P(`thigh.${s}`), knee: P(`shin.${s}`), ankle: P(`foot.${s}`),
      a: P(`shin.${s}`).distanceTo(P(`thigh.${s}`)), b: P(`foot.${s}`).distanceTo(P(`shin.${s}`)),
      bindPitch: FIT.footPitch(FIT.BIND_CRANK + (s === 'R' ? 0 : Math.PI)),
    }));
    this.arms = ['R', 'L'].map((s) => ({
      clav: bones[byName[`clavicle.${s}`]], upper: bones[byName[`upperarm.${s}`]], fore: bones[byName[`forearm.${s}`]], hand: bones[byName[`hand.${s}`]],
      shoulder: P(`upperarm.${s}`), elbow: P(`forearm.${s}`), wrist: P(`hand.${s}`),
      a: P(`forearm.${s}`).distanceTo(P(`upperarm.${s}`)), b: P(`hand.${s}`).distanceTo(P(`forearm.${s}`)),
    }));
    this.B = Object.fromEntries(['pelvis', 'spine', 'chest', 'neck', 'head', 'rear', 'front', 'crank'].map((n) => [n, bones[byName[n]]]));
    this.pivot = Object.fromEntries(['pelvis', 'spine', 'chest', 'neck', 'head'].map((n) => [n, P(n)]));

    // ---- Meshes ----
    const sphere = new THREE.Sphere(V(0, 0.85, -0.1), 1.4);
    const make = (geo, mat, cast = true) => {
      const m = new THREE.SkinnedMesh(geo, mat);
      m.bind(this.skeleton, new THREE.Matrix4());
      m.boundingSphere = sphere;
      m.frustumCulled = true;
      m.castShadow = cast && shadows && !ghost;
      m.receiveShadow = false;
      this.lean.add(m);
      return m;
    };
    const G = assets.geometries;
    const ghostMat = ghostColour ? pacerGhostMaterial(ghostColour) : ghostMaterial();
    const bodyMat = ghost ? ghostMat : kitMat(kit, skin, meta.landmarks, body, hair);
    const gearMat = ghost ? ghostMat : bikeMaterial();
    // Pacer ghosts never use the full-detail figure: the middle level is plenty for a see-through glow.
    this.lite = !!ghostColour;
    this.beard = ghost ? 0 : beardFor(body, skin, hair);
    const nearBody = this.lite ? null : make(faceMorphs(G['body' + sfx]), bodyMat);
    // A face of their own: a mix of the face shapes, picked from their looks (so a rider keeps theirs).
    if (nearBody?.morphTargetInfluences) {
      const h = [...`${skin}${hair}${body}`].reduce((a, ch) => (a * 131 + ch.charCodeAt(0)) >>> 0, 11);
      const r = (k) => ((h >>> (k * 5)) % 97) / 96;
      const S = MORPH_SCALE;
      nearBody.morphTargetInfluences[0] = (r(0) * 1.3 - 0.35) * S;
      nearBody.morphTargetInfluences[1] = (r(1) * 1.3 - 0.35) * S;
      nearBody.morphTargetInfluences[2] = r(2) * r(2) * S;
    }
    this.near = this.lite ? [] : [nearBody, make(bikeAndGear(kit, 'near', byName, assets, body), gearMat)];
    if (!ghost) this.near.push(make(G['hair' + sfx], hairMaterial(hair, body === 'f' ? 'ponytail' : 'short'), false));
    this.mid = [make(faceMorphs(G['bodyMid' + sfx] ?? G['body' + sfx]), bodyMat), make(bikeAndGear(kit, 'mid', byName, assets, body), gearMat)];
    if (!ghost) this.mid.push(make(G['hair' + sfx], hairMaterial(hair, body === 'f' ? 'ponytail' : 'short'), false));
    if (this.mid[0].morphTargetInfluences && nearBody?.morphTargetInfluences) this.mid[0].morphTargetInfluences = nearBody.morphTargetInfluences;
    this.far = [make(G['bodyFar' + sfx], bodyMat), make(bikeAndGear(kit, 'far', byName, assets, body), gearMat)];
    this.detail = null;
    this.setDetail(true);
    if (!ghost) {
      // A soft contact shadow, so the bike sits on the road even where there is no sun.
      this.blob = new THREE.Mesh(blobGeometry(), shadowMaterial());
      this.blob.renderOrder = 2;
      this.root.add(this.blob);
    }
    this.setPose(0, 0, 0);
  }

  /**
   * Full detail close to the camera, a light version further away. near: whether this rider may use the detailed
   * body at all; distance (m, optional): from it, the middle level is used beyond MID_FROM.
   */
  setDetail(near, distance = 0) {
    let level = !near ? 'far' : distance > MID_FROM ? 'mid' : 'near';
    if (this.lite && level === 'near') level = 'mid';
    if (this.detail === level) return;
    this.detail = level;
    for (const k of ['near', 'mid', 'far']) for (const m of this[k]) m.visible = k === level;
  }

  /** crank: crank angle (rad), wheel: wheel angle (rad), lean: roll (rad, positive leaning right). */
  setPose(crank, wheel, lean) {
    const B = this.B;
    B.crank.rotation.x = -crank;
    B.rear.rotation.x = -wheel;
    B.front.rotation.x = -wheel;
    this.lean.rotation.z = -lean;
    const t = performance.now() / 1000 + this.seed;
    const s1 = Math.sin(crank);

    // Rider-space rotations of the trunk: hips rock with the stroke, the chest counters a little, the head
    // steadies itself and now and then glances about.
    const rq = (x, y, z, out) => out.setFromEuler(_e.set(x, y, z, 'YXZ'));
    const qPelvis = rq(0, 0.012 * s1, 0.024 * s1, _qp);
    const qSpine = rq(0.004 * Math.sin(2 * crank), 0.006 * s1, 0.014 * s1, _qs);
    const breathe = 0.006 * Math.sin(t * 2.6);
    const qChest = rq(breathe, -0.01 * s1, 0.006 * s1, _qc);
    const glance = Math.sin(t * 0.21) > 0.93 ? Math.sin(t * 0.21 * 7) * 0.32 : 0;
    const qHead = rq(0.012 * Math.sin(2 * crank + 0.6) - breathe, 0.05 * Math.sin(t * 0.37) + glance, -0.01 * s1, _qh);
    const local = (bone, parentQ, q) => bone.quaternion.copy(parentQ).invert().multiply(q);
    local(B.pelvis, _id, qPelvis);
    local(B.spine, qPelvis, qSpine);
    local(B.chest, qSpine, qChest);
    local(B.neck, qChest, qChest);
    local(B.head, qChest, qHead);

    // Rider-space positions of the trunk joints (bones translate with their parents' rotations).
    const pv = this.pivot;
    const place = (pivotChild, pivotParent, parentPos, parentQ, out) => out.copy(pivotChild).sub(pivotParent).applyQuaternion(parentQ).add(parentPos);
    const pelvisPos = pv.pelvis;
    const spinePos = place(pv.spine, pv.pelvis, pelvisPos, qPelvis, _sp);
    const chestPos = place(pv.chest, pv.spine, spinePos, qSpine, _cp);

    // Legs: feet on the pedals.
    for (const L of this.legs) {
      const a = crank + (L.side > 0 ? 0 : Math.PI);
      const ankle = FIT.anklePosition(a, L.side, _ank);
      _ankV.set(ankle[0], ankle[1], ankle[2]);
      const hip = place(L.hip, pv.pelvis, pelvisPos, qPelvis, _hip);
      // Knee pole: forward, and out as it is at the bind pose.
      _pole.copy(L.knee).sub(L.hip).normalize().add(_fwd).normalize();
      const knee = ikJoint(hip, _ankV, L.a, L.b, _pole, _knee);
      between(_d1.copy(L.knee).sub(L.hip), _d2.copy(knee).sub(hip), _qt);
      between(_d1.copy(L.ankle).sub(L.knee), _d2.copy(_ankV).sub(knee), _qsh);
      _qf.setFromAxisAngle(_x, -(FIT.footPitch(a) - L.bindPitch));
      local(L.thigh, qPelvis, _qt);
      local(L.shin, _qt, _qsh);
      local(L.foot, _qsh, _qf);
    }
    // Arms: shoulders ride on the chest, the hands stay on the hoods.
    for (const R of this.arms) {
      local(R.clav, qChest, qChest);
      const sh = place(R.shoulder, pv.chest, chestPos, qChest, _sh);
      _pole.copy(R.elbow).sub(R.shoulder).normalize(); // elbows keep bending the way they do at the bind pose
      const el = ikJoint(sh, R.wrist, R.a, R.b, _pole, _el);
      between(_d1.copy(R.elbow).sub(R.shoulder), _d2.copy(el).sub(sh), _qu);
      between(_d1.copy(R.wrist).sub(R.elbow), _d2.copy(R.wrist).sub(el), _qfo);
      local(R.upper, qChest, _qu);
      local(R.fore, _qu, _qfo);
      local(R.hand, _qfo, _id);
    }
  }

  dispose() {
    this.skeleton.dispose();
  }
}
const _e = new THREE.Euler(), _id = new THREE.Quaternion();
const _qp = new THREE.Quaternion(), _qs = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _qh = new THREE.Quaternion();
const _qt = new THREE.Quaternion(), _qsh = new THREE.Quaternion(), _qf = new THREE.Quaternion(), _qu = new THREE.Quaternion(), _qfo = new THREE.Quaternion();
const _sp = V(0, 0, 0), _cp = V(0, 0, 0), _hip = V(0, 0, 0), _knee = V(0, 0, 0), _ankV = V(0, 0, 0), _ank = [0, 0, 0], _pole = V(0, 0, 0), _fwd = V(0, 0, -1);
const _d1 = V(0, 0, 0), _d2 = V(0, 0, 0), _sh = V(0, 0, 0), _el = V(0, 0, 0), _x = V(1, 0, 0);

let blobGeo = null;
function blobGeometry() {
  if (!blobGeo) blobGeo = new THREE.PlaneGeometry(0.9, 2.5).rotateX(-Math.PI / 2).translate(0, 0.012, -0.09);
  return blobGeo;
}

export const RIDER_DIMENSIONS = { WHEEL_R: FIT.WHEEL_R, length: 1.75 };
