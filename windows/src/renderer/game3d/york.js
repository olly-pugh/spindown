// York, built from OpenStreetMap data (© OpenStreetMap contributors, ODbL): every building footprint
// extruded with brick, render, stone, shopfront or timber-framed facades under pantile and slate roofs with
// chimney pots; the streets; the Ouse and the Foss sunk between their quay walls; parks; the medieval city
// walls with their wall-walk and battlements on grassy ramparts; and hand-built models of York Minster and
// Clifford's Tower placed on their real footprints. The route follows the real inner ring road.
import * as THREE from 'three';
import * as C from './common.js';
import * as T from './textures.js';
import * as B from './buildings.js'; // [buildings-pass]
import * as L from './landmarks.js'; // [buildings-pass]
import { RouteField } from '../../core/world/field.js';
import { rng, hash2 } from '../../core/world/noise.js';

const Y0 = 12; // street level, metres above sea level
const YW = Y0 - 3.4; // river level
const ROAD_HALF = 3.6;

/** York data points (x east, y north) to world (x, z = −y). */
const W = (flat) => {
  const out = new Array(flat.length);
  for (let i = 0; i < flat.length; i += 2) {
    out[i] = flat[i];
    out[i + 1] = -flat[i + 1];
  }
  return out;
};

function signedArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return a / 2;
}

function shapeGeometry(points, y, uvScale = 6) {
  const n = points.length / 2;
  const contour = [];
  for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(points[i * 2], points[i * 2 + 1]));
  if (contour.length > 2 && contour[0].distanceTo(contour[contour.length - 1]) < 0.01) contour.pop();
  if (contour.length < 3) return null;
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const pos = [], uv = [];
  for (const t of tris) {
    // Wind every triangle so it faces up.
    const [a, b, c] = t.map((k) => contour[k]);
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    for (const q of cross > 0 ? [a, c, b] : [a, b, c]) {
      pos.push(q.x, y, q.y);
      uv.push(q.x / uvScale, q.y / uvScale);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

/** Oriented bounding rectangle of a ring (principal axes), plus its centre, long axis and half-sizes. */
function orientedRect(ring) {
  const n = ring.length / 2;
  let mx = 0, mz = 0;
  for (let i = 0; i < ring.length; i += 2) {
    mx += ring[i];
    mz += ring[i + 1];
  }
  mx /= n;
  mz /= n;
  let cxx = 0, czz = 0, cxz = 0;
  for (let i = 0; i < ring.length; i += 2) {
    const dx = ring[i] - mx, dz = ring[i + 1] - mz;
    cxx += dx * dx;
    czz += dz * dz;
    cxz += dx * dz;
  }
  const t = 0.5 * Math.atan2(2 * cxz, cxx - czz);
  const ux = Math.cos(t), uz = Math.sin(t), vx = -uz, vz = ux;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const dx = ring[i] - mx, dz = ring[i + 1] - mz;
    const a = dx * ux + dz * uz, b = dx * vx + dz * vz;
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
    b0 = Math.min(b0, b);
    b1 = Math.max(b1, b);
  }
  // Centre of the rectangle (not of the vertices), and the long axis as the ridge direction.
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  const cx = mx + ux * ca + vx * cb, cz = mz + uz * ca + vz * cb;
  const alongU = a1 - a0 >= b1 - b0;
  return {
    area: (a1 - a0) * (b1 - b0), long: Math.max(a1 - a0, b1 - b0), short: Math.min(a1 - a0, b1 - b0),
    centre: [cx, cz], axis: alongU ? [ux, uz] : [vx, vz],
  };
}

function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], zi = poly[i + 1], xj = poly[j], zj = poly[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function bbox(poly) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]);
    maxX = Math.max(maxX, poly[i]);
    minZ = Math.min(minZ, poly[i + 1]);
    maxZ = Math.max(maxZ, poly[i + 1]);
  }
  return { minX, maxX, minZ, maxZ };
}

/** A box whose side faces repeat a wall texture `ru` times across the x-facing sides and `rw` across the z-facing ones, over v0…v1. */
function uvBox(w, h, d, rw, rd, v0 = 0, v1 = 1) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // Faces in order: +x, −x, +y, −y, +z, −z; 4 vertices each.
  const reps = [rd, rd, 0.01, 0.01, rw, rw];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (f === 2 || f === 3) uv.setXY(i, 0.02, 0.5);
      else uv.setXY(i, uv.getX(i) * reps[f], v0 + uv.getY(i) * (v1 - v0));
    }
  }
  return g;
}

export function buildYork(route, data, q) {
  const group = new THREE.Group();
  const field = new RouteField(route, { cell: 16, margin: 1200 });
  const tmp = {};
  const r = rng(1068);
  const bounds = data.bounds;
  const shadowy = (m) => {
    m.castShadow = q.shadows;
    m.receiveShadow = true;
    return m;
  };
  const receiving = (m) => {
    m.receiveShadow = true;
    return m;
  };
  const std = (o) => new THREE.MeshStandardMaterial(o);

  // ---- Water: the rivers lie below street level, so the ground is cut away over them ----
  const waters = data.water.map(W).map((p) => ({ p, box: bbox(p) }));
  const inWater = (x, z) => {
    for (const w of waters) if (x >= w.box.minX && x <= w.box.maxX && z >= w.box.minZ && z <= w.box.maxZ && pointInPolygon(x, z, w.p)) return true;
    return false;
  };
  const gw = bounds.maxX - bounds.minX + 800, gd = bounds.maxY - bounds.minY + 800;
  const gx0 = bounds.minX - 400, gz0 = -bounds.maxY - 400;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskCanvas.height = q.shadows ? 2048 : 1024;
  {
    const g = maskCanvas.getContext('2d');
    const s = maskCanvas.width;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, s, s);
    for (const w of waters) {
      g.beginPath();
      for (let i = 0; i < w.p.length; i += 2) {
        const px = ((w.p[i] - gx0) / gw) * s, py = ((w.p[i + 1] - gz0) / gd) * s;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = '#000';
      g.fill();
      // Pull the cut back a little from the bank so the ground always reaches the quay wall.
      g.strokeStyle = '#fff';
      g.lineWidth = (1.6 / gw) * s;
      g.stroke();
    }
  }
  const mask = new THREE.CanvasTexture(maskCanvas);
  mask.channel = 1;
  mask.flipY = false;
  const groundGeo = new THREE.PlaneGeometry(gw, gd, 1, 1).rotateX(-Math.PI / 2);
  {
    // After the rotation the plane's u runs east and v runs north; the mask is drawn with z (south) downwards.
    const p = groundGeo.attributes.position, uv = groundGeo.attributes.uv;
    const uv1 = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      uv1[i * 2] = p.getX(i) / gw + 0.5;
      uv1[i * 2 + 1] = p.getZ(i) / gd + 0.5;
      uv.setXY(i, (p.getX(i) + gw / 2) / 12, (p.getZ(i) + gd / 2) / 12);
    }
    groundGeo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  }
  const ground = new THREE.Mesh(groundGeo, C.groundMaterial({ map: T.yardTexture(), alphaMap: mask, alphaTest: 0.5, roughness: 1 }));
  ground.position.set(gx0 + gw / 2, Y0 - 0.1, gz0 + gd / 2);
  ground.receiveShadow = true;
  group.add(ground);

  const waterNormal = T.waterNormalTexture();
  const waterMat = std({ color: '#52706a', roughness: 0.08, metalness: 0.1, normalMap: waterNormal, normalScale: new THREE.Vector2(0.18, 0.18), envMapIntensity: 1.1 });
  const waterGeo = C.mergeAll(waters.map((w) => shapeGeometry(w.p, YW, 9)).filter(Boolean));
  group.add(receiving(new THREE.Mesh(waterGeo, waterMat)));
  // Quay walls down to the water.
  const quay = [];
  for (const w of waters) {
    const p = w.p.slice();
    if (Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]) > 0.01) p.push(p[0], p[1]);
    const dx = p[2] - p[0], dz = p[3] - p[1], len = Math.hypot(dx, dz) || 1;
    const inward = pointInPolygon((p[0] + p[2]) / 2 - (dz / len) * 0.4, (p[1] + p[3]) / 2 + (dx / len) * 0.4, w.p) ? 1 : -1;
    const g = C.profileAlong(p, [[-inward * 0.6, Y0 - 0.06], [0, Y0 - 0.06], [inward * 0.7, YW - 0.8]], { uvLength: 4, uvV: 4 });
    if (g) quay.push(g);
  }
  if (quay.length) group.add(receiving(new THREE.Mesh(C.mergeAll(quay), std({ map: T.stoneWallTexture({ tone: 'rubble' }), color: '#c9c2b2', roughness: 0.95, side: THREE.DoubleSide }))));

  // ---- Parks ----
  const greens = data.green.map(W);
  const greenGeo = C.mergeAll(greens.map((p) => shapeGeometry(p, Y0 - 0.06, 7)).filter(Boolean));
  group.add(receiving(new THREE.Mesh(greenGeo, C.groundMaterial({ map: T.grassTexture(), color: '#dfeec8', roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }))));

  // ---- Streets ----
  const roadSets = { asphalt: [], cobbles: [], paving: [] };
  const skirts = [];
  for (const rd of data.roads) {
    const pts = W(rd.p);
    const kind = rd.k === 'pedestrian' ? 'cobbles' : rd.k === 'footway' || rd.k === 'cycleway' ? 'paving' : 'asphalt';
    const lift = kind === 'asphalt' ? 0.02 : kind === 'cobbles' ? 0.015 : 0.01;
    const width = kind === 'asphalt' ? Math.max(3.2, rd.w * 1.5) : Math.max(2, rd.w);
    const g = C.polylineRibbon(pts, width, Y0 - 0.06 + lift, kind === 'asphalt' ? 9 : kind === 'cobbles' ? 2 : 3);
    if (g) roadSets[kind].push(g);
    // Where a street crosses the river it becomes a bridge: give the deck some depth.
    for (let i = 0; i < pts.length - 2; i += 2) {
      const mx = (pts[i] + pts[i + 2]) / 2, mz = (pts[i + 1] + pts[i + 3]) / 2;
      if (!inWater(mx, mz)) continue;
      const sk = C.profileAlong(pts.slice(Math.max(0, i - 2), i + 6), [[-width / 2 - 0.5, Y0 - 1.3], [-width / 2 - 0.5, Y0 + 0.9], [-width / 2 - 0.2, Y0 + 0.9], [-width / 2 - 0.2, Y0 - 0.05], [width / 2 + 0.2, Y0 - 0.05], [width / 2 + 0.2, Y0 + 0.9], [width / 2 + 0.5, Y0 + 0.9], [width / 2 + 0.5, Y0 - 1.3]], { uvLength: 4, uvV: 4 });
      if (sk) skirts.push(sk);
      i += 2;
    }
  }
  const streetMats = {
    asphalt: std({ map: T.roadTexture({ centreLine: false, edgeLines: false, tone: '#505154' }), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    cobbles: std({ map: T.cobbleTexture(), roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    paving: std({ map: T.pavingTexture(), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  };
  for (const [k, list] of Object.entries(roadSets)) if (list.length) group.add(receiving(new THREE.Mesh(C.mergeAll(list), streetMats[k])));
  const limestone = std({ map: T.stoneWallTexture({ tone: 'limestone' }), roughness: 0.9 });
  const limestone2 = std({ map: T.stoneWallTexture({ tone: 'limestone' }), roughness: 0.9, side: THREE.DoubleSide });
  if (skirts.length) group.add(shadowy(new THREE.Mesh(C.mergeAll(skirts), limestone2)));

  // The route: full-width tarmac with double yellow lines, raised kerbs and stone-flagged pavements.
  group.add(receiving(new THREE.Mesh(C.ribbon(route, { left: -ROAD_HALF, right: ROAD_HALF, lift: 0.06, uvLength: 9, step: 2 }), C.roadMaterial({ centreLine: true, yellow: true }))));
  const kerbs = [], paves = [];
  for (const s of [-1, 1]) {
    kerbs.push(C.ribbon(route, { left: s > 0 ? ROAD_HALF : -ROAD_HALF - 0.25, right: s > 0 ? ROAD_HALF + 0.25 : -ROAD_HALF, lift: 0.2, uvLength: 0.9 }));
    kerbs.push(C.routeWall(route, { lateral: s * ROAD_HALF, bottom: (d, y) => y + 0.03, top: (d, y) => y + 0.2, uvLength: 0.9, uvHeight: 1 }));
    paves.push(C.ribbon(route, { left: s > 0 ? ROAD_HALF + 0.25 : -ROAD_HALF - 2.7, right: s > 0 ? ROAD_HALF + 2.7 : -ROAD_HALF - 0.25, lift: 0.19, uvLength: 3, uvAcross: 0.8 }));
  }
  group.add(receiving(new THREE.Mesh(C.mergeAll(kerbs), std({ color: '#b4b0a6', roughness: 0.8, side: THREE.DoubleSide }))));
  group.add(receiving(new THREE.Mesh(C.mergeAll(paves), std({ map: T.pavingTexture(), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }))));

  // ---- Buildings ----
  // [buildings-pass] Footprints go to buildings.js, which works out terraces, party walls and street fronts and
  // builds each house with real openings, roofs along the street and chimneys on the party walls.
  const ring = W(data.route.points);
  // Where buildings stand (3 m cells), so street trees are not planted through a shop window.
  const occupied = new Set();
  const occKey = (x, z) => `${Math.floor(x / 3)},${Math.floor(z / 3)}`;
  const cityList = [];
  let built = 0;
  for (const b of data.buildings) {
    if (b.k === 'cathedral' || b.n === "Clifford's Tower") continue;
    let ringB = W(b.p);
    if (ringB.length > 6 && Math.hypot(ringB[0] - ringB[ringB.length - 2], ringB[1] - ringB[ringB.length - 1]) < 0.01) ringB.length -= 2;
    let cx = 0, cz = 0;
    const n = ringB.length / 2;
    if (n < 3) continue;
    for (let i = 0; i < ringB.length; i += 2) {
      cx += ringB[i];
      cz += ringB[i + 1];
    }
    cx /= n;
    cz /= n;
    // Keep the route clear: skip footprints that reach onto the road.
    let tooClose = false;
    for (let i = 0; i < ringB.length && !tooClose; i += 2) if (field.query(ringB[i], ringB[i + 1], tmp).distance < ROAD_HALF + 2.9) tooClose = true;
    if (!tooClose && field.query(cx, cz, tmp).distance < ROAD_HALF + 2.9) tooClose = true;
    if (tooClose) {
      // [buildings-pass] A house fronting the pavement is set back to the pavement line rather than dropped.
      const fitted = B.pushBehind(ringB, (x, z) => {
        field.query(x, z, tmp);
        const p = route.position(tmp.along);
        return { distance: tmp.distance, x: p.x, z: p.z };
      }, ROAD_HALF + 3.0, 4.5);
      if (!fitted) continue;
      ringB = fitted;
    }
    for (let i = 0; i < ringB.length; i += 2) {
      const j = (i + 2) % ringB.length;
      const len = Math.hypot(ringB[j] - ringB[i], ringB[j + 1] - ringB[i + 1]);
      for (let t = 0; t <= len; t += 2) occupied.add(occKey(ringB[i] + ((ringB[j] - ringB[i]) * t) / (len || 1), ringB[i + 1] + ((ringB[j + 1] - ringB[i + 1]) * t) / (len || 1)));
    }
    cityList.push({ ring: ringB, h: b.h, k: b.k, n: b.n });
    built++;
  }
  group.userData.buildingCount = built;
  const roadsForFronts = data.roads.map((rd) => {
    const kind = rd.k === 'pedestrian' ? 'cobbles' : rd.k === 'footway' || rd.k === 'cycleway' ? 'paving' : 'asphalt';
    return { p: W(rd.p), w: kind === 'asphalt' ? Math.max(3.2, rd.w * 1.5) : Math.max(2, rd.w), weight: kind === 'asphalt' ? 1 : kind === 'cobbles' ? 0.9 : 0.35 };
  });
  // The named bars and wall towers are built by landmarks.js from their footprints.
  const city = B.cityBuildings(cityList, { q, y: Y0, roads: roadsForFronts, roadHalf: ROAD_HALF, routeDistance: (x, z) => field.query(x, z, tmp).distance, inside: (x, z) => pointInPolygon(x, z, ring), walls: data.walls.map(W), routeRing: ring });
  group.add(city.group);

  // ---- City walls on their ramparts (cut where the route passes through) ----
  let ccx = 0, ccz = 0;
  for (let i = 0; i < ring.length; i += 2) {
    ccx += ring[i];
    ccz += ring[i + 1];
  }
  ccx /= ring.length / 2;
  ccz /= ring.length / 2;
  const rampartParts = [];
  const gates = [];
  const wallRuns = [];
  for (const wl of data.walls) {
    const pts = W(wl);
    // Split into runs that stay clear of the route.
    let run = [], clear = [];
    const flush = () => {
      if (run.length >= 4) {
        // Which side faces out of the city? (The parapet and battlements stand on the outer edge.)
        const k = Math.floor(run.length / 4) * 2;
        const k2 = Math.min(run.length - 2, k + 2), k1 = k2 - 2;
        const dx = run[k2] - run[k1], dz = run[k2 + 1] - run[k1 + 1];
        const out = (-dz) * (run[k1] - ccx) + dx * (run[k1 + 1] - ccz) > 0 ? 1 : -1;
        rampartParts.push(rampart(run, clear));
        wallRuns.push({ run, out, clear }); // [buildings-pass] the wall itself is built by landmarks.cityWalls
      }
      run = [];
      clear = [];
    };
    for (let i = 0; i < pts.length; i += 2) {
      const d = field.query(pts[i], pts[i + 1], tmp).distance;
      if (d < ROAD_HALF + 4) {
        if (run.length) gates.push({ x: pts[i], z: pts[i + 1], along: tmp.along });
        flush();
      } else {
        run.push(pts[i], pts[i + 1]);
        clear.push(d);
      }
    }
    flush();
  }
  /** The grassy bank under a run of wall, narrowed where the road comes close. */
  function rampart(run, clear) {
    const n = run.length / 2;
    const pos = [], uv = [], idx = [];
    let along = 0;
    for (let i = 0; i < n; i++) {
      const pi = Math.max(0, i - 1), ni = Math.min(n - 1, i + 1);
      let dx = run[ni * 2] - run[pi * 2], dz = run[ni * 2 + 1] - run[pi * 2 + 1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      if (i > 0) along += Math.hypot(run[i * 2] - run[i * 2 - 2], run[i * 2 + 1] - run[i * 2 - 1]);
      const half = Math.max(2.2, Math.min(13, clear[i] - ROAD_HALF - 3.2));
      const top = Math.min(4.2, half - 0.7);
      const x = run[i * 2], z = run[i * 2 + 1];
      for (const [o, y] of [[-half, -0.1], [-top, 3.0], [top, 3.0], [half, -0.1]]) {
        pos.push(x - dz * o, Y0 + y, z + dx * o);
        uv.push(o / 7, along / 7);
      }
      if (i > 0) {
        for (let j = 0; j < 3; j++) {
          const a = (i - 1) * 4 + j, b = i * 4 + j;
          idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  group.add(L.cityWalls(wallRuns, { y0: Y0, q })); // [buildings-pass]
  if (rampartParts.length) group.add(receiving(new THREE.Mesh(C.mergeAll(rampartParts), C.groundMaterial({ map: T.grassTexture(), color: '#e4f2c8', roughness: 1, side: THREE.DoubleSide }))));

  // ---- York Minster and Clifford's Tower ----
  group.add(minster(q));
  group.add(cliffordsTower(data, q));

  // ---- Bridges: where the route rises over the Ouse ----
  const spans = [];
  let spanStart = null;
  for (let d = 0; d <= route.length; d += 2) {
    const up = route.elevation(d) > Y0 + 0.25;
    if (up && spanStart == null) spanStart = d;
    if (!up && spanStart != null) {
      spans.push([spanStart, d]);
      spanStart = null;
    }
  }
  const onBridge = (d) => spans.some(([a, b]) => d > a - 6 && d < b + 6);
  const railMat = (c) => std({ map: T.railingTexture(c), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.3 });
  const sideOff = ROAD_HALF + 2.72;
  const stoneSides = [], piers = [];
  spans.forEach(([a, b], bi) => {
    // The part of the span that is over water.
    let wa = null, wb = null;
    for (let d = a; d <= b; d += 2) {
      const p = route.position(d);
      if (inWater(p.x, p.z)) {
        if (wa == null) wa = d;
        wb = d;
      }
    }
    const paint = bi % 2 === 0 ? ['#ece4c6', '#2f5d8a', '#27507a'] : ['#e6dcc0', '#7a2a2a', '#1f3d2c'];
    for (const s of [-1, 1]) {
      const stone = (from, to) => {
        if (to - from < 2) return;
        stoneSides.push(C.routeWall(route, { lateral: s * sideOff, from, to, bottom: () => Y0 - 0.1, top: (d, y) => y + 0.55, uvLength: 4, uvHeight: 4 }));
        stoneSides.push(C.ribbon(route, { left: s * sideOff - 0.22, right: s * sideOff + 0.22, lift: 0.55, from, to, uvLength: 4, uvAcross: 0.1 }));
      };
      if (wa == null) stone(a, b);
      else {
        stone(a, wa - 2);
        stone(wb + 2, b);
        const arch = new THREE.Mesh(C.routeWall(route, { lateral: s * sideOff, from: wa - 2, to: wb + 2, bottom: () => YW - 0.2, top: (d, y) => y + 0.3, uvSpan: true }), std({ map: T.bridgeArchTexture(paint[0], paint[1]), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.2 }));
        group.add(shadowy(arch));
        // Stone abutment towers at each end of the iron span.
        for (const d of [wa - 3.5, wb + 3.5]) {
          const p = route.position(d, s * (sideOff + 0.5));
          const hgt = p.y + 2.6 - (YW - 1);
          piers.push(uvBoxAt(2.6, hgt, 3.4, p.x, YW - 1 + hgt / 2, p.z, -p.heading));
          piers.push(uvBoxAt(3.0, 0.3, 3.8, p.x, p.y + 2.6, p.z, -p.heading));
          piers.push(new THREE.ConeGeometry(1.9, 1.3, 4).rotateY(Math.PI / 4 - p.heading).translate(p.x, p.y + 3.4, p.z));
        }
      }
      const rail = new THREE.Mesh(C.routeWall(route, { lateral: s * (sideOff - 0.05), from: wa == null ? a : wa - 2, to: wa == null ? b : wb + 2, bottom: (d, y) => y + (wa == null ? 0.55 : 0.2), top: (d, y) => y + (wa == null ? 1.35 : 1.3), uvLength: 2, uvHeight: wa == null ? 0.8 : 1.1 }), railMat(paint[2]));
      group.add(rail);
    }
  });
  function uvBoxAt(w, h, d, x, y, z, rot) {
    return uvBox(w, h, d, w / 4, d / 4, 0, h / 4).rotateY(rot).translate(x, y, z);
  }
  if (stoneSides.length) group.add(shadowy(new THREE.Mesh(C.mergeAll(stoneSides), limestone2)));
  if (piers.length) group.add(shadowy(new THREE.Mesh(C.mergeAll(piers), limestone)));

  // ---- Trees in parks, street trees along the route; lamp posts and people ----
  const treeSpots = [];
  for (const g of greens) {
    const bb = bbox(g);
    const area = (bb.maxX - bb.minX) * (bb.maxZ - bb.minZ);
    const count = Math.min(80, Math.floor((area / 260) * q.treeDensity));
    for (let k = 0; k < count; k++) {
      const x = bb.minX + r() * (bb.maxX - bb.minX), z = bb.minZ + r() * (bb.maxZ - bb.minZ);
      if (!pointInPolygon(x, z, g) || inWater(x, z)) continue;
      if (field.query(x, z, tmp).distance < ROAD_HALF + 6) continue;
      if (occupied.has(occKey(x, z))) continue;
      treeSpots.push({ x, z, y: Y0, kind: 'broad', s: 0.9 + r() * 0.7, rot: r() * 6.3, hue: r() - 0.5, sx: 0.9 + r() * 0.25, sy: 0.9 + r() * 0.3 });
    }
  }
  const nearGate = (d) => gates.some((g) => Math.abs(g.along - d) < 22);
  const blocked = (x, z, rad) => {
    for (let dx = -rad; dx <= rad; dx += 3) for (let dz = -rad; dz <= rad; dz += 3) if (occupied.has(occKey(x + dx, z + dz))) return true;
    return false;
  };
  const nearWall = (x, z) => {
    for (const w of wallRuns) for (let i = 0; i < w.run.length; i += 2) if (Math.abs(w.run[i] - x) < 6 && Math.abs(w.run[i + 1] - z) < 6) return true;
    return false;
  };
  const streetTrees = [];
  for (let d = 90; d < route.length - 90; d += 34) {
    const s = Math.floor(d / 34) % 2 ? 1 : -1;
    if (onBridge(d) || nearGate(d)) continue;
    const p = route.position(d + 9, s * (ROAD_HALF + 1.7));
    if (blocked(p.x, p.z, 3) || nearWall(p.x, p.z) || inWater(p.x, p.z)) continue;
    streetTrees.push({ x: p.x, z: p.z, y: Y0 + 0.4, kind: 'broad', s: 0.55 + r() * 0.2, rot: r() * 6.3, hue: r() * 0.6 - 0.1, sx: 0.85, sy: 1.25 });
  }
  group.add(C.trees([...streetTrees, ...treeSpots.slice(0, q.maxTrees)], { shadows: q.shadows, maxDistance: 1200, lod: 200 }));

  const lamps = [], people = [];
  for (let d = 0; d < route.length; d += 30) {
    for (const s of [-1, 1]) {
      const p = route.position(d + (s > 0 ? 15 : 0), s * (ROAD_HALF + 0.75));
      if (nearGate(d + (s > 0 ? 15 : 0))) continue;
      lamps.push({ x: p.x, y: p.y + 0.19, z: p.z, rot: -p.heading });
    }
  }
  for (let d = -70; d <= 70; d += 1.1) {
    for (const s of [-1, 1]) {
      if (r() < 0.3) continue;
      const p = route.position(d, s * (ROAD_HALF + 1.3 + r() * 1.2));
      people.push({ x: p.x, y: p.y + 0.19, z: p.z, rot: -p.heading + (s > 0 ? Math.PI / 2 : -Math.PI / 2) + (r() - 0.5) * 0.6 });
    }
  }
  for (let d = 150; d < route.length - 80; d += 110 + r() * 90) {
    const s = r() < 0.5 ? -1 : 1;
    const n = 2 + Math.floor(r() * 5);
    for (let k = 0; k < n; k++) {
      const p = route.position(d + k * 1.1, s * (ROAD_HALF + 1.1 + r() * 1.3));
      people.push({ x: p.x, y: p.y + 0.19, z: p.z, rot: -p.heading + (s > 0 ? Math.PI / 2 : -Math.PI / 2) + (r() - 0.5) });
    }
  }
  group.add(C.lampPosts(lamps, { shadows: q.shadows }));
  group.add(C.spectators(people));
  // Crowd barriers with sponsor boards along the finish straight.
  const barrierMat = std({ map: T.textTexture('SPINDOWN  ·  YORK  ·  SPINDOWN', { width: 1024, height: 64, bg: '#1d7f46', font: '700 40px Arial' }), color: '#b4b4b4', roughness: 0.9, envMapIntensity: 0.3, side: THREE.DoubleSide });
  const barriers = [];
  for (const s of [-1, 1]) barriers.push(C.routeWall(route, { lateral: s * (ROAD_HALF + 0.5), from: -60, to: 60, bottom: (d, y) => y + 0.22, top: (d, y) => y + 1.12, uvLength: 16 * s, uvHeight: 0.9 }));
  group.add(shadowy(new THREE.Mesh(C.mergeAll(barriers), barrierMat)));

  // Daffodils on the rampart banks, as every spring.
  {
    const daffs = [];
    const qq = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    for (const { run, clear } of wallRuns) {
      for (let i = 0; i < run.length - 2; i += 2) {
        const ax = run[i], az = run[i + 1], bx = run[i + 2], bz = run[i + 3];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.1) continue;
        const nx = -(bz - az) / len, nz = (bx - ax) / len;
        const half = Math.max(2.2, Math.min(13, Math.min(clear[i / 2], clear[i / 2 + 1]) - ROAD_HALF - 3.2));
        const top = Math.min(4.2, half - 0.7);
        if (half - top < 3) continue;
        for (let t = 0; t < len; t += 1.1 / q.treeDensity) {
          const side = r() < 0.5 ? -1 : 1, f = 0.12 + r() * 0.8;
          const off = top + (half - top) * f;
          const x = ax + ((bx - ax) * t) / len + nx * off * side, z = az + ((bz - az) * t) / len + nz * off * side;
          qq.setFromAxisAngle(up, r() * 6.28);
          const sc = 0.65 + r() * 0.4;
          daffs.push({ matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, Y0 + 3.0 - 3.1 * f - 0.03, z), qq, new THREE.Vector3(sc, sc, sc)) });
        }
      }
    }
    const parts = [];
    for (const [dx, dz] of [[0, 0], [0.14, 0.09], [-0.11, 0.12]]) {
      parts.push(C.tint(new THREE.CylinderGeometry(0.01, 0.012, 0.34, 3, 1, true).translate(dx, 0.17, dz), '#4c7a2a'));
      parts.push(C.tint(new THREE.ConeGeometry(0.055, 0.03, 5).rotateX(Math.PI * 0.6).translate(dx, 0.35, dz - 0.01), '#ffd21f'));
      parts.push(C.tint(new THREE.CylinderGeometry(0.022, 0.016, 0.05, 5, 1, true).rotateX(Math.PI * 0.6 - Math.PI / 2).translate(dx, 0.345, dz - 0.045), '#ff9a1f'));
    }
    parts.push(C.tint(new THREE.ConeGeometry(0.1, 0.3, 4, 1, true).translate(0.02, 0.15, 0.04), '#5b8c32'));
    group.add(C.chunked(C.mergeAll(parts, { colour: true, uv: false }), std({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }), daffs, { shadows: false, maxDistance: 110, chunk: 70 }));
  }

  // Gatehouses ("bars") where the route passes through the walls.
  if (gates.length) {
    // [buildings-pass] No invented gatehouse where a real bar stands close by (Bootham Bar at St Leonard's Place).
    const parts = gates.filter((g) => !city.nearBar(route.position(g.along), 60)).map((g) => gatehouse(route, g.along));
    if (parts.length) group.add(shadowy(new THREE.Mesh(C.mergeAll(parts), limestone)));
  }

  // ---- Start/finish and zone arches ----
  group.add(C.arch(route, 0, 'SPINDOWN  ·  YORK', { width: 2 * ROAD_HALF + 1.4, height: 6 }));
  for (const s of route.zones) {
    group.add(C.arch(route, s.from, `⚡ ${s.name.toUpperCase()}`, { width: 2 * ROAD_HALF + 1.4, colour: '#0a6cc2', height: 6 }));
    group.add(C.arch(route, s.to, 'FINISH ▸', { width: 2 * ROAD_HALF + 1.4, colour: '#333', height: 6 }));
  }

  const update = (t) => {
    waterNormal.offset.set(t * 0.012, t * 0.02);
  };
  return { group, heightAt: () => Y0, roadHalf: ROAD_HALF, buildingCount: built, update };
}

/** A medieval gatehouse ("bar") straddling the route: a tower over an arch, with corner turrets. One geometry. */
function gatehouse(route, along) {
  const p = route.position(along);
  const w = 2 * ROAD_HALF + 1.6, depth = 8, side = 4.2, top = 13;
  const parts = [];
  for (const s of [-1, 1]) parts.push(uvBox(side, top, depth, side / 4, depth / 4, 0, top / 4).translate((s * (w + side)) / 2, top / 2, 0));
  // The stage over the road, with a rounded arch cut through it.
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 4.6);
  shape.lineTo(-w / 2, top);
  shape.lineTo(w / 2, top);
  shape.lineTo(w / 2, 4.6);
  shape.absarc(0, 4.6, w / 2, 0, Math.PI, false);
  const over = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 14 }).translate(0, 0, -depth / 2);
  const uv = over.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 4, uv.getY(i) / 4);
  parts.push(over);
  // Corner turrets (bartizans) and battlements.
  const tw = w / 2 + side - 0.4;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(new THREE.CylinderGeometry(1.25, 1.25, 4.6, 10).translate(sx * tw, top - 0.8, sz * (depth / 2 - 0.2)));
      parts.push(new THREE.CylinderGeometry(1.45, 1.25, 0.5, 10).translate(sx * tw, top + 1.6, sz * (depth / 2 - 0.2)));
      for (let k = 0; k < 6; k += 2) parts.push(new THREE.BoxGeometry(0.6, 0.7, 0.5).translate(1.2, 0.35, 0).rotateY((k / 6) * Math.PI * 2 + 0.4).translate(sx * tw, top + 1.85, sz * (depth / 2 - 0.2)));
    }
  }
  for (let x = -tw + 2.2; x <= tw - 2.2; x += 1.9) for (const z of [-depth / 2 + 0.3, depth / 2 - 0.3]) parts.push(new THREE.BoxGeometry(1.0, 0.9, 0.6).translate(x, top + 0.45, z));
  const g = C.mergeAll(parts);
  g.rotateY(-p.heading);
  g.translate(p.x, Y0 - 0.1, p.z);
  return g;
}

/** York Minster: built by landmarks.js with its real Gothic massing. [buildings-pass] */
function minster(q) {
  return L.minster(q, { y0: Y0 });
}

/** Clifford's Tower on its motte: built by landmarks.js. [buildings-pass] */
function cliffordsTower(data, q) {
  return L.cliffordsTower(data.landmarks.cliffordsTower, q, { y0: Y0 });
}
