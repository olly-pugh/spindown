// Roadside furniture, all procedural geometry with vertex colours (instanced wherever it repeats): field gates
// (timber five-bar and galvanised steel) and their posts, York's black heritage lamp posts, and the street
// and lane furniture of a British road (signs, bollards, benches, bins, railings, telegraph poles).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as F from './foliage.js';
import { hash2 } from '../../core/world/noise.js';

const V3 = THREE.Vector3;

/** Colours a geometry (vertex colours) and strips it to position/normal/color for merging. */
function paint(geo, hex, k = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex).multiplyScalar(k);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const k2 of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k2)) g.deleteAttribute(k2);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}
const merge = (list) => mergeGeometries(list, false);

/** A box from (x0, y0, z0) to (x1, y1, z1). */
const box = (x0, y0, z0, x1, y1, z1) => new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
/** A bar of square section `t` from a to b (in the xy plane at z). */
function bar(ax, ay, bx, by, t, d = t, z = 0) {
  const len = Math.hypot(bx - ax, by - ay);
  return new THREE.BoxGeometry(len, t, d).rotateZ(Math.atan2(by - ay, bx - ax)).translate((ax + bx) / 2, (ay + by) / 2, z);
}
/** A tube of radius r from a to b (in the xy plane at z). */
function tube(ax, ay, bx, by, r, z = 0, sides = 6) {
  const len = Math.hypot(bx - ax, by - ay);
  return new THREE.CylinderGeometry(r, r, len, sides, 1).rotateZ(Math.atan2(by - ay, bx - ax) - Math.PI / 2).translate((ax + bx) / 2, (ay + by) / 2, z);
}

// ---- Field gates -------------------------------------------------------------------------------------

/**
 * A gate leaf `w` metres wide, hinged at x = 0 and closing at x = w, in the xy plane (z across):
 *  - 'timber': a weathered five-bar gate with a heavy top rail, a diagonal brace and a middle stile;
 *  - 'metal': a galvanised tubular gate with a diagonal stay.
 */
export function gateLeaf(kind, w) {
  const parts = [];
  if (kind === 'metal') {
    const steel = '#9aa0a3';
    parts.push(paint(tube(0.04, 0.12, 0.04, 1.15, 0.03), steel));
    parts.push(paint(tube(w - 0.03, 0.12, w - 0.03, 1.12, 0.025), steel));
    parts.push(paint(tube(0.04, 1.1, w - 0.03, 1.1, 0.026), steel));
    for (const y of [0.2, 0.38, 0.56, 0.74, 0.92]) parts.push(paint(tube(0.04, y, w - 0.03, y, 0.012, 0, 5), steel, 0.95));
    parts.push(paint(tube(0.06, 0.2, w * 0.55, 1.1, 0.014, 0, 5), steel, 0.95));
    parts.push(paint(tube(w * 0.55, 0.2, w * 0.55, 1.1, 0.014, 0, 5), steel, 0.95));
  } else {
    const wood = '#7d6e5a';
    parts.push(paint(box(0, 0.12, -0.05, 0.11, 1.18, 0.05), wood, 0.95)); // hanging stile
    parts.push(paint(box(w - 0.09, 0.12, -0.04, w, 1.12, 0.04), wood, 0.95)); // shutting stile
    parts.push(paint(box(0.1, 1.04, -0.045, w - 0.08, 1.14, 0.045), wood, 1.05)); // top rail
    for (const y of [0.22, 0.42, 0.62, 0.83]) parts.push(paint(box(0.1, y, -0.018, w - 0.08, y + 0.085, 0.018), wood, 0.9 + y * 0.12));
    parts.push(paint(bar(0.12, 0.22, w * 0.62, 1.06, 0.075, 0.03, 0.03), wood, 0.88)); // brace
    parts.push(paint(box(w * 0.5 - 0.04, 0.2, -0.03, w * 0.5 + 0.04, 1.06, 0.03), wood, 0.92)); // middle stile
    // Hinges and a latch.
    for (const y of [0.3, 1.0]) parts.push(paint(box(-0.02, y, -0.06, 0.25, y + 0.03, 0.06), '#2a2a2a'));
    parts.push(paint(box(w - 0.14, 0.95, -0.05, w + 0.04, 0.99, 0.05), '#2a2a2a'));
  }
  return merge(parts);
}

/** A gatepost: a weathered limestone stoop, or a square timber post. Base at the origin. */
export function gatePost(kind = 'stone') {
  if (kind === 'timber') return merge([paint(box(-0.09, -0.3, -0.09, 0.09, 1.45, 0.09), '#5f5446'), paint(box(-0.1, 1.45, -0.1, 0.1, 1.5, 0.1), '#56493c')]);
  const g = new THREE.BoxGeometry(0.3, 1.85, 0.3, 1, 3, 1).translate(0, 0.62, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), k = 1 - (y + 0.3) * 0.06;
    p.setXYZ(i, p.getX(i) * k + Math.sin(y * 7 + p.getZ(i) * 9) * 0.012, y + (y > 1.4 ? Math.sin(p.getX(i) * 13) * 0.04 : 0), p.getZ(i) * k + Math.cos(y * 5 + p.getX(i) * 11) * 0.012);
  }
  g.computeVertexNormals();
  return paint(g, '#a7a49b');
}

/** Gate leaf geometry for the boundaries module: kind 'timber'|'metal', width class in metres. */
export function gateGeometry(kind, { width = 3.3 } = {}) {
  return gateLeaf(kind, width);
}

// ---- Street furniture models (vertex-coloured, base at the origin, front facing +z) --------------------

const IRON = '#1c1f21';
const GOLD = '#b08d3c';

/** York's black heritage lamp column: fluted base on a plinth, collars, ladder arms and a glazed lantern. */
export function heritageLamp() {
  const p = [];
  const lathe = (pts, hex, k = 1, seg = 10) => p.push(paint(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg), hex, k));
  // Plinth, fluted base and the shaft with its collars.
  lathe([[0.001, 0], [0.19, 0], [0.19, 0.08], [0.16, 0.1], [0.155, 0.16], [0.13, 0.2], [0.13, 0.82], [0.155, 0.86], [0.155, 0.92], [0.11, 0.97], [0.085, 1.05], [0.06, 1.15], [0.001, 1.15]], IRON, 1, 12);
  for (let k = 0; k < 8; k++) {
    // Flutes on the base: thin raised ribs.
    const a = (k / 8) * Math.PI * 2;
    p.push(paint(box(-0.012, 0.22, -0.012, 0.012, 0.8, 0.012).translate(Math.cos(a) * 0.132, 0, Math.sin(a) * 0.132), IRON, 1.15));
  }
  lathe([[0.05, 1.12], [0.05, 3.1], [0.065, 3.14], [0.065, 3.2], [0.05, 3.24], [0.045, 3.75], [0.07, 3.8], [0.07, 3.86], [0.001, 3.86]], IRON, 1, 8);
  // The ladder bar (lamplighters leant their ladders on it) with its ball ends.
  p.push(paint(box(-0.33, 3.36, -0.015, 0.33, 3.39, 0.015), IRON));
  for (const s of [-1, 1]) p.push(paint(new THREE.SphereGeometry(0.03, 6, 4).translate(s * 0.34, 3.375, 0), IRON));
  // Scrolls under the lantern (simplified as two curved struts).
  for (const s of [-1, 1]) p.push(paint(tube(0, 3.62, s * 0.16, 3.86, 0.012, 0, 5), IRON));
  // Lantern: a square glazed box narrowing to the base, a pyramid cap and a finial.
  p.push(paint(box(-0.13, 3.86, -0.13, 0.13, 3.9, 0.13), IRON));
  const glass = new THREE.CylinderGeometry(0.2, 0.14, 0.46, 4, 1, true).rotateY(Math.PI / 4).translate(0, 4.13, 0);
  p.push(paint(glass, '#e9e2bf', 0.9));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    p.push(paint(bar(0, 3.9, 0, 4.36, 0.025).rotateZ(0).translate(Math.cos(a) * 0.17, 0, Math.sin(a) * 0.17), IRON));
  }
  p.push(paint(box(-0.21, 4.35, -0.21, 0.21, 4.39, 0.21), IRON));
  p.push(paint(new THREE.ConeGeometry(0.27, 0.24, 4, 1).rotateY(Math.PI / 4).translate(0, 4.51, 0), IRON));
  p.push(paint(new THREE.SphereGeometry(0.04, 6, 5).translate(0, 4.66, 0), IRON));
  p.push(paint(new THREE.CylinderGeometry(0.008, 0.008, 0.14, 4).translate(0, 4.74, 0), IRON));
  return merge(p);
}

/** A park bench: black cast-iron ends with timber slats, 1.8 m long, facing +z. */
export function bench() {
  const p = [];
  const wood = '#6e4f33';
  for (const x of [-0.82, 0.82]) {
    // Cast-iron end: legs, arm and back upright.
    p.push(paint(bar(x, 0, x, 0.44, 0.06, 0.05, 0.22), IRON));
    p.push(paint(bar(x, 0, x, 0.44, 0.06, 0.05, -0.2), IRON));
    p.push(paint(box(x - 0.03, 0.42, -0.24, x + 0.03, 0.46, 0.26), IRON));
    p.push(paint(box(x - 0.03, 0.62, -0.02, x + 0.03, 0.66, 0.3), IRON)); // arm
    p.push(paint(box(x - 0.025, 0.46, 0.27, x + 0.025, 0.66, 0.31), IRON));
    p.push(paint(new THREE.BoxGeometry(0.05, 0.5, 0.05).rotateX(-0.25).translate(x, 0.7, -0.26), IRON));
  }
  for (let k = 0; k < 4; k++) p.push(paint(box(-0.9, 0.45, -0.22 + k * 0.12, 0.9, 0.48, -0.13 + k * 0.12), wood, 0.9 + (k % 2) * 0.12));
  for (let k = 0; k < 3; k++) p.push(paint(new THREE.BoxGeometry(1.8, 0.09, 0.025).rotateX(-0.25).translate(0, 0.6 + k * 0.13, -0.27 - k * 0.032), wood, 0.95 + (k % 2) * 0.1));
  return merge(p);
}

/** A York litter bin: black, with a gold band and a domed lid. */
export function litterBin() {
  const p = [];
  p.push(paint(new THREE.CylinderGeometry(0.25, 0.23, 0.82, 12).translate(0, 0.41, 0), IRON, 1.1));
  p.push(paint(new THREE.CylinderGeometry(0.257, 0.257, 0.06, 12).translate(0, 0.62, 0), GOLD));
  p.push(paint(new THREE.CylinderGeometry(0.27, 0.27, 0.05, 12).translate(0, 0.84, 0), IRON));
  p.push(paint(new THREE.SphereGeometry(0.26, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.4, 1).translate(0, 0.86, 0), IRON, 1.1));
  p.push(paint(box(-0.12, 0.66, 0.22, 0.12, 0.72, 0.27), '#0c0c0c')); // the slot
  return merge(p);
}

/** A cast-iron bollard: black, a gold band and a rounded cap. */
export function bollard() {
  const p = [];
  p.push(paint(new THREE.LatheGeometry([[0.001, 0], [0.12, 0], [0.11, 0.08], [0.085, 0.14], [0.08, 0.72], [0.095, 0.78], [0.095, 0.82], [0.075, 0.86], [0.04, 0.93], [0.001, 0.95]].map(([r, y]) => new THREE.Vector2(r, y)), 10), IRON, 1.1));
  p.push(paint(new THREE.CylinderGeometry(0.083, 0.083, 0.05, 10).translate(0, 0.66, 0), GOLD));
  return merge(p);
}

/** A wooden telegraph pole (8 m) with a crossarm and insulators; the wires hang from y 7.6 at x ±0.5. */
export function telegraphPole() {
  const p = [];
  const wood = '#5e5040';
  p.push(paint(new THREE.CylinderGeometry(0.1, 0.14, 8.4, 7).translate(0, 3.9, 0), wood));
  p.push(paint(box(-0.62, 7.5, -0.05, 0.62, 7.6, 0.05), wood, 0.9));
  for (const x of [-0.55, -0.2, 0.2, 0.55]) p.push(paint(new THREE.CylinderGeometry(0.025, 0.03, 0.12, 5).translate(x, 7.66, 0), '#e8e4d8'));
  // Step bolts up the pole and the cap.
  for (let k = 0; k < 6; k++) p.push(paint(box(-0.16, 2.5 + k * 0.45, -0.01, 0.16, 2.52 + k * 0.45, 0.01).rotateY(k * 1.57), '#3a3a3a'));
  p.push(paint(new THREE.CylinderGeometry(0.105, 0.105, 0.04, 7).translate(0, 8.12, 0), '#2a2a2a'));
  return merge(p);
}

/** A sign post: galvanised tube `h` metres tall. */
export function signPost(h = 2.4) {
  return merge([paint(new THREE.CylinderGeometry(0.038, 0.038, h + 0.3, 8).translate(0, h / 2 - 0.15, 0), '#a7abac'), paint(new THREE.CylinderGeometry(0.04, 0.04, 0.02, 8).translate(0, h, 0), '#8f9395')]);
}

// ---- Road signs ----------------------------------------------------------------------------------------

/** Cell order in the 4 × 2 sign atlas (each cell 256 px; faces in the top row of each pair, backs below). */
export const SIGNS = ['bendLeft', 'bendRight', 'steepUp', 'steepDown', 'limit30', 'nsl', 'passing', 'limit20'];

/**
 * UK road sign faces on a canvas atlas (8 faces in a 4 × 4 grid: rows 0–1 faces, rows 2–3 the grey backs of
 * the same shapes), drawn to the Traffic Signs Manual's look: red-bordered triangles, red rings, the black
 * slash of the national speed limit, the white oblong of a passing place. Returns {texture, rect(name, back)}.
 */
export function signAtlas(steepPercent = 16) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = 4 * S;
  c.height = 4 * S;
  const g = c.getContext('2d');
  const red = '#c8102e';
  const triangle = (x, y, inner) => {
    g.beginPath();
    g.moveTo(x + S / 2, y + 14);
    g.lineTo(x + S - 10, y + S - 30);
    g.lineTo(x + 10, y + S - 30);
    g.closePath();
    g.lineJoin = 'round';
    g.fillStyle = red;
    g.fill();
    g.lineWidth = 16;
    g.strokeStyle = red;
    g.stroke();
    g.beginPath();
    g.moveTo(x + S / 2, y + 52);
    g.lineTo(x + S - 46, y + S - 50);
    g.lineTo(x + 46, y + S - 50);
    g.closePath();
    g.fillStyle = '#ffffff';
    g.fill();
    g.save();
    g.translate(x, y);
    inner();
    g.restore();
  };
  const ring = (x, y, inner) => {
    g.beginPath();
    g.arc(x + S / 2, y + S / 2, S / 2 - 8, 0, Math.PI * 2);
    g.fillStyle = red;
    g.fill();
    g.beginPath();
    g.arc(x + S / 2, y + S / 2, S / 2 - 34, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.save();
    g.translate(x, y);
    inner();
    g.restore();
  };
  const cells = {};
  SIGNS.forEach((name, i) => {
    const x = (i % 4) * S, y = Math.floor(i / 4) * S;
    cells[name] = [i % 4, Math.floor(i / 4)];
    g.fillStyle = '#111';
    g.strokeStyle = '#111';
    if (name === 'bendLeft' || name === 'bendRight') {
      triangle(x, y, () => {
        const s = name === 'bendLeft' ? -1 : 1;
        g.lineWidth = 16;
        g.lineCap = 'butt';
        g.beginPath();
        g.moveTo(128 - s * 8, 186);
        g.lineTo(128 - s * 8, 150);
        g.quadraticCurveTo(128 - s * 8, 112, 128 + s * 26, 104);
        g.stroke();
        g.beginPath();
        g.moveTo(128 + s * 50, 100);
        g.lineTo(128 + s * 18, 82);
        g.lineTo(128 + s * 22, 122);
        g.closePath();
        g.fill();
      });
    } else if (name === 'steepUp' || name === 'steepDown') {
      triangle(x, y, () => {
        // The black gradient wedge and the percentage.
        g.beginPath();
        if (name === 'steepUp') {
          g.moveTo(70, 196);
          g.lineTo(186, 196);
          g.lineTo(186, 150);
        } else {
          g.moveTo(70, 150);
          g.lineTo(70, 196);
          g.lineTo(186, 196);
        }
        g.closePath();
        g.fill();
        g.font = '700 44px Arial, Helvetica, sans-serif';
        g.textAlign = 'center';
        g.fillText(`${steepPercent}%`, 128, 142);
      });
    } else if (name === 'limit30' || name === 'limit20') {
      ring(x, y, () => {
        g.font = '700 112px Arial, Helvetica, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(name === 'limit30' ? '30' : '20', 128, 134);
      });
    } else if (name === 'nsl') {
      g.beginPath();
      g.arc(x + S / 2, y + S / 2, S / 2 - 8, 0, Math.PI * 2);
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = '#222';
      g.stroke();
      g.save();
      g.beginPath();
      g.arc(x + S / 2, y + S / 2, S / 2 - 8, 0, Math.PI * 2);
      g.clip();
      g.translate(x + S / 2, y + S / 2);
      g.rotate(-Math.PI / 4 - 0.15);
      g.fillStyle = '#111';
      g.fillRect(-S, -22, 2 * S, 44);
      g.restore();
    } else if (name === 'passing') {
      g.fillStyle = '#ffffff';
      g.fillRect(x + 18, y + 58, S - 36, S - 116);
      g.lineWidth = 6;
      g.strokeStyle = '#111';
      g.strokeRect(x + 26, y + 66, S - 52, S - 132);
      g.fillStyle = '#111';
      g.font = '700 38px Arial, Helvetica, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('Passing', x + S / 2, y + 108);
      g.fillText('Place', x + S / 2, y + 150);
    }
    // The back: the same shape in galvanised grey (copied through the face's alpha).
    g.save();
    g.globalCompositeOperation = 'source-over';
    g.drawImage(c, x, y, S, S, x, y + 2 * S, S, S);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = '#8d9193';
    g.fillRect(x, y + 2 * S, S, S);
    g.restore();
  });
  const texture = F.foliageTexture(c, { threshold: 0.5, grid: [4, 4] });
  const inset = 2 / (4 * S);
  const rect = (name, back = false) => {
    const [col, row0] = cells[name];
    const row = row0 + (back ? 2 : 0);
    return { u0: col / 4 + inset, u1: (col + 1) / 4 - inset, v0: 1 - (row + 1) / 4 + inset, v1: 1 - row / 4 - inset };
  };
  return { texture, rect };
}

/** A sign plate `w` m square (centre at y = h on a post at the origin), front facing +z, back facing −z. */
export function signPlate(atlas, name, w = 0.9, h = 2.0) {
  const quad = (r, z, flip) => {
    const g = new THREE.PlaneGeometry(w, w);
    if (flip) g.rotateY(Math.PI);
    g.translate(0, h, z);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, r.u0 + (flip ? 1 - uv.getX(i) : uv.getX(i)) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
    return g;
  };
  return mergeGeometries([quad(atlas.rect(name), 0.045, false), quad(atlas.rect(name, true), 0.035, true)], false);
}

// ---- Placing it ----------------------------------------------------------------------------------------

/** Instanced copies of geo in square chunks, with the culling userData the scene uses (cullChunks). */
function instanced(geo, mat, matrices, { chunk = 250, maxDistance = 400, shadows = true } = {}) {
  const group = new THREE.Group();
  const cells = new Map();
  const v = new V3();
  for (const m of matrices) {
    v.setFromMatrixPosition(m);
    const k = `${Math.floor(v.x / chunk)},${Math.floor(v.z / chunk)}`;
    (cells.get(k) ?? cells.set(k, []).get(k)).push(m);
  }
  for (const list of cells.values()) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.computeBoundingSphere();
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.userData.centre = mesh.boundingSphere.center.clone();
    mesh.userData.radius = mesh.boundingSphere.radius;
    mesh.userData.maxDistance = maxDistance;
    mesh.userData.minDistance = 0;
    group.add(mesh);
  }
  return group;
}

const furnitureMat = () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.15 });

/** York's heritage lamp posts at points [{x, y, z, rot}], instanced in chunks. */
export function lampPosts(points, { shadows = false } = {}) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new V3(0, 1, 0);
  const items = points.map((p) => m.clone().compose(new V3(p.x, p.y, p.z), q.setFromAxisAngle(up, p.rot ?? 0), new V3(1, 1, 1)));
  return instanced(heritageLamp(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2 }), items, { chunk: 300, maxDistance: 450, shadows });
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Street and lane furniture along a route. opts: {world: 'york'|'dales', roadHalf (m), ground(x, z, d) → y,
 * avoid(d) → true where nothing should stand (bridges, gateways, the finish), q (quality preset)}.
 *  - York: black litter bins, benches, cast-iron bollards, black railings along stretches of pavement, and
 *    30 mph repeater signs.
 *  - Dales: warning signs before sharp bends and steep hills (with the steepest gradient of the course), the
 *    national speed limit, passing-place signs on single-track lanes, and a wooden telegraph line with its
 *    wires sagging between the poles.
 */
export function roadside(route, opts) {
  const group = new THREE.Group();
  group.name = 'roadside';
  const { world, roadHalf, ground, avoid = () => false } = opts;
  const q = opts.q;
  const shadows = q ? !!q.shadows : opts.shadows !== false;
  const L = route.length;
  const p = {};
  const up = new V3(0, 1, 0);
  const at = (d, lateral, rot, s = 1, dy = 0) => {
    route.position(d, lateral, p);
    const y = ground(p.x, p.z, d) + dy;
    return new THREE.Matrix4().compose(new V3(p.x, y, p.z), new THREE.Quaternion().setFromAxisAngle(up, rot), new V3(s, s, s));
  };
  // Facing riders coming along the road (front +z towards them), or facing the road from either side.
  const facing = (d) => -route.heading(d);
  const facingRoad = (d, side) => (side < 0 ? Math.PI / 2 : -Math.PI / 2) - route.heading(d);
  const mat = furnitureMat();
  const signs = { list: [], percent: 10 };
  const sign = (d, name, side = -1, h = 2.0, w = 0.9) => {
    if (avoid(d)) return;
    signs.list.push({ d, name, side, h, w });
  };

  if (world === 'york') {
    const bins = [], benches = [], bollards = [];
    for (let d = 37; d < L - 20; d += 140) {
      const side = Math.floor(d / 140) % 2 ? 1 : -1;
      if (!avoid(d)) bins.push(at(d, side * (roadHalf + 0.95), facingRoad(d, side)));
    }
    for (let d = 120; d < L - 40; d += 260) {
      const side = Math.floor(d / 260) % 2 ? -1 : 1;
      if (!avoid(d) && !avoid(d + 2) && !avoid(d - 2)) benches.push(at(d, side * (roadHalf + 2.35), facingRoad(d, side)));
    }
    for (let d = 200; d < L - 40; d += 330) {
      for (let k = 0; k < 3; k++) if (!avoid(d + k * 1.5)) bollards.push(at(d + k * 1.5, roadHalf + 0.45, facing(d)));
    }
    group.add(instanced(litterBin(), mat, bins, { maxDistance: 300, shadows }));
    group.add(instanced(bench(), mat, benches, { maxDistance: 300, shadows }));
    group.add(instanced(bollard(), mat, bollards, { maxDistance: 250, shadows }));
    group.add(railings(route, { roadHalf, ground, avoid, shadows }));
    for (let d = 300; d < L - 100; d += 520) sign(d, 'limit30', -1, 2.1, 0.75);
  } else {
    // Sharp bends: a warning sign on the nearside verge about 70 m before each.
    let last = -1e9;
    for (let d = 0; d < L; d += 8) {
      const turn = wrapAngle(route.heading(d + 35) - route.heading(d - 15));
      if (Math.abs(turn) > 0.4 && d - last > 220) {
        sign((d - 70 + L) % L, turn < 0 ? 'bendLeft' : 'bendRight');
        last = d;
      }
    }
    // Steep hills, up and down: at the foot (or brow) of each sustained steep stretch.
    let steepest = 0;
    for (let d = 0; d < L; d += 10) steepest = Math.max(steepest, Math.abs(route.elevation(d + 50) - route.elevation(d)) / 50);
    signs.percent = Math.max(10, Math.round(steepest * 100));
    let lastUp = -1e9, lastDown = -1e9;
    for (let d = 0; d < L; d += 10) {
      const ahead = (route.elevation(d + 80) - route.elevation(d)) / 80, before = (route.elevation(d) - route.elevation(d - 60)) / 60;
      if (ahead > 0.08 && before < 0.05 && d - lastUp > 600) {
        sign((d - 40 + L) % L, 'steepUp');
        lastUp = d;
      }
      if (ahead < -0.08 && before > -0.05 && d - lastDown > 600) {
        sign((d - 40 + L) % L, 'steepDown');
        lastDown = d;
      }
    }
    // The national speed limit where the lane leaves the start (or the village).
    for (let d = 150; d < L; d += 10) {
      if (!avoid(d) && !avoid(d - 30)) {
        sign(d, 'nsl', -1, 2.0, 0.75);
        break;
      }
    }
    // Single-track lanes have passing places, each with its white sign.
    if (roadHalf < 2.7) for (let d = 250; d < L - 100; d += 380) sign(d, 'passing', Math.floor(d / 380) % 2 ? 1 : -1, 1.7, 0.75);
    group.add(telegraphLine(route, { roadHalf, ground, avoid, shadows }));
  }

  // Signs: posts and plates (the plates alpha-tested on the sign atlas).
  if (signs.list.length) {
    const atlas = signAtlas(signs.percent);
    const plateMat = new THREE.MeshStandardMaterial({ map: atlas.texture, alphaTest: 0.5, roughness: 0.45, metalness: 0.1 });
    const posts = [];
    const byName = new Map();
    for (const s of signs.list) {
      const lateral = s.side * (roadHalf + (world === 'york' ? 0.55 : 0.9));
      posts.push(at(s.d, lateral, facing(s.d), 1, 0));
      (byName.get(s.name) ?? byName.set(s.name, []).get(s.name)).push({ m: at(s.d, lateral, facing(s.d), 1, 0), s });
    }
    group.add(instanced(signPost(2.4), mat, posts, { maxDistance: 400, shadows }));
    for (const [name, list] of byName) {
      const { h, w } = list[0].s;
      group.add(instanced(signPlate(atlas, name, w, h + w / 2 - 0.05), plateMat, list.map((x) => x.m), { maxDistance: 400, shadows }));
    }
  }
  group.userData.signs = signs.list.map((s) => ({ d: Math.round(s.d), name: s.name, side: s.side }));
  return group;
}

/** A wooden telegraph line along the left of the road: poles about every 60 m, four wires sagging between them. */
function telegraphLine(route, { roadHalf, ground, avoid, shadows }) {
  const group = new THREE.Group();
  const L = route.length;
  const poles = [];
  const p = {};
  const lateral = -(roadHalf + 4.2);
  for (let d = 30; d < L - 30; d += 58 + hash2(Math.floor(d), 3, 61) * 8) {
    if (avoid(d)) {
      poles.push(null);
      continue;
    }
    route.position(d, lateral, p);
    const h = route.heading(d);
    poles.push({ x: p.x, y: ground(p.x, p.z, d), z: p.z, h });
  }
  const mats = [];
  const wire = [];
  const up = new V3(0, 1, 0);
  poles.forEach((a, i) => {
    if (!a) return;
    mats.push(new THREE.Matrix4().compose(new V3(a.x, a.y - 0.3, a.z), new THREE.Quaternion().setFromAxisAngle(up, -a.h), new V3(1, 1, 1)));
    const b = poles[i + 1];
    if (!b) return;
    for (const off of [-0.55, -0.2, 0.2, 0.55]) {
      const ax = a.x + Math.cos(a.h) * off, az = a.z + Math.sin(a.h) * off, ay = a.y - 0.3 + 7.72;
      const bx = b.x + Math.cos(b.h) * off, bz = b.z + Math.sin(b.h) * off, by = b.y - 0.3 + 7.72;
      const span = Math.hypot(bx - ax, bz - az), sag = 0.012 * span;
      const n = 10;
      for (let k = 0; k < n; k++) {
        for (const t of [k / n, (k + 1) / n]) wire.push(ax + (bx - ax) * t, ay + (by - ay) * t - 4 * sag * t * (1 - t), az + (bz - az) * t);
      }
    }
  });
  group.add(instanced(telegraphPole(), furnitureMat(), mats, { maxDistance: 900, shadows }));
  if (wire.length) {
    // Wires as 1-pixel lines: thin at any distance, never a flickering sub-pixel tube.
    const cells = new Map();
    for (let i = 0; i < wire.length; i += 6) {
      const k = `${Math.floor(wire[i] / 400)},${Math.floor(wire[i + 2] / 400)}`;
      const list = cells.get(k) ?? cells.set(k, []).get(k);
      for (let j = 0; j < 6; j++) list.push(wire[i + j]);
    }
    const lineMat = new THREE.LineBasicMaterial({ color: '#2b2b2b', transparent: true, opacity: 0.85 });
    for (const list of cells.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
      g.computeBoundingSphere();
      group.add(new THREE.LineSegments(g, lineMat));
    }
  }
  return group;
}

/** Black cast-iron railings with spear-headed bars along stretches of the back of the pavement. */
function railings(route, { roadHalf, ground, avoid, shadows }) {
  const L = route.length;
  const lateral = roadHalf + 2.62;
  const cells = new Map();
  const p = {};
  const add = (geo, x, z) => {
    const k = `${Math.floor(x / 150)},${Math.floor(z / 150)}`;
    (cells.get(k) ?? cells.set(k, []).get(k)).push(geo);
  };
  for (let block = 0; block * 120 < L; block++) {
    for (const side of [-1, 1]) {
      if (hash2(block, side, 71) > 0.28) continue;
      const from = block * 120 + 10 + hash2(block, side, 72) * 40, to = Math.min(L - 5, from + 30 + hash2(block, side, 73) * 45);
      const parts = [];
      let anchor = null;
      for (let d = from; d < to; d += 0.13) {
        if (avoid(d)) continue;
        route.position(d, side * lateral, p);
        const y = ground(p.x, p.z, d);
        anchor ??= [p.x, p.z];
        const post = Math.abs(((d - from) % 2.4)) < 0.13;
        const h = post ? 1.15 : 1.05;
        parts.push(paint(new THREE.BoxGeometry(post ? 0.055 : 0.018, h, post ? 0.055 : 0.018).translate(p.x, y + h / 2, p.z), IRON));
        if (!post) parts.push(paint(new THREE.ConeGeometry(0.022, 0.07, 4).translate(p.x, y + h + 0.03, p.z), IRON));
      }
      // Top and bottom rails, following the road in 2 m pieces.
      for (let d = from; d < to - 0.5; d += 2) {
        if (avoid(d) || avoid(d + 2)) continue;
        const a = route.position(d, side * lateral), b = route.position(Math.min(to, d + 2), side * lateral);
        const ya = ground(a.x, a.z, d), yb = ground(b.x, b.z, d + 2);
        for (const hh of [0.12, 0.92]) {
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          const g = new THREE.BoxGeometry(len, 0.035, 0.022).rotateZ(Math.atan2(yb - ya, len)).rotateY(Math.atan2(-(b.z - a.z), b.x - a.x)).translate((a.x + b.x) / 2, (ya + yb) / 2 + hh, (a.z + b.z) / 2);
          parts.push(paint(g, IRON));
        }
      }
      if (parts.length && anchor) add(merge(parts), anchor[0], anchor[1]);
    }
  }
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2 });
  for (const list of cells.values()) {
    const g = merge(list);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.userData.centre = g.boundingSphere.center.clone();
    mesh.userData.radius = g.boundingSphere.radius;
    mesh.userData.maxDistance = 180;
    mesh.userData.minDistance = 0;
    group.add(mesh);
  }
  return group;
}
