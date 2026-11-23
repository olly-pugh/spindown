// The Yorkshire Dales world: a valley road climbing over a fell, patchwork meadows and pastures divided by
// dry-stone walls and hawthorn hedges, field barns and gates, woods, Swaledale sheep, a river with a stone
// packhorse bridge, a tarn, and the village of Thornby with its church, pub, phone box and green. Distant
// fells ring the horizon.
import * as THREE from 'three';
import * as C from './common.js';
import * as T from './textures.js';
import { RouteField } from '../../core/world/field.js';
import { fbm, rng, hash2 } from '../../core/world/noise.js';

const ROAD_HALF = 2.9; // tarmac half-width incl. edge lines
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Grid lines that are `step` apart between fineMin and fineMax and spread out progressively beyond. */
function gridAxis(min, max, fineMin, fineMax, step) {
  const out = [];
  for (let x = fineMin; x <= fineMax; x += step) out.push(x);
  let s = step, x = out[out.length - 1];
  while (x < max) {
    s = Math.min(s * 1.22, 160);
    x = Math.min(max, x + s);
    out.push(x);
  }
  s = step;
  x = fineMin;
  while (x > min) {
    s = Math.min(s * 1.22, 160);
    x = Math.max(min, x - s);
    out.unshift(x);
  }
  return out;
}

/** A box whose side faces carry a wall texture at `per` metres per repeat. */
function stoneBox(w, h, d, per = 4) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const sizes = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) uv.setXY(f * 4 + k, (uv.getX(f * 4 + k) * sizes[f][0]) / per, (uv.getY(f * 4 + k) * sizes[f][1]) / per);
  return g;
}

export function buildDales(route, q) {
  const group = new THREE.Group();
  const field = new RouteField(route, { cell: 20, margin: 2400 });
  const course = route.course;
  const L = route.length;
  const tmp = {};

  // ---- River: out of a tarn inside the loop, under Thorn Bridge, away down the dale ----
  const bridgeAt = course.river.at;
  const bp = route.position(bridgeAt);
  const across = bp.heading + Math.PI / 2; // perpendicular to the road
  const dirX = Math.sin(across), dirZ = -Math.cos(across);
  // Which way is outward (away from the loop centre)?
  const outward = bp.x * dirX + bp.z * dirZ > 0 ? 1 : -1;
  const river = [];
  for (let t = -420; t <= 2600; t += 12) {
    const s = t * outward;
    const wiggle = Math.sin(t / 170) * 38 * smoothstep(40, 300, Math.abs(t)) + Math.sin(t / 61) * 7 * smoothstep(20, 120, Math.abs(t));
    river.push(bp.x + dirX * s + Math.cos(across) * wiggle, bp.z + dirZ * s + Math.sin(across) * wiggle);
  }
  const tarn = { x: river[0], z: river[1], r: 95 };
  const waterLevel = route.elevation(bridgeAt) - 3.6;
  const riverDistance = (x, z) => {
    let best = Infinity;
    for (let i = 0; i < river.length - 2; i += 2) {
      const ax = river[i], az = river[i + 1], bx = river[i + 2], bz = river[i + 3];
      const vx = bx - ax, vz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
      const d = (x - ax - vx * t) ** 2 + (z - az - vz * t) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  // Coarse river-distance grid for speed.
  const rCell = 12, rx0 = bp.x - 3200, rz0 = bp.z - 3200, rn = Math.ceil(6400 / rCell);
  const rGrid = new Float32Array(rn * rn);
  for (let j = 0; j < rn; j++) {
    for (let i = 0; i < rn; i++) {
      const x = rx0 + i * rCell, z = rz0 + j * rCell;
      // Cheap reject far from the river's bounding corridor.
      rGrid[j * rn + i] = riverDistanceFast(x, z);
    }
  }
  function riverDistanceFast(x, z) {
    const dx = x - bp.x, dz = z - bp.z;
    const along = dx * dirX * outward + dz * dirZ * outward;
    if (along < -560 || along > 2700) return 999;
    const side = Math.abs(dx * Math.cos(across) + dz * Math.sin(across));
    if (side > 140) return 999;
    return riverDistance(x, z);
  }
  const riverAt = (x, z) => {
    const fx = (x - rx0) / rCell, fz = (z - rz0) / rCell;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= rn - 1 || j >= rn - 1) return 999;
    const a = rGrid[j * rn + i], b = rGrid[j * rn + i + 1], c = rGrid[(j + 1) * rn + i], d = rGrid[(j + 1) * rn + i + 1];
    const u = fx - i, v = fz - j;
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };

  // ---- Terrain height ----
  const village = (along) => {
    const from = course.village.from, to = course.village.to;
    return along >= from || along <= to;
  };
  function heightAt(x, z) {
    field.query(x, z, tmp);
    const roadY = route.elevation(tmp.along);
    const dist = tmp.distance;
    const near = smoothstep(ROAD_HALF + 3, 70, dist);
    const far = smoothstep(60, 700, dist);
    let h = roadY - 0.35
      + near * ((fbm(x / 130, z / 130, 3, 11) - 0.5) * 9 + 1.5)
      + far * ((fbm(x / 520, z / 520, 4, 12) - 0.4) * 120)
      + smoothstep(900, 2400, dist) * 140 * fbm(x / 900, z / 900, 3, 13);
    // River channel and tarn.
    const rd = riverAt(x, z);
    const td = Math.hypot(x - tarn.x, z - tarn.z);
    const channel = Math.min(rd - 5, td - tarn.r);
    if (channel < 40) {
      const bed = waterLevel - 1.6;
      const k = smoothstep(0, 40, channel);
      h = Math.min(h, bed + k * (h - bed));
      if (channel < 0) h = bed;
    }
    // Keep the road itself clear (the bridge spans the channel).
    if (dist < ROAD_HALF + 2 && Math.abs(tmp.along - bridgeAt) > 14) h = Math.min(h, roadY - 0.3);
    return h;
  }
  group.userData.heightAt = heightAt;

  // ---- Terrain mesh: a fine grid around the loop that coarsens towards the horizon ----
  const b = route.bounds();
  const ext = 2300, fine = 380;
  const step = q.terrainStep;
  const xs = gridAxis(b.minX - ext, b.maxX + ext, b.minX - fine, b.maxX + fine, step);
  const zs = gridAxis(b.minZ - ext, b.maxZ + ext, b.minZ - fine, b.maxZ + fine, step);
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3), col = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
  const c = new THREE.Color();
  // Meadows, pastures and a few fields cut for hay: lush layered greens.
  const pal = ['#86b04f', '#93b958', '#6f9c40', '#a3c15f', '#c4cf74', '#7ba648', '#8eb252', '#a9c463', '#66943c', '#b7c868', '#d2d27e', '#7fae58'].map((x) => C.colour(x));
  const moor = C.colour('#9a8a5c'), heather = C.colour('#7c5a72'), bank = C.colour('#5f8040'), bracken = C.colour('#8a7a44'), lush = C.colour('#6f9c42');
  const fieldCell = 150, ang = 0.35, ca = Math.cos(ang), sa = Math.sin(ang);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i], z = zs[j];
      const y = heightAt(x, z);
      const k = j * nx + i;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / 7;
      uv[k * 2 + 1] = z / 7;
      // Patchwork fields: tint by field cell; rough moorland higher up; darker and lusher near water.
      const u = (x * ca + z * sa) / fieldCell, v = (-x * sa + z * ca) / (fieldCell * 0.8);
      c.copy(pal[Math.floor(hash2(Math.floor(u), Math.floor(v), 5) * pal.length)]);
      c.lerp(lush, 0.35 * fbm(x / 60, z / 60, 2, 21));
      const high = smoothstep(200, 250, y + 14 * (fbm(x / 90, z / 90, 2, 3) - 0.5));
      c.lerp(moor, high * 0.85).lerp(bracken, high * 0.5 * fbm(x / 55, z / 55, 2, 7)).lerp(heather, high * 0.55 * smoothstep(0.45, 0.7, fbm(x / 70, z / 70, 3, 9)));
      const wet = 1 - smoothstep(0, 25, Math.min(riverAt(x, z) - 5, Math.hypot(x - tarn.x, z - tarn.z) - tarn.r));
      c.lerp(bank, wet * 0.7);
      const jitter = 0.92 + 0.16 * fbm(x / 9, z / 9, 2, 4);
      col[k * 3] = c.r * jitter;
      col[k * 3 + 1] = c.g * jitter;
      col[k * 3 + 2] = c.b * jitter;
    }
  }
  const index = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let ii = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b2 = a + 1, cc = a + nx, d = cc + 1;
      index[ii++] = a;
      index[ii++] = cc;
      index[ii++] = b2;
      index[ii++] = b2;
      index[ii++] = cc;
      index[ii++] = d;
    }
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  tg.setIndex(new THREE.BufferAttribute(index, 1));
  tg.computeVertexNormals();
  // The vertex colours already carry the green; the texture (drawn green) is lightened so it adds grain, not hue.
  const terrain = new THREE.Mesh(tg, C.groundMaterial({ map: T.grassTexture('pale'), vertexColors: true, roughness: 0.97, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
  terrain.receiveShadow = true;
  group.add(terrain);

  // ---- Road, verges and the bridge ----
  const road = new THREE.Mesh(C.ribbon(route, { left: -ROAD_HALF, right: ROAD_HALF, lift: 0.04, uvLength: 9 }), C.roadMaterial({ centreLine: true }));
  road.receiveShadow = true;
  group.add(road);
  const vergeMat = C.groundMaterial({ map: T.grassTexture('pale'), color: '#86ad50', roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const verges = [];
  for (const [l, r] of [[-ROAD_HALF - 2.0, -ROAD_HALF + 0.05], [ROAD_HALF - 0.05, ROAD_HALF + 2.0]]) {
    verges.push(C.ribbon(route, { left: l, right: r, lift: 0.0, uvLength: 7, uvAcross: 0.3, heightAt: (x, z, d) => Math.max(route.elevation(d) - 0.12, Math.min(route.elevation(d) + 0.25, heightAt(x, z) + 0.04)) }));
  }
  const verge = new THREE.Mesh(C.mergeAll(verges), vergeMat);
  verge.receiveShadow = true;
  group.add(verge);

  // Thorn Bridge: a humped stone bridge with a single arch and low parapets.
  const stone = new THREE.MeshStandardMaterial({ map: T.stoneWallTexture({ tone: 'rubble' }), roughness: 0.95, side: THREE.DoubleSide });
  {
    const parts = [];
    for (const s of [-1, 1]) {
      const o = s * (ROAD_HALF + 0.35);
      parts.push(C.routeWall(route, { lateral: o - 0.22, from: bridgeAt - 17, to: bridgeAt + 17, step: 1, bottom: (d, y) => y - 0.2, top: (d, y) => y + 0.95, uvLength: 4, uvHeight: 4 }));
      parts.push(C.routeWall(route, { lateral: o + 0.22, from: bridgeAt - 17, to: bridgeAt + 17, step: 1, bottom: (d, y) => y - 0.6, top: (d, y) => y + 0.95, uvLength: 4, uvHeight: 4 }));
      parts.push(C.ribbon(route, { left: o - 0.26, right: o + 0.26, lift: 0.95, from: bridgeAt - 17, to: bridgeAt + 17, step: 1, uvLength: 4, uvAcross: 0.12 }));
    }
    // The body: a slab across the channel with a round arch through it.
    const span = 30, depth = 2 * ROAD_HALF + 1.2, tall = bp.y - (waterLevel - 2);
    const shape = new THREE.Shape();
    shape.moveTo(-span / 2, 0);
    shape.lineTo(-span / 2, tall - 0.15);
    shape.lineTo(span / 2, tall - 0.15);
    shape.lineTo(span / 2, 0);
    shape.lineTo(4.6, 0);
    shape.absarc(0, 1.9, 4.6, 0, Math.PI, false);
    shape.lineTo(-span / 2, 0);
    const body = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 16 }).translate(0, 0, -depth / 2);
    const buv = body.attributes.uv;
    for (let i = 0; i < buv.count; i++) buv.setXY(i, buv.getX(i) / 4, buv.getY(i) / 4);
    // The extrusion's x runs along the road, its z across it.
    body.rotateY(Math.PI / 2 - bp.heading);
    body.translate(bp.x, waterLevel - 2, bp.z);
    parts.push(body);
    const bridge = new THREE.Mesh(C.mergeAll(parts), stone);
    bridge.castShadow = q.shadows;
    bridge.receiveShadow = true;
    group.add(bridge);
  }

  // ---- Water: the river ribbon and the tarn ----
  const waterNormal = T.waterNormalTexture();
  const waterMat = new THREE.MeshStandardMaterial({ color: '#4f7078', roughness: 0.07, metalness: 0.1, normalMap: waterNormal, normalScale: new THREE.Vector2(0.2, 0.2), envMapIntensity: 1.1 });
  const riverGeo = C.polylineRibbon(river, 13, waterLevel, 12);
  const tarnGeo = new THREE.CircleGeometry(tarn.r + 6, 48).rotateX(-Math.PI / 2).translate(tarn.x, waterLevel + 0.01, tarn.z);
  {
    const tuv = tarnGeo.attributes.uv, tp = tarnGeo.attributes.position;
    for (let i = 0; i < tuv.count; i++) tuv.setXY(i, tp.getX(i) / 12, tp.getZ(i) / 12);
  }
  const water = new THREE.Mesh(C.mergeAll([riverGeo, tarnGeo]), waterMat);
  water.receiveShadow = true;
  group.add(water);

  // ---- Walls and hedges: along the road and across the fields ----
  const r = rng(2024);
  const roadWalls = [], fieldWalls = [], hedges = [], gates = [];
  const roadside = (s) => {
    let prev = null;
    const at = (d) => {
      const p = route.position(d, s * (ROAD_HALF + 2.4));
      return { x: p.x, z: p.z, y: heightAt(p.x, p.z), heading: p.heading };
    };
    for (let d = 0; d < L; d += 5) {
      const inVillage = village(d) || Math.abs(d - bridgeAt) < 24;
      if (inVillage) {
        prev = null;
        continue;
      }
      const list = route.elevation(d) > 190 || hash2(Math.floor(d / 400), s, 8) < 0.6 ? roadWalls : hedges;
      const p = at(d);
      const gate = hash2(Math.floor(d / 60), s, 3) < 0.16 && d % 60 < 5 && prev; // a field gate
      if (gate) {
        const a = at(d - 1.9), b2 = at(d + 1.9);
        list.push({ x1: prev.x, z1: prev.z, y1: prev.y, x2: a.x, z2: a.z, y2: a.y });
        gates.push({ x: p.x, y: (a.y + b2.y) / 2, z: p.z, rot: -p.heading });
        prev = b2;
        continue;
      }
      if (prev) list.push({ x1: prev.x, z1: prev.z, y1: prev.y, x2: p.x, z2: p.z, y2: p.y });
      prev = p;
    }
  };
  roadside(-1);
  roadside(1);
  // Field boundaries on a rotated grid, out to the quality radius.
  const radius = q.sceneryRadius;
  for (const [axisU, spacing] of [[true, fieldCell], [false, fieldCell * 0.8]]) {
    for (let line = -40; line <= 40; line++) {
      const off = line * spacing;
      let prev = null;
      for (let t = -4000; t <= 4000; t += 6) {
        const u = axisU ? off : t, v = axisU ? t : off;
        const x = u * ca - v * sa, z = u * sa + v * ca;
        field.query(x, z, tmp);
        const ok = tmp.distance > ROAD_HALF + 9 && tmp.distance < radius && riverAt(x, z) > 9 && Math.hypot(x - tarn.x, z - tarn.z) > tarn.r + 8 && !(village(tmp.along) && tmp.distance < 60);
        if (!ok) {
          prev = null;
          continue;
        }
        const y = heightAt(x, z);
        if (prev) (y > 185 ? fieldWalls : hash2(line, axisU ? 1 : 2, 6) < 0.45 ? hedges : fieldWalls).push({ x1: prev.x, z1: prev.z, y1: prev.y, x2: x, z2: z, y2: y });
        prev = { x, z, y };
      }
    }
  }
  group.add(C.linear([...roadWalls, ...fieldWalls], 'wall', { shadows: q.shadows, q }));
  group.add(C.linear(hedges, 'hedge', { shadows: q.shadows, q }));
  group.add(gateMesh(gates, q));
  // Lane furniture: warning signs, passing places, a telegraph line (clear of the village and the bridge).
  group.add(C.roadside(route, { world: 'dales', roadHalf: ROAD_HALF, ground: (x, z) => heightAt(x, z), avoid: (d) => village(route.wrap(d)) || Math.abs(route.wrap(d) - bridgeAt) < 30, q }));

  // ---- Trees: boundary trees, woods, riverside ----
  const placements = [];
  const tryTree = (x, z, kind, s) => {
    field.query(x, z, tmp);
    if (tmp.distance < ROAD_HALF + 6) return;
    if (riverAt(x, z) < 8 || Math.hypot(x - tarn.x, z - tarn.z) < tarn.r + 4) return;
    if (village(tmp.along) && tmp.distance < 45) return;
    const tall = kind === 'broad' && r() < 0.3;
    placements.push({ x, z, y: heightAt(x, z), kind, s, rot: r() * 6.28, hue: r() - 0.5, sx: tall ? 0.7 + r() * 0.15 : 0.9 + r() * 0.35, sy: tall ? 1.2 + r() * 0.3 : 0.85 + r() * 0.3 });
  };
  for (const seg of hedges) if (r() < 0.2) tryTree(seg.x1 + (r() - 0.5) * 2, seg.z1 + (r() - 0.5) * 2, 'broad', 0.8 + r() * 0.6);
  for (let w = 0; w < 26; w++) {
    const at = r() * L;
    const p = route.position(at, (r() < 0.5 ? -1 : 1) * (40 + r() * (radius * 0.7)));
    const conifer = route.elevation(at) > 180 && r() < 0.7;
    const rad = 40 + r() * 110;
    const n = Math.floor(rad * rad * 0.004 * q.treeDensity);
    for (let k = 0; k < n; k++) {
      const a = r() * 6.28, d = Math.sqrt(r()) * rad;
      tryTree(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d, conifer ? 'conifer' : 'broad', 0.8 + r() * 0.7);
    }
  }
  for (let i = 0; i < river.length; i += 6) if (r() < 0.6 * q.treeDensity) tryTree(river[i] + (r() - 0.5) * 30, river[i + 1] + (r() - 0.5) * 30, 'broad', 0.9 + r() * 0.6);
  // Scattered single trees.
  for (let k = 0; k < 900 * q.treeDensity; k++) {
    const at = r() * L;
    const p = route.position(at, (r() < 0.5 ? -1 : 1) * (12 + r() * radius));
    if (r() < 0.5) tryTree(p.x, p.z, route.elevation(at) > 205 && r() < 0.5 ? 'conifer' : 'broad', 0.7 + r() * 0.8);
  }
  group.add(C.trees(placements.slice(0, q.maxTrees), { shadows: q.shadows, q }));

  // ---- Sheep: flocks in the fields ----
  const sheep = [];
  for (let f = 0; f < 46; f++) {
    const at = r() * L;
    const p = route.position(at, (r() < 0.5 ? -1 : 1) * (16 + r() * 220));
    const n = 6 + Math.floor(r() * 16);
    for (let k = 0; k < n; k++) {
      const x = p.x + (r() - 0.5) * 50, z = p.z + (r() - 0.5) * 50;
      field.query(x, z, tmp);
      if (tmp.distance < ROAD_HALF + 5 || riverAt(x, z) < 8 || (village(tmp.along) && tmp.distance < 40)) continue;
      sheep.push({ x, z, y: heightAt(x, z), rot: r() * 6.28, s: r() < 0.2 ? 0.55 + r() * 0.1 : 0.9 + r() * 0.25 });
    }
  }
  group.add(sheepMesh(sheep));

  // ---- Field barns: the stone barns that dot every dale ----
  {
    const barns = [];
    for (let k = 0; k < 40 && barns.length < 14; k++) {
      const at = 500 + r() * (L - 1100);
      const side = r() < 0.5 ? -1 : 1;
      const p = route.position(at, side * (26 + r() * 110));
      if (riverAt(p.x, p.z) < 25 || Math.hypot(p.x - tarn.x, p.z - tarn.z) < tarn.r + 20) continue;
      if (field.query(p.x, p.z, tmp).distance < 22) continue;
      const y = Math.min(heightAt(p.x - 4, p.z), heightAt(p.x + 4, p.z), heightAt(p.x, p.z - 4), heightAt(p.x, p.z + 4));
      barns.push({ x: p.x, y: y + 0.1, z: p.z, rot: -p.heading + (r() - 0.5) * 0.5, w: 8 + r() * 3, d: 5.5 + r(), h: 4.6 + r() * 0.8, kind: 'barn', roof: 'stone', chimney: false, storey: 5.5, tint: ['#f1e8d8', '#ffffff', '#e6dccb'][k % 3], gableTint: '#e9e0d0' });
    }
    group.add(C.buildings(barns, { shadows: q.shadows }));
  }

  // ---- Thornby village ----
  group.add(buildVillage(route, heightAt, q, course));

  // ---- Start/finish arch, zone banners ----
  group.add(C.arch(route, 0, 'SPINDOWN · THORNBY', { width: 2 * ROAD_HALF + 1.2 }));
  for (const s of route.zones) {
    group.add(C.arch(route, s.from, s.kind === 'kom' ? `▲ ${s.name.toUpperCase()}` : `⚡ ${s.name.toUpperCase()}`, { width: 2 * ROAD_HALF + 1.2, colour: s.kind === 'kom' ? '#b3261e' : '#0a6cc2' }));
    group.add(C.arch(route, s.to, 'FINISH ▸', { width: 2 * ROAD_HALF + 1.2, colour: '#333' }));
  }

  // ---- Distant fells ----
  group.add(fells(route, heightAt));

  const update = (t) => {
    waterNormal.offset.set(t * 0.03, t * 0.012);
  };
  return { group, heightAt, roadHalf: ROAD_HALF, update };
}

/** Swaledale sheep: woolly bodies, black faces with pale muzzles, ears and thin black legs. */
function sheepMesh(list) {
  const wool = new THREE.IcosahedronGeometry(0.55, 1);
  {
    const p = wool.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.07 * Math.sin(x * 9) * Math.sin(y * 11 + 1) + 0.05 * Math.sin(z * 13);
      p.setXYZ(i, x * k, y * k, z * k);
    }
  }
  wool.scale(0.72, 0.62, 1.12).translate(0, 0.72, 0.03);
  const parts = [
    C.shadeY(wool, 0.72, 1.06, '#efeadc'),
    C.tint(new THREE.SphereGeometry(0.19, 8, 6).scale(0.78, 0.92, 1.25).translate(0, 0.9, -0.66), '#26221f'),
    C.tint(new THREE.SphereGeometry(0.1, 6, 5).scale(0.85, 0.8, 1).translate(0, 0.84, -0.86), '#d9d2c2'), // pale muzzle
    C.tint(new THREE.SphereGeometry(0.2, 7, 5).scale(0.9, 0.7, 0.8).translate(0, 0.98, -0.5), '#efeadc'), // woolly topknot
  ];
  for (const s of [-1, 1]) parts.push(C.tint(new THREE.SphereGeometry(0.07, 5, 4).scale(1.5, 0.5, 0.8).translate(s * 0.2, 0.97, -0.6), '#26221f')); // ears
  for (const [x, z] of [[-0.19, -0.36], [0.19, -0.36], [-0.19, 0.4], [0.19, 0.4]]) parts.push(C.tint(new THREE.CylinderGeometry(0.045, 0.035, 0.46, 5).translate(x, 0.22, z), '#26221f'));
  const geo = C.mergeAll(parts, { colour: true, uv: false });
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const items = list.map((sh) => {
    q.setFromAxisAngle(up, sh.rot);
    return { matrix: new THREE.Matrix4().compose(new THREE.Vector3(sh.x, sh.y - 0.03, sh.z), q, new THREE.Vector3(sh.s, sh.s, sh.s)) };
  });
  return C.chunked(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), items, { shadows: true, maxDistance: 420, chunk: 150 });
}

/** Field gates: now hung by C.linear() itself in the gateways it finds between wall ends (boundaries.js). */
function gateMesh() {
  return new THREE.Group();
}

function buildVillage(route, heightAt, q, course) {
  const g = new THREE.Group();
  const r = rng(51);
  const items = [];
  const L = route.length;
  const stones = ['#ffffff', '#f3ead9', '#e9decb', '#f8f1e4', '#ded5c4', '#efe4d0'];
  const washes = ['#ffffff', '#f6efdc', '#efe6d2', '#e6ecea'];
  const place = (d, side, w, depth, h, kind, roof, extra = {}) => {
    const lateral = side * (ROAD_HALF + 3.4 + depth / 2);
    const p = route.position(d, lateral);
    const y = Math.min(route.elevation(d), heightAt(p.x, p.z)) - 0.2;
    items.push({ x: p.x, y, z: p.z, rot: -p.heading, w, d: depth, h, kind, roof, ...extra });
    return p;
  };
  // Terraced cottages lining the street through the village, both sides, with gaps for lanes.
  for (const side of [-1, 1]) {
    let d = course.village.from - L + 20;
    while (d < course.village.to - 20) {
      const w = 6.5 + r() * 4;
      const special = side === -1 && Math.abs(d - 170) < 30 ? 'church' : side === 1 && d > 56 && d < 86 ? 'pub' : null;
      if (!special && r() > 0.1) {
        const render = r() > 0.8;
        const tint = render ? washes[Math.floor(r() * washes.length)] : stones[Math.floor(r() * stones.length)];
        place(d + w / 2, side, w, 6.5 + r() * 1.5, r() < 0.25 ? 8.2 : 5.5, render ? 'render' : 'cottage', r() < 0.6 ? 'stone' : 'slate', { tint, gableTint: render ? '#d9d2c4' : tint });
      }
      d += w + (r() < 0.18 ? 6 + r() * 10 : 0.05);
    }
  }
  // The pub.
  place(71, 1, 13, 8, 6.0, 'render', 'slate', { tint: '#fbf6ea', gableTint: '#e4ddcf' });
  g.add(C.buildings(items, { shadows: q.shadows }));

  // Flagged pavements along the village street.
  const from = course.village.from - L + 10, to = course.village.to - 10;
  const paves = [];
  for (const s of [-1, 1]) {
    paves.push(C.ribbon(route, { left: s > 0 ? ROAD_HALF : -ROAD_HALF - 3.5, right: s > 0 ? ROAD_HALF + 3.5 : -ROAD_HALF, lift: 0.07, from, to, uvLength: 3, uvAcross: 1.1 }));
  }
  const pave = new THREE.Mesh(C.mergeAll(paves), new THREE.MeshStandardMaterial({ map: T.pavingTexture(), color: '#e8e2d6', roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  pave.receiveShadow = true;
  g.add(pave);

  // Church: nave with lancet windows and a battlemented west tower, set back on the left.
  const stoneMat = new THREE.MeshStandardMaterial({ map: T.stoneWallTexture({ tone: 'rubble' }), roughness: 0.95, side: THREE.DoubleSide });
  const cp = route.position(170, -(ROAD_HALF + 20));
  const cy = heightAt(cp.x, cp.z) - 0.3;
  const church = new THREE.Group();
  const nave = new THREE.Mesh(C.facadeRing([-4.5, -11, 4.5, -11, 4.5, 11, -4.5, 11], -0.5, 7.5, '#e9e0cf', { storey: 7 }), new THREE.MeshStandardMaterial({ map: T.facadeTexture('church'), vertexColors: true, roughness: 0.95 }));
  church.add(nave);
  const roof = C.roofPrism({ cx: 0, cz: 0, ax: 0, az: 1, la: 11, lb: 4.5, y: 7, rh: 4.6, gableTint: '#ffffff' });
  church.add(new THREE.Mesh(roof.slopes, new THREE.MeshStandardMaterial({ map: T.roofTexture('stone'), roughness: 0.85, side: THREE.DoubleSide })));
  const stoneParts = [roof.gables, stoneBox(6, 19.5, 6).translate(0, 9.25, 13.5), stoneBox(6.5, 0.4, 6.5).translate(0, 19, 13.5)];
  for (const [x, z] of [[-2.7, 10.8], [2.7, 10.8], [-2.7, 16.2], [2.7, 16.2], [0, 10.8], [0, 16.2], [-2.7, 13.5], [2.7, 13.5]]) stoneParts.push(stoneBox(1.0, 1.1, 1.0).translate(x, 19.7, z));
  for (const [x, z] of [[-2.9, 10.6], [2.9, 10.6], [-2.9, 16.4], [2.9, 16.4]]) stoneParts.push(new THREE.ConeGeometry(0.45, 1.6, 4).translate(x, 21, z));
  church.add(new THREE.Mesh(C.mergeAll(stoneParts), stoneMat));
  const clock = new THREE.Mesh(new THREE.CircleGeometry(0.95, 24), new THREE.MeshStandardMaterial({ map: clockTexture(), roughness: 0.6 }));
  clock.position.set(0, 15, 16.56);
  church.add(clock);
  const louvre = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.4), new THREE.MeshStandardMaterial({ color: '#2a2622', roughness: 1 }));
  louvre.position.set(0, 11.2, 16.53);
  church.add(louvre);
  church.position.set(cp.x, cy, cp.z);
  church.rotation.y = -cp.heading + Math.PI / 2;
  church.traverse((o) => { if (o.isMesh) { o.castShadow = q.shadows; o.receiveShadow = true; } });
  g.add(church);

  // The pub's hanging sign on a post.
  const signTex = T.textTexture('THE BLACK SHEEP', { width: 512, height: 160, bg: '#1c2b1f', fg: '#f3e3b0', font: '700 46px Georgia, serif' });
  const sp = route.position(63, ROAD_HALF + 2.9);
  const sy = route.elevation(63);
  const signPost = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: '#1d1d1b', roughness: 0.6 });
  signPost.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 3.8, 8).translate(0, 1.9, 0), dark));
  signPost.add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.06).translate(0.7, 3.6, 0), dark));
  signPost.add(new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.62, 0.06).translate(0.8, 3.2, 0), [dark, dark, dark, dark, new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.7 }), new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.7 })]));
  signPost.position.set(sp.x, sy, sp.z);
  signPost.rotation.y = -sp.heading + Math.PI / 2;
  signPost.traverse((o) => { if (o.isMesh) o.castShadow = q.shadows; });
  g.add(signPost);

  // Red phone box and pillar box on the green.
  const red = '#c8102e';
  const pb = route.position(L - 120, -(ROAD_HALF + 2.4));
  const boxParts = [
    C.tint(new THREE.BoxGeometry(0.92, 2.3, 0.92).translate(0, 1.15, 0), red),
    C.tint(new THREE.BoxGeometry(1.0, 0.1, 1.0).translate(0, 2.35, 0), red),
    C.tint(new THREE.SphereGeometry(0.62, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.35, 1).translate(0, 2.4, 0), red),
  ];
  for (let k = 0; k < 4; k++) {
    // Glazing on each face: three columns of small panes.
    const pane = C.tint(new THREE.PlaneGeometry(0.62, 1.45).translate(0, 1.3, 0.465), '#27323a');
    const bars = [];
    for (let j = 1; j < 6; j++) bars.push(C.tint(new THREE.PlaneGeometry(0.62, 0.03).translate(0, 0.6 + j * 0.24, 0.468), red));
    for (const x of [-0.14, 0.14]) bars.push(C.tint(new THREE.PlaneGeometry(0.03, 1.45).translate(x, 1.3, 0.468), red));
    boxParts.push(...[pane, ...bars].map((x) => x.rotateY((k * Math.PI) / 2)));
    boxParts.push(C.tint(new THREE.PlaneGeometry(0.6, 0.14).translate(0, 2.17, 0.465).rotateY((k * Math.PI) / 2), '#f3efe2'));
  }
  const phone = new THREE.Mesh(C.mergeAll(boxParts, { colour: true, uv: false }), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4 }));
  phone.position.set(pb.x, route.elevation(L - 120) + 0.07, pb.z);
  phone.rotation.y = -pb.heading;
  phone.castShadow = q.shadows;
  g.add(phone);
  const pst = route.position(L - 112, -(ROAD_HALF + 2.2));
  const pillar = new THREE.Mesh(C.mergeAll([
    C.tint(new THREE.CylinderGeometry(0.24, 0.24, 1.3, 14).translate(0, 0.75, 0), red),
    C.tint(new THREE.CylinderGeometry(0.27, 0.27, 0.1, 14).translate(0, 0.05, 0), '#18181a'),
    C.tint(new THREE.CylinderGeometry(0.1, 0.29, 0.16, 14).translate(0, 1.48, 0), red),
    C.tint(new THREE.BoxGeometry(0.03, 0.035, 0.2).translate(0.235, 1.15, 0), '#18181a'),
  ], { colour: true, uv: false }), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4 }));
  pillar.position.set(pst.x, route.elevation(L - 112) + 0.07, pst.z);
  pillar.rotation.y = -pst.heading + Math.PI;
  pillar.castShadow = q.shadows;
  g.add(pillar);

  // Fingerposts at the landmarks.
  const postMat = new THREE.MeshStandardMaterial({ color: '#f2efe6', roughness: 0.8 });
  for (const m of route.landmarks) {
    const fp = route.position(m.at + 12, ROAD_HALF + 1.5);
    const fg = new THREE.Group();
    fg.add(new THREE.Mesh(C.mergeAll([new THREE.CylinderGeometry(0.055, 0.065, 2.5, 8).translate(0, 1.25, 0), new THREE.SphereGeometry(0.09, 8, 6).translate(0, 2.55, 0), new THREE.CylinderGeometry(0.1, 0.1, 0.5, 8).translate(0, 0.25, 0)]), postMat));
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.26, 0.04), new THREE.MeshStandardMaterial({ map: T.textTexture(m.name.toUpperCase(), { width: 512, height: 96, bg: '#f2efe6', fg: '#1a1a1a', font: '700 40px Arial' }) }));
    plate.position.set(0.72, 2.2, 0);
    fg.add(plate);
    fg.position.set(fp.x, heightAt(fp.x, fp.z), fp.z);
    fg.rotation.y = -fp.heading + Math.PI / 2;
    fg.traverse((o) => { if (o.isMesh) o.castShadow = q.shadows; });
    g.add(fg);
  }
  return g;
}

function clockTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#1e2a44';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#e6c85a';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(64, 64, 56, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 4;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    g.beginPath();
    g.moveTo(64 + Math.cos(a) * 42, 64 + Math.sin(a) * 42);
    g.lineTo(64 + Math.cos(a) * 52, 64 + Math.sin(a) * 52);
    g.stroke();
  }
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(64, 64);
  g.lineTo(64 + 24, 64 - 14);
  g.moveTo(64, 64);
  g.lineTo(64 - 8, 64 - 44);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A ring of big, fogged fells on the horizon: green flanks rising to brown and heather tops. */
function fells(route, heightAt) {
  const b = route.bounds();
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const g = [];
  const r = rng(808);
  const low = C.colour('#7f9c58'), mid = C.colour('#8c8a5a'), top = C.colour('#7a6a66');
  const c = new THREE.Color();
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + r() * 0.2;
    const dist = 4200 + r() * 1400;
    const m = new THREE.IcosahedronGeometry(1, 3);
    const p = m.attributes.position;
    const cols = new Float32Array(p.count * 3);
    for (let k = 0; k < p.count; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      const n = 0.75 + 0.5 * fbm(x * 2 + i, z * 2, 3, 77);
      const yy = Math.max(-0.2, y) * n;
      p.setXYZ(k, x * n, yy, z * n);
      const t = Math.min(1, Math.max(0, yy * 1.15 + 0.25 * (fbm(x * 6 + i, z * 6, 2, 5) - 0.5)));
      c.copy(low).lerp(mid, smoothstep(0.25, 0.6, t)).lerp(top, smoothstep(0.6, 0.95, t));
      cols[k * 3] = c.r;
      cols[k * 3 + 1] = c.g;
      cols[k * 3 + 2] = c.b;
    }
    m.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const w = 700 + r() * 900, h = 260 + r() * 360;
    m.scale(w, h, w * (0.7 + r() * 0.5));
    m.translate(cx + Math.sin(a) * dist, heightAt(cx, cz) - 60, cz - Math.cos(a) * dist);
    g.push(m);
  }
  const geo = C.mergeAll(g, { colour: true, uv: false });
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
}
