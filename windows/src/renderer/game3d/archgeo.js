// Fast geometry writing for the architecture builders (buildings.js, landmarks.js).
//
// Thousands of window reveals, sills, cornices and chimney stacks are far too many for THREE.BoxGeometry plus
// mergeGeometries, so primitives are written straight into growing typed arrays: position, a flat normal
// (bytes), uv, a vertex colour (bytes) and a texture-array layer index per vertex (see archtex.js). Everything is
// written in a local right-handed frame: s to the right along a wall as you face it from outside, h up and d
// out of the wall (towards you); `frame()` places that frame in the world. UVs are given in metres and divided
// by the current layer's tile size, so every surface keeps its real-world texture scale.
import * as THREE from 'three';

const GROW = 1.6;

export class Writer {
  /** tiles: metres per texture repeat, by layer index. */
  constructor(tiles, cap = 2048) {
    this.tiles = tiles;
    this.pos = new Float32Array(cap * 3);
    this.nrm = new Float32Array(cap * 3);
    this.uv = new Float32Array(cap * 2);
    this.col = new Uint8Array(cap * 3);
    this.lay = new Uint8Array(cap);
    this.idx = new Uint32Array(cap * 2);
    this.nv = 0;
    this.ni = 0;
    this.layer = 0;
    this.tile = tiles[0] ?? 1;
    this.r = 255;
    this.g = 255;
    this.b = 255;
    this.uo = 0; // uv offset in metres (decorrelates neighbouring buildings)
    this.vo = 0;
    this.aoH = 0; // > 0: darken towards the foot of the frame over this many metres (cheap ambient occlusion)
    this.frame(0, 0, 0, 1, 0);
  }

  /** Local frame: origin (x, y, z), s along the horizontal unit vector (ux, uz), h up, d along n = (−uz, ux). */
  frame(x, y, z, ux, uz) {
    this.ox = x;
    this.oy = y;
    this.oz = z;
    this.ux = ux;
    this.uz = uz;
    // n = up × … chosen so (u, up, n) is right handed: u = (1,0,0) gives n = (0,0,1).
    this.nx = -uz;
    this.nz = ux;
    return this;
  }

  /** The frame of a wall edge a→b of a footprint wound with positive area (outward normal on the right of a→b). */
  wallFrame(ax, az, bx, bz, y) {
    const len = Math.hypot(ax - bx, az - bz) || 1;
    // Facing the wall from outside, s runs from b (left) to a (right).
    return this.frame(bx, y, bz, (ax - bx) / len, (az - bz) / len);
  }

  setLayer(layer) {
    this.layer = layer;
    this.tile = this.tiles[layer] ?? 1;
    return this;
  }

  /** Vertex colour in linear 0…1 (values above 1 are clamped). */
  setColour(r, g, b) {
    this.r = Math.max(0, Math.min(255, Math.round(r * 255)));
    this.g = Math.max(0, Math.min(255, Math.round(g * 255)));
    this.b = Math.max(0, Math.min(255, Math.round(b * 255)));
    return this;
  }

  colour(c, k = 1) {
    return this.setColour(c.r * k, c.g * k, c.b * k);
  }

  grow(nv, ni) {
    if (this.nv + nv > this.lay.length) {
      const cap = Math.ceil((this.nv + nv) * GROW);
      const re = (a, n) => {
        const b = new a.constructor(cap * n);
        b.set(a);
        return b;
      };
      this.pos = re(this.pos, 3);
      this.nrm = re(this.nrm, 3);
      this.uv = re(this.uv, 2);
      this.col = re(this.col, 3);
      this.lay = re(this.lay, 1);
    }
    if (this.ni + ni > this.idx.length) {
      const b = new Uint32Array(Math.ceil((this.ni + ni) * GROW));
      b.set(this.idx);
      this.idx = b;
    }
  }

  /** A vertex at local (s, h, d) with local normal (a, b, c) and uv in metres. Returns its index. */
  v(s, h, d, a, b, c, um, vm) {
    const i = this.nv++;
    const p = i * 3;
    this.pos[p] = this.ox + this.ux * s + this.nx * d;
    this.pos[p + 1] = this.oy + h;
    this.pos[p + 2] = this.oz + this.uz * s + this.nz * d;
    this.nrm[p] = this.ux * a + this.nx * c;
    this.nrm[p + 1] = b;
    this.nrm[p + 2] = this.uz * a + this.nz * c;
    if (this.tile) {
      this.uv[i * 2] = (um + this.uo) / this.tile;
      this.uv[i * 2 + 1] = (vm + this.vo) / this.tile;
    } else {
      // Layers with tile 0 take uvs as given (0…1 over a window, door or sign).
      this.uv[i * 2] = um;
      this.uv[i * 2 + 1] = vm;
    }
    if (this.aoH > 0) {
      const k = 0.78 + 0.22 * Math.min(1, Math.max(0, h / this.aoH));
      this.col[p] = this.r * k;
      this.col[p + 1] = this.g * k;
      this.col[p + 2] = this.b * k;
    } else {
      this.col[p] = this.r;
      this.col[p + 1] = this.g;
      this.col[p + 2] = this.b;
    }
    this.lay[i] = this.layer;
    return i;
  }

  /**
   * A planar quad from four local points (counter-clockwise seen from the side it faces), with uvs in metres
   * [u0,v0, u1,v1, u2,v2, u3,v3]. The normal is computed from the points.
   */
  quad(p0, p1, p2, p3, uv) {
    this.grow(4, 6);
    // Normal = (p1 − p0) × (p3 − p0), in local space.
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const i = this.v(p0[0], p0[1], p0[2], nx, ny, nz, uv[0], uv[1]);
    this.v(p1[0], p1[1], p1[2], nx, ny, nz, uv[2], uv[3]);
    this.v(p2[0], p2[1], p2[2], nx, ny, nz, uv[4], uv[5]);
    this.v(p3[0], p3[1], p3[2], nx, ny, nz, uv[6], uv[7]);
    const k = this.ni;
    this.idx[k] = i;
    this.idx[k + 1] = i + 1;
    this.idx[k + 2] = i + 2;
    this.idx[k + 3] = i;
    this.idx[k + 4] = i + 2;
    this.idx[k + 5] = i + 3;
    this.ni += 6;
  }

  tri(p0, p1, p2, uv) {
    this.grow(3, 3);
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const i = this.v(p0[0], p0[1], p0[2], nx, ny, nz, uv[0], uv[1]);
    this.v(p1[0], p1[1], p1[2], nx, ny, nz, uv[2], uv[3]);
    this.v(p2[0], p2[1], p2[2], nx, ny, nz, uv[4], uv[5]);
    this.idx[this.ni++] = i;
    this.idx[this.ni++] = i + 1;
    this.idx[this.ni++] = i + 2;
  }

  /** A rectangle facing +d at depth d: s0…s1 across, h0…h1 up (uv = local metres). */
  rect(s0, s1, h0, h1, d = 0) {
    this.quad([s0, h0, d], [s1, h0, d], [s1, h1, d], [s0, h1, d], [s0, h0, s1, h0, s1, h1, s0, h1]);
  }

  /**
   * A box s0…s1, h0…h1, d0…d1 in the local frame. faces: bit mask of which faces to draw
   * (1 front +d, 2 back −d, 4 right +s, 8 left −s, 16 top, 32 bottom); default all but the back.
   */
  box(s0, s1, h0, h1, d0, d1, faces = 61) {
    if (faces & 1) this.quad([s0, h0, d1], [s1, h0, d1], [s1, h1, d1], [s0, h1, d1], [s0, h0, s1, h0, s1, h1, s0, h1]);
    if (faces & 2) this.quad([s1, h0, d0], [s0, h0, d0], [s0, h1, d0], [s1, h1, d0], [-s1, h0, -s0, h0, -s0, h1, -s1, h1]);
    if (faces & 4) this.quad([s1, h0, d1], [s1, h0, d0], [s1, h1, d0], [s1, h1, d1], [-d1, h0, -d0, h0, -d0, h1, -d1, h1]);
    if (faces & 8) this.quad([s0, h0, d0], [s0, h0, d1], [s0, h1, d1], [s0, h1, d0], [d0, h0, d1, h0, d1, h1, d0, h1]);
    if (faces & 16) this.quad([s0, h1, d1], [s1, h1, d1], [s1, h1, d0], [s0, h1, d0], [s0, -d1, s1, -d1, s1, -d0, s0, -d0]);
    if (faces & 32) this.quad([s0, h0, d0], [s1, h0, d0], [s1, h0, d1], [s0, h0, d1], [s0, d0, s1, d0, s1, d1, s0, d1]);
  }

  /** A vertical cylinder (n sides) round local (s, d) from h0 to h1, radius r0 at the foot, r1 at the top. */
  cylinder(s, d, r0, r1, h0, h1, n = 8, { top = true, bottom = false, a0 = 0 } = {}) {
    const circ = 2 * Math.PI * Math.max(r0, r1);
    for (let k = 0; k < n; k++) {
      const t0 = a0 + (k / n) * Math.PI * 2, t1 = a0 + ((k + 1) / n) * Math.PI * 2;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      const u0 = (k / n) * circ, u1 = ((k + 1) / n) * circ;
      // Counter-clockwise from outside: going round with increasing angle in the (s, d) plane seen from +h
      // is clockwise, so list the far-angle edge first.
      this.quad([s + c1 * r0, h0, d - s1 * r0], [s + c0 * r0, h0, d - s0 * r0], [s + c0 * r1, h1, d - s0 * r1], [s + c1 * r1, h1, d - s1 * r1], [u1, h0, u0, h0, u0, h1, u1, h1]);
    }
    if (top && r1 > 0) {
      for (let k = 0; k < n; k++) {
        const t0 = a0 + (k / n) * Math.PI * 2, t1 = a0 + ((k + 1) / n) * Math.PI * 2;
        this.tri([s, h1, d], [s + Math.cos(t0) * r1, h1, d - Math.sin(t0) * r1], [s + Math.cos(t1) * r1, h1, d - Math.sin(t1) * r1], [0, 0, Math.cos(t0) * r1, Math.sin(t0) * r1, Math.cos(t1) * r1, Math.sin(t1) * r1]);
      }
    }
    if (bottom && r0 > 0) {
      for (let k = 0; k < n; k++) {
        const t0 = a0 + (k / n) * Math.PI * 2, t1 = a0 + ((k + 1) / n) * Math.PI * 2;
        this.tri([s, h0, d], [s + Math.cos(t1) * r0, h0, d - Math.sin(t1) * r0], [s + Math.cos(t0) * r0, h0, d - Math.sin(t0) * r0], [0, 0, 1, 0, 0, 1]);
      }
    }
  }

  /** An n-sided pyramid (spirelet, pinnacle top) on local (s, d) from h0 (radius r) to an apex at h1. */
  pyramid(s, d, r, h0, h1, n = 4, a0 = Math.PI / 4) {
    const slant = Math.hypot(r, h1 - h0);
    for (let k = 0; k < n; k++) {
      const t0 = a0 + (k / n) * Math.PI * 2, t1 = a0 + ((k + 1) / n) * Math.PI * 2;
      const side = 2 * r * Math.sin(Math.PI / n);
      this.tri([s + Math.cos(t1) * r, h0, d - Math.sin(t1) * r], [s + Math.cos(t0) * r, h0, d - Math.sin(t0) * r], [s, h1, d], [0, 0, side, 0, side / 2, slant]);
    }
  }

  /** A gabled prism along s (s0…s1): width across d (d0…d1), from h0 up to a ridge at h1 over the middle. */
  prism(s0, s1, d0, d1, h0, h1, { ends = true } = {}) {
    const dm = (d0 + d1) / 2;
    const sl = Math.hypot((d1 - d0) / 2, h1 - h0);
    this.quad([s0, h0, d1], [s1, h0, d1], [s1, h1, dm], [s0, h1, dm], [s0, 0, s1, 0, s1, sl, s0, sl]);
    this.quad([s1, h0, d0], [s0, h0, d0], [s0, h1, dm], [s1, h1, dm], [-s1, 0, -s0, 0, -s0, sl, -s1, sl]);
    if (ends) {
      this.tri([s1, h0, d1], [s1, h0, d0], [s1, h1, dm], [d1, h0, d0, h0, dm, h1]);
      this.tri([s0, h0, d0], [s0, h0, d1], [s0, h1, dm], [-d0, h0, -d1, h0, -dm, h1]);
    }
  }

  /** Triangulated polygon (local s/d plane at height h, facing up or down) from a flat [s,d,...] ring. */
  flat(ring, h, up = true) {
    const pts = [];
    for (let i = 0; i < ring.length; i += 2) pts.push(new THREE.Vector2(ring[i], ring[i + 1]));
    if (pts.length < 3) return;
    const tris = THREE.ShapeUtils.triangulateShape(pts, []);
    for (const [a, b, c] of tris) {
      const A = pts[a], B = pts[b], C = pts[c];
      // Face up (+h): counter-clockwise seen from above means (B−A)×(C−A) has +h.
      const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
      // In the right-handed local frame (s, h, d), +h normal needs (B−A)×(C−A)·h > 0, which is cross < 0.
      const flip = up ? cross > 0 : cross < 0;
      const P = flip ? [A, C, B] : [A, B, C];
      this.tri([P[0].x, h, P[0].y], [P[1].x, h, P[1].y], [P[2].x, h, P[2].y], [P[0].x, P[0].y, P[1].x, P[1].y, P[2].x, P[2].y]);
    }
  }

  /** Appends everything another writer holds (same layers). */
  append(o) {
    if (!o.nv) return;
    this.grow(o.nv, o.ni);
    const v0 = this.nv;
    this.pos.set(o.pos.subarray(0, o.nv * 3), v0 * 3);
    this.nrm.set(o.nrm.subarray(0, o.nv * 3), v0 * 3);
    this.uv.set(o.uv.subarray(0, o.nv * 2), v0 * 2);
    this.col.set(o.col.subarray(0, o.nv * 3), v0 * 3);
    this.lay.set(o.lay.subarray(0, o.nv), v0);
    for (let i = 0; i < o.ni; i++) this.idx[this.ni + i] = o.idx[i] + v0;
    this.nv += o.nv;
    this.ni += o.ni;
  }

  /** Forgets what has been written (keeps the buffers). */
  clear() {
    this.nv = 0;
    this.ni = 0;
  }

  get empty() {
    return this.nv === 0;
  }

  /** A BufferGeometry over what has been written. */
  geometry() {
    const g = new THREE.BufferGeometry();
    const nv = this.nv;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, nv * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.slice(0, nv * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, nv * 2), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, nv * 3), 3, true));
    g.setAttribute('layer', new THREE.BufferAttribute(this.lay.slice(0, nv), 1));
    const idx = this.idx.subarray(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(nv < 65535 ? new Uint16Array(idx) : idx.slice(), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Square cells that collect writers per set ('near', 'far', 'always' …), so the scene can cull by distance
 * and the renderer by frustum. Building geometry is filed under the cell of the building's centre.
 */
export class Cells {
  constructor(size, tiles) {
    this.size = size;
    this.tiles = tiles;
    this.map = new Map();
  }

  cell(x, z) {
    const cx = Math.floor(x / this.size), cz = Math.floor(z / this.size);
    const key = `${cx},${cz}`;
    let c = this.map.get(key);
    if (!c) this.map.set(key, (c = { cx, cz, sets: {}, minY: Infinity, maxY: -Infinity, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }));
    return c;
  }

  writer(x, z, set) {
    const c = this.cell(x, z);
    return c.sets[set] ?? (c.sets[set] = new Writer(this.tilesFor ? this.tilesFor(set) : this.tiles));
  }

  /**
   * Meshes for every cell and set. opts[set] = { material, shadows, near (max distance) or far (shown beyond
   * the cell's near distance) }. Each cell's sets share one bounding sphere so near and far swap exactly.
   */
  build(group, opts) {
    const v = new THREE.Vector3();
    for (const c of this.map.values()) {
      const geos = {};
      const box = new THREE.Box3();
      for (const [set, w] of Object.entries(c.sets)) {
        if (w.empty) continue;
        geos[set] = w.geometry();
        box.union(geos[set].boundingBox);
      }
      if (box.isEmpty()) continue;
      const centre = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(v).length() / 2;
      for (const [set, geo] of Object.entries(geos)) {
        const o = opts[set];
        if (!o) continue;
        const mesh = new THREE.Mesh(geo, o.material);
        mesh.castShadow = !!o.shadows;
        mesh.receiveShadow = true;
        mesh.userData.centre = centre;
        mesh.userData.radius = radius;
        mesh.userData.maxDistance = o.near ?? Infinity;
        mesh.userData.minDistance = o.far != null ? o.far + radius : 0;
        mesh.userData.arch = set;
        group.add(mesh);
      }
    }
    return group;
  }
}
