// Roadside spectators: smooth people (humans.js) drawn as instances, each with its own clothes, skin and hair
// colours, cheering and waving. The arm and bounce animation runs in the vertex shader from one shared clock,
// so a crowd of hundreds costs a handful of draw calls and no per-frame work in JavaScript. People near the
// camera get the detailed mesh (and cast shadows); the rest a light one.
import * as THREE from 'three';
import { personTemplates, R } from './humans.js';

/** Seconds, advanced by the scene each frame. */
export const CROWD_TIME = { value: 0 };

const TOPS = ['#24479c', '#b33a3a', '#34704a', '#e0ac1a', '#6a7076', '#ece6d4', '#7a4a8e', '#127c90', '#cf6a12', '#32485a', '#d65f8c', '#8a5a34', '#1d7f46', '#f2f2f2', '#c8102e'];
const BOTTOMS = ['#26324a', '#33343a', '#5a4e44', '#46597a', '#1f2328', '#6b6f73', '#3d3a36'];
const SKINS = ['#f1c7a5', '#e0ac8a', '#c68863', '#8d5a3b', '#f5d2b8', '#a86f4c'];
const HAIRS = ['#3a2718', '#7a5632', '#d2ae6a', '#222222', '#a7a7a7', '#5a3a22', '#a65e2e'];

// Region codes the shader understands: 0 keeps the vertex colour (shoes).
const CODE = { [R.TOP]: 1, [R.BOTTOM]: 2, [R.SKIN]: 3, [R.HAIR]: 4, [R.HAT]: 5, [R.LIPS]: 6 };

/** Per-variant animation: arm swing amplitude (rad), rate (rad/s) and how much they bounce (m). */
const MOTION = { cheer: [0.32, 7.5, 0.045], wave: [0.42, 5.5, 0.0], down: [0, 3, 0.0] };

const geometryCache = new Map();
function crowdGeometry(t, lod, k) {
  const key = `${lod}-${k}`;
  if (geometryCache.has(key)) return geometryCache.get(key);
  const n = t.regions.length;
  const region = new Float32Array(n), col = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    region[i] = CODE[t.regions[i]] ?? 0;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 6; // shoes: near black
  }
  const g = t.geometry;
  g.setAttribute('region', new THREE.BufferAttribute(region, 1));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  geometryCache.set(key, g);
  return g;
}

function crowdMaterial(motion) {
  const [amp, rate, bounce] = MOTION[motion];
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = CROWD_TIME;
    shader.uniforms.uAmp = { value: amp };
    shader.uniforms.uRate = { value: rate };
    shader.uniforms.uBounce = { value: bounce };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float arm;
        attribute float region;
        attribute vec3 iTop;
        attribute vec3 iBottom;
        attribute vec3 iSkin;
        attribute vec3 iHair;
        uniform float uTime, uAmp, uRate, uBounce;
        float crowdPhase() { return fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831; }
        vec2 crowdRotate(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        float crowdPh = crowdPhase();
        float crowdAng = uAmp * sin(uTime * uRate + crowdPh) * arm;
        objectNormal.xy = crowdRotate(objectNormal.xy, crowdAng);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        if (abs(arm) > 0.001) {
          vec2 pivot = vec2(sign(arm) * 0.2, 1.425);
          transformed.xy = pivot + crowdRotate(transformed.xy - pivot, crowdAng);
        }
        transformed.y += uBounce * max(0.0, sin(uTime * uRate * 0.5 + crowdPh));`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        if (region > 0.5) {
          vColor.rgb = region < 1.5 ? iTop : region < 2.5 ? iBottom : region < 3.5 ? iSkin : region < 4.5 ? iHair : region < 5.5 ? iTop * 0.75 : iSkin * vec3(0.82, 0.58, 0.56);
        }`);
  };
  m.customProgramCacheKey = () => 'spindown-crowd';
  return m;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const NEAR = 40; // metres: detailed people inside this, light ones beyond
const CHUNK = 48;

/** points: [{x, y, z, rot}] (rot faces them across the road). Returns a Group of culled, chunked instances. */
export function crowd(points, { shadows = true, maxDistance = 300 } = {}) {
  const group = new THREE.Group();
  const near = personTemplates('near'), far = personTemplates('far');
  const r = rng(99);
  const kinds = near.length;
  // Bucket by chunk and variant.
  const cells = new Map();
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  for (const p of points) {
    const k = Math.floor(r() * kinds);
    const key = `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)},${k}`;
    if (!cells.has(key)) cells.set(key, { k, items: [] });
    q.setFromAxisAngle(up, p.rot + Math.PI);
    const s = 0.9 + r() * 0.16;
    cells.get(key).items.push({
      matrix: new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(s, s, s)),
      top: c.set(TOPS[Math.floor(r() * TOPS.length)]).toArray(),
      bottom: c.set(BOTTOMS[Math.floor(r() * BOTTOMS.length)]).toArray(),
      skin: c.set(SKINS[Math.floor(r() * SKINS.length)]).toArray(),
      hair: c.set(HAIRS[Math.floor(r() * HAIRS.length)]).toArray(),
    });
  }
  const materials = new Map();
  const mat = (motion) => {
    if (!materials.has(motion)) materials.set(motion, crowdMaterial(motion));
    return materials.get(motion);
  };
  for (const { k, items } of cells.values()) {
    const motion = near[k].variant.pose;
    const meshes = ['near', 'far'].map((lod) => {
      const t = (lod === 'near' ? near : far)[k];
      const base = crowdGeometry(t, lod, k);
      // Each chunk gets its own geometry object sharing the vertex data, with its own instance colours.
      const g = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(base.attributes)) g.setAttribute(name, a);
      g.setIndex(base.index);
      g.boundingSphere = base.boundingSphere;
      for (const [name, field] of [['iTop', 'top'], ['iBottom', 'bottom'], ['iSkin', 'skin'], ['iHair', 'hair']]) {
        g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(items.flatMap((it) => it[field])), 3));
      }
      const m = new THREE.InstancedMesh(g, mat(motion), items.length);
      items.forEach((it, i) => m.setMatrixAt(i, it.matrix));
      m.computeBoundingSphere();
      m.castShadow = shadows && lod === 'near';
      m.receiveShadow = false;
      m.userData.centre = m.boundingSphere.center.clone();
      m.userData.radius = m.boundingSphere.radius;
      return m;
    });
    const [mn, mf] = meshes;
    mn.userData.maxDistance = NEAR;
    mn.userData.minDistance = 0;
    mf.userData.maxDistance = maxDistance;
    mf.userData.minDistance = NEAR + mn.userData.radius;
    group.add(mn, mf);
  }
  group.userData.chunked = true;
  return group;
}
