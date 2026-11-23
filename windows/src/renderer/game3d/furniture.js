// Roadside furniture, all procedural geometry with vertex colours (instanced wherever it repeats): field gates
// (timber five-bar and galvanised steel) and their posts, York's black heritage lamp posts, and the street
// and lane furniture of a British road (signs, bollards, benches, bins, railings, telegraph poles).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
