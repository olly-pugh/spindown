// York beyond the modelled city (data from scripts/build-york-outskirts.mjs; Map data © OpenStreetMap
// contributors, ODbL): the suburbs as low-cost housing blocks on their real footprints (red brick under grey and
// brown tiled roofs, sheds and warehouses with flat roofs), leafy gardens, woods and street trees, and the
// streets, railways, rivers, parks and fields painted into the ground the Vale of York is drawn with.
//
// Buildings are one instanced unit house per 800 m chunk: the roof (gabled, hipped or flat) is shaped per
// instance in the vertex shader, windows are drawn in the fragment shader, so the whole suburb costs a few dozen
// draw calls.
import * as THREE from 'three';
import { hash2 } from '../../core/world/noise.js';

const CHUNK = 800;

const dec = (b64, Type) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
};

export class Outskirts {
  /** data: the York map data (with `outskirts`); q: the quality preset. */
  constructor(data, q) {
    const o = data.outskirts;
    this.q = q;
    this.ext = o.ext;
    this.unit = o.unit;
    this.coords = dec(o.coords, Int16Array);
    this.buildings = dec(o.buildings, Int16Array);
    this.areas = dec(o.areas, Int32Array);
    this.lines = dec(o.lines, Int32Array);
    this.treePts = dec(o.trees, Int16Array);
    const b = data.bounds;
    this.city = { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY };
    this.rect = { x0: -this.ext, y0: -this.ext, x1: this.ext, y1: this.ext };
    this.paint = this.makePaint();
  }

  /** Points of a packed line or ring, data coords (x east, y north). */
  pts(start, n) {
    const out = new Array(n * 2), u = this.unit, c = this.coords;
    for (let i = 0; i < n * 2; i++) out[i] = c[start * 2 + i] * u;
    return out;
  }

  /**
   * Two textures over the whole box: land use (R residential, G green, B wood; R+G industrial, G+B water) and
   * lines (R street: 0.5 pavement, 1 carriageway; G railway; B hedge or tree row).
   */
  makePaint() {
    const low = this.q.terrainStep >= 16, high = this.q.terrainStep <= 10;
    const S1 = low ? 1024 : 2048, S2 = low ? 2048 : high ? 3072 : 2048;
    const span = 2 * this.ext;
    const canvas = (S) => {
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.fillStyle = '#000';
      g.fillRect(0, 0, S, S);
      return [c, g];
    };
    const path = (g, S, pts, close) => {
      const k = S / span;
      g.beginPath();
      for (let i = 0; i < pts.length; i += 2) {
        const px = (pts[i] + this.ext) * k, py = (this.ext - pts[i + 1]) * k;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      if (close) g.closePath();
    };
    // Land use.
    const [c1, g1] = canvas(S1);
    const AREA_COL = { 1: '#ff0000', 2: '#ffff00', 3: null, 4: '#00ff00', 5: '#0000ff', 6: '#0000a0', 7: '#00c000', 8: '#00ff00', 9: '#ff0000', 10: '#ffff00', 11: '#00ffff' };
    const A = this.areas;
    for (let i = 0; i < A.length; i += 3) {
      const col = AREA_COL[A[i + 2]];
      if (col === undefined) continue;
      path(g1, S1, this.pts(A[i], A[i + 1]), true);
      g1.fillStyle = col ?? '#000000';
      g1.fill();
    }
    // Rivers and streams as water.
    const L = this.lines;
    g1.lineCap = g1.lineJoin = 'round';
    for (let i = 0; i < L.length; i += 3) {
      const cls = L[i + 2];
      if (cls < 20 || cls > 22) continue;
      path(g1, S1, this.pts(L[i], L[i + 1]), false);
      g1.strokeStyle = '#00ffff';
      g1.lineWidth = Math.max(1, ((cls === 20 ? 30 : cls === 21 ? 3 : 1.5) * S1) / span);
      g1.stroke();
    }
    // Lines: pavements first, then carriageways, rail, hedges.
    const [c2, g2] = canvas(S2);
    g2.lineCap = g2.lineJoin = 'round';
    const W = { 1: 13, 2: 9, 3: 7.5, 4: 6, 5: 3.5, 6: 2.5, 7: 3, 10: 7, 30: 2.5, 31: 4 };
    const stroke = (cls, width, style) => {
      for (let i = 0; i < L.length; i += 3) {
        if (L[i + 2] !== cls) continue;
        path(g2, S2, this.pts(L[i], L[i + 1]), false);
        g2.strokeStyle = style;
        g2.lineWidth = Math.max(0.8, (width * S2) / span);
        g2.stroke();
      }
    };
    g2.globalCompositeOperation = 'lighter';
    for (const cls of [1, 2, 3, 4]) stroke(cls, W[cls] + 4.5, 'rgb(128,0,0)');
    g2.globalCompositeOperation = 'lighten';
    for (const cls of [1, 2, 3, 4, 5, 6, 7]) stroke(cls, W[cls], cls === 7 ? 'rgb(150,0,0)' : 'rgb(255,0,0)');
    stroke(10, W[10], 'rgb(0,255,0)');
    stroke(30, W[30], 'rgb(0,0,255)');
    stroke(31, W[31], 'rgb(0,0,255)');
    const tex = (c) => {
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.NoColorSpace;
      t.anisotropy = 4;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      return t;
    };
    // Keep the pixels for placing trees off streets and out of water.
    this.landPx = g1.getImageData(0, 0, S1, S1).data;
    this.linePx = g2.getImageData(0, 0, S2, S2).data;
    this.S1 = S1;
    this.S2 = S2;
    return { landuse: { texture: tex(c1), rect: this.rect }, lines: { texture: tex(c2), rect: this.rect }, city: this.city };
  }

  /** Land use and line paint at data (x, y): {res, green, wood, ind, water, road, rail, hedge} in 0..1. */
  sample(x, y, out = {}) {
    const u = (x + this.ext) / (2 * this.ext), v = (this.ext - y) / (2 * this.ext);
    const i1 = (Math.min(this.S1 - 1, Math.max(0, Math.floor(v * this.S1))) * this.S1 + Math.min(this.S1 - 1, Math.max(0, Math.floor(u * this.S1)))) * 4;
    const i2 = (Math.min(this.S2 - 1, Math.max(0, Math.floor(v * this.S2))) * this.S2 + Math.min(this.S2 - 1, Math.max(0, Math.floor(u * this.S2)))) * 4;
    const R = this.landPx[i1] / 255, G = this.landPx[i1 + 1] / 255, B = this.landPx[i1 + 2] / 255;
    out.ind = Math.min(R, G);
    out.water = Math.min(G, B);
    out.res = R - out.ind;
    out.green = G - out.ind - out.water;
    out.wood = B - out.water;
    out.road = this.linePx[i2] / 255;
    out.rail = this.linePx[i2 + 1] / 255;
    out.hedge = this.linePx[i2 + 2] / 255;
    return out;
  }

  /** Builds the buildings and trees, standing on `heightAt(x, z)` (world coords). */
  build(heightAt) {
    const group = new THREE.Group();
    group.name = 'outskirts';
    group.add(this.buildHouses(heightAt));
    group.add(this.buildTrees(heightAt));
    group.add(this.buildHorizon(heightAt));
    this.group = group;
    this.landPx = this.linePx = null;
    return group;
  }

  /**
   * From the street the suburbs beyond the nearest are hidden behind the city anyway: draw them out to a distance
   * that grows with the camera's height (the chunks' maxDistance, applied by the scene's chunk culling).
   */
  update(camera, groundY = 12) {
    if (!camera || !this.group) return;
    const h = Math.max(0, camera.position.y - groundY);
    const reach = Math.min(9000, 1000 + h * 30);
    this.group.traverse((o) => {
      if (o.isMesh && o.userData.centre && o.userData.outskirt) o.userData.maxDistance = reach;
    });
  }

  /** The Vale beyond the mapped land: flat fields to the horizon, so the land does not end in a hard line. */
  buildHorizon(heightAt) {
    const r0 = this.ext * Math.SQRT2 * 0.97, r1 = 16000, n = 64;
    const pos = [], idx = [];
    const y = heightAt(0, 0) - 1.5;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      for (const r of [r0 * 0.75, r1]) pos.push(Math.cos(a) * r, r === r1 ? y - 30 : y, Math.sin(a) * r);
    }
    for (let i = 0; i < n; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: '#4d5c33', roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }));
    mesh.receiveShadow = false;
    return mesh;
  }

  buildHouses(heightAt) {
    const B = this.buildings;
    const n = B.length / 7;
    const low = this.q.terrainStep >= 16;
    const keepR = low ? 2600 : Infinity; // the low preset's haze hides the outer suburbs anyway
    const cells = new Map();
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), s = new THREE.Vector3();
    const WALLS = ['#a35a43', '#9c5340', '#b0654b', '#8f4d3b', '#a86b52', '#c08f6c', '#d8cdb8', '#bfb6a6', '#9b6a55', '#b5745a'];
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      const x = B[o] * 0.5, y = B[o + 1] * 0.5;
      if (Math.hypot(x, y) > keepR) continue;
      const L = Math.max(2, B[o + 2] / 10), Wd = Math.max(2, B[o + 3] / 10), ang = (B[o + 4] / 32767) * Math.PI, h = B[o + 5] / 10, flags = B[o + 6];
      const roof = flags & 3, church = flags & 4, big = flags & 8;
      const z = -y;
      const ground = heightAt(x, z);
      // Roof height: a pitch of ~35° across the short side for houses, low for sheds, none for flat roofs.
      const rh = roof === 2 ? 0 : Math.min(church ? Wd * 0.8 : Wd * 0.36, 4.5);
      q.setFromAxisAngle(up, ang);
      p.set(x, ground - 0.3, z);
      s.set(L, h + 0.3, Wd);
      m.compose(p, q, s);
      const hsh = hash2(Math.round(x), Math.round(y), 3);
      const wall = new THREE.Color(big ? (hsh < 0.5 ? '#9a9890' : '#b4b0a4') : WALLS[Math.floor(hsh * WALLS.length)]);
      const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
      if (!cells.has(key)) cells.set(key, []);
      // roofInfo: type (0 gable, 1 hip, 2 flat), roof height (m), hip inset as a fraction of the length, windows kind.
      cells.get(key).push({ m: m.clone(), c: wall, info: [roof, rh, roof === 1 ? Math.min(0.45, (Wd * 0.5) / L) : 0, big ? 2 : h < 3.2 ? 0 : 1] });
    }
    const geo = unitHouse();
    const mat = houseMaterial();
    const group = new THREE.Group();
    let count = 0;
    for (const list of cells.values()) {
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      const info = new Float32Array(list.length * 4);
      list.forEach((it, k) => {
        mesh.setMatrixAt(k, it.m);
        mesh.setColorAt(k, it.c);
        info.set(it.info, k * 4);
      });
      // Per-instance attribute on a per-mesh copy of the geometry's attribute set.
      mesh.geometry = geo.clone();
      mesh.geometry.setAttribute('roofInfo', new THREE.InstancedBufferAttribute(info, 4));
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.userData.centre = mesh.boundingSphere.center.clone();
      mesh.userData.radius = mesh.boundingSphere.radius;
      mesh.userData.maxDistance = 6500;
      mesh.userData.outskirt = true;
      group.add(mesh);
      count += list.length;
    }
    group.userData.count = count;
    this.houseCount = count;
    return group;
  }

  buildTrees(heightAt) {
    const caps = this.q.terrainStep >= 16 ? 5000 : this.q.terrainStep <= 10 ? 26000 : 14000;
    const pts = [];
    const sm = {};
    const ok = (x, y) => {
      if (Math.abs(x) > this.ext - 20 || Math.abs(y) > this.ext - 20) return false;
      if (x > this.city.x0 - 10 && x < this.city.x1 + 10 && y > this.city.y0 - 10 && y < this.city.y1 + 10) return false;
      this.sample(x, y, sm);
      return sm.road < 0.3 && sm.rail < 0.3 && sm.water < 0.3;
    };
    // Mapped street and garden trees first.
    const T = this.treePts;
    for (let i = 0; i < T.length; i += 2) {
      const x = T[i] * 0.5, y = T[i + 1] * 0.5;
      if (ok(x, y)) pts.push([x, y, 0.9 + hash2(i, 1, 2) * 0.5, 0]);
    }
    // Hedgerow trees and tree rows.
    const L = this.lines;
    for (let i = 0; i < L.length; i += 3) {
      const cls = L[i + 2];
      if (cls !== 30 && cls !== 31) continue;
      const P = this.pts(L[i], L[i + 1]);
      const every = cls === 31 ? 9 : 38;
      let acc = hash2(i, 7, 1) * every;
      for (let k = 2; k < P.length; k += 2) {
        const ax = P[k - 2], ay = P[k - 1], bx = P[k], by = P[k + 1];
        const len = Math.hypot(bx - ax, by - ay);
        while (acc < len) {
          const t = acc / len;
          const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
          if (ok(x, y)) pts.push([x, y, 0.9 + hash2(Math.round(x), Math.round(y), 4) * 0.6, 0]);
          acc += every * (0.6 + hash2(Math.round(x), Math.round(y), 5) * 0.8);
        }
        acc -= len;
      }
    }
    // Gardens and woods: candidates on a jittered grid, thinned to the budget.
    const cand = [];
    const step = 11;
    for (let y = -this.ext; y < this.ext; y += step) {
      for (let x = -this.ext; x < this.ext; x += step) {
        const jx = x + hash2(x, y, 11) * step, jy = y + hash2(x, y, 12) * step;
        if (!ok(jx, jy)) continue;
        const w = sm.wood * 1.0 + sm.res * 0.42 + sm.green * 0.12 + sm.ind * 0.05;
        if (w <= 0.05) continue;
        cand.push([jx, jy, w]);
      }
    }
    let total = 0;
    for (const c of cand) total += c[2];
    const left = Math.max(0, caps - pts.length);
    const keep = Math.min(1, left / Math.max(1, total));
    for (const c of cand) {
      if (hash2(Math.round(c[0] * 3), Math.round(c[1] * 3), 21) < c[2] * keep) pts.push([c[0], c[1], 0.8 + hash2(Math.round(c[0]), Math.round(c[1]), 22) * 0.7, sm.wood > 0.5 ? 1 : 0]);
    }
    // Instanced blobs, chunked.
    const geo = treeBlob();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    const cells = new Map();
    const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    for (const [x, y, sc] of pts.slice(0, caps)) {
      const z = -y;
      const hs = hash2(Math.round(x * 5), Math.round(y * 5), 31);
      qq.setFromAxisAngle(up, hs * 6.28);
      const size = 4.5 * sc;
      p.set(x, heightAt(x, z) - 0.3, z);
      s.set(size * (0.85 + hs * 0.3), size * (1.05 + hash2(Math.round(x), Math.round(y), 32) * 0.5), size * (0.85 + hs * 0.3));
      m.compose(p, qq, s);
      col.setHSL(0.24 + hs * 0.08, 0.38 + hs * 0.12, 0.13 + hash2(Math.round(x), Math.round(y), 33) * 0.06);
      const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push({ m: m.clone(), c: col.clone() });
    }
    const group = new THREE.Group();
    for (const list of cells.values()) {
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((it, k) => {
        mesh.setMatrixAt(k, it.m);
        mesh.setColorAt(k, it.c);
      });
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      mesh.userData.centre = mesh.boundingSphere.center.clone();
      mesh.userData.radius = mesh.boundingSphere.radius;
      mesh.userData.maxDistance = 6500;
      mesh.userData.outskirt = true;
      group.add(mesh);
    }
    this.treeCount = Math.min(caps, pts.length);
    return group;
  }
}

/**
 * A unit house: a box 1×1×1 (x along the ridge, y up from 0 to 1 at the eaves, z across) with a roof above it
 * whose ridge the shader raises, shortens (hipped) or flattens per instance. Vertex attribute `part`: 0 wall, 1
 * roof slope, 2 gable end, 3 ridge vertex.
 */
function unitHouse() {
  const pos = [], nrm = [], part = [], idx = [];
  const quad = (a, b, c, d, n, pt) => {
    const k = pos.length / 3;
    for (const v of [a, b, c, d]) {
      pos.push(...v);
      nrm.push(...n);
      part.push(pt);
    }
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  };
  const h = 0.5;
  // Walls.
  quad([-h, 0, h], [h, 0, h], [h, 1, h], [-h, 1, h], [0, 0, 1], 0);
  quad([h, 0, -h], [-h, 0, -h], [-h, 1, -h], [h, 1, -h], [0, 0, -1], 0);
  quad([h, 0, h], [h, 0, -h], [h, 1, -h], [h, 1, h], [1, 0, 0], 0);
  quad([-h, 0, -h], [-h, 0, h], [-h, 1, h], [-h, 1, -h], [-1, 0, 0], 0);
  // Roof slopes (the ridge vertices, part 3, are moved by the shader; normals are recomputed there).
  {
    const k = pos.length / 3;
    const verts = [[-h, 1, h], [h, 1, h], [h, 1, 0], [-h, 1, 0], [h, 1, -h], [-h, 1, -h], [h, 1, 0], [-h, 1, 0]];
    const parts = [1, 1, 3, 3, 1, 1, 3, 3];
    verts.forEach((v, i) => {
      pos.push(...v);
      nrm.push(0, 0, i < 4 ? 1 : -1); // which slope (the shader works out the real normal)
      part.push(parts[i]);
    });
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3, k + 4, k + 5, k + 7, k + 4, k + 7, k + 6);
  }
  // Gable ends (triangles; for a hipped roof they become the hip slopes).
  {
    const k = pos.length / 3;
    const verts = [[h, 1, h], [h, 1, -h], [h, 1, 0], [-h, 1, -h], [-h, 1, h], [-h, 1, 0]];
    const parts = [2, 2, 3, 2, 2, 3];
    verts.forEach((v, i) => {
      pos.push(...v);
      nrm.push(i < 3 ? 1 : -1, 0, 0); // which end
      part.push(parts[i]);
    });
    idx.push(k, k + 1, k + 2, k + 3, k + 4, k + 5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('part', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

/** Brick (instance colour) walls with windows, tiled roofs (grey or red-brown, by instance). */
function houseMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float part;
        attribute vec4 roofInfo;
        varying vec3 vHLocal;
        varying vec3 vHHint;
        varying float vHPart;
        varying vec4 vHInfo;
        varying float vHSeed;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        // Instance scale (metres): length, eaves height, depth. Normals are given in the unit house's space
        // (three.js applies the inverse instance scale to them).
        vec3 hsc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        float roofT = roofInfo.x, rhu = roofInfo.y / hsc.y, hip = roofInfo.z;
        vec3 hp = position;
        vec3 hint = objectNormal;
        if (part > 2.5) {
          // Ridge vertices rise by the roof height; a hipped roof pulls the ridge ends in.
          hp.y += rhu;
          if (roofT > 0.5 && roofT < 1.5) hp.x *= 1.0 - 2.0 * hip;
        }
        if (part > 0.5) {
          if (roofT > 1.5) objectNormal = vec3(0.0, 1.0, 0.0);
          else if (abs(hint.z) > 0.5) objectNormal = normalize(vec3(0.0, 0.5, sign(hint.z) * rhu));
          else if (roofT > 0.5) objectNormal = normalize(vec3(sign(hint.x) * rhu, hip, 0.0));
          else objectNormal = vec3(sign(hint.x), 0.0, 0.0);
        }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed = hp;
        vHLocal = hp * hsc;
        vHHint = hint;
        vHPart = part;
        vHInfo = roofInfo;
        vHSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vHLocal;
        varying vec3 vHHint;
        varying float vHPart;
        varying vec4 vHInfo;
        varying float vHSeed;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vHPart > 0.5 && vHInfo.x < 1.5) {
          // Pitched roofs: concrete tile grey, brown or red.
          vec3 r1 = vec3(0.16, 0.16, 0.17), r2 = vec3(0.22, 0.12, 0.09), r3 = vec3(0.30, 0.12, 0.08);
          vec3 rc = vHSeed < 0.5 ? r1 : vHSeed < 0.8 ? r2 : r3;
          // Courses of tiles.
          rc *= 0.9 + 0.1 * step(0.5, fract(vHLocal.y * 3.3 + vHLocal.z * 0.0));
          diffuseColor.rgb = rc * (0.85 + 0.3 * fract(vHSeed * 7.3));
        } else if (vHPart > 0.5) {
          // Flat roofs: felt, gravel or metal.
          diffuseColor.rgb = mix(vec3(0.18, 0.18, 0.18), vec3(0.32, 0.32, 0.31), fract(vHSeed * 3.1));
        } else {
          // Walls: windows in storeys, a door on the ground floor now and then.
          vec2 wuv = vec2(abs(vHHint.z) > 0.5 ? vHLocal.x : vHLocal.z, vHLocal.y);
          float storey = vHInfo.w > 1.5 ? 4.0 : 2.7;
          float bay = vHInfo.w > 1.5 ? 3.2 : 2.6 + vHSeed * 0.8;
          vec2 cell = vec2(fract(wuv.x / bay), fract(wuv.y / storey));
          float win = step(0.3, cell.x) * step(cell.x, 0.72) * step(0.35, cell.y) * step(cell.y, 0.78);
          if (vHInfo.w < 0.5) win = 0.0;
          if (vHInfo.w > 1.5) win *= step(0.6, cell.y); // high strip windows on sheds and warehouses
          if (wuv.y < 0.35) win = 0.0;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.06, 0.07), win * 0.9);
          // A darker plinth and weathering near the ground.
          diffuseColor.rgb *= mix(0.75, 1.0, smoothstep(0.0, 0.6, vHLocal.y));
        }`);
  };
  m.customProgramCacheKey = () => 'outskirts-house-v1';
  return m;
}

/** A tree canopy blob on a short trunk (smooth-shaded, vertex-coloured: trunk brown, canopy white x instance). */
function treeBlob() {
  const can = new THREE.IcosahedronGeometry(0.5, 0);
  const p = can.attributes.position;
  const nrm = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const l = Math.hypot(x, y, z);
    nrm.set([x / l, y / l, z / l], i * 3);
    const k = 1 + 0.12 * Math.sin(x * 9.1 + z * 4.3) + 0.08 * Math.sin(y * 7.7);
    p.setXYZ(i, x * k, y * k * 0.9 + 0.62, z * k);
  }
  can.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  const cc = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = 0.75 + 0.35 * Math.min(1, Math.max(0, (p.getY(i) - 0.2) / 0.9));
    cc.set([t, t, t], i * 3);
  }
  can.setAttribute('color', new THREE.BufferAttribute(cc, 3));
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.45, 3, 1, true).translate(0, 0.2, 0).toNonIndexed();
  const tc = new Float32Array(trunk.attributes.position.count * 3);
  for (let i = 0; i < tc.length; i += 3) tc.set([0.6, 0.45, 0.32], i);
  trunk.setAttribute('color', new THREE.BufferAttribute(tc, 3));
  trunk.deleteAttribute('uv');
  can.deleteAttribute('uv');
  const merged = new THREE.BufferGeometry();
  const parts = [can, trunk];
  const count = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const pos = new Float32Array(count * 3), n2 = new Float32Array(count * 3), c2 = new Float32Array(count * 3);
  let off = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, off * 3);
    n2.set(g.attributes.normal.array, off * 3);
    c2.set(g.attributes.color.array, off * 3);
    off += g.attributes.position.count;
  }
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(n2, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(c2, 3));
  return merged;
}
