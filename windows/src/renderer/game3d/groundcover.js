// Plants and stones near the camera, so the ground has depth instead of being a painted carpet: a fine sward of
// grass blades close by, long grass and flowers on the road verges, tawny tussocks on the rough grazing, clumps
// of soft rush in the wet ground, and limestone boulders on the outcrops, under the scars and on the scree.
//
// Everything is placed from what the map knows about each spot (ground class, the relief, the aerial imagery's
// colour, the road), in 16 m chunks generated around the camera and dropped behind it, drawn as one instanced
// mesh per kind (a handful of draw calls), shrinking away smoothly at the edge of its range so nothing pops in.
// Plants take the colour of the ground under them, so they read as the field's own grass, not stuck-on clumps.
import * as THREE from 'three';
import { hash2 } from '../../core/world/noise.js';

const CHUNK = 16;

// ---- Card textures (one atlas, four columns): fine grass, verge grass with flowers, soft rush, tussock ----
// Drawn in near-neutral tones: the instance colour (the ground's colour) gives the hue.

function cardAtlas() {
  const W = 1024, H = 512, cw = W / 4;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  let seed = 7;
  const r = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const blade = (x0, y0, x1, y1, w, col, bend = 0) => {
    const mx = (x0 + x1) / 2 + bend, my = (y0 + y1) / 2;
    const nx = -(y1 - y0), ny = x1 - x0, l = Math.hypot(nx, ny) || 1;
    const ox = (nx / l) * w, oy = (ny / l) * w;
    g.beginPath();
    g.moveTo(x0 - ox, y0 - oy);
    g.quadraticCurveTo(mx - ox * 0.5, my - oy * 0.5, x1, y1);
    g.quadraticCurveTo(mx + ox * 0.5, my + oy * 0.5, x0 + ox, y0 + oy);
    g.closePath();
    g.fillStyle = col;
    g.fill();
  };
  // Neutral greys, a few warmer (dead) blades.
  const grey = (l, warm = 0) => `rgb(${Math.round(l * (1 + warm * 0.25))}, ${Math.round(l * (1 + warm * 0.12))}, ${Math.round(l * (1 - warm * 0.35))})`;
  // 0: fine grass: many thin blades, densest at the base.
  for (let i = 0; i < 160; i++) {
    const x0 = cw * 0.5 + (r() - 0.5) * cw * 0.8, a = (r() - 0.5) * 0.9, len = H * (0.3 + r() * 0.7);
    const dead = r() < 0.15;
    blade(x0, H, x0 + Math.sin(a) * len * 0.6, H - Math.cos(a) * len, 1.6 + r() * 1.6, grey(150 + r() * 90, dead ? 1 : r() * 0.3), a * 25);
  }
  // 1: verge grass: taller, seed heads, the odd buttercup or cow parsley.
  for (let i = 0; i < 120; i++) {
    const x0 = cw + cw * 0.5 + (r() - 0.5) * cw * 0.7, a = (r() - 0.5) * 0.9, len = H * (0.4 + r() * 0.6);
    const x1 = x0 + Math.sin(a) * len * 0.6, y1 = H - Math.cos(a) * len;
    blade(x0, H, x1, y1, 1.8 + r() * 1.8, grey(150 + r() * 90, r() < 0.2 ? 1 : r() * 0.3), a * 30);
    if (r() < 0.2) {
      g.fillStyle = grey(190 + r() * 40, 1.4);
      g.beginPath();
      g.ellipse(x1, y1 + 9, 3, 15, a, 0, Math.PI * 2);
      g.fill();
    }
  }
  for (let i = 0; i < 10; i++) {
    const x = cw + cw * (0.15 + r() * 0.7), y = H * (0.08 + r() * 0.35);
    g.fillStyle = r() < 0.55 ? '#ffe04a' : '#fbfaf2';
    g.beginPath();
    g.arc(x, y, 5 + r() * 4, 0, Math.PI * 2);
    g.fill();
  }
  // 2: soft rush: straight round stems in a tight fan, brown flower tufts.
  for (let i = 0; i < 130; i++) {
    const x0 = 2 * cw + cw * 0.5 + (r() - 0.5) * cw * 0.2, a = (r() - 0.5) * 0.8, len = H * (0.55 + r() * 0.45);
    const x1 = x0 + Math.sin(a) * len, y1 = H - Math.cos(a) * len;
    blade(x0, H, x1, y1, 1.6 + r() * 1.2, grey(120 + r() * 80, r() < 0.1 ? 1 : 0), 0);
    if (r() < 0.12) {
      g.fillStyle = 'rgb(120, 95, 60)';
      g.beginPath();
      g.ellipse(x0 + Math.sin(a) * len * 0.78, H - Math.cos(a) * len * 0.78, 4, 8, a, 0, Math.PI * 2);
      g.fill();
    }
  }
  // 3: tussock (moor grass, bent): a dense mound, arching, many dead blades.
  for (let i = 0; i < 170; i++) {
    const x0 = 3 * cw + cw * 0.5 + (r() - 0.5) * cw * 0.35, a = (r() - 0.5) * 2.2, len = H * (0.35 + r() * 0.6);
    blade(x0, H, x0 + Math.sin(a) * len * 0.85, H - Math.cos(a) * len * 0.8, 1.8 + r() * 1.6, grey(140 + r() * 100, r() < 0.45 ? 1 : r() * 0.4), a * 50);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Crossed vertical quads, 1 m wide and tall, mapped to atlas column k. */
function cardGeometry(k, quads) {
  const pos = [], uv = [], nrm = [], idx = [];
  const u0 = k / 4 + 0.004, u1 = (k + 1) / 4 - 0.004;
  for (let q = 0; q < quads; q++) {
    const a = (q / quads) * Math.PI;
    const ca = Math.cos(a), sa = Math.sin(a);
    const base = pos.length / 3;
    pos.push(-ca * 0.5, -0.05, -sa * 0.5, ca * 0.5, -0.05, sa * 0.5, ca * 0.5, 1, sa * 0.5, -ca * 0.5, 1, -sa * 0.5);
    uv.push(u0, 0, u1, 0, u1, 1, u0, 1);
    // Lit as if they were the ground they grow from, so they sit in the field rather than glowing or going black.
    for (let i = 0; i < 4; i++) nrm.push(0, 1, 0);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/** Limestone boulders: a few weathered, flat-topped shapes. */
function boulderGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + 0.16 * Math.sin(x * 4.1 + seed) * Math.sin(z * 3.7 - seed) + 0.1 * Math.sin(y * 6.3 + x * 2.1 + seed * 2);
    x *= n;
    z *= n;
    y *= n;
    // Bedding: limestone breaks into slabs with flat tops and sides.
    if (y > 0.35) y = 0.35 + (y - 0.35) * 0.25;
    if (y < -0.5) y = -0.5;
    const ax = Math.abs(x);
    if (ax > 0.8) x = Math.sign(x) * (0.8 + (ax - 0.8) * 0.3);
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

// ---- Limestone pavement: clints on the same joint lattice the ground shader paints (ground.js grikes) ----

/** The integer hash the ground shader uses (ihash in ground.js). */
function ihash(x) {
  let h = Math.imul((x + 1000000) >>> 0, 0x9e3779b1) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x85ebca77) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h & 0xffff) / 65535;
}

/**
 * Clints whose centres fall in a data-coordinate box (x east, y north): [{x, y, ang, w, l, tone}]. The lattice: in
 * rotated coordinates q, joints every 2.3 m across, rows of 1.4-3.8 m along, as in the shader.
 */
export function clintLattice(x0, y0, x1, y1) {
  const out = [];
  // Rotated bounds (q = R p), generously.
  const qs = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [0.94 * x + 0.34 * y, -0.34 * x + 0.94 * y]);
  const qx0 = Math.min(...qs.map((q) => q[0])) - 3, qx1 = Math.max(...qs.map((q) => q[0])) + 3;
  const qy0 = Math.min(...qs.map((q) => q[1])) - 4, qy1 = Math.max(...qs.map((q) => q[1])) + 4;
  for (let col = Math.floor(qx0 / 2.3); col <= Math.floor(qx1 / 2.3); col++) {
    const sp = 1.4 + 2.4 * ihash(col), off = ihash(col + 7919) * sp;
    for (let row = Math.floor((qy0 + off) / sp) - 1; row <= Math.floor((qy1 + off) / sp) + 1; row++) {
      // Solve for the cell centre: wx = (col + 0.5) 2.3, wy = (row + 0.5) sp (two fixed-point passes).
      let qy = (row + 0.5) * sp - off, qx = (col + 0.5) * 2.3;
      for (let it = 0; it < 3; it++) {
        qx = (col + 0.5) * 2.3 - 0.3 * Math.sin(qy * 0.61) - 0.14 * Math.sin(qy * 1.7);
        qy = (row + 0.5) * sp - off - 0.25 * Math.sin(qx * 1.3);
      }
      const x = 0.94 * qx - 0.34 * qy, y = 0.34 * qx + 0.94 * qy;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
      out.push({ x, y, ang: Math.atan2(0.34, 0.94), w: 2.3, l: sp, tone: ihash(col * 131 + row) });
    }
  }
  return out;
}

/** A clint: a flat-topped limestone block with rounded, solution-fluted edges (1×1 m top, base at y = 0). */
function clintGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1, 4, 2, 4);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i) + 0.5, z = p.getZ(i);
    // Round the top edges, draw the base in a little, flute the sides.
    const ex = Math.abs(x) / 0.5, ez = Math.abs(z) / 0.5;
    const edge = Math.max(ex, ez);
    // Flat tops with crisp, slightly rounded edges and runnels (karren) down the sides.
    if (y > 0.9) y -= Math.pow(Math.max(0, edge - 0.75) / 0.25, 2) * 0.12;
    const k = y < 0.2 ? 0.92 : 1;
    x *= k;
    z *= k;
    x *= 1 + 0.06 * Math.sin(z * 19 + y * 3);
    z *= 1 + 0.06 * Math.sin(x * 17 - y * 2);
    p.setXYZ(i, x, y - 0.05, z);
  }
  g.computeVertexNormals();
  return g;
}

/** A plant material that shrinks instances away between `fade0` and `fade1` metres from the camera. */
function plantMaterial(atlas, time, fade0, fade1, aa, sway) {
  const m = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95, metalness: 0, alphaToCoverage: aa });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.coverTime = time;
    shader.uniforms.coverFade = { value: new THREE.Vector3(fade0, fade1, sway) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float coverTime;
        uniform vec3 coverFade;
        varying float vCoverH;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 coverO = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float coverD = distance(cameraPosition, coverO);
        transformed *= 1.0 - smoothstep(coverFade.x, coverFade.y, coverD);
        float hgt = clamp(position.y, 0.0, 1.0);
        float sway = sin(coverTime * 1.7 + coverO.x * 0.31 + coverO.z * 0.23) + 0.4 * sin(coverTime * 3.1 + coverO.z * 0.7);
        transformed.x += sway * coverFade.z * hgt * hgt;
        transformed.z += sway * coverFade.z * 0.6 * hgt * hgt;
        vCoverH = hgt;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vCoverH;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        // Darker down in the sward, where the light does not reach.
        diffuseColor.rgb *= mix(0.72, 1.1, smoothstep(0.0, 0.8, vCoverH));`);
  };
  m.customProgramCacheKey = () => 'groundcover-plants-v2';
  return m;
}

/**
 * opts: {probe(x, z, out) -> fills {skip, under, h, verge, field, rough, rushPatch, rock, scree, high, colour:
 * [r, g, b] linear}, q (quality preset), rockMaterial}.
 */
export class GroundCover {
  constructor(opts) {
    this.opts = opts;
    const q = opts.q;
    this.level = q.cover ?? 1;
    const R = q.coverRadius ?? 45;
    this.radius = R;
    this.rockRadius = q.rockRadius ?? 150;
    this.group = new THREE.Group();
    this.group.name = 'groundcover';
    this.chunks = new Map();
    this.time = { value: 0 };
    const atlas = cardAtlas();
    const aa = !!q.antialias;
    // Per kind: atlas column, range (fine grass only close by), instance cap per quality level.
    const L = this.level;
    const spec = [
      { col: 0, fade: [R * 0.2, R * 0.36], cap: [0, 14000, 26000][L], sway: 0.02 }, // fine sward
      { col: 1, fade: [R * 0.6, R], cap: [3000, 7000, 12000][L], sway: 0.06 }, // verge grass
      { col: 2, fade: [R * 0.75, R * 1.3], cap: [400, 1500, 3000][L], sway: 0.03 }, // soft rush
      { col: 3, fade: [R * 0.6, R], cap: [0, 2500, 5000][L], sway: 0.04 }, // tussocks
    ];
    this.kinds = spec.map((s) => {
      const cap = Math.max(1, s.cap);
      const mesh = new THREE.InstancedMesh(cardGeometry(s.col, 2), plantMaterial(atlas, this.time, s.fade[0], s.fade[1], aa, s.sway), cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.group.add(mesh);
      return { mesh, cap: s.cap, range: s.fade[1] };
    });
    // Clints on the limestone pavements (out to clintRange, then the ground shader paints them).
    this.clintRange = [40, 60, 80][L];
    const clintCap = [1500, 3500, 6000][L];
    {
      const mesh = new THREE.InstancedMesh(clintGeometry(), opts.clintMaterial ?? opts.rockMaterial, clintCap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = !!q.shadows;
      mesh.receiveShadow = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(clintCap * 3), 3);
      this.group.add(mesh);
      this.clints = { mesh, cap: clintCap, range: this.clintRange };
    }
    const rockCap = [300, 900, 1800][L];
    this.rockKinds = [0, 1, 2].map((s) => {
      const cap = Math.max(1, Math.round(rockCap / 3));
      const mesh = new THREE.InstancedMesh(boulderGeometry(s * 1.7 + 0.3), opts.rockMaterial, cap);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = !!q.shadows;
      mesh.receiveShadow = true;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.group.add(mesh);
      return { mesh, cap, range: this.rockRadius };
    });
    this.dirty = false;
    this.last = null;
  }

  /** The plants of one chunk (deterministic: the same every time it is visited). */
  makePlants(ci, cj) {
    const out = [[], [], [], []];
    const probe = this.opts.probe;
    const x0 = ci * CHUNK, z0 = cj * CHUNK;
    // What the ground is at each corner of a 1 m lattice; plants in between take their height bilinearly.
    const N = CHUNK + 1;
    const P = new Array(N * N);
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) P[b * N + a] = probe(x0 + a, z0 + b, {});
    const fine = this.level >= 1 ? (this.level >= 2 ? 9 : 6) : 0;
    for (let gz = 0; gz < CHUNK; gz++) {
      for (let gx = 0; gx < CHUNK; gx++) {
        const c00 = P[gz * N + gx], c10 = P[gz * N + gx + 1], c01 = P[(gz + 1) * N + gx], c11 = P[(gz + 1) * N + gx + 1];
        if (c00.skip || c00.under || c11.skip || c11.under || c10.skip || c01.skip) continue;
        const hAt = (u, v) => (c00.h * (1 - u) + c10.h * u) * (1 - v) + (c01.h * (1 - u) + c11.h * u) * v;
        const col = c00.colour;
        const seedI = ci * 64 + gx, seedJ = cj * 64 + gz;
        const verge = c00.verge > 0 && c11.verge > 0;
        // Fine sward everywhere there is turf (a few blades' worth of card per square metre).
        // Grazed pasture is a fine, close turf (the ground texture shows it): long grass only on the verges and the
        // rough grazing.
        const nFine = verge ? fine + 1 : c00.rough > 0.5 ? fine - 1 : 0;
        for (let k = 0; k < nFine; k++) {
          const u = hash2(seedI * 7 + k, seedJ, 11), v = hash2(seedI, seedJ * 7 + k, 12), w = hash2(seedI + k * 31, seedJ - k * 17, 13);
          const s = (verge ? 0.2 : c00.rough > 0.5 ? 0.16 : 0.09) + w * (verge ? 0.12 : 0.08);
          // Instance colour ~2.3x the ground's: the card texture averages ~0.55 and the base is in shade, so on
          // average the sward matches the ground it grows from, tips a little brighter.
          const tone = 2.1 + w * 0.45;
          out[0].push(x0 + gx + u, hAt(u, v), z0 + gz + v, w * 6.283, s * 1.6, s, col[0] * tone, col[1] * tone, col[2] * tone * 0.92);
        }
        const hA = hash2(seedI, seedJ, 21), hB = hash2(seedI, seedJ, 22), hC = hash2(seedI, seedJ, 23);
        if (verge) {
          // Long grass and flowers along the road.
          const n = this.level >= 2 ? 3 : 2;
          for (let k = 0; k < n; k++) {
            const u = hash2(seedI * 5 + k, seedJ * 3, 31), v = hash2(seedI * 3, seedJ * 5 + k, 32), w = hash2(seedI + k, seedJ + k * 7, 33);
            const s = 0.3 + w * 0.32;
            out[1].push(x0 + gx + u, hAt(u, v), z0 + gz + v, w * 6.283, s * 1.2, s, col[0] * 2.4, col[1] * 2.25, col[2] * 1.9);
          }
          continue;
        }
        if (c00.rushPatch > 0 && hA < c00.rushPatch) {
          const s = 0.5 + hB * 0.45;
          out[2].push(x0 + gx + hB, hAt(hB, hC), z0 + gz + hC, hA * 40, s * 0.8, s, col[0] * 1.5, col[1] * 1.85, col[2] * 1.3);
          continue;
        }
        // Tussocks on the rough grazing; the odd one in the fields.
        const tus = c00.rough > 0.5 ? 0.1 : c00.field ? 0.01 : 0;
        if (hC < tus) {
          const s = c00.rough > 0.5 ? 0.3 + hB * 0.3 : 0.2 + hB * 0.15;
          // Moor grass goes tawny; a field tussock is the field's green, a little paler.
          const tc = c00.rough > 0.5 ? [col[0] * 3.4 + 0.05, col[1] * 2.6 + 0.03, col[2] * 2.0] : [col[0] * 2.6, col[1] * 2.4, col[2] * 2.0];
          out[3].push(x0 + gx + hA, hAt(hA, hB), z0 + gz + hB, hC * 40, s * 1.4, s, tc[0], tc[1], tc[2]);
        }
      }
    }
    return out;
  }

  /** The clints of one chunk: on the pavement lattice, wherever the ground there is pavement. */
  makeClints(ci, cj) {
    const out = [];
    const probe = this.opts.probe;
    const p = {};
    const x0 = ci * CHUNK, z0 = cj * CHUNK;
    // Data coords: y = -z.
    for (const c of clintLattice(x0, -(z0 + CHUNK), x0 + CHUNK, -z0)) {
      const x = c.x, z = -c.y;
      probe(x, z, p);
      if (p.skip || p.under || !(p.pave > 0.5)) continue;
      // Leave out the odd clint (a grassy hollow, a fallen block's gap) and vary their height and finish.
      const h = hash2(Math.round(x * 4), Math.round(z * 4), 81);
      if (h < 0.08) continue;
      const gap = 0.42 + h * 0.2; // grike width
      const w = Math.max(0.6, c.w - gap), l = Math.max(0.5, c.l - gap);
      const ht = 0.18 + 0.22 * hash2(Math.round(x * 4), Math.round(z * 4), 82);
      // Weathered grey, some darker with lichen.
      const tone = 0.62 + 0.3 * c.tone;
      // The joint direction (data angle a, north of east) is world yaw +a (x east, z south).
      out.push(x, p.h - 0.08, z, c.ang, w, ht, l, tone, tone, tone * 0.98);
    }
    return out;
  }

  /** The boulders of one chunk, on a coarser grid: on outcrops, scree and below the scars. */
  makeRocks(ci, cj) {
    const out = [[], [], []];
    const probe = this.opts.probe;
    const p = {};
    const x0 = ci * CHUNK, z0 = cj * CHUNK;
    for (let gz = 0; gz < CHUNK; gz += 2) {
      for (let gx = 0; gx < CHUNK; gx += 2) {
        const hA = hash2(ci * 128 + gx, cj * 128 + gz, 71), hB = hash2(ci * 128 + gx, cj * 128 + gz, 72), hC = hash2(ci * 128 + gx, cj * 128 + gz, 73);
        const x = x0 + gx + hA * 2, z = z0 + gz + hB * 2;
        probe(x, z, p);
        if (p.skip || p.under || p.verge > 0) continue;
        const chance = p.pave > 0.5 ? 0.008 : p.scree * 0.7 + p.rock * 0.32 + (p.field && p.high ? 0.012 : 0);
        if (hC >= chance) continue;
        const big = p.scree > 0.5 ? 0.15 + hA * 0.35 : 0.3 + Math.pow(hA, 2) * 1.2;
        const tone = 0.85 + hB * 0.3;
        out[Math.floor(hC * 97) % 3].push(x, p.h - big * 0.25, z, hB * 6.283, big * (0.8 + hC * 0.6), big * (0.55 + hA * 0.4), tone, tone, tone * 0.97);
      }
    }
    return out;
  }

  /**
   * Call every frame with the camera: fills chunks coming into range (nearest first, within a few milliseconds a
   * frame), drops those left behind, and refreshes the instances when anything changed.
   */
  update(camera, dt = 0.016, budgetMs = 4) {
    this.time.value += dt;
    if (!camera) return;
    const cx = camera.position.x, cz = camera.position.z;
    const R = Math.max(this.radius * 1.3, this.rockRadius) + CHUNK;
    const i0 = Math.floor((cx - R) / CHUNK), i1 = Math.floor((cx + R) / CHUNK), j0 = Math.floor((cz - R) / CHUNK), j1 = Math.floor((cz + R) / CHUNK);
    const todo = [];
    const keep = new Set();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = Math.max(0, Math.abs(cx - (i + 0.5) * CHUNK) - CHUNK / 2), dz = Math.max(0, Math.abs(cz - (j + 0.5) * CHUNK) - CHUNK / 2);
        const d = Math.hypot(dx, dz);
        if (d > R) continue;
        const key = `${i},${j}`;
        keep.add(key);
        let ch = this.chunks.get(key);
        if (!ch) this.chunks.set(key, (ch = { i, j, plants: null, rocks: null, clints: null }));
        if ((!ch.plants && d < this.radius * 1.3) || (!ch.rocks && d < this.rockRadius) || (!ch.clints && d < this.clintRange)) todo.push({ ch, d });
      }
    }
    todo.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    for (const { ch, d } of todo) {
      if (performance.now() - t0 > budgetMs) break;
      if (!ch.plants && d < this.radius * 1.3) ch.plants = this.makePlants(ch.i, ch.j);
      if (!ch.rocks && d < this.rockRadius) ch.rocks = this.makeRocks(ch.i, ch.j);
      if (!ch.clints && d < this.clintRange) ch.clints = this.makeClints(ch.i, ch.j);
      this.dirty = true;
    }
    for (const key of [...this.chunks.keys()]) {
      if (!keep.has(key)) {
        this.chunks.delete(key);
        this.dirty = true;
      }
    }
    this.since = (this.since ?? 0) + dt;
    const moved = !this.last || Math.hypot(cx - this.last.x, cz - this.last.z) > 4;
    if (this.dirty && (moved || this.since > 0.3)) {
      this.last = { x: cx, z: cz };
      this.since = 0;
      this.dirty = false;
      this.rebuild(cx, cz);
    }
  }

  rebuild(cx, cz) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    // Nearest chunks first, so the caps cut the far ones.
    const list = [...this.chunks.values()].map((ch) => ({ ch, d: Math.hypot((ch.i + 0.5) * CHUNK - cx, (ch.j + 0.5) * CHUNK - cz) })).sort((a, b) => a.d - b.d);
    const fill = (target, cap, getArr, range) => {
      let n = 0;
      for (const { ch, d } of list) {
        if (d > range + CHUNK) break;
        const a = getArr(ch);
        if (!a) continue;
        for (let k = 0; k + 8 < a.length && n < cap; k += 9) {
          q.setFromAxisAngle(up, a[k + 3]);
          s.set(a[k + 4], a[k + 5], a[k + 4]);
          v.set(a[k], a[k + 1], a[k + 2]);
          m.compose(v, q, s);
          target.setMatrixAt(n, m);
          c.setRGB(a[k + 6], a[k + 7], a[k + 8]);
          target.setColorAt(n, c);
          n++;
        }
      }
      target.count = n;
      target.instanceMatrix.needsUpdate = true;
      if (target.instanceColor) target.instanceColor.needsUpdate = true;
    };
    this.kinds.forEach((k, idx) => fill(k.mesh, k.cap, (ch) => ch.plants?.[idx], k.range));
    this.rockKinds.forEach((k, idx) => fill(k.mesh, k.cap, (ch) => ch.rocks?.[idx], k.range));
    {
      const t = this.clints;
      let n = 0;
      for (const { ch, d } of list) {
        if (d > t.range + CHUNK) break;
        const a = ch.clints;
        if (!a) continue;
        for (let k = 0; k + 9 < a.length && n < t.cap; k += 10) {
          q.setFromAxisAngle(up, a[k + 3]);
          s.set(a[k + 4], a[k + 5], a[k + 6]);
          v.set(a[k], a[k + 1], a[k + 2]);
          m.compose(v, q, s);
          t.mesh.setMatrixAt(n, m);
          c.setRGB(a[k + 7], a[k + 8], a[k + 9]);
          t.mesh.setColorAt(n, c);
          n++;
        }
      }
      t.mesh.count = n;
      t.mesh.instanceMatrix.needsUpdate = true;
      if (t.mesh.instanceColor) t.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Forget everything (when what the probe knows has changed, e.g. the imagery has loaded). */
  reset() {
    this.chunks.clear();
    this.dirty = true;
    this.last = null;
  }
}
