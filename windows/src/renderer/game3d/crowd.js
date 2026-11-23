// Roadside spectators: MakeHuman people (CC0; built by scripts/people/build-people.mjs) of different ages and
// builds, in jeans, tees, shirts, a jacket, overalls, a blouse and skirt or sportswear, with real hair and shoes;
// kids among them; some with a Yorkshire flag. Each person is posed in two key frames and the vertex shader
// blends between them on a shared clock (each with their own timing and energy), so they cheer, wave, clap,
// film on a phone or stand about. Each instance has its own top, trouser, skin and hair colours.
//
// Three levels of detail, chosen per person in the vertex shader from the camera distance: the clothed, textured
// figures within 16 m (5-8k triangles), a 1.5k-triangle body coloured from the outfit to 55 m, and a
// 440-triangle one beyond (9 and 40 m on low graphics, 22 and 70 m on high). Instanced in chunks with distance culling: a few draw calls for hundreds of people.
import * as THREE from 'three';
import crowdBin from './people/crowd.bin';
import atlasUrl from './people/crowd-atlas.jpg';
import maskUrl from './people/crowd-mask.png';
import { unpack } from './people/pack.js';

/** Seconds, advanced by the scene each frame. */
export const CROWD_TIME = { value: 0 };
/** Camera position (world), set by the scene each frame: each person picks their level of detail from it. */
export const CROWD_CAMERA = { value: new THREE.Vector3() };
/** Where the levels of detail change (m), by graphics quality; shared by every crowd material. */
const RANGES = { low: [9, 40], medium: [16, 55], high: [22, 70] };
const LOD_NEAR = { value: 16 }, LOD_FAR = { value: 55 };
/** Call before building a world: the crowd's level-of-detail ranges for this quality ('low'|'medium'|'high'). */
export function setCrowdDetail(quality) {
  [LOD_NEAR.value, LOD_FAR.value] = RANGES[quality] ?? RANGES.medium;
}

const TOPS = ['#24479c', '#b33a3a', '#34704a', '#e0ac1a', '#6a7076', '#ece6d4', '#7a4a8e', '#127c90', '#cf6a12', '#32485a', '#d65f8c', '#8a5a34', '#1d7f46', '#f2f2f2', '#c8102e', '#1b1b1d', '#5b7fb5'];
const BOTTOMS = ['#26324a', '#33343a', '#5a4e44', '#46597a', '#1f2328', '#6b6f73', '#3d3a36', '#7a6a52'];
const SKINS = ['#f1c7a5', '#e0ac8a', '#c68863', '#8d5a3b', '#f5d2b8', '#a86f4c', '#e8b897', '#6b4630'];
const HAIRS = ['#3a2718', '#7a5632', '#d2ae6a', '#222222', '#a7a7a7', '#5a3a22', '#a65e2e', '#141210', '#c9c3b8'];

/** Per pose: blend rate (rad/s) and how much they bounce (m). */
const MOTION = { cheer: [6.5, 0.035], wave: [7.5, 0], clap: [10, 0.008], flag: [3.2, 0.012], phone: [0.8, 0], folded: [0.6, 0], hips: [0.6, 0], down: [0.7, 0] };

let data = null;
function crowdData() {
  if (!data) {
    const { meta, geometries } = unpack(crowdBin);
    data = { meta, geometries, stats: new Map() };
    const loader = new THREE.TextureLoader();
    data.atlas = loader.load(atlasUrl, (t) => measure(t));
    data.atlas.colorSpace = THREE.SRGBColorSpace;
    data.atlas.anisotropy = 4;
    data.mask = loader.load(maskUrl);
    data.mask.colorSpace = THREE.NoColorSpace;
  }
  return data;
}

/** Mean colours per variant part (from the atlas at the parts' vertices), so tints set the average colour. */
function measure(tex) {
  const img = tex.image, W = 512, H = 640;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  const lin = (v) => (v / 255) ** 2.2;
  for (const v of data.meta.variants) {
    const geo = data.geometries[v.name];
    const uv = geo.attributes.uv, part = geo.attributes.part;
    const acc = {};
    for (let i = 0; i < uv.count; i += 3) {
      const p = part.getX(i);
      const x = Math.min(W - 1, Math.floor(uv.getX(i) * W)), y = Math.min(H - 1, Math.floor((1 - uv.getY(i)) * H));
      const o = (y * W + x) * 4;
      const a = acc[p] ?? (acc[p] = [0, 0, 0, 0]);
      a[0] += lin(px[o]); a[1] += lin(px[o + 1]); a[2] += lin(px[o + 2]); a[3]++;
    }
    const mean = (p) => (acc[p] ? acc[p].slice(0, 3).map((x) => x / acc[p][3]) : [0.5, 0.5, 0.5]);
    const lum = (m) => Math.max(0.03, m[0] * 0.3 + m[1] * 0.59 + m[2] * 0.11);
    // Every variant, used yet or not: a world built later shares these uniforms.
    const s = variantStats(v.name);
    s.topLum.value = lum(mean(1));
    s.botLum.value = lum(mean(2));
    s.skinMean.value.setRGB(...mean(0));
  }
}

function variantStats(name) {
  if (!data.stats.has(name)) data.stats.set(name, { topLum: { value: 0.4 }, botLum: { value: 0.2 }, skinMean: { value: new THREE.Color(0.7, 0.48, 0.38) } });
  return data.stats.get(name);
}

/** Vertex shader patch shared by the colour and shadow materials: key-frame blend, hop, sway, flag ripple, LOD. */
function patchVertex(sh, variant, lod) {
  const d = crowdData();
  const [rate, bounce] = MOTION[variant.arms] ?? MOTION.down;
  Object.assign(sh.uniforms, { uTime: CROWD_TIME, uCam: CROWD_CAMERA, uNear: LOD_NEAR, uFar: LOD_FAR, uRate: { value: rate }, uBounce: { value: bounce }, uAtlas: { value: d.atlas } });
  const near = lod === 'near';
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
      attribute vec3 positionB;
      attribute vec3 normalB;
      attribute float part;
      attribute vec4 iMisc; // phase, energy, tint trousers, spare
      uniform float uTime, uRate, uBounce;
      uniform vec3 uCam;
      uniform float uNear, uFar;
      float crowdBlend() { return 0.5 + 0.5 * sin(uTime * uRate * (0.85 + 0.3 * iMisc.y) + iMisc.x); }
      // Level of detail per person: the clothed figure inside uNear, the light body to uFar, the lightest beyond.
      float crowdHide() {
      #ifdef USE_INSTANCING
        float camDist = distance((modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz, uCam);
        return ${lod === 'near' ? 'step(uNear, camDist)' : lod === 'far' ? '1.0 - step(uNear, camDist) * (1.0 - step(uFar, camDist))' : '1.0 - step(uFar, camDist)'};
      #else
        return 0.0;
      #endif
      }`)
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      objectNormal = normalize(mix(objectNormal, normalB, crowdBlend()));`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      float cb = crowdBlend();
      float lodHide = crowdHide();
      transformed = mix(position, positionB, cb);
      transformed.y += uBounce * iMisc.y * max(0.0, sin(uTime * uRate * 0.5 + iMisc.x));
      transformed.x += 0.012 * sin(uTime * 0.7 + iMisc.x * 3.0) * smoothstep(0.6, 1.6, transformed.y);
      if (part > 6.5 && part < 7.5) {
        float u = clamp(fract(uv.x * ${(d.meta.atlas.w / 256).toFixed(1)}), 0.0, 1.0);
        transformed.z += u * 0.12 * sin(uTime * 7.0 - u * 6.0 + iMisc.x);
        transformed.y += u * 0.03 * sin(uTime * 5.0 - u * 5.0 + iMisc.x);
      }
      transformed *= 1.0 - lodHide;`);
}

const materials = new Map();
function crowdMaterial(variant, lod) {
  const key = `${variant.name}:${lod}`;
  if (materials.has(key)) return materials.get(key);
  const d = crowdData();
  const st = variantStats(variant.name);
  const near = lod === 'near';
  const m = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, map: near ? d.atlas : null, alphaMap: near ? d.mask : null, alphaTest: near ? 0.5 : 0, side: near ? THREE.DoubleSide : THREE.FrontSide });
  m.onBeforeCompile = (sh) => {
    patchVertex(sh, variant, lod);
    Object.assign(sh.uniforms, { uTopLum: st.topLum, uBotLum: st.botLum, uSkinMean: st.skinMean });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 iTop, iBottom, iSkin, iHair;
        attribute float ao;
        varying float vAO;
        uniform sampler2D uAtlas;
        varying float vPart;
        varying vec3 vTint;
        varying float vTintBottom;
        varying vec3 vFarCol;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vPart = part;
        vAO = ao;
        vTint = part < 0.5 ? iSkin : part < 1.5 ? iTop : part < 2.5 ? iBottom : part < 3.5 ? iHair : part > 9.5 && part < 10.5 ? iTop : part > 10.5 && part < 11.5 ? iBottom : vec3(1.0);
        vTintBottom = iMisc.z;
        ${near ? 'vFarCol = vec3(1.0);' : 'vFarCol = textureLod(uAtlas, uv, 4.0).rgb;'}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTopLum, uBotLum;
        uniform vec3 uSkinMean;
        varying float vAO;
        varying float vPart;
        varying vec3 vTint;
        varying float vTintBottom;
        varying vec3 vFarCol;`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vAO;
        reflectedLight.directDiffuse *= mix(1.0, vAO, 0.3);`)
      .replace('#include <map_fragment>', `${near ? '#include <map_fragment>' : 'diffuseColor.rgb = vFarCol;'}
        {
          vec3 t = diffuseColor.rgb;
          float l = dot(t, vec3(0.3, 0.59, 0.11));
          if (vPart < 0.5) t *= vTint / max(uSkinMean, vec3(0.03));                // skin tone
          else if (vPart < 1.5) t = l / uTopLum * vTint;                               // tops: own colour, folds kept
          else if (vPart < 2.5) t = mix(t, l / uBotLum * vTint, vTintBottom);          // trousers: denim, or a colour
          else if (vPart < 3.5) t = l * vTint * 1.7;                                   // hair
          else if (vPart > 7.5 && vPart < 8.5) t = vec3(0.12);                         // flag pole
          else if (vPart > 8.5 && vPart < 9.5) t = vec3(0.025);                        // phone
          else if (vPart > 9.5 && vPart < 10.5) t = vTint * 0.85;                      // cap, in their colours
          else if (vPart > 10.5 && vPart < 11.5) t = vTint * 1.15 + 0.02;              // knitted beanie
          else if (vPart > 11.5) t = vec3(0.075, 0.045, 0.028);                        // leather bag
          diffuseColor.rgb = t;
        }`);
  };
  m.customProgramCacheKey = () => `spindown-crowd-${lod}-ao`;
  materials.set(key, m);
  return m;
}

/** Shadow (depth) material doing the same vertex work, so shadows move and respect the level of detail. */
const depthMaterials = new Map();
function crowdDepthMaterial(variant) {
  if (depthMaterials.has(variant.name)) return depthMaterials.get(variant.name);
  const d = crowdData();
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaMap: d.mask, alphaTest: 0.5 });
  m.onBeforeCompile = (sh) => patchVertex(sh, variant, 'near');
  m.customProgramCacheKey = () => 'spindown-crowd-depth';
  depthMaterials.set(variant.name, m);
  return m;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const CHUNK = 24;

/** points: [{x, y, z, rot}] (rot faces them across the road). Returns a Group of culled, chunked instances. */
export function crowd(points, { shadows = true, maxDistance = 300 } = {}) {
  const d = crowdData();
  const group = new THREE.Group();
  const variants = d.meta.variants;
  // Fewer kids and flag-wavers than adults.
  const weights = variants.map((v) => (v.age === 'child' ? 0.45 : v.flag ? 0.5 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const pick = (u) => {
    let x = u * total;
    for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) < 0) return i;
    return weights.length - 1;
  };
  const r = rng(99);
  const cells = new Map();
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  for (const p of points) {
    const k = pick(r());
    const key = `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)},${k}`;
    if (!cells.has(key)) cells.set(key, { k, items: [] });
    // Face the road, give or take; heights vary a little.
    q.setFromAxisAngle(up, p.rot + Math.PI + (r() - 0.5) * 0.5);
    const s = 0.94 + r() * 0.12;
    cells.get(key).items.push({
      matrix: new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(s, s, s)),
      top: c.set(TOPS[Math.floor(r() * TOPS.length)]).toArray(),
      bottom: c.set(BOTTOMS[Math.floor(r() * BOTTOMS.length)]).toArray(),
      skin: c.set(SKINS[Math.floor(r() * SKINS.length)]).toArray(),
      hair: c.set(HAIRS[Math.floor(r() * HAIRS.length)]).toArray(),
      misc: [r() * Math.PI * 2, 0.6 + r() * 0.8, r() < 0.3 ? 1 : 0, 0],
    });
  }
  for (const { k, items } of cells.values()) {
    const v = variants[k];
    const meshes = ['near', 'far', 'vfar'].map((lod) => {
      const base = d.geometries[lod === 'near' ? v.name : `${v.name}:${lod}`];
      const g = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(base.attributes)) g.setAttribute(name, a);
      g.setIndex(base.index);
      g.boundingSphere = base.boundingSphere;
      for (const [name, field, size] of [['iTop', 'top', 3], ['iBottom', 'bottom', 3], ['iSkin', 'skin', 3], ['iHair', 'hair', 3], ['iMisc', 'misc', 4]]) {
        g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(items.flatMap((it) => it[field])), size));
      }
      const m = new THREE.InstancedMesh(g, crowdMaterial(v, lod), items.length);
      items.forEach((it, i) => m.setMatrixAt(i, it.matrix));
      m.computeBoundingSphere();
      m.castShadow = shadows && lod === 'near';
      if (m.castShadow) m.customDepthMaterial = crowdDepthMaterial(v);
      m.receiveShadow = false;
      m.userData.centre = m.boundingSphere.center.clone();
      m.userData.radius = m.boundingSphere.radius;
      return m;
    });
    // Each level is drawn only for chunks that can hold someone in its range; the shader picks per person.
    const [mn, mf, mv] = meshes, NEAR = LOD_NEAR.value, FAR = LOD_FAR.value;
    mn.userData.maxDistance = NEAR + mn.userData.radius;
    mn.userData.minDistance = 0;
    mf.userData.maxDistance = FAR + mf.userData.radius;
    mf.userData.minDistance = Math.max(0, NEAR - mf.userData.radius);
    mv.userData.maxDistance = maxDistance;
    mv.userData.minDistance = Math.max(0, FAR - mv.userData.radius);
    group.add(mn, mf, mv);
  }
  group.userData.chunked = true;
  group.userData.people = points.length;
  return group;
}
