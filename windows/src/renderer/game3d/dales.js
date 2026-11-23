// The Yorkshire Dales world: the real Malham loop, built from open data (see scripts/build-dales.mjs).
//  - Terrain: Environment Agency LIDAR (5 m, then 10 m) near the loop and terrain tiles out to ~7 km, in
//    square tiles whose detail follows the camera; the road sits in it with cuttings and embankments.
//  - Ground colour: Sentinel-2 cloudless 2016 imagery (EOX, CC BY 4.0) with close-up detail textures.
//  - OpenStreetMap: every dry-stone wall, building footprint, wood, single tree, tree row, tarn, beck,
//    limestone scar, power line and pole, in its real place.
// Map data © OpenStreetMap contributors (ODbL).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as C from './common.js';
import * as T from './textures.js';
import { RouteField } from '../../core/world/field.js';
import { rng, hash2 } from '../../core/world/noise.js';
import { nestedTerrain, Raster, imageryTexture, landMaterial, normalTexture, classTexture, roadDistanceTexture, ImagerySampler } from './ground.js';
import { Scars } from './cliffs.js';
import { limestoneFaceMaterial, groundDetailArrays, boulderMaterial, lakeMaterial, beckWaterMaterial, beckBedMaterial } from './nature.js';
import { Becks } from './becks.js';
import { GroundCover } from './groundcover.js';
import nearImageUrl from './data/dales-near.jpg';
import farImageUrl from './data/dales-far.jpg';
import reliefUrl from './data/dales-relief.jpg';

const ROAD_HALF = 2.5; // Malham's lanes are single track: ~5 m of tarmac
const BED = 14; // half-width of the road bed (verges and the cut or fill slopes) drawn along the road
const TILE = 640; // terrain tile size (m)
const LOD_STEPS = [5, 10, 20, 40, 80];

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Data coords (x east, y north) to world (x, z = −y), flat arrays. */
const W = (flat) => {
  const out = new Array(flat.length);
  for (let i = 0; i < flat.length; i += 2) {
    out[i] = flat[i];
    out[i + 1] = -flat[i + 1];
  }
  return out;
};

// Ground classes in the raster.
const CLS = { meadow: 1, heath: 2, rock: 3, pavement: 4, scree: 5, wet: 6, scrub: 7, yard: 8, quarry: 9, village: 10, wood: 11, water: 12, grass: 13 };

export function buildDales(route, data, q) {
  const t0 = performance.now();
  const group = new THREE.Group();
  const field = new RouteField(route, { cell: 20, margin: 3000 });
  const tmp = {};
  const L = route.length;
  const r = rng(2024);
  const levels = ['far', 'mid', 'near'].map((k) => data.terrain[k]).filter(Boolean);
  const terrain = nestedTerrain(levels, [0, 400, 200]);
  const dem = terrain.dem;
  const mid = data.terrain.mid ?? data.terrain.near;

  // ---- Rasters: ground class and water over the detailed area (4 m cells) ----
  const rx0 = mid.x0, rz0 = -(mid.y0 + (mid.ny - 1) * mid.cell), rx1 = mid.x0 + (mid.nx - 1) * mid.cell, rz1 = -mid.y0;
  const cls = new Raster(rx0, rz0, rx1, rz1, 4);
  for (const c of data.cover ?? []) if (CLS[c.c]) cls.fill(W(c.p), CLS[c.c]);
  for (const w of data.woods ?? []) cls.fill(W(w.p), CLS.wood);
  for (const c of data.cliffs ?? []) cls.stroke(W(c.p), 5, CLS.rock);
  const wet = new Raster(rx0, rz0, rx1, rz1, 4);
  // Lakes and tarns sit flat at their shore level.
  const lakes = [];
  for (const w of data.water ?? []) {
    const ring = W(w.p);
    if (ring.length < 6) continue;
    const shore = [];
    for (let i = 0; i < ring.length; i += 2) shore.push(dem(ring[i], ring[i + 1]));
    shore.sort((a, b) => a - b);
    // A water area on a slope, or a long thin one, is a river or a run of pools, not a tarn: leave it to the becks.
    if (shore[Math.floor(shore.length * 0.9)] - shore[Math.floor(shore.length * 0.1)] > 3) continue;
    let area = 0, perim = 0;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      area += (ring[j] + ring[i]) * (ring[j + 1] - ring[i + 1]);
      perim += Math.hypot(ring[i] - ring[j], ring[i + 1] - ring[j + 1]);
    }
    if ((4 * Math.PI * Math.abs(area / 2)) / (perim * perim) < 0.3 && Math.abs(area / 2) < 150000) continue;
    const level = shore[Math.floor(shore.length * 0.15)] - 0.2;
    if (lakes.length < 250) {
      lakes.push({ ring, level, name: w.n });
      wet.fill(ring, lakes.length);
    }
  }

  // ---- Height: the DEM, with the road let into it (cuttings and embankments) and lakes kept below water ----
  const inField = (x, z) => x > field.x0 && z > field.z0 && x < field.x0 + field.nx * field.cell && z < field.z0 + field.nz * field.cell;
  /** A quick lower bound on the distance to the road (the route field's grid; exact to within ~20 m). */
  const roadFar = (x, z) => {
    const cx = Math.round((x - field.x0) / field.cell), cz = Math.round((z - field.z0) / field.cell);
    if (cx < 0 || cz < 0 || cx >= field.nx || cz >= field.nz) return Infinity;
    return Math.sqrt(field.dist[cz * field.nx + cx]) - field.cell;
  };
  function heightAt(x, z) {
    let h = dem(x, z);
    const lake = wet.get(x, z);
    if (lake) h = Math.min(h, lakes[lake - 1].level - 0.6);
    if (inField(x, z) && roadFar(x, z) < 72) {
      field.query(x, z, tmp);
      const d = tmp.distance;
      if (d < 70) {
        const ry = route.elevation(tmp.along) - 0.06;
        const diff = h - ry;
        // Batters about 1:1.4, a flat shoulder by the tarmac.
        const width = Math.min(50, Math.max(3, 1.5 + Math.abs(diff) * 1.4));
        const t = smoothstep(ROAD_HALF + 0.5, ROAD_HALF + 0.5 + width, d);
        h = ry + diff * t;
      }
    }
    return h;
  }
  group.userData.heightAt = heightAt;
  const roadDistance = (x, z) => (inField(x, z) ? field.query(x, z, tmp).distance : Infinity);

  // ---- Materials: imagery draped over everything that is ground ----
  const rectOf = (g) => ({ x0: g.x0, y0: g.y0, x1: g.x1 ?? g.x0 + (g.nx - 1) * g.cell, y1: g.y1 ?? g.y0 + (g.ny - 1) * g.cell });
  const im = data.imagery ?? {};
  const wallTex = wallLineTexture(data, im.near ?? rectOf(mid));
  // The land's shape for lighting: the 2 m LIDAR relief near the loop, 40 m normals from the terrain beyond.
  const reliefTex = new THREE.TextureLoader().load(reliefUrl);
  reliefTex.colorSpace = THREE.NoColorSpace;
  reliefTex.anisotropy = 4;
  const farN = normalTexture((x, y) => terrain.grids[0].at(x, y), rectOf(data.terrain.far), 40);
  // What the ground is made of, from the map: rock, scree, rough grazing and moor, limestone pavement.
  const classes = classTexture(cls, {
    [CLS.rock]: [1, 0, 0, 0], [CLS.quarry]: [1, 0, 0, 0], [CLS.pavement]: [1, 0, 0, 1], [CLS.scree]: [0, 1, 0, 0],
    [CLS.heath]: [0, 0, 1, 0], [CLS.scrub]: [0, 0, 0.8, 0], [CLS.wet]: [0, 0, 0.9, 0], [CLS.wood]: [0, 0, 0.7, 0],
  });
  const landOpts = {
    near: { texture: imageryTexture(nearImageUrl), rect: im.near ?? rectOf(mid) },
    far: { texture: imageryTexture(farImageUrl), rect: im.far ?? rectOf(data.terrain.far) },
    walls: { texture: wallTex, rect: im.near ?? rectOf(mid) },
    relief: data.relief ? { texture: reliefTex, rect: data.relief } : null,
    farNormal: farN,
    classes,
    road: roadDistanceTexture(field),
    layers: groundDetailArrays(),
    saturation: 0.9, gamma: 0.8, gain: 1.95, tint: [1.05, 1.1, 0.24],
  };
  const ground = landMaterial(landOpts, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  // The road bed's cuttings and embankments are not in the survey: lit by their own shape.
  const bedMat = landMaterial(landOpts, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  bedMat.userData.uniforms.reliefStrength.value = 0;

  /** Per-vertex ground detail: rock, moor, verge weights from the class raster and the road. */
  function detailAt(x, z, roadD) {
    const c = cls.get(x, z);
    const rock = c === CLS.rock || c === CLS.quarry ? 1 : c === CLS.pavement ? 0.9 : c === CLS.scree ? 0.75 : 0;
    const moor = c === CLS.heath ? 1 : c === CLS.wet ? 0.8 : c === CLS.scrub ? 0.6 : 0;
    const verge = roadD < ROAD_HALF + 7 ? 1 - smoothstep(ROAD_HALF + 1, ROAD_HALF + 7, roadD) : 0;
    // In the village and farmyards the road is edged with flags, gravel and setts, not grass.
    if ((c === CLS.village || c === CLS.yard) && roadD < ROAD_HALF + 4) return [0.85 * (1 - smoothstep(ROAD_HALF + 2, ROAD_HALF + 4, roadD)), 0, 0];
    return [rock, moor, verge];
  }

  // ---- Limestone faces from the 1 m LIDAR (cliffs.js): the terrain is cut away in their 20 m cells ----
  const tMat = performance.now();
  const tm = { start: tMat };
  const mark = (k) => { tm[k] = Math.round(performance.now() - tm.start); };
  const scars = new Scars(data.scars, { roadDistance, q, detailAt, ground, rock: limestoneFaceMaterial() });
  mark("scars");
  const SCAR_LEVEL = 2; // tiles drawn at this detail or finer show the 3D faces (and have their cells cut out)

  // ---- Becks (becks.js): channels cut into the most detailed tiles, a flat ribbon of water beyond ----
  const becks = new Becks((data.streams ?? []).filter((s) => {
    for (let i = 0; i < s.p.length; i += 8) if (roadDistance(s.p[i], -s.p[i + 1]) < 1300) return true;
    return false;
  }).map((s) => ({ p: W(s.p), w: s.w })), {
    heightAt,
    keep: (x, z) => !scars.underFace(x, z) && (roadFar(x, z) > ROAD_HALF + 8 || roadDistance(x, z) > ROAD_HALF + 8) && !wet.get(x, z),
  });
  // Banks are lit by their own shape (the survey's relief does not have the cut channel in it).
  const beckMats = { banks: null, bed: beckBedMaterial(), water: beckWaterMaterial(), far: null };
  beckMats.banks = bedMat;
  beckMats.far = lakeMaterial();
  beckMats.far.polygonOffset = true;
  beckMats.far.polygonOffsetFactor = -3;
  beckMats.far.polygonOffsetUnits = -3;
  const beckOut = {};
  mark("scars+becks");
  const apronOut = {};

  // ---- Terrain tiles with distance-based detail ----
  const far = data.terrain.far;
  const fx0 = Math.ceil(far.x0 / TILE) * TILE, fx1 = Math.floor((far.x0 + (far.nx - 1) * far.cell) / TILE) * TILE;
  const fz0 = Math.ceil(-(far.y0 + (far.ny - 1) * far.cell) / TILE) * TILE, fz1 = Math.floor(-far.y0 / TILE) * TILE;
  const tiles = [];
  const terrainGroup = new THREE.Group();
  group.add(terrainGroup);
  const lodScale = q.terrainStep <= 10 ? 1.4 : q.terrainStep >= 16 ? 0.7 : 1;
  const minLevel = q.terrainStep >= 16 ? 1 : 0;
  const lodDist = [190, 650, 1500, 3200].map((d) => d * lodScale);
  for (let tz = fz0; tz < fz1; tz += TILE) {
    for (let tx = fx0; tx < fx1; tx += TILE) {
      const cx = tx + TILE / 2, cz = tz + TILE / 2;
      const rd = roadDistance(cx, cz);
      tiles.push({ x: tx, z: tz, cx, cz, roadNear: rd < TILE, meshes: [], level: -1, scarCells: null, scar: null, beckNear: false, becks: null });
    }
  }
  {
    // Which tiles hold cliff cells.
    const across = Math.round((fx1 - fx0) / TILE);
    const list = data.scars?.cells ?? [];
    for (let i = 0; i < list.length; i += 2) {
      const x = list[i] * scars.cell + scars.cell / 2, z = list[i + 1] * scars.cell + scars.cell / 2;
      const ti = Math.floor((x - fx0) / TILE), tj = Math.floor((z - fz0) / TILE);
      const t = tiles[tj * across + ti];
      if (!t || ti < 0 || ti >= across) continue;
      (t.scarCells ??= []).push(list[i], list[i + 1]);
    }
  }

  {
    // Which tiles have a beck channel (or its banks) in them.
    const across = Math.round((fx1 - fx0) / TILE);
    for (const line of becks.lines) {
      const e = Becks.edge(line.half);
      for (const p of line.P) {
        for (const [dx, dz] of [[-e, -e], [e, -e], [-e, e], [e, e]]) {
          const ti = Math.floor((p.x + dx - fx0) / TILE), tj = Math.floor((p.z + dz - fz0) / TILE);
          if (ti < 0 || ti >= across) continue;
          const t = tiles[tj * across + ti];
          if (t) t.beckNear = true;
        }
      }
    }
  }

  /** The 2 m ground under a tile's cliff cells, pushed down out of sight under the faces (see cliffs.js). */
  function buildApron(tile) {
    const C = scars.cell, S = 2, M = C / S + 1;
    const cellSet = new Set();
    for (let i = 0; i < tile.scarCells.length; i += 2) cellSet.add(`${tile.scarCells[i]},${tile.scarCells[i + 1]}`);
    const pos = [], det = [], nrm = [], idx = [];
    const base = tile.roadNear ? heightAt : dem;
    const hOf = (x, z) => scars.adjust(x, z, base(x, z), apronOut).y;
    for (let i = 0; i < tile.scarCells.length; i += 2) {
      const cx = tile.scarCells[i], cz = tile.scarCells[i + 1];
      const x0 = cx * C, z0 = cz * C;
      // Heights with a ring of extra samples for normals.
      const N = M + 2;
      const hs = new Float32Array(N * N);
      for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) hs[b * N + a] = hOf(x0 + (a - 1) * S, z0 + (b - 1) * S);
      const v0 = pos.length / 3;
      for (let b = 0; b < M; b++) {
        for (let a = 0; a < M; a++) {
          const x = x0 + a * S, z = z0 + b * S;
          const h = hs[(b + 1) * N + a + 1];
          pos.push(x, h, z);
          const nx = hs[(b + 1) * N + a] - hs[(b + 1) * N + a + 2], nz = hs[b * N + a + 1] - hs[(b + 2) * N + a + 1], ny = 2 * S;
          const l = Math.hypot(nx, ny, nz);
          nrm.push(nx / l, ny / l, nz / l);
          const rd = tile.roadNear ? roadDistance(x, z) : Infinity;
          const d = detailAt(x, z, rd);
          det.push(d[0], d[1], d[2]);
        }
      }
      for (let b = 0; b < M - 1; b++) {
        for (let a = 0; a < M - 1; a++) {
          const p = v0 + b * M + a;
          idx.push(p, p + M, p + 1, p + 1, p + M, p + M + 1);
        }
      }
      // Skirts on edges facing ordinary terrain.
      const sides = [[0, -1, (k) => k, M], [0, 1, (k) => (M - 1) * M + k, M], [-1, 0, (k) => k * M, M], [1, 0, (k) => k * M + M - 1, M]];
      for (const [dx, dz, at] of sides) {
        if (cellSet.has(`${cx + dx},${cz + dz}`)) continue;
        const s0 = pos.length / 3;
        for (let k = 0; k < M; k++) {
          const v = v0 + at(k);
          pos.push(pos[v * 3], pos[v * 3 + 1] - 3, pos[v * 3 + 2]);
          nrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
          det.push(det[v * 3], det[v * 3 + 1], det[v * 3 + 2]);
        }
        for (let k = 0; k + 1 < M; k++) {
          const a = v0 + at(k), b = v0 + at(k + 1), a2 = s0 + k, b2 = s0 + k + 1;
          idx.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('detail', new THREE.Float32BufferAttribute(det, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, ground);
    m.receiveShadow = true;
    return m;
  }

  /** A tile's limestone: the apron and the rock faces with their caps (built when first needed). */
  function buildScar(tile) {
    const parts = [];
    if (tile.scarCells) parts.push(buildApron(tile));
    const faces = scars.buildTile(tile.x, tile.z, tile.x + TILE, tile.z + TILE);
    if (faces) parts.push(faces.face, ...(faces.cap ? [faces.cap] : []));
    const g = new THREE.Group();
    for (const p of parts) g.add(p);
    g.visible = false;
    terrainGroup.add(g);
    tile.scar = g;
    return g;
  }

  function buildTile(tile, level) {
    const step = LOD_STEPS[level];
    const n = TILE / step + 1;
    const N = n + 2; // one extra ring of samples for normals
    const hs = new Float32Array(N * N);
    const nearRoad = tile.roadNear;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = tile.x + (i - 1) * step, z = tile.z + (j - 1) * step;
        hs[j * N + i] = nearRoad ? heightAt(x, z) : dem(x, z);
      }
    }
    const vcount = n * n + 4 * n;
    const pos = new Float32Array(vcount * 3), nrm = new Float32Array(vcount * 3), det = new Float32Array(vcount * 3);
    const sink = Math.min(3, 0.35 + step * 0.04); // keep the mesh under the road bed
    let v = 0;
    const put = (x, y, z, i, j) => {
      const hl = hs[j * N + i - 1], hr = hs[j * N + i + 1], hd = hs[(j - 1) * N + i], hu = hs[(j + 1) * N + i];
      const nx = hl - hr, nz = hd - hu, ny = 2 * step;
      const len = Math.hypot(nx, ny, nz);
      pos[v * 3] = x;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = z;
      nrm[v * 3] = nx / len;
      nrm[v * 3 + 1] = ny / len;
      nrm[v * 3 + 2] = nz / len;
      const rd = nearRoad ? roadDistance(x, z) : Infinity;
      const d = detailAt(x, z, rd);
      det[v * 3] = d[0];
      det[v * 3 + 1] = d[1];
      det[v * 3 + 2] = d[2];
      if (rd < BED - step * 0.25) pos[v * 3 + 1] -= sink;
      if (level === 0 && tile.beckNear) {
        becks.nearest(x, z, beckOut);
        if (beckOut.d < Becks.edge(beckOut.half) - step * 0.9) pos[v * 3 + 1] -= 2;
      }
      v++;
    };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) put(tile.x + i * step, hs[(j + 1) * N + i + 1], tile.z + j * step, i + 1, j + 1);
    // Skirts hanging down from the four edges hide cracks against coarser neighbours.
    const drop = 1.5 + step * 0.35;
    const edges = [];
    for (const [i0, j0, di, dj] of [[0, 0, 1, 0], [n - 1, 0, 0, 1], [n - 1, n - 1, -1, 0], [0, n - 1, 0, -1]]) {
      const e = [];
      for (let k = 0; k < n; k++) {
        const i = i0 + di * k, j = j0 + dj * k;
        e.push([j * n + i, v]);
        put(tile.x + i * step, hs[(j + 1) * N + i + 1] - drop, tile.z + j * step, i + 1, j + 1);
      }
      edges.push(e);
    }
    const idx = [];
    // Cells holding a limestone face are cut out (at every detail level up to SCAR_LEVEL); the apron and the 3D
    // face fill them. Their edges get skirts, like the tile's own edges.
    const holes = level <= SCAR_LEVEL && tile.scarCells ? new Uint8Array((n - 1) * (n - 1)) : null;
    if (holes) {
      for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) holes[j * (n - 1) + i] = scars.isCliffCell(tile.x + (i + 0.5) * step, tile.z + (j + 0.5) * step) ? 1 : 0;
    }
    const isHole = (i, j) => holes && i >= 0 && j >= 0 && i < n - 1 && j < n - 1 && holes[j * (n - 1) + i] === 1;
    const holeSkirts = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        if (isHole(i, j)) continue;
        idx.push(a, c, b, b, c, d);
        if (holes) {
          if (isHole(i, j - 1)) holeSkirts.push([a, b]);
          if (isHole(i, j + 1)) holeSkirts.push([c, d]);
          if (isHole(i - 1, j)) holeSkirts.push([a, c]);
          if (isHole(i + 1, j)) holeSkirts.push([b, d]);
        }
      }
    }
    for (const e of edges) {
      for (let k = 0; k + 1 < e.length; k++) {
        const [a, a2] = e[k], [b, b2] = e[k + 1];
        idx.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2); // both windings: a skirt is seen from either side
      }
    }
    let posA = pos, nrmA = nrm, detA = det;
    if (holeSkirts.length) {
      // Extra vertices hanging under each hole edge.
      const extra = holeSkirts.length * 2;
      posA = new Float32Array(pos.length + extra * 3);
      nrmA = new Float32Array(nrm.length + extra * 3);
      detA = new Float32Array(det.length + extra * 3);
      posA.set(pos);
      nrmA.set(nrm);
      detA.set(det);
      let w = vcount;
      for (const [a, b] of holeSkirts) {
        for (const s of [a, b]) {
          for (let k = 0; k < 3; k++) {
            posA[w * 3 + k] = pos[s * 3 + k] - (k === 1 ? drop + 2 : 0);
            nrmA[w * 3 + k] = nrm[s * 3 + k];
            detA[w * 3 + k] = det[s * 3 + k];
          }
          w++;
        }
        const a2 = w - 2, b2 = w - 1;
        idx.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(posA, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrmA, 3));
    g.setAttribute('detail', new THREE.BufferAttribute(detA, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, ground);
    mesh.receiveShadow = true;
    mesh.visible = false;
    terrainGroup.add(mesh);
    tile.meshes[level] = mesh;
    // A tile with its cliff cells cut out needs its faces ready before it is first shown.
    if (holes && !tile.scar) buildScar(tile);
    return mesh;
  }

  // Every tile at the coarsest detail up front (the horizon), finer ones as the camera comes near.
  for (const t of tiles) buildTile(t, 3);
  // The coarse tiles are also merged into blocks of 4×4, one draw call each, used wherever no tile in the
  // block needs more detail (most of the horizon).
  const blocks = new Map();
  for (const t of tiles) {
    const key = `${Math.floor((t.x - fx0) / (TILE * 4))},${Math.floor((t.z - fz0) / (TILE * 4))}`;
    if (!blocks.has(key)) blocks.set(key, { tiles: [] });
    blocks.get(key).tiles.push(t);
    t.block = blocks.get(key);
  }
  for (const b of blocks.values()) {
    const g = mergeGeometries(b.tiles.map((t) => t.meshes[3].geometry), false);
    g.computeBoundingSphere();
    b.mesh = new THREE.Mesh(g, ground);
    b.mesh.receiveShadow = true;
    terrainGroup.add(b.mesh);
  }
  let lastCam = null;
  function updateTerrain(camera, budget = 3, reach = Infinity) {
    if (!camera) return;
    const cx = camera.position.x, cz = camera.position.z;
    lastCam = { x: cx, z: cz };
    const work = [];
    for (const t of tiles) {
      const dx = Math.max(0, Math.abs(cx - t.cx) - TILE / 2), dz = Math.max(0, Math.abs(cz - t.cz) - TILE / 2);
      const d = Math.hypot(dx, dz);
      let want = 4;
      for (let k = 0; k < lodDist.length; k++) if (d < lodDist[k]) { want = k; break; }
      want = Math.max(minLevel, want === 4 ? 3 : want); // level 4 (80 m) is not needed: level 3 is cheap
      t.want = want;
      t.d = d;
      if (!t.meshes[want]) work.push(t);
    }
    work.sort((a, b) => a.d - b.d);
    for (const t of work.slice(0, budget)) if (t.d <= reach) buildTile(t, t.want);
    for (const b of blocks.values()) {
      b.merged = b.tiles.every((t) => t.want >= 3);
      b.mesh.visible = b.merged;
    }
    for (const t of tiles) {
      // Show the wanted level if built, else the nearest built level (coarser first); nothing if the block
      // is drawn merged.
      let show = t.block.merged ? -1 : t.meshes[t.want] ? t.want : -1;
      if (show < 0 && !t.block.merged) for (let k = t.want + 1; k < LOD_STEPS.length && show < 0; k++) if (t.meshes[k]) show = k;
      if (show < 0 && !t.block.merged) for (let k = t.want - 1; k >= 0 && show < 0; k--) if (t.meshes[k]) show = k;
      t.meshes.forEach((m, k) => {
        if (!m) return;
        m.visible = k === show;
        // Free fine meshes well out of range.
        if (k < 3 && k !== show && t.d > lodDist[k] * 1.8 + 200) {
          terrainGroup.remove(m);
          m.geometry.dispose();
          t.meshes[k] = undefined;
        }
      });
      // Becks: the cut channel with the most detailed mesh (let down under it), a flat ribbon of water beyond.
      if (t.beckNear && show >= 0 && show <= 2 && t.becks === null) {
        t.becks = becks.buildTile(t.x, t.z, t.x + TILE, t.z + TILE, beckMats, (x, z) => detailAt(x, z, Infinity)) ?? false;
        if (t.becks) terrainGroup.add(t.becks.near, t.becks.far);
      }
      if (t.becks) {
        t.becks.near.visible = show === 0;
        t.becks.far.visible = show >= 1 && show <= 2;
      }
      // The limestone faces go with the detailed meshes that have their cells cut out.
      if (t.scar) t.scar.visible = show >= 0 && show <= SCAR_LEVEL && !!t.scarCells;
    }
  }

  // ---- Road bed: verges and cut/fill slopes either side of the tarmac, in the ground material ----
  {
    const offs = [-BED, -10, -7, -4.8, -(ROAD_HALF + 1.2), -(ROAD_HALF - 0.3), ROAD_HALF - 0.3, ROAD_HALF + 1.2, 4.8, 7, 10, BED];
    const chunk = 300;
    const p = {};
    for (let from = 0; from < L; from += chunk) {
      const to = Math.min(L, from + chunk);
      const pos = [], det = [], idx = [];
      let rows = 0;
      for (let d = from; d <= to + 0.01; d += 2, rows++) {
        route.position(d, 0, p);
        const ch = Math.cos(p.heading), sh = Math.sin(p.heading);
        for (const o of offs) {
          const x = p.x + ch * o, z = p.z + sh * o;
          const inner = Math.abs(o) < ROAD_HALF;
          pos.push(x, inner ? p.y - 0.06 : heightAt(x, z), z);
          const dd = detailAt(x, z, Math.abs(o));
          det.push(dd[0] * smoothstep(5, 10, Math.abs(o)), dd[1] * smoothstep(5, 10, Math.abs(o)), dd[2]);
        }
        if (rows > 0) {
          const k = offs.length, a0 = (rows - 1) * k, b0 = rows * k;
          for (let i = 0; i < k - 1; i++) idx.push(a0 + i, a0 + i + 1, b0 + i, a0 + i + 1, b0 + i + 1, b0 + i);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('detail', new THREE.Float32BufferAttribute(det, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, bedMat);
      m.receiveShadow = true;
      group.add(m);
    }
  }
  const road = new THREE.Mesh(C.ribbon(route, { left: -ROAD_HALF, right: ROAD_HALF, lift: 0.04, uvLength: 9 }), C.roadMaterial({ centreLine: false, edgeLines: false, tone: '#6b6a66' }));
  road.receiveShadow = true;
  group.add(road);

  // ---- Water: tarns and ponds flat at their shore level (the becks are built with the terrain tiles) ----
  const lakeMat = lakeMaterial();
  const waterNormal = lakeMat.userData.ripple;
  {
    const parts = [];
    for (const lk of lakes) {
      const contour = [];
      for (let i = 0; i < lk.ring.length; i += 2) contour.push(new THREE.Vector2(lk.ring[i], lk.ring[i + 1]));
      if (contour.length < 3) continue;
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const pos = [], uv = [];
      for (const t of tris) {
        const [a, b, c] = t.map((k) => contour[k]);
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        for (const pnt of cross > 0 ? [a, c, b] : [a, b, c]) {
          pos.push(pnt.x, lk.level, pnt.y);
          // Ripples about 2.5 m across.
          uv.push(pnt.x / 2.5, pnt.y / 2.5);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      parts.push(g);
    }
    if (parts.length) {
      const lakesMesh = new THREE.Mesh(C.mergeAll(parts), lakeMat);
      lakesMesh.receiveShadow = true;
      group.add(lakesMesh);
    }
  }

  mark("tilesetup+lakes");
  // ---- Dry-stone walls: every OSM wall near the loop, following the ground ----
  const sceneryR = q.sceneryRadius;
  const wallR = sceneryR * 1.9;
  {
    const segs = [];
    const hedgeSegs = [];
    const add = (list, flatPts, out, maxR) => {
      for (const w of list) {
        const pts = densify(W(w), 4);
        let prev = null;
        for (let i = 0; i < pts.length; i += 2) {
          const x = pts[i], z = pts[i + 1];
          const rd = roadFar(x, z) > maxR ? Infinity : roadDistance(x, z);
          if (rd < ROAD_HALF + 0.5 || rd > maxR) {
            prev = null;
            continue;
          }
          const cur = { x, z, y: heightAt(x, z) };
          if (prev) out.push({ x1: prev.x, z1: prev.z, y1: prev.y, x2: cur.x, z2: cur.z, y2: cur.y });
          prev = cur;
        }
      }
      void flatPts;
    };
    add(data.walls ?? [], true, segs, wallR);
    add(data.hedges ?? [], true, hedgeSegs, wallR);
    group.add(C.linear(segs, 'wall', { shadows: q.shadows, maxDistance: Math.max(600, wallR * 0.75) }));
    if (hedgeSegs.length) group.add(C.linear(hedgeSegs, 'hedge', { shadows: q.shadows }));
    group.userData.wallSegments = segs.length;
  }

  mark("walls");
  // ---- Buildings: every OSM footprint near the loop, as stone cottages and field barns ----
  const houses = placeBuildings(data, heightAt, roadDistance, q, sceneryR * 3);
  group.add(houses);
  group.userData.buildings = houses.userData.count;

  mark("buildings");
  // ---- Trees: OSM woods (filled), tree rows and single trees, nearest the road first ----
  {
    const spots = [];
    const tryAdd = (x, z, kind, s, pri) => {
      const rd = roadDistance(x, z);
      if (rd < ROAD_HALF + 4) return;
      if (wet.get(x, z) || scars.underFace(x, z)) return;
      if (becks.nearest(x, z, beckOut).d < beckOut.half + 1.5) return;
      spots.push({ x, z, kind, s, pri: rd + pri });
    };
    for (let i = 0; i < (data.trees ?? []).length; i += 2) tryAdd(data.trees[i], -data.trees[i + 1], 'broad', 0.9 + r() * 0.5, -200);
    for (const row of data.treeRows ?? []) {
      const pts = densify(W(row), 7);
      for (let i = 0; i < pts.length; i += 2) tryAdd(pts[i] + (r() - 0.5) * 2, pts[i + 1] + (r() - 0.5) * 2, 'broad', 0.8 + r() * 0.5, -100);
    }
    for (const w of data.woods ?? []) {
      const ring = W(w.p);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        minX = Math.min(minX, ring[i]);
        maxX = Math.max(maxX, ring[i]);
        minZ = Math.min(minZ, ring[i + 1]);
        maxZ = Math.max(maxZ, ring[i + 1]);
      }
      const centreD = roadDistance((minX + maxX) / 2, (minZ + maxZ) / 2);
      if (centreD > 2600) continue;
      const spacing = centreD < 500 ? 7.5 : centreD < 1200 ? 10 : 14;
      for (let z = minZ + spacing / 2; z < maxZ; z += spacing) {
        for (let x = minX + spacing / 2; x < maxX; x += spacing) {
          const px = x + (r() - 0.5) * spacing * 0.9, pz = z + (r() - 0.5) * spacing * 0.9;
          if (!pointInRing(px, pz, ring)) continue;
          const conifer = w.t === 'conifer' || (w.t === 'mixed' && r() < 0.55);
          tryAdd(px, pz, conifer ? 'conifer' : 'broad', (conifer ? 1.0 : 0.95) + r() * 0.45, 0);
        }
      }
    }
    spots.sort((a, b) => a.pri - b.pri);
    const cap = q.maxTrees;
    const placements = spots.slice(0, cap).map((s) => ({ x: s.x, z: s.z, y: heightAt(s.x, s.z), kind: s.kind, s: s.s, rot: r() * 6.28, hue: r() - 0.5, sx: 0.85 + r() * 0.3, sy: 0.85 + r() * 0.35 }));
    group.add(C.trees(placements, { shadows: q.shadows, maxDistance: 2600 }));
    group.userData.trees = placements.length;
  }

  mark("trees");
  // ---- Power: wooden pole lines (11 kV / 33 kV) with sagging wires; steel towers where mapped ----
  const power = powerLines(data, heightAt, roadDistance, q);
  group.add(power);

  // ---- Limestone outcrops: clints and boulders on the mapped bare rock and pavement near the road ----
  {
    const rocks = [];
    const cap = Math.round(3500 * q.treeDensity);
    for (const c of data.cover ?? []) {
      if (c.c !== 'rock' && c.c !== 'pavement' && c.c !== 'scree') continue;
      const ring = W(c.p);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        minX = Math.min(minX, ring[i]);
        maxX = Math.max(maxX, ring[i]);
        minZ = Math.min(minZ, ring[i + 1]);
        maxZ = Math.max(maxZ, ring[i + 1]);
      }
      const cd = roadDistance((minX + maxX) / 2, (minZ + maxZ) / 2);
      if (cd > 900) continue;
      const spacing = c.c === 'pavement' ? 4.5 : c.c === 'scree' ? 3 : 6;
      for (let z = minZ; z < maxZ; z += spacing) {
        for (let x = minX; x < maxX; x += spacing) {
          const px = x + r() * spacing, pz = z + r() * spacing;
          if (!pointInRing(px, pz, ring) || roadDistance(px, pz) < ROAD_HALF + 2) continue;
          const big = c.c === 'pavement' ? 1.4 + r() * 2.2 : c.c === 'scree' ? 0.3 + r() * 0.6 : 0.8 + r() * 2.4;
          rocks.push({ x: px, z: pz, s: big, pri: roadDistance(px, pz) });
        }
      }
    }
    rocks.sort((a, b) => a.pri - b.pri);
    group.add(limestoneRocks(rocks.slice(0, cap), heightAt, q, r));
  }

  mark("power+rocks");
  // ---- Sheep in the fields near the road ----
  {
    const sheep = [];
    const want = Math.round(900 * q.treeDensity);
    for (let f = 0; f < 400 && sheep.length < want; f++) {
      const at = r() * L;
      const p = route.position(at, (r() < 0.5 ? -1 : 1) * (14 + r() * 320));
      const c = cls.get(p.x, p.z);
      if (![0, CLS.meadow, CLS.grass, CLS.heath].includes(c) || wet.get(p.x, p.z)) continue;
      const n = 5 + Math.floor(r() * 14);
      for (let k = 0; k < n; k++) {
        const x = p.x + (r() - 0.5) * 45, z = p.z + (r() - 0.5) * 45;
        const ck = cls.get(x, z);
        if (![0, CLS.meadow, CLS.grass, CLS.heath].includes(ck) || roadDistance(x, z) < ROAD_HALF + 5) continue;
        sheep.push({ x, z, y: heightAt(x, z), rot: r() * 6.28, s: r() < 0.2 ? 0.55 + r() * 0.1 : 0.9 + r() * 0.25 });
      }
    }
    group.add(sheepMesh(sheep));
  }

  // ---- Spectators: the steep ramps of Cove Road and the start in the village ----
  {
    const pts = [];
    const kom = route.segments.find((s) => s.id === 'cove');
    const add = (from, to, every) => {
      for (let d = from; d < to; d += every) {
        for (const s of [-1, 1]) {
          if (r() < 0.45) continue;
          const p = route.position(d + r() * every, s * (ROAD_HALF + 0.7 + r() * 0.8));
          pts.push({ x: p.x, y: heightAt(p.x, p.z), z: p.z, rot: -p.heading + (s > 0 ? Math.PI / 2 : -Math.PI / 2) + (r() - 0.5) * 0.8 });
        }
      }
    };
    if (kom) add(kom.to - 450, kom.to + 30, 6);
    add(L - 120, L, 5);
    add(0, 60, 5);
    group.add(C.spectators(pts));
  }

  // ---- Ground cover near the camera: verge grass, tussocks, rushes, bracken, boulders (groundcover.js) ----
  const imgNear = new ImagerySampler(nearImageUrl, im.near ?? rectOf(mid), landOpts, () => cover.reset());
  const fallbackGreen = [0.05, 0.11, 0.025, 0.08];
  const probeCol = [0, 0, 0, 0];
  const probeBeck = {};
  const probe = (x, z, p) => {
    const rd = roadDistance(x, z);
    const c = cls.get(x, z);
    p.skip = rd < ROAD_HALF + 0.15 || wet.get(x, z) > 0 || c === CLS.village || c === CLS.yard || c === CLS.quarry;
    if (p.skip) return p;
    p.h = heightAt(x, z);
    p.under = scars.underFace(x, z);
    // Not in a beck; rushes and long grass along its banks.
    const bd = becks.nearest(x, z, probeBeck);
    if (bd.d < bd.half + 1.1) p.skip = true;
    const col = imgNear.colour(x, -z, probeCol) ? probeCol : fallbackGreen;
    p.colour = [col[0], col[1], col[2], col[3]];
    p.verge = rd < ROAD_HALF + 3.6 ? 1 : 0;
    const sx = dem(x + 2, z) - dem(x - 2, z), sz = dem(x, z + 2) - dem(x, z - 2);
    const slope = Math.hypot(sx, sz) / 4;
    p.high = p.h > 330;
    p.field = c === 0 || c === CLS.meadow || c === CLS.grass;
    p.rough = c === CLS.heath ? 1 : c === CLS.scrub ? 0.8 : c === CLS.wet ? 0.7 : c === CLS.wood ? 0.6 : 0;
    // Pale grey pixels in the imagery are bare rock.
    const lum = col[3] ?? 0.08, grey = Math.abs(col[1] - col[0]) < 0.03;
    const bare = Math.min(1, Math.max(0, (lum - 0.06) / 0.05)) * (grey ? 1 : 0.4);
    p.rock = c === CLS.rock || c === CLS.pavement ? 0.25 + 0.75 * bare : slope > 0.75 ? 0.5 : 0;
    p.scree = c === CLS.scree ? 1 : 0;
    // Soft rush: in the wet ground, and in patches in the flatter fields.
    const patch = hash2(Math.floor(x / 11), Math.floor(z / 11), 5);
    p.rushPatch = bd.d < bd.half + 4 ? 0.4 : c === CLS.wet ? 0.5 : p.field && slope < 0.18 && patch < 0.09 ? 0.35 * (1 - patch / 0.09) + 0.1 : 0;
    // Bracken on the slopes of the rough ground and the dale sides.
    const bp = hash2(Math.floor(x / 15), Math.floor(z / 15), 9);
    p.bracken = slope > 0.14 && slope < 0.8 && (p.rough > 0.5 || (p.field && !p.high && bp < 0.22)) ? 0.4 : 0;
    return p;
  };
  const cover = new GroundCover({ probe, q, rockMaterial: boulderMaterial() });
  group.add(cover.group);

  // ---- Start/finish arch and zone banners ----
  group.add(C.arch(route, 0, 'SPINDOWN · MALHAM', { width: 2 * ROAD_HALF + 1.6 }));
  for (const s of route.zones) {
    group.add(C.arch(route, s.from, s.kind === 'kom' ? `▲ ${s.name.toUpperCase()}` : `⚡ ${s.name.toUpperCase()}`, { width: 2 * ROAD_HALF + 1.6, colour: s.kind === 'kom' ? '#b3261e' : '#0a6cc2' }));
    group.add(C.arch(route, s.to, 'FINISH ▸', { width: 2 * ROAD_HALF + 1.6, colour: '#333' }));
  }

  const tScene = performance.now();
  // Warm the terrain detail around the start so the first frame is sharp.
  const start = route.position(0);
  // (Only the nearest tiles: the rest come in over the first frames, shown coarse until then.)
  updateTerrain({ position: new THREE.Vector3(start.x, start.y, start.z) }, 1e9, 700);

  const tWarm = performance.now();
  let lastT = null;
  const update = (t, camera) => {
    waterNormal.offset.set(t * 0.03, t * 0.012);
    beckMats.water.userData.flow.value = t;
    updateTerrain(camera);
    cover.update(camera, lastT == null ? 0.016 : Math.min(0.1, t - lastT));
    lastT = t;
    // Wires are a pixel wide at any distance, so only draw the ones near enough to really see.
    if (camera) for (const w of power.userData.wires) w.visible = camera.position.distanceTo(w.geometry.boundingSphere.center) - w.geometry.boundingSphere.radius < 450;
  };
  /** Atmosphere for real hills: haze that thickens with distance instead of a wall of fog. */
  const atmosphere = (view) => {
    const fog = view.scene.fog;
    if (!fog) return;
    const thick = fog.far < view.q.fogFar * 0.8; // overcast or rain
    fog.near = thick ? fog.near : Math.max(fog.near, 350);
    fog.far = thick ? fog.far * 1.6 : Math.max(fog.far * 2.4, 6200);
    view.camera.far = Math.max(view.camera.far, Math.min(9000, fog.far * 1.15));
    view.camera.updateProjectionMatrix();
    view.sky.scale.setScalar(view.camera.far * 0.9);
  };
  const ms = Math.round(performance.now() - t0);
  console.log(`[world] Malham built in ${ms} ms (materials ${Math.round(tMat - t0)}, scenery ${Math.round(tScene - tMat)} ${JSON.stringify(tm)}, terrain warm-up ${Math.round(tWarm - tScene)}): ${tiles.length} terrain tiles, ${group.userData.wallSegments} wall segments, ${group.userData.trees} trees, ${group.userData.buildings} buildings`);
  return { group, heightAt, roadHalf: ROAD_HALF, update, atmosphere, buildingCount: group.userData.buildings, buildMs: ms, debug: { tiles, lastCam: () => lastCam, becks, scars } };
}

// ---- Helpers ---------------------------------------------------------------------------------------------

/** Adds points so no segment of a flat [x, z, ...] polyline is longer than `step`. */
function densify(pts, step) {
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], az = pts[i - 1], bx = pts[i], bz = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
  }
  return out;
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Principal-axis rectangle of a footprint ring (flat world [x, z, ...]): centre, long axis, sizes. */
function orientedRect(ring) {
  const n = ring.length / 2;
  let mx = 0, mz = 0;
  for (let i = 0; i < ring.length; i += 2) {
    mx += ring[i];
    mz += ring[i + 1];
  }
  mx /= n;
  mz /= n;
  // Longest edge direction is the most reliable axis for small, nearly rectangular buildings.
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const dx = ring[j] - ring[i], dz = ring[j + 1] - ring[i + 1];
    const len = Math.hypot(dx, dz);
    if (len > best) [best, ux, uz] = [len, dx / len, dz / len];
  }
  const vx = -uz, vz = ux;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const dx = ring[i] - mx, dz = ring[i + 1] - mz;
    const a = dx * ux + dz * uz, b = dx * vx + dz * vz;
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
    b0 = Math.min(b0, b);
    b1 = Math.max(b1, b);
  }
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  const la = a1 - a0, lb = b1 - b0;
  const along = la >= lb;
  return { cx: mx + ux * ca + vx * cb, cz: mz + uz * ca + vz * cb, ax: along ? ux : vx, az: along ? uz : vz, long: Math.max(la, lb), short: Math.min(la, lb) };
}

/**
 * OSM building footprints near the road, given to the shared building builder as oriented rectangles (the
 * real ring is passed along as `footprint`). Houses in Malham are limestone and gritstone under stone-flag or
 * slate roofs; field barns ("laithes") are rubble stone with stone roofs.
 */
function placeBuildings(data, heightAt, roadDistance, q, radius) {
  const items = [];
  const stones = ['#f3efe6', '#e9e4d8', '#f7f3ea', '#dedad0', '#ece6da'];
  for (const b of data.buildings ?? []) {
    if (b.k === 'ruin') continue;
    const ring = W(b.p);
    if (ring.length < 6) continue;
    const o = orientedRect(ring);
    if (o.short < 2.2) continue;
    const rd = roadDistance(o.cx, o.cz);
    if (rd > radius || rd < ROAD_HALF + 0.8) continue;
    // Base: down to the lowest corner (the walls reach 0.6 m below it), so nothing floats on a slope.
    const hs = [];
    for (let i = 0; i < ring.length; i += 2) hs.push(heightAt(ring[i], ring[i + 1]));
    hs.push(heightAt(o.cx, o.cz));
    const lo = Math.min(...hs), hi = Math.max(...hs);
    const barn = b.k === 'barn';
    const hsh = hash2(Math.round(o.cx), Math.round(o.cz), 7);
    items.push({
      x: o.cx, y: lo + Math.min(0.5, (hi - lo) * 0.3), z: o.cz,
      rot: Math.atan2(-o.ax, -o.az),
      w: o.long, d: Math.min(o.short, 14), h: Math.max(barn ? 4.2 : 5, b.h ?? 5.8) + (hi - lo) * 0.3,
      kind: barn ? 'barn' : b.k === 'chapel' ? 'cottage' : 'cottage',
      roof: barn || hsh < 0.55 ? 'stone' : 'slate',
      chimney: !barn,
      storey: barn ? 5.5 : 2.8,
      tint: stones[Math.floor(hsh * stones.length)],
      gableTint: '#e9e3d6',
      footprint: ring,
      name: b.n,
    });
  }
  const g = C.buildings(items, { shadows: q.shadows });
  g.userData.count = items.length;
  return g;
}

/** Wooden poles (and lattice towers) along the OSM power lines, with three sagging conductors. */
function powerLines(data, heightAt, roadDistance, q) {
  const group = new THREE.Group();
  const poles = [], towers = [];
  const wires = new Map(); // 400 m cells of conductor segments, shown only near the camera
  const R = 2400;
  for (const line of data.power ?? []) {
    const pts = W(line.p);
    const steel = line.k === 'line';
    const tops = [];
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i], z = pts[i + 1];
      const pi = Math.max(0, i - 2), ni = Math.min(pts.length - 2, i + 2);
      const heading = Math.atan2(pts[ni] - pts[pi], pts[ni + 1] - pts[pi + 1]);
      const near = roadDistance(x, z) < R;
      const y = heightAt(x, z);
      const h = steel ? 26 : 8.6;
      tops.push({ x, y: y + h, z, heading, near });
      if (!near) continue;
      (steel ? towers : poles).push({ x, y, z, rot: heading });
    }
    const arm = steel ? 5 : 0.85;
    for (let i = 0; i + 1 < tops.length; i++) {
      const a = tops[i], b = tops[i + 1];
      if (!a.near && !b.near) continue;
      const span = Math.hypot(b.x - a.x, b.z - a.z);
      if (span > 600) continue;
      const sag = Math.min(4, 0.25 + span * span * 0.00012);
      for (const o of steel ? [-arm, 0, arm] : [-arm, 0, arm]) {
        const ax = a.x + Math.cos(a.heading) * o, az = a.z - Math.sin(a.heading) * o;
        const bx = b.x + Math.cos(b.heading) * o, bz = b.z - Math.sin(b.heading) * o;
        const yo = o === 0 && !steel ? 0.35 : 0;
        const n = Math.max(4, Math.ceil(span / 12));
        for (let k = 0; k < n; k++) {
          const t0 = k / n, t1 = (k + 1) / n;
          const y0 = a.y + yo + (b.y - a.y) * t0 - sag * 4 * t0 * (1 - t0), y1 = a.y + yo + (b.y - a.y) * t1 - sag * 4 * t1 * (1 - t1);
          const key = `${Math.floor((ax + bx) / 800)},${Math.floor((az + bz) / 800)}`;
          if (!wires.has(key)) wires.set(key, []);
          wires.get(key).push(ax + (bx - ax) * t0, y0, az + (bz - az) * t0, ax + (bx - ax) * t1, y1, az + (bz - az) * t1);
        }
      }
    }
  }
  // Pole: a creosoted wooden pole with a crossarm and three insulators on top.
  const wood = '#4a3d30';
  const poleGeo = C.mergeAll([
    C.tint(new THREE.CylinderGeometry(0.11, 0.15, 9.2, 7).translate(0, 4.4, 0), wood),
    C.tint(new THREE.BoxGeometry(2.0, 0.12, 0.12).translate(0, 8.45, 0), wood),
    ...[-0.85, 0, 0.85].map((x) => C.tint(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 6).translate(x, x === 0 ? 9.05 : 8.66, 0), '#c8c2b0')),
  ], { colour: true, uv: false });
  const towerGeo = C.mergeAll([
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => C.tint(new THREE.CylinderGeometry(0.12, 0.18, 26, 4).translate(0, 13, 0).rotateZ(sx * 0.07).rotateX(-sz * 0.07).translate(sx * 1.4, 0, sz * 1.4), '#8d9398')),
    C.tint(new THREE.BoxGeometry(10.5, 0.35, 0.35).translate(0, 22, 0), '#8d9398'),
    C.tint(new THREE.BoxGeometry(7, 0.3, 0.3).translate(0, 25.5, 0), '#8d9398'),
    C.tint(new THREE.ConeGeometry(1.2, 4, 4).translate(0, 28, 0), '#8d9398'),
  ], { colour: true, uv: false });
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const up = new THREE.Vector3(0, 1, 0), qq = new THREE.Quaternion();
  const toItems = (list) => list.map((p) => ({ matrix: new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y - 0.3, p.z), qq.setFromAxisAngle(up, p.rot).clone(), new THREE.Vector3(1, 1, 1)) }));
  if (poles.length) group.add(C.chunked(poleGeo, mat, toItems(poles), { shadows: q.shadows, maxDistance: 1400, chunk: 400 }));
  if (towers.length) group.add(C.chunked(towerGeo, mat, toItems(towers), { shadows: q.shadows, maxDistance: 4000, chunk: 600 }));
  const wireMat = new THREE.LineBasicMaterial({ color: '#3a3a38', transparent: true, opacity: 0.6 });
  group.userData.wires = [];
  for (const list of wires.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
    g.computeBoundingSphere();
    const lines = new THREE.LineSegments(g, wireMat);
    group.add(lines);
    group.userData.wires.push(lines);
  }
  group.userData.poles = poles.length;
  return group;
}

/**
 * The dry-stone wall network drawn into a texture over the detailed area, so walls still read on distant
 * hillsides where the 3D walls are not drawn.
 */
function wallLineTexture(data, rect) {
  const size = 2048;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  const sx = size / (rect.x1 - rect.x0), sy = size / (rect.y1 - rect.y0);
  g.strokeStyle = '#fff';
  g.lineWidth = Math.max(1, 1.1 * sx);
  g.lineCap = 'round';
  g.beginPath();
  for (const w of data.walls ?? []) {
    for (let i = 0; i < w.length; i += 2) {
      const px = (w[i] - rect.x0) * sx, py = (rect.y1 - w[i + 1]) * sy;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
  }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Pale grey limestone blocks, flattened and sunk into the turf, instanced in chunks. */
function limestoneRocks(list, heightAt, q, r) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.18 * Math.sin(x * 5.1 + z * 2.3) + 0.12 * Math.sin(z * 7.7 - y * 3.1);
    p.setXYZ(i, x * k, Math.max(-0.4, y) * k * (y > 0.55 ? 0.75 : 1), z * k);
  }
  g.computeVertexNormals();
  const geo = C.mergeAll([C.shadeY(g, 0.62, 1.05, '#d3d1c8')], { colour: true, uv: false });
  const qq = new THREE.Quaternion(), e = new THREE.Euler();
  const items = list.map((rk) => {
    e.set((r() - 0.5) * 0.15, r() * 6.28, (r() - 0.5) * 0.15);
    qq.setFromEuler(e);
    const s = rk.s;
    return { matrix: new THREE.Matrix4().compose(new THREE.Vector3(rk.x, heightAt(rk.x, rk.z) - 0.12 * s, rk.z), qq, new THREE.Vector3(s * (0.8 + r() * 0.5), s * (0.22 + r() * 0.2), s * (0.6 + r() * 0.4))), colour: new THREE.Color().setScalar(0.85 + r() * 0.25) };
  });
  return C.chunked(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), items, { shadows: q.shadows, maxDistance: 650, chunk: 200 });
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
