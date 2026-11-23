// Detail streamed round the camera: grass at the foot of walls and hedges, coping stones, hedge sprigs, verge
// plants. The world is cut into square cells whose instance matrices (and geometry) are made the first time the
// camera comes near and cached; shared instanced meshes are refilled as the camera moves, so only what is within a
// few tens of metres is ever drawn, and nothing has to be built for the whole world up front.
import * as THREE from 'three';
import { crispCoverage, dullSheen } from './vegetation.js';

const V3 = THREE.Vector3;

export function newArrays() {
  return { pos: [], nrm: [], uv: [], col: [], idx: [] };
}
export function toGeometry(a) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(a.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(a.col, 3));
  if (a.pos.length / 3 > 65535) g.setIndex(new THREE.Uint32BufferAttribute(a.idx, 1));
  else g.setIndex(a.idx);
  g.computeBoundingSphere();
  return g;
}

// ---- Near detail, streamed round the camera ----------------------------------------------------------

/**
 * Keeps detail meshes filled with what lies within `radius` of the camera: the world is cut into square
 * cells whose detail (body geometry arrays and instance matrices) is made on first need and cached; the
 * shared meshes are refilled when the camera has moved a few metres. `make(cellKey)` returns {body?:
 * arrays, inst: {name: {matrices: number[], colours?: number[]}}}.
 */
export class NearDetail {
  constructor({ cell = 50, radius = 60, make, meshes, bodyMat = null, shadows = true }) {
    this.cell = cell;
    this.radius = radius;
    this.make = make;
    this.meshes = meshes; // name -> InstancedMesh (capacity fixed)
    this.bodyMat = bodyMat;
    this.shadows = shadows;
    this.cache = new Map();
    this.cells = new Set(); // keys that have content
    this.group = new THREE.Group();
    this.group.name = 'near-detail';
    for (const m of Object.values(meshes)) {
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.body = null;
    this.garbage = [];
    this.last = new V3(Infinity, 0, 0);
    this.frame = -1;
    this.pending = [];
  }
  hook(mesh) {
    const before = mesh.onBeforeRender, shadow = mesh.onBeforeShadow;
    const self = this;
    mesh.onBeforeRender = function (renderer, scene, camera, ...rest) {
      if (scene) self.tick(renderer, camera);
      before.call(this, renderer, scene, camera, ...rest);
    };
    mesh.onBeforeShadow = function (renderer, object, camera, ...rest) {
      self.tick(renderer, camera);
      shadow.call(this, renderer, object, camera, ...rest);
    };
  }
  tick(renderer, camera) {
    const f = renderer.info.render.frame;
    if (f === this.frame) return;
    this.frame = f;
    for (const g of this.garbage.splice(0)) g.dispose();
    const cam = camera.position;
    if (cam.distanceToSquared(this.last) < 9 && !this.pending.length) return;
    // Make at most two missing cells a frame; refill once everything in range exists.
    const R = this.radius, C = this.cell;
    const want = [];
    for (let i = Math.floor((cam.x - R) / C); i <= Math.floor((cam.x + R) / C); i++) {
      for (let j = Math.floor((cam.z - R) / C); j <= Math.floor((cam.z + R) / C); j++) {
        const key = `${i},${j}`;
        if (this.cells.has(key)) want.push(key);
      }
    }
    this.pending = want.filter((k) => !this.cache.has(k));
    for (const k of this.pending.splice(0, 2)) this.cache.set(k, this.make(k));
    if (this.pending.length) return;
    this.last.copy(cam);
    this.refill(want, cam);
    // Forget cells well out of range.
    if (this.cache.size > want.length * 3 + 20) {
      for (const k of this.cache.keys()) if (!want.includes(k)) this.cache.delete(k);
    }
  }
  refill(keys, cam) {
    const R2 = this.radius * this.radius;
    for (const [name, mesh] of Object.entries(this.meshes)) {
      const arr = mesh.instanceMatrix.array, cap = mesh.instanceMatrix.count;
      const cols = mesh.instanceColor?.array;
      const r2 = (mesh.userData.radius ?? this.radius) ** 2;
      let n = 0;
      for (const k of keys) {
        const d = this.cache.get(k)?.inst?.[name];
        if (!d) continue;
        const m = d.matrices;
        for (let i = 0; i < m.length && n < cap; i += 16) {
          const dx = m[i + 12] - cam.x, dz = m[i + 14] - cam.z;
          if (dx * dx + dz * dz > Math.min(R2, r2)) continue;
          arr.set(m.subarray(i, i + 16), n * 16);
          if (cols && d.colours) cols.set(d.colours.subarray((i / 16) * 3, (i / 16) * 3 + 3), n * 3);
          n++;
        }
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (this.bodyMat) {
      const parts = keys.map((k) => this.cache.get(k)?.body).filter((b) => b && b.pos.length);
      const all = newArrays();
      for (const p of parts) {
        const off = all.pos.length / 3;
        for (const v of p.pos) all.pos.push(v);
        for (const v of p.nrm) all.nrm.push(v);
        for (const v of p.uv) all.uv.push(v);
        for (const v of p.col) all.col.push(v);
        for (const v of p.idx) all.idx.push(v + off);
      }
      const geo = toGeometry(all);
      // This runs mid-frame (from a mesh's render hook): swap the geometry on a mesh that stays in the scene,
      // and free the old one next frame, when nothing can still be drawing it.
      if (!this.body) {
        this.body = new THREE.Mesh(geo, this.bodyMat);
        this.body.castShadow = this.shadows;
        this.body.receiveShadow = true;
        this.body.frustumCulled = false;
        this.group.add(this.body);
      } else {
        this.garbage.push(this.body.geometry);
        this.body.geometry = geo;
      }
    }
  }
}

/** Crossed quads for a tuft of grass (unit height), UVs on a leaf-atlas cell. */
export function tuftGeometry(rect) {
  const pos = [], uv = [], nrm = [], idx = [];
  for (let k = 0; k < 2; k++) {
    const a = (k * Math.PI) / 2 + 0.3, cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
    const b = pos.length / 3;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    uv.push(rect.u0, rect.v0, rect.u1, rect.v0, rect.u1, rect.v1, rect.u0, rect.v1);
    for (let i = 0; i < 4; i++) nrm.push(0, 1, 0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Alpha-tested foliage material (grass, sprigs) lit softly, with a faint sheen, both sides alike. */
export function plantMaterial(map, level) {
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, metalness: 0, alphaToCoverage: level !== 'low' });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <alphatest_fragment>', crispCoverage)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${dullSheen}`);
  };
  m.customProgramCacheKey = () => 'spindown-plant';
  return m;
}

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(), tmpP = new V3(), tmpS = new V3();
export function pushMatrix(list, x, y, z, yaw, pitch, roll, sx, sy, sz) {
  tmpE.set(pitch, yaw, roll, 'YXZ');
  tmpQ.setFromEuler(tmpE);
  tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz));
  for (let i = 0; i < 16; i++) list.push(tmpM.elements[i]);
}

export function qualityLevel(opts) {
  const q = opts.q;
  if (q) return !q.shadows ? 'low' : (q.shadowSize ?? 2048) > 2048 ? 'high' : 'medium';
  return opts.shadows === false ? 'low' : 'medium';
}
