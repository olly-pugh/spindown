// York's landmarks with their real massing, in pale magnesian limestone: York Minster (twin pinnacled west
// towers, the great central lantern tower, nave and choir with aisles, clerestory, buttresses and flying
// buttresses, transepts with the Five Sisters and the rose window, the great west and east windows, the
// octagonal chapter house), Clifford's Tower (the quatrefoil keep on its motte, forebuilding and steps), the
// bars (gatehouses with corner bartizans, battlements and arch passages; Walmgate with its barbican), the wall
// towers, and the city walls (wall-walk and crenellated parapet with arrow slits on the grassy rampart).
//
// Everything is written with archgeo.Writer in the shared surface material (archtex.js), so each landmark is a
// mesh or two.
import * as THREE from 'three';
import * as C from './common.js';
import { Writer } from './archgeo.js';
import { L, TILES, materials } from './archtex.js';
import * as T from './textures.js';
import { hash2 } from '../../core/world/noise.js';

const lin = (hex) => new THREE.Color(hex);
const STONE = lin('#fbe8c4'); // weathered magnesian limestone, warm in the sun
const STONE2 = lin('#e4dbc4');
const LEADC = lin('#c9cfcf');
const DEG = Math.PI / 180;
// The walling layer: coursed limestone for the walls, bars and castle; minster() switches to fine ashlar.
let stoneL = L.LIMESTONE;
// Fine detail (crockets, finials) only at medium quality and above.
let fine = true;

export function mesh(W, q, { shadows = true } = {}) {
  const m = new THREE.Mesh(W.geometry(), materials(q.texDetail ?? T.getDetail()).surface);
  m.castShadow = shadows && !!q.shadows;
  m.receiveShadow = true;
  return m;
}

// ---- Shared Gothic pieces -------------------------------------------------------------------------------

/** Outline of an arched opening, (s, h) points counter-clockwise from the bottom left: round or pointed. */
export function archOutline(s0, s1, h0, spring, kind = 'pointed', seg = 6) {
  const w = s1 - s0, out = [[s0, h0], [s1, h0], [s1, spring]];
  if (kind === 'round') {
    const r = w / 2, c = (s0 + s1) / 2;
    for (let k = 1; k < seg * 2; k++) {
      const a = (k / (seg * 2)) * Math.PI;
      out.push([c + Math.cos(a) * r, spring + Math.sin(a) * r]);
    }
  } else {
    // Two-centred arch: each side an arc of radius r centred on the far side (r = w: equilateral).
    const r = w * (kind === 'drop' ? 0.75 : 1);
    const aMax = Math.acos(1 - w / (2 * r));
    const cR = s1 - r, cL = s0 + r;
    for (let k = 1; k <= seg; k++) {
      const a = (aMax * k) / seg;
      out.push([cR + Math.cos(a) * r, spring + Math.sin(a) * r]);
    }
    for (let k = seg - 1; k >= 1; k--) {
      const a = (aMax * k) / seg;
      out.push([cL - Math.cos(a) * r, spring + Math.sin(a) * r]);
    }
  }
  out.push([s0, spring]);
  return out;
}

const apexOf = (pts) => Math.max(...pts.map((p) => p[1]));

/**
 * A wall face s0…s1 × h0…h1 (local frame, facing +d) with shaped openings cut through it. holes: [{pts (outline),
 * depth, glaze, variant, uv: 'lancet'|'box'}]. Emits the wall (layer `layer`), reveals and glass.
 */
function faceWithHoles(W, s0, s1, h0, h1, holes, opts = {}) {
  shapedFace(W, [[s0, h0], [s1, h0], [s1, h1], [s0, h1]], holes, opts);
}

/** A wall face of any outline (counter-clockwise (s, h) points) with shaped openings. */
export function shapedFace(W, outline, holes, { layer = stoneL, tint = STONE, frame = STONE } = {}) {
  const contour = outline.map(([x, y]) => new THREE.Vector2(x, y));
  const hv = holes.map((o) => o.pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const tris = THREE.ShapeUtils.triangulateShape(contour, hv);
  const all = contour.concat(...hv);
  W.setLayer(layer).colour(tint);
  for (const [a, b, c] of tris) {
    let A = all[a], B = all[b], Cc = all[c];
    if ((B.x - A.x) * (Cc.y - A.y) - (B.y - A.y) * (Cc.x - A.x) < 0) [B, Cc] = [Cc, B];
    W.tri([A.x, A.y, 0], [B.x, B.y, 0], [Cc.x, Cc.y, 0], [A.x, A.y, B.x, B.y, Cc.x, Cc.y]);
  }
  for (const o of holes) opening(W, o, { layer, tint, frame });
}

/** Reveal round an opening outline and the glass set back in it. */
function opening(W, o, { layer = stoneL, tint = STONE, frame = STONE } = {}) {
  const pts = o.pts, n = pts.length, dr = o.depth ?? 0.4;
  W.setLayer(layer);
  let run = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const ny = (q[0] - p[0]) / (len || 1); // up-facing amount of this reveal face
    W.colour(tint, ny > 0.5 ? 0.9 : ny < -0.3 ? 0.62 : 0.78);
    W.quad([p[0], p[1], 0], [q[0], q[1], 0], [q[0], q[1], -dr], [p[0], p[1], -dr], [run, 0, run + len, 0, run + len, dr, run, dr]);
    run += len;
  }
  if (!o.glaze) return;
  // Glass: uv over the opening's box (for lancets, the springing line maps to where the painted heads start).
  let sMin = Infinity, sMax = -Infinity, hMin = Infinity, hMax = -Infinity;
  for (const [x, y] of pts) {
    sMin = Math.min(sMin, x);
    sMax = Math.max(sMax, x);
    hMin = Math.min(hMin, y);
    hMax = Math.max(hMax, y);
  }
  const spring = o.spring ?? hMax;
  let u0 = 0, du = 1;
  if (o.glaze === L.LANCET || o.glaze === L.DOOR) {
    u0 = ((o.variant ?? 0) % 4) * 0.25;
    du = 0.25;
  } else if (o.glaze === L.SASH6 || o.glaze === L.SASH2 || o.glaze === L.CASEMENT || o.glaze === L.LEADED) {
    u0 = ((o.variant ?? 0) % 2) * 0.5;
    du = 0.5;
  }
  const uvOf = (x, y) => {
    const u = u0 + ((x - sMin) / (sMax - sMin)) * du;
    let v;
    if (o.glaze === L.LANCET && spring < hMax) v = y <= spring ? ((y - hMin) / (spring - hMin)) * 0.8 : 0.8 + ((y - spring) / (hMax - spring)) * 0.2;
    else v = (y - hMin) / (hMax - hMin);
    if (o.glaze === L.SASH6 || o.glaze === L.SASH2 || o.glaze === L.CASEMENT || o.glaze === L.LEADED) v = v * 0.5 + 0.5;
    return [u, v];
  };
  W.setLayer(o.glaze).colour(frame);
  // Fan from a point at the middle of the springing line (or the centre for round windows).
  const cx = (sMin + sMax) / 2, cy = o.round ? (hMin + hMax) / 2 : Math.min(spring, (hMin + hMax) / 2);
  const cuv = uvOf(cx, cy);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const pu = uvOf(p[0], p[1]), qu = uvOf(q[0], q[1]);
    W.tri([cx, cy, -dr], [p[0], p[1], -dr], [q[0], q[1], -dr], [cuv[0], cuv[1], pu[0], pu[1], qu[0], qu[1]]);
  }
}

/** A circle outline (rose windows, oculi). */
function circleOutline(cs, ch, r, seg = 20) {
  const out = [];
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2 - Math.PI / 2;
    out.push([cs + Math.cos(a) * r, ch + Math.sin(a) * r]);
  }
  return out;
}

/** A pinnacle: square shaft with a little gabled cap and a spirelet, at local (s, d). */
export function pinnacle(W, s, d, h0, shaftH, w, { tint = STONE, spire = 2.6 } = {}) {
  W.setLayer(stoneL).colour(tint);
  W.box(s - w / 2, s + w / 2, h0, h0 + shaftH, d - w / 2, d + w / 2, 1 | 2 | 4 | 8);
  // Gablets on each face round the foot of the spirelet.
  W.setLayer(L.ASHLAR).colour(tint, 0.95);
  W.box(s - w / 2 - 0.06, s + w / 2 + 0.06, h0 + shaftH, h0 + shaftH + 0.18, d - w / 2 - 0.06, d + w / 2 + 0.06, 1 | 2 | 4 | 8 | 16 | 32);
  W.setLayer(stoneL).colour(tint);
  W.pyramid(s, d, w * 0.62, h0 + shaftH + 0.18, h0 + shaftH + 0.18 + w * spire, 4, Math.PI / 4);
  // Crockets: small knobs up the spirelet's edges, read as a feathered outline.
  const top = h0 + shaftH + 0.18 + w * spire;
  W.setLayer(L.ASHLAR).colour(tint, 0.9);
  for (let k = 1; k <= (fine ? 3 : 0); k++) {
    const t = k / 4, hh = h0 + shaftH + 0.18 + (top - h0 - shaftH - 0.18) * t, rr = w * 0.62 * (1 - t) + 0.06;
    for (const [a, c] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const x = s + a * rr * 0.7, z = d + c * rr * 0.7;
      W.box(x - 0.07, x + 0.07, hh - 0.07, hh + 0.07, z - 0.07, z + 0.07, 1 | 2 | 4 | 8 | 16);
    }
  }
  W.box(s - 0.07, s + 0.07, top - 0.05, top + 0.35, d - 0.07, d + 0.07, 1 | 2 | 4 | 8 | 16);
}

/** Battlements along the top of a wall in the current frame: merlons on a parapet from s0 to s1 at height h. */
export function battlements(W, s0, s1, h, { thick = 0.5, merlonH = 0.75, merlonW = 1.0, gap = 0.6, d0 = -0.5, tint = STONE, coping = true } = {}) {
  W.setLayer(stoneL).colour(tint);
  const len = s1 - s0;
  const n = Math.max(1, Math.floor((len + gap) / (merlonW + gap)));
  const used = n * merlonW + (n - 1) * gap;
  let s = s0 + (len - used) / 2;
  for (let k = 0; k < n; k++) {
    W.box(s, s + merlonW, h, h + merlonH, d0, d0 + thick, coping ? 15 : 31);
    if (coping) {
      W.setLayer(L.ASHLAR).colour(tint, 0.92);
      W.box(s - 0.03, s + merlonW + 0.03, h + merlonH, h + merlonH + 0.1, d0 - 0.03, d0 + thick + 0.03, 1 | 2 | 4 | 8 | 16 | 32);
      W.setLayer(stoneL).colour(tint);
    }
    s += merlonW + gap;
  }
}

/** A buttress against a wall in the current frame at s, stepping back in stages up to h1. */
function buttress(W, s, h0, h1, { w = 1.4, proj = 1.6, stages = 3, tint = STONE } = {}) {
  W.setLayer(stoneL).colour(tint);
  let p = proj;
  const step = (h1 - h0) / stages;
  for (let k = 0; k < stages; k++) {
    const a = h0 + step * k, b = h0 + step * (k + 1) - 0.35;
    W.box(s - w / 2, s + w / 2, a, b, 0, p, 1 | 4 | 8);
    // Sloped set-off weathering.
    const np = k === stages - 1 ? 0 : p * 0.68;
    W.setLayer(L.ASHLAR).colour(tint, 0.95);
    W.quad([s - w / 2, b, p], [s + w / 2, b, p], [s + w / 2, b + 0.35, np], [s - w / 2, b + 0.35, np], [0, 0, w, 0, w, 0.4, 0, 0.4]);
    W.tri([s + w / 2, b, p], [s + w / 2, b, np], [s + w / 2, b + 0.35, np], [0, 0, 1, 0, 1, 1]);
    W.tri([s - w / 2, b, np], [s - w / 2, b, p], [s - w / 2, b + 0.35, np], [0, 0, 1, 0, 1, 1]);
    W.setLayer(stoneL).colour(tint);
    p = np;
  }
}

/** Extrudes a profile (s, h points, counter-clockwise) through d0…d1 in the current frame. */
function extrude(W, pts, d0, d1, layer = stoneL, tint = STONE) {
  W.setLayer(layer).colour(tint);
  const v = pts.map(([x, y]) => new THREE.Vector2(x, y));
  const tris = THREE.ShapeUtils.triangulateShape(v, []);
  for (const [a, b, c] of tris) {
    let A = v[a], B = v[b], Cc = v[c];
    if ((B.x - A.x) * (Cc.y - A.y) - (B.y - A.y) * (Cc.x - A.x) < 0) [B, Cc] = [Cc, B];
    W.tri([A.x, A.y, d1], [B.x, B.y, d1], [Cc.x, Cc.y, d1], [A.x, A.y, B.x, B.y, Cc.x, Cc.y]);
    W.tri([A.x, A.y, d0], [Cc.x, Cc.y, d0], [B.x, B.y, d0], [A.x, A.y, Cc.x, Cc.y, B.x, B.y]);
  }
  // Sides: for a counter-clockwise outline the outside is on the right of each edge.
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  const ccw = area > 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (ccw) W.quad([q[0], q[1], d0], [p[0], p[1], d0], [p[0], p[1], d1], [q[0], q[1], d1], [0, 0, len, 0, len, d1 - d0, 0, d1 - d0]);
    else W.quad([p[0], p[1], d0], [q[0], q[1], d0], [q[0], q[1], d1], [p[0], p[1], d1], [0, 0, len, 0, len, d1 - d0, 0, d1 - d0]);
  }
}

/** Walls of a block (ring of world x/z points with positive area) from h0 to h1 above y, with an optional face callback. */
function blockWalls(W, ring, y, h0, h1, { layer = stoneL, tint = STONE, face = null } = {}) {
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) continue;
    W.wallFrame(ax, az, bx, bz, y);
    if (face && face(W, i, len) !== false) continue;
    W.setLayer(layer).colour(tint);
    W.rect(0, len, h0, h1);
  }
}

/** A rectangle ring (positive area) x0…x1 × z0…z1 in world coordinates. */
const rectRing = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];

/** A lead roof ridge over a rectangle (ridge along x or z), eaves at y + h, with rise; gable walls in stone. */
function leadRoof(W, y, x0, z0, x1, z1, h, rise, alongX, { gables = true, tint = STONE } = {}) {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const la = alongX ? (x1 - x0) / 2 : (z1 - z0) / 2, lb = alongX ? (z1 - z0) / 2 : (x1 - x0) / 2;
  W.frame(cx, y + h, cz, alongX ? 1 : 0, alongX ? 0 : 1);
  W.setLayer(L.LEAD).colour(LEADC);
  const sl = Math.hypot(lb, rise);
  W.quad([-la, 0, lb], [la, 0, lb], [la, rise, 0], [-la, rise, 0], [-la, 0, la, 0, la, sl, -la, sl]);
  W.quad([la, 0, -lb], [-la, 0, -lb], [-la, rise, 0], [la, rise, 0], [-la, 0, la, 0, la, sl, -la, sl]);
  if (gables) {
    W.setLayer(stoneL).colour(tint);
    W.tri([la, 0, lb], [la, 0, -lb], [la, rise, 0], [-lb, 0, lb, 0, 0, rise]);
    W.tri([-la, 0, -lb], [-la, 0, lb], [-la, rise, 0], [-lb, 0, lb, 0, 0, rise]);
  }
}

// ---- York Minster --------------------------------------------------------------------------------------

/** Sets a wall frame on the segment a–b whose outward normal points along (ox, oz). Returns the length. */
function faceFrame(W, ax, az, bx, bz, y, ox, oz) {
  // wallFrame(a, b) faces (bz − az, ax − bx); swap the ends if that points the wrong way.
  if ((bz - az) * ox + (ax - bx) * oz < 0) [ax, az, bx, bz] = [bx, bz, ax, az];
  W.wallFrame(ax, az, bx, bz, y);
  return Math.hypot(bx - ax, bz - az);
}

/**
 * York Minster on its real footprint (map data x east, y north, metres; world z = −y), street level y0.
 * Dimensions from the building: 158 m long, nave 31 m to the parapet, west towers 60 m, central tower 72 m.
 */
export function minster(q, { y0 = 12 } = {}) {
  stoneL = L.ASHLARWALL;
  fine = !!q.shadows;
  try {
    return minsterBody(q, y0);
  } finally {
    stoneL = L.LIMESTONE;
  }
}

function minsterBody(q, y0) {
  const W = new Writer(TILES);
  const Z = (y) => -y;
  const AX = 247.5; // nave axis (data y)
  const vessel = 6.9, aisle = 19; // half-widths: main vessel walls and aisle walls
  const HA = 14, HC = 31; // aisle and clerestory wall heights
  const tint = STONE;
  const pierce = (len, h) => battlements(W, 0, len, h, { thick: 0.45, merlonH: 0.85, merlonW: 0.75, gap: 0.55, d0: -0.45, tint });
  const lancet = (c, w, sill, spring, variant = 1, depth = 0.7) => ({ pts: archOutline(c - w / 2, c + w / 2, sill, spring, 'pointed', 6), depth, glaze: L.LANCET, variant, spring });

  // ---- Nave (x −71.5…−23) and choir (x 7.5…75): aisles with pinnacled buttresses, clerestory, flyers ----
  for (const [xa, xb, bays, ca, cb] of [[-71.5, -23, 7, -71.5, -18.5], [7.5, 75, 9, 3, 75]]) {
    const bw = (xb - xa) / bays;
    for (const side of [-1, 1]) {
      const oz = side < 0 ? 1 : -1; // outward in world z (south is +z)
      const ya = AX + side * aisle, yv = AX + side * vessel;
      // Aisle wall: a traceried window in every bay.
      let len = faceFrame(W, xa, Z(ya), xb, Z(ya), y0, 0, oz);
      const holes = [];
      for (let k = 0; k < bays; k++) holes.push(lancet((k + 0.5) * bw, Math.min(4.2, bw * 0.58), 3.2, 9.6, 1 + (k % 2)));
      faceWithHoles(W, 0, len, -0.5, HA, holes, { tint });
      pierce(len, HA);
      for (let k = 0; k <= bays; k++) {
        buttress(W, k * bw, -0.5, HA - 0.6, { w: 1.5, proj: 1.9, stages: 3, tint });
        pinnacle(W, k * bw, 0.75, HA - 0.6, 3.2, 1.0, { tint });
      }
      // Lean-to aisle roof, rising from the aisle parapet to the clerestory.
      W.frame(0, y0 + HA, 0, 1, 0);
      W.setLayer(L.LEAD).colour(LEADC);
      const zo = Z(ya), zi = Z(yv);
      const pq = [[xa, -0.2, zo], [xb, -0.2, zo], [xb, 3.2, zi], [xa, 3.2, zi]];
      if (oz > 0) W.quad(pq[0], pq[1], pq[2], pq[3], [0, 0, xb - xa, 0, xb - xa, 12, 0, 12]);
      else W.quad(pq[1], pq[0], pq[3], pq[2], [0, 0, xb - xa, 0, xb - xa, 12, 0, 12]);
      // Clerestory: great windows between buttress strips, a pierced parapet and pinnacles.
      len = faceFrame(W, ca, Z(yv), cb, Z(yv), y0, 0, oz);
      const off = Math.abs(xa - ca); // the clerestory may start nearer the crossing than the aisle
      const ch = [];
      for (let k = 0; k < bays; k++) ch.push(lancet(off + (k + 0.5) * bw, Math.min(5.2, bw * 0.7), 17.5, 25.3, 3, 0.6));
      // faceFrame may have swapped the ends: mirror the window positions if s runs the other way.
      const flipS = W.ux * (cb - ca) < 0;
      const place = (s) => (flipS ? len - s : s);
      for (const o of ch) o.pts = o.pts.map(([s, h]) => [place(s), h]).reverse();
      faceWithHoles(W, 0, len, HA - 0.2, HC, ch, { tint });
      for (let k = 0; k <= bays; k++) {
        const s = place(off + k * bw);
        W.setLayer(stoneL).colour(tint);
        W.box(s - 0.6, s + 0.6, HA + 2.5, HC - 0.4, 0, 0.45, 1 | 4 | 8);
        pinnacle(W, s, 0.2, HC - 0.4, 3.0, 0.9, { tint, spire: 3 });
      }
      pierce(len, HC);
      // Flying buttresses from the aisle pinnacles up to the clerestory wall.
      for (let k = 1; k < bays; k++) {
        const x = xa + k * bw;
        W.frame(x, y0, Z(yv), 0, oz); // s runs outward across the aisle, d along the nave
        const out = aisle - vessel;
        const top0 = HC - 3.4, top1 = HA + 2.2;
        const prof = [[0, top0], [0, top0 - 1.1]];
        for (let a = 1; a <= 6; a++) {
          const t = a / 7;
          prof.push([out * t, top0 - 1.1 - (top0 - 1.1 - (top1 - 2.6)) * (1 - Math.cos((t * Math.PI) / 2))]);
        }
        prof.push([out + 0.2, top1 - 2.6], [out + 0.2, top1]);
        extrude(W, prof, -0.36, 0.36, stoneL, tint);
      }
    }
  }
  // Main roofs of the nave and choir.
  leadRoof(W, y0, -85, Z(AX + vessel), -18.5, Z(AX - vessel), HC, 7.6, true, { gables: false });
  leadRoof(W, y0, 3, Z(AX + vessel), 75, Z(AX - vessel), HC, 7.6, true, { gables: false });

  // ---- Transepts: x −23…7.5, north to y 284, south to y 213; vessel x −15.5…0 between aisles ----
  for (const side of [-1, 1]) {
    const yEnd = side > 0 ? 284 : 213;
    const oz = side > 0 ? -1 : 1; // the front faces north (−z) or south (+z)
    const yAisle = AX + side * aisle, yTower = AX + side * 10.75;
    const yA1 = Math.min(yAisle, yEnd), yA2 = Math.max(yAisle, yEnd);
    const yC1 = Math.min(yTower, yEnd), yC2 = Math.max(yTower, yEnd);
    for (const [x, xc, ox] of [[-23, -15.5, -1], [7.5, 0, 1]]) {
      // Aisle wall of the arm.
      let len = faceFrame(W, x, Z(yA1), x, Z(yA2), y0, ox, 0);
      faceWithHoles(W, 0, len, -0.5, HA, [lancet(len * 0.25, 3.4, 3.5, 9.8), lancet(len * 0.75, 3.4, 3.5, 9.8)], { tint });
      pierce(len, HA);
      for (const s of [0, len / 2, len]) buttress(W, s, -0.5, HA - 0.6, { w: 1.4, proj: 1.7, tint });
      // Lean-to over the arm's aisle.
      W.frame(0, y0 + HA, 0, 1, 0);
      W.setLayer(L.LEAD).colour(LEADC);
      const z1 = Z(yA1), z2 = Z(yA2);
      const pq = [[x, -0.2, z1], [x, -0.2, z2], [xc, 3.2, z2], [xc, 3.2, z1]];
      if (ox > 0) W.quad(pq[0], pq[1], pq[2], pq[3], [0, 0, len, 0, len, 9, 0, 9]);
      else W.quad(pq[1], pq[0], pq[3], pq[2], [0, 0, len, 0, len, 9, 0, 9]);
      // Clerestory of the arm, from the central tower to the front.
      len = faceFrame(W, xc, Z(yC1), xc, Z(yC2), y0, ox, 0);
      // Windows in the part of the arm beyond the aisles (positions from world points, whichever way s runs).
      const armLen = Math.abs(yEnd - yAisle);
      const sAt = (zw) => (xc - W.ox) * W.ux + (zw - W.oz) * W.uz;
      faceWithHoles(W, 0, len, HA - 0.2, HC, [0.27, 0.73].map((t) => lancet(sAt(Z(yEnd - side * armLen * t)), 4.6, 17.5, 25.3, 3, 0.6)), { tint });
      pierce(len, HC);
    }
    // The front: aisle ends and the great windows (the Five Sisters north, the rose window south).
    const flen = faceFrame(W, -23, Z(yEnd), 7.5, Z(yEnd), y0, 0, oz);
    const fh = [];
    if (side > 0) {
      for (let k = 0; k < 5; k++) {
        const c = 9.05 + k * 3.1;
        fh.push(lancet(c, 2.1, 4.5, 17.5 - Math.abs(k - 2) * 0.7, 0, 0.8));
      }
      fh.push(lancet(15.25, 4.2, 23.0, 26.6, 2, 0.6));
    } else {
      for (let k = 0; k < 4; k++) fh.push(lancet(9.7 + k * 3.7, 2.2, 6, 15.5, 1));
      fh.push({ pts: circleOutline(15.25, 24.4, 4.0, 24), depth: 0.8, glaze: L.ROSE, round: true });
    }
    fh.push(lancet(3.6, 3.2, 4, 10), lancet(flen - 3.6, 3.2, 4, 10));
    faceWithHoles(W, 0, flen, -0.5, HC, fh, { tint });
    // Gable with a raised coping and an apex pinnacle; corner buttresses with pinnacles.
    W.setLayer(stoneL).colour(tint);
    W.tri([7.5, HC, 0], [23, HC, 0], [15.25, HC + 7.9, 0], [0, 0, 15.5, 0, 7.75, 7.9]);
    W.setLayer(L.ASHLAR).colour(tint, 0.95);
    W.quad([7.5, HC, 0.3], [15.25, HC + 7.9, 0.3], [15.25, HC + 8.3, 0.3], [7.5, HC + 0.4, 0.3], [0, 0, 1, 0, 1, 0.1, 0, 0.1]);
    W.quad([15.25, HC + 7.9, 0.3], [23, HC, 0.3], [23, HC + 0.4, 0.3], [15.25, HC + 8.3, 0.3], [0, 0, 1, 0, 1, 0.1, 0, 0.1]);
    pinnacle(W, 15.25, 0, HC + 7.8, 1.5, 1.0, { tint });
    for (const s of [0.4, 7.5, 23, flen - 0.4]) {
      const tall = s > 1 && s < flen - 1;
      buttress(W, s, -0.5, tall ? HC - 1 : HA, { w: 1.6, proj: 1.8, stages: 3, tint });
      pinnacle(W, s, 0.9, tall ? HC - 1 : HA - 0.5, 4, 1.25, { tint, spire: 3.2 });
    }
    pierce(7.5, HA);
    // Transept main roof, from the central tower to the front gable.
    leadRoof(W, y0, -15.5, Z(yC2), 0, Z(yC1), HC, 7.6, false, { gables: false });
  }

  // ---- Central tower: x −18.5…3, y 236.75…258.25, rising to 69 m, battlements and corner pinnacles ----
  {
    const x0 = -18.5, x1 = 3, ya = 236.75, yb = 258.25;
    blockWalls(W, rectRing(x0, Z(yb), x1, Z(ya)), y0, HC - 1, 69, {
      tint,
      face: (Wr, i, len) => {
        const holes = [len * 0.31, len * 0.69].map((c) => ({ pts: archOutline(c - 2.1, c + 2.1, HC + 10, 61.5, 'pointed', 6), depth: 0.9, glaze: L.LOUVRE, spring: 61.5 }));
        faceWithHoles(Wr, 0, len, HC - 1, 69, holes, { tint });
        Wr.setLayer(stoneL).colour(tint);
        for (const s of [0.9, len - 0.9]) Wr.box(s - 0.9, s + 0.9, HC - 1, 69, 0, 0.7, 1 | 4 | 8);
        Wr.box(len / 2 - 0.55, len / 2 + 0.55, HC + 6, 69, 0, 0.45, 1 | 4 | 8);
        Wr.setLayer(L.ASHLAR).colour(tint, 0.9);
        Wr.box(0, len, 66.3, 66.7, 0, 0.18, 1 | 16 | 32);
        battlements(Wr, 0, len, 69, { thick: 0.6, merlonH: 1.4, merlonW: 1.1, gap: 0.7, d0: -0.6, tint });
        for (const s of [0.9, len - 0.9]) pinnacle(Wr, s, 0.35, 69, 1.8, 1.3, { tint, spire: 2 });
        return true;
      },
    });
    W.frame((x0 + x1) / 2, y0 + 68.6, Z((ya + yb) / 2), 1, 0);
    W.setLayer(L.LEAD).colour(LEADC, 0.85);
    W.box(-(x1 - x0) / 2 + 0.6, (x1 - x0) / 2 - 0.6, 0, 0.3, -(yb - ya) / 2 + 0.6, (yb - ya) / 2 - 0.6, 16);
  }

  // ---- West towers: belfry lancets, angle buttresses, openwork parapet and a crown of eight pinnacles ----
  for (const [ta, tb] of [[228.5, 240.5], [254.5, 266.5]]) {
    const x0 = -85, x1 = -71.5;
    blockWalls(W, rectRing(x0, Z(tb), x1, Z(ta)), y0, -0.5, 52, {
      tint,
      face: (Wr, i, len) => {
        const holes = [len * 0.3, len * 0.7].map((c) => ({ pts: archOutline(c - 1.35, c + 1.35, 36.5, 47.3, 'pointed', 5), depth: 0.8, glaze: L.LOUVRE, spring: 47.3 }));
        if (i === 3) {
          holes.push({ pts: archOutline(len / 2 - 2.2, len / 2 + 2.2, 13, 24.3, 'pointed', 6), depth: 0.8, glaze: L.LANCET, variant: 2, spring: 24.3 });
          holes.push({ pts: archOutline(len / 2 - 1.3, len / 2 + 1.3, -0.3, 4.8, 'pointed', 5), depth: 1.2, glaze: L.DARK, spring: 4.8 });
        }
        faceWithHoles(Wr, 0, len, -0.5, 52, holes, { tint, layer: L.PANELS });
        for (const s of [1.1, len - 1.1]) buttress(Wr, s, -0.5, 50.5, { w: 2.2, proj: 3.2, stages: 5, tint });
        Wr.setLayer(L.ASHLAR).colour(tint, 0.92);
        for (const h of [HA + 0.5, HC + 1, 35.2]) Wr.box(0, len, h, h + 0.35, 0, 0.2, 1 | 16 | 32);
        battlements(Wr, 0, len, 52, { thick: 0.5, merlonH: 1.2, merlonW: 0.6, gap: 0.45, d0: -0.5, tint, coping: false });
        pinnacle(Wr, len / 2, 0, 52, 3.4, 0.9, { tint, spire: 3.2 });
        pinnacle(Wr, 0.6, 0.6, 52, 4.4, 1.6, { tint, spire: 3.1 });
        return true;
      },
    });
    W.frame((x0 + x1) / 2, y0 + 51.6, Z((ta + tb) / 2), 1, 0);
    W.setLayer(L.LEAD).colour(LEADC, 0.85);
    W.box(-6, 6, 0, 0.3, -5.5, 5.5, 16);
  }
  // The west front between the towers: the Great West Window over the central portal, under a gable.
  {
    const len = faceFrame(W, -85, Z(240.5), -85, Z(254.5), y0, -1, 0);
    faceWithHoles(W, 0, len, -0.5, HC + 1, [
      { pts: archOutline(2.0, 12.0, 15.2, 22.6, 'pointed', 8), depth: 1.0, glaze: L.WESTWIN, spring: 22.6 },
      { pts: archOutline(4.2, 9.8, -0.3, 6.8, 'pointed', 6), depth: 1.6, glaze: L.DARK, spring: 6.8 },
    ], { tint });
    W.setLayer(L.ASHLAR).colour(tint, 0.95);
    W.box(3.4, 10.6, 11.5, 12.0, 0, 0.6, 1 | 4 | 8 | 16 | 32);
    W.tri([3.4, 12.0, 0.6], [10.6, 12.0, 0.6], [7, 14.6, 0.6], [0, 0, 1, 0, 0.5, 0.4]);
    W.setLayer(stoneL).colour(tint);
    W.tri([0, HC + 1, 0], [len, HC + 1, 0], [len / 2, HC + 9, 0], [0, 0, 14, 0, 7, 8]);
    pinnacle(W, len / 2, 0, HC + 8.6, 1.8, 1.1, { tint, spire: 3 });
    for (const s of [0.6, len - 0.6]) {
      buttress(W, s, -0.5, HC + 1, { w: 1.2, proj: 1.6, stages: 4, tint });
      pinnacle(W, s, 0.8, HC + 0.5, 3.6, 1.15, { tint, spire: 3.2 });
    }
  }

  // ---- The east end: the Great East Window in the vessel gable, octagonal turrets, aisle-end windows ----
  {
    const len = faceFrame(W, 75, Z(AX - aisle), 75, Z(AX + aisle), y0, 1, 0);
    const c = len / 2;
    // One face shaped like an inverted T: aisle-height across the whole end, the vessel rising in the middle.
    const contour = [[0, -0.5], [len, -0.5], [len, HA], [c + vessel, HA], [c + vessel, HC + 1], [c - vessel, HC + 1], [c - vessel, HA], [0, HA]];
    shapedFace(W, contour, [
      { pts: archOutline(c - 4.7, c + 4.7, 7.5, 23.4, 'pointed', 8), depth: 1.0, glaze: L.EASTWIN, spring: 23.4 },
      lancet(6.5, 3.6, 3.5, 10.3, 2), lancet(len - 6.5, 3.6, 3.5, 10.3, 2),
    ], { tint });
    W.setLayer(stoneL).colour(tint);
    W.tri([c - vessel, HC + 1, 0], [c + vessel, HC + 1, 0], [c, HC + 8.6, 0], [0, 0, 13.8, 0, 6.9, 7.6]);
    pinnacle(W, c, 0, HC + 8.3, 1.6, 1.0, { tint });
    for (const s of [0.6, c - vessel, c + vessel, len - 0.6]) {
      const big = s > 1 && s < len - 1;
      W.setLayer(stoneL).colour(tint);
      W.cylinder(s, 0.5, 1.2, 1.1, -0.5, big ? HC + 3 : HA + 0.5, 8);
      pinnacle(W, s, 0.5, big ? HC + 3 : HA + 0.5, 3.2, 1.2, { tint, spire: 3.4 });
    }
  }

  // ---- Chapter house: octagon, tall windows, pinnacled buttresses, steep pyramidal lead roof ----
  {
    const cx = 25.4, cz = Z(294.4), R = 10.8, H = 19.5;
    const ring = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      ring.push(cx + Math.cos(a) * R, cz + Math.sin(a) * R);
    }
    blockWalls(W, ring, y0, -0.5, H, {
      tint,
      face: (Wr, i, len) => {
        const holes = i === 3 ? [] : [{ pts: archOutline(len / 2 - 2.5, len / 2 + 2.5, 4.5, 14.2, 'pointed', 6), depth: 0.8, glaze: L.LANCET, variant: 3, spring: 14.2 }];
        faceWithHoles(Wr, 0, len, -0.5, H, holes, { tint });
        pierce(len, H);
        return true;
      },
    });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      W.frame(cx + Math.cos(a) * R, y0, cz + Math.sin(a) * R, Math.sin(a), -Math.cos(a));
      buttress(W, 0, -0.5, H - 0.5, { w: 1.4, proj: 1.8, stages: 3, tint });
      pinnacle(W, 0, 0.5, H - 0.5, 3.6, 1.1, { tint, spire: 3.2 });
    }
    W.frame(cx, y0 + H, cz, 1, 0);
    W.setLayer(L.LEAD).colour(LEADC);
    W.pyramid(0, 0, R + 0.3, 0, 16.5, 8, Math.PI / 8);
    W.setLayer(L.ASHLAR).colour(tint);
    W.box(-0.25, 0.25, 16.3, 18.2, -0.25, 0.25, 1 | 2 | 4 | 8 | 16);
  }
  // Vestibule to the chapter house, and the lower vestries and annexes along the south side.
  for (const [x0, y1, x1, y2, h] of [[-1.6, 284.3, 15.5, 298, 12.5], [-38, 214.7, -23, 229, 12], [8.3, 221.5, 41.2, 228.5, 9.5], [41.2, 226, 64, 228.5, 8.5]]) {
    blockWalls(W, rectRing(x0, Z(y2), x1, Z(y1)), y0, -0.5, h, {
      tint,
      face: (Wr, i, len) => {
        const n = Math.max(1, Math.floor(len / 5));
        const holes = [];
        for (let k = 0; k < n; k++) holes.push({ pts: archOutline(((k + 0.5) * len) / n - 0.9, ((k + 0.5) * len) / n + 0.9, 2.8, h - 3.4, 'pointed', 4), depth: 0.5, glaze: L.LANCET, variant: 0, spring: h - 3.4 });
        faceWithHoles(Wr, 0, len, -0.5, h, holes, { tint });
        pierce(len, h);
        return true;
      },
    });
    W.frame((x0 + x1) / 2, y0 + h - 0.3, Z((y1 + y2) / 2), 1, 0);
    W.setLayer(L.LEAD).colour(LEADC, 0.9);
    W.box(-(x1 - x0) / 2, (x1 - x0) / 2, 0, 0.5, -(y2 - y1) / 2, (y2 - y1) / 2, 16);
  }
  const g = new THREE.Group();
  g.add(mesh(W, q));
  g.userData.landmark = 'minster';
  return g;
}

// ---- Clifford's Tower ----------------------------------------------------------------------------------

/**
 * Clifford's Tower: the 13th-century quatrefoil keep (four round lobes, 24 m across, walls ~10 m high with arrow
 * slits and a broken crenellated top) on the steep grassy motte, the forebuilding facing the long flight of
 * steps. lm: {x, y} map centre.
 */
export function cliffordsTower(lm, q, { y0 = 12 } = {}) {
  const g = new THREE.Group();
  const cx = lm.x, cz = -lm.y;
  const top = 15; // motte summit above the street
  // The motte: steep grass, a little irregular, flattened round the keep.
  const grass = C.groundMaterial({ map: T.grassTexture(), color: '#dcecc0', roughness: 1 });
  {
    const seg = 56, rings = [[0, top + 0.05], [13.6, top], [15.2, top - 0.7], [19.5, top - 4.8], [25.5, top - 10.2], [31.5, top - 13.9], [35, top - 14.9], [38, top - 15.15]];
    const pos = [], uv = [], idx = [];
    for (let j = 0; j < rings.length; j++) {
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        const wob = j > 1 && j < rings.length - 1 ? 1 + 0.035 * Math.sin(a * 3 + 1.3) + 0.02 * Math.sin(a * 7 + 0.4) : 1;
        const r = rings[j][0] * wob;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        pos.push(x, rings[j][1] - 0.1, z);
        uv.push(x / 7, z / 7);
      }
    }
    for (let j = 0; j < rings.length - 1; j++) {
      for (let k = 0; k < seg; k++) {
        const a = j * (seg + 1) + k, b = a + seg + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mound = new THREE.Mesh(geo, grass);
    mound.position.set(cx, y0, cz);
    mound.receiveShadow = true;
    g.add(mound);
  }
  const W = new Writer(TILES);
  const tint = lin('#ebe3cf');
  const lobes = [-83, 7, 97, 187].map((a) => a * DEG);
  const fore = 52 * DEG;
  const c = 5.6, R = 6.6, wallH = 9.6, thick = 2.5;
  const base = y0 + top;
  // Each lobe: the part of its circle outside the other lobes (about 270°), outer and inner faces and a wall-walk.
  for (let li = 0; li < 4; li++) {
    const a = lobes[li];
    const lx = cx + Math.cos(a) * c, lz = cz + Math.sin(a) * c;
    // Arc from the junction with the previous lobe to the next one: ±(180 − 45 + δ)° about the lobe direction.
    const half = (135 + 3) * DEG;
    const n = 22;
    for (let k = 0; k < n; k++) {
      const t0 = a - half + ((2 * half) * k) / n, t1 = a - half + ((2 * half) * (k + 1)) / n;
      const p0x = lx + Math.cos(t0) * R, p0z = lz + Math.sin(t0) * R, p1x = lx + Math.cos(t1) * R, p1z = lz + Math.sin(t1) * R;
      // Outer face: wall frame with the outward normal pointing away from the lobe centre (a→b clockwise?).
      W.wallFrame(p0x, p0z, p1x, p1z, base);
      const len = Math.hypot(p1x - p0x, p1z - p0z);
      // Batter at the foot, then the wall, with an arrow slit in a few segments.
      W.setLayer(stoneL).colour(tint, 0.97);
      W.quad([0, -1.5, 0.9], [len, -1.5, 0.9], [len, 1.2, 0], [0, 1.2, 0], [0, 0, len, 0, len, 2.8, 0, 2.8]);
      const slit = k % 7 === 3;
      if (slit) {
        const sh = { pts: [[len / 2 - 0.12, 3.2], [len / 2 + 0.12, 3.2], [len / 2 + 0.12, 6.4], [len / 2 - 0.12, 6.4]], depth: 0.9, glaze: L.DARK };
        faceWithHoles(W, 0, len, 1.2, wallH, [sh], { tint });
      } else {
        W.setLayer(stoneL).colour(tint);
        W.rect(0, len, 1.2, wallH);
      }
      // String course and a parapet that is broken down in places.
      W.setLayer(L.ASHLAR).colour(tint, 0.9);
      W.box(0, len, wallH - 1.45, wallH - 1.25, 0, 0.12, 1 | 16 | 32);
      // A plain parapet, broken down in places, with only a few merlons left standing.
      const ruin = hash2(li * 31 + k, 7, 3);
      const ph = ruin < 0.12 ? 1.6 : ruin < 0.3 ? 0.55 : 1.05;
      W.setLayer(stoneL).colour(tint);
      W.box(0, len, wallH, wallH + ph, -0.6, 0, 1 | 16 | 4 | 8);
    }
    // Inner face (seen from above) and the wall top.
    const Ri = R - thick;
    for (let k = 0; k < n; k++) {
      const t0 = a - half + ((2 * half) * k) / n, t1 = a - half + ((2 * half) * (k + 1)) / n;
      const p0x = lx + Math.cos(t0) * Ri, p0z = lz + Math.sin(t0) * Ri, p1x = lx + Math.cos(t1) * Ri, p1z = lz + Math.sin(t1) * Ri;
      W.wallFrame(p1x, p1z, p0x, p0z, base);
      const len = Math.hypot(p1x - p0x, p1z - p0z);
      W.setLayer(stoneL).colour(tint, 0.82);
      W.rect(0, len, 0, wallH);
      // Wall-walk on top.
      W.frame(0, base + wallH, 0, 1, 0);
      const o0x = lx + Math.cos(t0) * (R - 0.6), o0z = lz + Math.sin(t0) * (R - 0.6), o1x = lx + Math.cos(t1) * (R - 0.6), o1z = lz + Math.sin(t1) * (R - 0.6);
      W.setLayer(L.ASHLAR).colour(tint, 0.85);
      W.quad([p0x, 0, p0z], [p1x, 0, p1z], [o1x, 0, o1z], [o0x, 0, o0z], [0, 0, len, 0, len, 2, 0, 2]);
    }
  }
  // Floor inside the keep.
  W.frame(cx, base + 0.05, cz, 1, 0);
  W.setLayer(L.ASHLAR).colour(lin('#b8b09c'));
  const floor = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    floor.push(Math.cos(a) * 9, Math.sin(a) * 9);
  }
  W.flat(floor, 0, true);
  // Forebuilding: a rectangular block between the south and east lobes, the door at the top of the steps.
  {
    const fx = cx + Math.cos(fore) * 10.6, fz = cz + Math.sin(fore) * 10.6;
    const ux = -Math.sin(fore), uz = Math.cos(fore); // across the forebuilding
    const w = 7.2, d = 5.2, h = 8.6;
    const ring = [];
    for (const [s, t] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) ring.push(fx + ux * s + Math.cos(fore) * t, fz + uz * s + Math.sin(fore) * t);
    // Make the ring positive.
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
    }
    const pr = area > 0 ? ring : [ring[6], ring[7], ring[4], ring[5], ring[2], ring[3], ring[0], ring[1]];
    blockWalls(W, pr, base, -2, h, {
      tint,
      face: (Wr, i, len) => {
        // The outward face (away from the keep) has the doorway and the carved arms above it.
        const ex = (pr[i * 2] + pr[((i + 1) % 4) * 2]) / 2 - cx, ez = (pr[i * 2 + 1] + pr[((i + 1) % 4) * 2 + 1]) / 2 - cz;
        const outward = (ex * Math.cos(fore) + ez * Math.sin(fore)) / Math.hypot(ex, ez) > 0.9;
        const holes = outward ? [{ pts: archOutline(len / 2 - 0.85, len / 2 + 0.85, 0.05, 2.3, 'pointed', 5), depth: 1.4, glaze: L.DARK, spring: 2.3 }] : [];
        faceWithHoles(Wr, 0, len, -2, h, holes, { tint });
        if (outward) {
          Wr.setLayer(L.ASHLAR).colour(lin('#d8ccb0'));
          Wr.box(len / 2 - 0.75, len / 2 + 0.75, 4.2, 5.8, 0, 0.14, 1 | 4 | 8 | 16 | 32);
        }
        battlements(Wr, 0, len, h, { thick: 0.55, merlonH: 0.9, merlonW: 0.9, gap: 0.6, d0: -0.55, tint });
        return true;
      },
    });
    // Steps: a long straight flight down the motte with low side walls.
    const sx = cx + Math.cos(fore) * (10.6 + d / 2), sz = cz + Math.sin(fore) * (10.6 + d / 2);
    const run = 24.5, steps = 52;
    W.frame(sx, base, sz, Math.cos(fore), Math.sin(fore));
    for (let k = 0; k < steps; k++) {
      const s0 = (k / steps) * run, s1 = ((k + 1) / steps) * run;
      const h = -(k / steps) * top - 0.1;
      W.setLayer(L.ASHLAR).colour(lin('#d2c9b4'));
      W.box(s0, s1 + 0.02, h - top / steps, h, -1.75, 1.75, 16 | 4 | 1 | 2);
    }
    // Central iron handrail on posts, following the slope.
    extrude(W, [[0, 0.95], [0, 0.88], [run, -top + 0.88], [run, -top + 0.95]], -0.03, 0.03, L.PAINT, lin('#2a2c2e'));
    for (let k = 0; k <= 8; k++) {
      const x = (k / 8) * run, y = -(k / 8) * top;
      W.box(x - 0.025, x + 0.025, y - 0.1, y + 0.9, -0.025, 0.025, 1 | 2 | 4 | 8);
    }
    W.frame(sx, base, sz, Math.cos(fore), Math.sin(fore));
    W.setLayer(stoneL).colour(tint, 0.9);
    for (const side of [-1, 1]) {
      const d0 = side * 1.75, d1 = side * 2.15;
      extrude(W, [[0, 0.7], [0, -0.4], [run, -top - 0.4], [run, -top + 0.5]].map(([x, y]) => [x, y]), Math.min(d0, d1), Math.max(d0, d1), stoneL, tint);
    }
  }
  const keep = mesh(W, q);
  g.add(keep);
  g.userData.landmark = 'clifford';
  return g;
}

// ---- The bars, wall towers and walls --------------------------------------------------------------------

const BARS = {
  'Micklegate Bar': { h: 15.5, arch: 'round', storeys: 3, figures: 3, arms: true },
  'Bootham Bar': { h: 14, arch: 'round', storeys: 3, figures: 3, arms: false },
  'Monk Bar': { h: 19, arch: 'pointed', storeys: 4, figures: 4, arms: true, portcullis: true },
  'Walmgate Bar': { h: 13, arch: 'pointed', storeys: 2, figures: 0, arms: false, barbican: true, house: true },
  'Fishergate Bar': { h: 8.5, arch: 'pointed', storeys: 1, figures: 0, arms: false, small: true },
};

/** Is this a named bar or wall tower that landmarks.js builds? */
export function isYorkLandmark(name) {
  return !!BARS[name] || /Tower$|Postern Tower$/.test(name ?? '') && name !== "Clifford's Tower";
}

/** The direction of the nearest city wall to (x, z), from world polylines. */
function wallDirection(walls, x, z) {
  let best = Infinity, dir = null;
  for (const w of walls ?? []) {
    for (let i = 0; i + 3 < w.length; i += 2) {
      const ax = w[i], az = w[i + 1], bx = w[i + 2], bz = w[i + 3];
      const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / l2));
      const d = Math.hypot(x - ax - vx * t, z - az - vz * t);
      if (d < best) {
        best = d;
        const l = Math.sqrt(l2);
        dir = [vx / l, vz / l];
      }
    }
  }
  return best < 30 ? dir : null;
}

/**
 * A bar from its footprint (world ring) and name: a gatehouse tower over an arch passage, corner bartizans on
 * the outer face, battlements and figures; Walmgate with its barbican and Elizabethan timber house.
 * centre: [x, z] of the city (to know which face is outer). walls: world polylines of the city walls.
 */
export function bar(ring, name, { y0 = 12, q, walls = [], centre = [0, 0], writer = null } = {}) {
  const spec = BARS[name] ?? BARS['Bootham Bar'];
  let cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i += 2) {
    cx += ring[i];
    cz += ring[i + 1];
  }
  cx /= ring.length / 2;
  cz /= ring.length / 2;
  // Along the wall (u) and through the passage (v, pointing out of the city).
  let [ux, uz] = wallDirection(walls, cx, cz) ?? [1, 0];
  let vx = -uz, vz = ux;
  if ((cx - centre[0]) * vx + (cz - centre[1]) * vz < 0) {
    vx = -vx;
    vz = -vz;
  }
  // Extent of the footprint along u and v.
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    const dx = ring[i] - cx, dz = ring[i + 1] - cz;
    const u = dx * ux + dz * uz, w = dx * vx + dz * vz;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    w0 = Math.min(w0, w);
    w1 = Math.max(w1, w);
  }
  let halfU = Math.max(3.6, Math.min(6.5, (u1 - u0) / 2)), halfV = Math.max(3, Math.min(5, (w1 - w0) / 2));
  let vMid = (w0 + w1) / 2;
  if (spec.barbican) {
    // The footprint includes the barbican: the gatehouse is its inner (city) end.
    halfV = 4.2;
    vMid = w0 + halfV;
  }
  if (spec.small) {
    halfU = Math.max(3.2, (u1 - u0) / 2);
    halfV = 2.2;
  }
  const W = writer ?? new Writer(TILES);
  const tint = lin('#efe6d0');
  const H = spec.h;
  const ox = cx + vx * vMid, oz = cz + vz * vMid;
  // Local frame for the bar: s along the wall (u), d out of the city (v).
  const P = (s, d) => [ox + ux * s + vx * d, oz + uz * s + vz * d];
  const ringL = [];
  for (const [s, d] of [[-halfU, -halfV], [halfU, -halfV], [halfU, halfV], [-halfU, halfV]]) ringL.push(...P(s, d));
  // Orientation: positive area.
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += ringL[i * 2] * ringL[j * 2 + 1] - ringL[j * 2] * ringL[i * 2 + 1];
  }
  const pr = area > 0 ? ringL : [ringL[6], ringL[7], ringL[4], ringL[5], ringL[2], ringL[3], ringL[0], ringL[1]];
  const archW = spec.small ? 3.4 : 4.4, archH = spec.small ? 3.6 : 4.6;
  blockWalls(W, pr, y0, -0.6, H, {
    tint,
    face: (Wr, i, len) => {
      const a = [pr[i * 2], pr[i * 2 + 1]], b = [pr[((i + 1) % 4) * 2], pr[((i + 1) % 4) * 2 + 1]];
      const mx = (a[0] + b[0]) / 2 - ox, mz = (a[1] + b[1]) / 2 - oz;
      const dv = (mx * vx + mz * vz) / Math.hypot(mx, mz);
      const outer = dv > 0.7, inner = dv < -0.7;
      const holes = [];
      if (outer || inner) {
        // The arch passage through the bar, with smaller windows and slits above.
        holes.push({ pts: archOutline(len / 2 - archW / 2, len / 2 + archW / 2, -0.1, archH, spec.arch, 7), depth: outer ? 2 * halfV + 0.02 : 0.02, spring: archH });
        for (let k = 1; k < spec.storeys; k++) {
          const h = archH + 3 + (k - 1) * 3.2;
          if (h + 1.6 > H - 1.2) break;
          if (outer && spec.arms && k === 1) continue;
          if (inner) holes.push({ pts: [[len / 2 - 0.55, h], [len / 2 + 0.55, h], [len / 2 + 0.55, h + 1.4], [len / 2 - 0.55, h + 1.4]], depth: 0.5, glaze: L.LEADED, variant: k });
          else holes.push({ pts: [[len / 2 - 0.1, h], [len / 2 + 0.1, h], [len / 2 + 0.1, h + 1.5], [len / 2 - 0.1, h + 1.5]], depth: 0.8, glaze: L.DARK });
        }
      } else {
        for (let k = 1; k < spec.storeys; k++) {
          const h = archH + 3 + (k - 1) * 3.2;
          if (h + 1.6 > H - 1.2) break;
          holes.push({ pts: [[len / 2 - 0.1, h], [len / 2 + 0.1, h], [len / 2 + 0.1, h + 1.4], [len / 2 - 0.1, h + 1.4]], depth: 0.8, glaze: L.DARK });
        }
      }
      faceWithHoles(Wr, 0, len, -0.6, H, holes, { tint, frame: lin('#6a5a48') });
      // Passage soffit faces are part of the reveal; the vault inside is dark.
      Wr.setLayer(L.ASHLAR).colour(tint, 0.9);
      Wr.box(0, len, H - 1.6, H - 1.35, 0, 0.14, 1 | 16 | 32);
      if (outer && spec.arms) {
        // The royal arms in a painted panel over the arch.
        Wr.setLayer(L.ASHLAR).colour(lin('#d9cdb2'));
        Wr.box(len / 2 - 1.2, len / 2 + 1.2, archH + 2.6, archH + 4.6, 0, 0.15, 1 | 4 | 8 | 16 | 32);
        Wr.setLayer(L.PAINT).colour(lin('#8a1c22'));
        Wr.box(len / 2 - 0.85, len / 2 + 0.85, archH + 2.85, archH + 4.35, 0.15, 0.2, 1);
        Wr.colour(lin('#c8a43c'));
        Wr.box(len / 2 - 0.35, len / 2 + 0.35, archH + 3.2, archH + 4.0, 0.2, 0.23, 1);
      }
      if (spec.portcullis && outer) {
        // The portcullis, raised, its spikes showing under the arch.
        Wr.setLayer(L.OAK).colour(lin('#2a2420'));
        for (let k = 0; k < 7; k++) {
          const s = len / 2 - archW / 2 + 0.35 + (k * (archW - 0.7)) / 6;
          Wr.box(s - 0.06, s + 0.06, archH - 0.9, archH + archW * 0.3, -0.35, -0.23, 1 | 4 | 8 | 32);
        }
        Wr.box(len / 2 - archW / 2 + 0.2, len / 2 + archW / 2 - 0.2, archH - 0.55, archH - 0.42, -0.36, -0.22, 1 | 16 | 32);
      }
      battlements(Wr, 0, len, H, { thick: 0.6, merlonH: 1.0, merlonW: 1.0, gap: 0.62, d0: -0.6, tint });
      if (outer && spec.figures) {
        // Stone figures on the battlements.
        for (let k = 0; k < spec.figures; k++) {
          const s = len * ((k + 1) / (spec.figures + 1));
          Wr.setLayer(L.ASHLAR).colour(lin('#cfc5ae'));
          Wr.cylinder(s, -0.3, 0.24, 0.2, H + 1.1, H + 2.3, 6);
          Wr.cylinder(s, -0.3, 0.14, 0.12, H + 2.3, H + 2.55, 6);
        }
      }
      return true;
    },
  });
  // Roof deck.
  W.frame(ox, y0, oz, vz, -vx);
  W.setLayer(L.LEAD).colour(LEADC, 0.85);
  W.box(-halfU + 0.6, halfU - 0.6, H - 0.4, H - 0.2, -halfV + 0.6, halfV - 0.6, 16);
  // Local frame for the details: s along the wall, d out of the city (frame u chosen so that its normal is v).
  const fux = vz, fuz = -vx;
  const at = (sv, dv) => [ox + fux * sv + vx * dv, oz + fuz * sv + vz * dv];
  // Bartizans: round turrets corbelled out from the two outer corners, rising above the parapet.
  if (!spec.small) {
    for (const corner of [-halfU, halfU]) {
      // The drum stands clear of both faces, corbelled out from the corner.
      const s = corner + Math.sign(corner) * 0.55, d = halfV + 0.55;
      const r = 1.5;
      const h0 = archH + 3.4;
      W.frame(ox, y0, oz, fux, fuz);
      W.setLayer(stoneL).colour(tint);
      // Corbelling (inverted cone), the turret drum and its own crenellations.
      W.cylinder(s, d, 0.35, r, h0 - 2.2, h0, 10, { top: false });
      W.cylinder(s, d, r, r, h0, H + 2.4, 14, { top: false });
      // Cross slits on the drum, facing out and to the side.
      W.setLayer(L.DARK).setColour(1, 1, 1);
      for (const hh of [h0 + 1.0, h0 + 3.6]) {
        if (hh + 1.2 > H) continue;
        W.quad([s - 0.06, hh, d + r + 0.01], [s + 0.06, hh, d + r + 0.01], [s + 0.06, hh + 1.2, d + r + 0.01], [s - 0.06, hh + 1.2, d + r + 0.01], [0, 0, 1, 0, 1, 1, 0, 1]);
        W.quad([s - 0.25, hh + 0.75, d + r + 0.012], [s + 0.25, hh + 0.75, d + r + 0.012], [s + 0.25, hh + 0.84, d + r + 0.012], [s - 0.25, hh + 0.84, d + r + 0.012], [0, 0, 1, 0, 1, 1, 0, 1]);
      }
      W.setLayer(stoneL).colour(tint);
      W.setLayer(L.ASHLAR).colour(tint, 0.9);
      W.cylinder(s, d, r + 0.12, r + 0.12, H + 2.4, H + 2.65, 12, { top: true });
      W.setLayer(stoneL).colour(tint);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const x = s + Math.cos(a) * (r - 0.15), z = d - Math.sin(a) * (r - 0.15);
        W.box(x - 0.28, x + 0.28, H + 2.65, H + 3.45, z - 0.28, z + 0.28, 1 | 2 | 4 | 8 | 16);
      }
      // A stone figure on each turret.
      if (spec.figures) {
        W.setLayer(L.ASHLAR).colour(lin('#cfc5ae'));
        W.cylinder(s, d, 0.26, 0.2, H + 3.45, H + 4.6, 6);
        W.cylinder(s, d, 0.15, 0.12, H + 4.6, H + 4.88, 6);
      }
    }
  }
  // Walmgate: the barbican in front, a walled forecourt with its own battlemented arch.
  if (spec.barbican) {
    const len = 10.5, wallT = 1.2, wh = 7.5;
    for (const side of [-1, 1]) {
      const sm = side * (archW / 2 + 0.6 + wallT / 2);
      W.frame(ox, y0, oz, fux, fuz);
      W.setLayer(stoneL).colour(tint);
      W.box(sm - wallT / 2, sm + wallT / 2, -0.6, wh, halfV - 0.2, halfV + len, 1 | 2 | 4 | 8);
      // Battlements along its top, in a frame running out along the barbican.
      const [bx, bz] = at(sm, halfV + len / 2);
      W.frame(bx, y0, bz, vx, vz);
      battlements(W, -len / 2, len / 2, wh, { thick: 0.55, merlonH: 0.9, merlonW: 0.9, gap: 0.6, d0: -0.275, tint });
    }
    // Outer gate of the barbican, facing out.
    const fw = archW + 2 * (0.6 + wallT);
    const [ax2, az2] = at(-fw / 2, halfV + len), [bx2, bz2] = at(fw / 2, halfV + len);
    const flen = faceFrame(W, ax2, az2, bx2, bz2, y0, vx, vz);
    faceWithHoles(W, 0, flen, -0.6, wh + 1.5, [{ pts: archOutline(flen / 2 - archW / 2 + 0.3, flen / 2 + archW / 2 - 0.3, -0.1, archH - 0.6, 'pointed', 6), depth: 1.2, spring: archH - 0.6 }], { tint });
    battlements(W, 0, flen, wh + 1.5, { thick: 0.6, merlonH: 0.9, merlonW: 0.9, gap: 0.6, d0: -0.6, tint });
    // The gate's back and sides.
    W.frame(ox, y0, oz, fux, fuz);
    W.setLayer(stoneL).colour(tint, 0.85);
    W.box(-fw / 2, fw / 2, -0.6, wh + 1.5, halfV + len - 1.2, halfV + len, 2 | 4 | 8 | 16);
  }
  if (spec.house) {
    // The Elizabethan timber-framed house on the city side, carried on stone columns.
    const d0 = -halfV - 3.2, d1 = -halfV;
    W.frame(ox, y0, oz, fux, fuz);
    W.setLayer(L.RENDER).colour(lin('#f2ead8'));
    W.box(-halfU + 0.3, halfU - 0.3, archH + 0.6, archH + 5.4, d0, d1, 2 | 1 | 4 | 8 | 32);
    W.setLayer(L.OAK).colour(lin('#2c241e'));
    for (let s = -halfU + 0.5; s < halfU - 0.4; s += 0.55) W.box(s - 0.08, s + 0.08, archH + 0.6, archH + 5.4, d0 - 0.03, d0, 2);
    W.box(-halfU + 0.3, halfU - 0.3, archH + 0.45, archH + 0.75, d0 - 0.05, d1, 2 | 32 | 4 | 8);
    W.setLayer(stoneL).colour(tint);
    for (const s of [-halfU + 0.6, -archW / 2 - 0.4, archW / 2 + 0.4, halfU - 0.6]) W.cylinder(s, d0 + 0.4, 0.28, 0.25, -0.6, archH + 0.45, 8);
    const [hx, hz] = at(0, (d0 + d1) / 2);
    W.frame(hx, y0 + archH + 5.4, hz, fux, fuz);
    W.setLayer(L.PLAINTILE).setColour(1, 1, 1);
    W.prism(-halfU + 0.1, halfU - 0.1, -1.9, 1.9, 0, 2.2, { ends: true });
  }
  if (writer) return null;
  const g = new THREE.Group();
  g.add(mesh(W, q));
  g.userData.landmark = name;
  return g;
}

/** A tower on the walls from its footprint: stone, battlemented; Red Tower in brick under a tiled roof. */
export function wallTower(ring, name, { y0 = 12, q, writer = null } = {}) {
  const W = writer ?? new Writer(TILES);
  const brick = /Red Tower|Davy Tower/.test(name);
  const roofed = /Red Tower|Fishergate Postern/.test(name);
  const tint = brick ? lin('#f4e2d6') : lin('#efe6d0');
  const layer = brick ? L.BRICK : stoneL;
  let area = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  const pr = [];
  if (area > 0) pr.push(...ring);
  else for (let i = n - 1; i >= 0; i--) pr.push(ring[i * 2], ring[i * 2 + 1]);
  const H = /Fishergate Postern/.test(name) ? 12 : brick ? 8.5 : 8;
  blockWalls(W, pr, y0, -0.6, H, {
    layer,
    tint,
    face: (Wr, i, len) => {
      const holes = len > 2.2 ? [{ pts: [[len / 2 - 0.1, H * 0.45], [len / 2 + 0.1, H * 0.45], [len / 2 + 0.1, H * 0.45 + 1.3], [len / 2 - 0.1, H * 0.45 + 1.3]], depth: 0.7, glaze: L.DARK }] : [];
      faceWithHoles(Wr, 0, len, -0.6, H, holes, { layer, tint });
      if (!roofed) battlements(Wr, 0, len, H, { thick: 0.5, merlonH: 0.85, merlonW: 0.9, gap: 0.6, d0: -0.5, tint });
      return true;
    },
  });
  if (roofed) {
    // A hipped roof of clay tiles.
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      cx += pr[i * 2];
      cz += pr[i * 2 + 1];
    }
    cx /= n;
    cz /= n;
    W.frame(cx, y0 + H, cz, 1, 0);
    let rad = 0;
    for (let i = 0; i < n; i++) rad = Math.max(rad, Math.hypot(pr[i * 2] - cx, pr[i * 2 + 1] - cz));
    W.setLayer(L.PANTILE).setColour(1, 1, 1);
    W.pyramid(0, 0, rad + 0.4, -0.2, rad * 0.9, 4, Math.PI / 4);
  } else {
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      cx += pr[i * 2];
      cz += pr[i * 2 + 1];
    }
    W.frame(cx / n, y0 + H - 0.2, cz / n, 1, 0);
    W.setLayer(L.LEAD).colour(LEADC, 0.8);
    const f = [];
    for (let i = 0; i < n; i++) f.push(pr[i * 2] - cx / n, pr[i * 2 + 1] - cz / n);
    W.flat(f, 0, true);
  }
  if (writer) return null;
  const g = new THREE.Group();
  g.add(mesh(W, q));
  g.userData.landmark = name;
  return g;
}

/**
 * The city walls along runs (world polylines with the outward side: out = +1 when the parapet is on the left
 * of the direction of travel… as york.js computes it): the wall body on its rampart, wall-walk, a parapet
 * with merlons (every other one with a cross slit) and a string course. Returns a Group (merged wall per
 * chunk, instanced merlons).
 */
export function cityWalls(runs, { y0 = 12, q } = {}) {
  const group = new THREE.Group();
  const cells = new Map();
  const tint = lin('#efe6d0');
  for (const { run, out } of runs) {
    // A squared pier where the run ends (a road cut through the walls), rising a little above the parapet.
    const nPts = run.length / 2;
    let runLen = 0;
    for (let i = 0; i + 3 < run.length; i += 2) runLen += Math.hypot(run[i + 2] - run[i], run[i + 3] - run[i + 1]);
    if (runLen > 6) {
      for (const [i0, i1] of [[0, 1], [nPts - 1, nPts - 2]]) {
        const px = run[i0 * 2], pz = run[i0 * 2 + 1];
        let tx = run[i1 * 2] - px, tz = run[i1 * 2 + 1] - pz;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const key = `${Math.floor(px / 320)},${Math.floor(pz / 320)}`;
        let Wp = cells.get(key);
        if (!Wp) cells.set(key, (Wp = new Writer(TILES)));
        Wp.frame(px, y0, pz, tx, tz); // s into the wall, d = (−tz, tx)
        // Which way is out of the city in this frame?
        const segOut = i0 === 0 ? 1 : -1; // the run direction is reversed at the far end
        const sign = out * segOut;
        const d0 = sign > 0 ? -1.4 : -1.8, d1 = sign > 0 ? 1.8 : 1.4;
        Wp.setLayer(stoneL).colour(tint, 0.97);
        Wp.box(-0.15, 1.6, 2.4, 7.0, d0, d1, 1 | 2 | 8 | 16);
        Wp.setLayer(L.ASHLAR).colour(tint, 0.9);
        Wp.box(-0.22, 1.67, 7.0, 7.16, d0 - 0.07, d1 + 0.07, 1 | 2 | 8 | 16 | 32);
        Wp.prism(-0.22, 1.67, d0 - 0.07, d1 + 0.07, 7.16, 7.5, { ends: true });
      }
    }
    for (let i = 0; i + 3 < run.length; i += 2) {
      const ax = run[i], az = run[i + 1], bx = run[i + 2], bz = run[i + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) continue;
      const key = `${Math.floor(ax / 320)},${Math.floor(az / 320)}`;
      let W = cells.get(key);
      if (!W) cells.set(key, (W = new Writer(TILES)));
      // Frame so that +d points out of the city: the segment a→b with the outward normal on the right.
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      const nx = dz, nz = -dx; // right of a→b
      // york.js: out = +1 when (−dz, dx)·(p − centre) > 0, i.e. the outward normal is (−dz, dx)·out.
      const ox = -dz * out, oz = dx * out;
      const flip = ox * nx + oz * nz < 0;
      if (flip) W.wallFrame(bx, bz, ax, az, y0);
      else W.wallFrame(ax, az, bx, bz, y0);
      const L0 = 0, L1 = len;
      // Cross-section in d (out of the city): inner face at −1.15, outer face at +1.15 with a batter.
      W.uo = (ax * 0.37 + az * 0.61) % 8;
      W.setLayer(stoneL).colour(tint);
      // Outer face: battered plinth, then plain ashlar to the parapet.
      W.quad([L0, 2.6, 1.55], [L1, 2.6, 1.55], [L1, 3.7, 1.15], [L0, 3.7, 1.15], [L0, 0, L1, 0, L1, 1.2, L0, 1.2]);
      W.rect(L0, L1, 3.7, 6.05, 1.15);
      // String course under the parapet.
      W.setLayer(L.ASHLAR).colour(tint, 0.9);
      W.box(L0, L1, 5.0, 5.18, 1.15, 1.25, 1 | 16 | 32);
      // Parapet top (embrasure sills, weathered outward) and inner face.
      W.setLayer(stoneL).colour(tint, 0.95);
      W.quad([L1, 6.05, 1.15], [L0, 6.05, 1.15], [L0, 6.12, 0.45], [L1, 6.12, 0.45], [L0, 0, L1, 0, L1, 0.7, L0, 0.7]);
      W.colour(tint, 0.85);
      W.quad([L1, 5.1, 0.45], [L0, 5.1, 0.45], [L0, 6.12, 0.45], [L1, 6.12, 0.45], [L0, 0, L1, 0, L1, 1, L0, 1]);
      // Wall-walk (flags) and the inner face down to the rampart.
      W.setLayer(L.ASHLAR).colour(lin('#d6cdb8'));
      W.quad([L0, 5.1, 0.45], [L1, 5.1, 0.45], [L1, 5.1, -1.15], [L0, 5.1, -1.15], [L0, 0, L1, 0, L1, 1.6, L0, 1.6]);
      W.setLayer(stoneL).colour(tint, 0.88);
      W.quad([L1, 2.6, -1.15], [L0, 2.6, -1.15], [L0, 5.1, -1.15], [L1, 5.1, -1.15], [L0, 0, L1, 0, L1, 2.5, L0, 2.5]);
      W.uo = 0;
      // Merlons along the parapet, 1.5 m long with 0.75 m embrasures; every other one has a cross slit.
      for (let t = 0.55, k = Math.floor((ax + az) * 7) & 1; t + 1.5 < len; t += 2.25, k++) {
        const s0 = t, s1 = t + 1.5;
        W.setLayer(stoneL).colour(tint);
        W.box(s0, s1, 6.05, 7.05, 0.45, 1.15, 1 | 2 | 4 | 8);
        W.setLayer(L.ASHLAR).colour(tint, 0.9);
        W.prism(s0 - 0.04, s1 + 0.04, 0.41, 1.19, 7.05, 7.22, { ends: true });
        if (k & 1) {
          const m = (s0 + s1) / 2;
          W.setLayer(L.DARK).setColour(1, 1, 1);
          W.quad([m - 0.05, 6.17, 1.16], [m + 0.05, 6.17, 1.16], [m + 0.05, 6.95, 1.16], [m - 0.05, 6.95, 1.16], [0, 0, 1, 0, 1, 1, 0, 1]);
          W.quad([m - 0.22, 6.65, 1.161], [m + 0.22, 6.65, 1.161], [m + 0.22, 6.73, 1.161], [m - 0.22, 6.73, 1.161], [0, 0, 1, 0, 1, 1, 0, 1]);
        }
      }
    }
  }
  for (const W of cells.values()) {
    const m = mesh(W, q);
    m.geometry.computeBoundingSphere();
    m.userData.centre = m.geometry.boundingSphere.center.clone();
    m.userData.radius = m.geometry.boundingSphere.radius;
    m.userData.maxDistance = 2500;
    m.userData.minDistance = 0;
    group.add(m);
  }
  return group;
}
