// Buildings whose geometry carries the architecture: York's Georgian brick terraces, Victorian terraces,
// stuccoed Regency fronts, limestone civic buildings, jettied timber-framed houses and modern blocks, and Dales
// farmhouses, cottages and field barns.
//
// Every footprint is analysed first: which walls it shares with its neighbours (party walls get no windows and
// carry the chimney stacks, as in a real terrace), which walls face a street (fronts get the door, the shopfront
// and the best windows), and which terrace it belongs to (a terrace shares a style and a height, with small
// variations house to house). Roofs are pitched along the street with real eaves, verges, ridge tiles and
// gables, or hipped, or rise from every wall of an awkward block to a flat lead top.
//
// Near the route each wall is built with its openings cut through it: deep reveals, sash windows set back in
// them, stone sills and lintels or gauged brick arches, doorcases with fanlights, shopfronts with pilasters,
// fascia and stall riser, string courses, plinths, cornices, gutters and downpipes. That geometry is in
// chunks shown within a quality-dependent distance; beyond it the same buildings swap to the painted facades
// (textures.facadeTexture). Roofs, gables and chimney stacks are always drawn; chimney pots are instanced.
import * as THREE from 'three';
import * as C from './common.js';
import { Cells, Writer } from './archgeo.js';
import { L, TILES, FACADE_LAYER, SIGN_PAINTS, materials } from './archtex.js';
import { isYorkLandmark, bar, wallTower } from './landmarks.js';
import * as T from './textures.js';
import { hash2 } from '../../core/world/noise.js';

const CELL = 120;
const BG_CELL = 320;
const DEG = Math.PI / 180;

/** Near-detail distance by quality (metres from the camera to a chunk). */
export function nearDistance(q) {
  return q.shadows ? (q.shadowSize >= 4096 ? 260 : 165) : 105;
}

const lin = (hex) => new THREE.Color(hex);
const pick = (arr, t) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];

// ---- Palettes ------------------------------------------------------------------------------------------
const P = {
  brickTints: ['#ffffff', '#f6ece4', '#fff0e2', '#ebe0d6', '#fff4ea', '#e9dacd', '#f2e4da', '#ffe8dc'].map(lin),
  brick2Tints: ['#ffffff', '#f3e9e4', '#ffeee6', '#e8dcd6', '#f6f0ea'].map(lin),
  renderTints: ['#fbf6e8', '#f6ead0', '#f7e4d6', '#e8f0e6', '#e6ecf2', '#f6e8c0', '#f0dcd4', '#f2eef4', '#fbf1e4', '#e2ead8', '#ffffff', '#f4ecd8'].map(lin),
  stoneTints: ['#ffffff', '#f7f0e0', '#eee5cf', '#f3ead6'].map(lin),
  dalesTints: ['#ffffff', '#f3ead9', '#e9decb', '#f8f1e4', '#ded5c4', '#efe4d0'].map(lin),
  white: lin('#f4f2ea'),
  cream: lin('#ece4cc'),
  stoneTrim: lin('#dcd2bc'),
  yorkStone: lin('#ddd3bb'),
  dalesStone: lin('#c9c0ac'),
  dark: lin('#22262a'),
  iron: lin('#1d2124'),
  doorPaints: ['#16382a', '#111417', '#6e1622', '#1d3a63', '#27323b', '#0f4a4a', '#7a2d18', '#3b2a50', '#2c4a2a', '#5a1a1a', '#1a2a4a'].map(lin),
  oak: lin('#5a4636'),
  tar: lin('#2a221c'),
  cement: lin('#a8a296'),
  potCols: ['#b8643c', '#c46e44', '#a85a36', '#d2b48a', '#6a5a50', '#b06a48', '#c98a5c'].map(lin),
};

// ---- Styles --------------------------------------------------------------------------------------------
// win(k, n): window for storey k of n (0 = ground): w, h, sill height.
const STYLE = {
  georgian: {
    far: 'brick', wall: L.BRICK, tints: P.brickTints, storeyH: [3.3, 3.25, 2.8, 2.5, 2.5], bay: 2.45, reveal: 0.13,
    win: (k) => [{ w: 1.05, h: 1.85, sill: 0.85 }, { w: 1.05, h: 1.95, sill: 0.7 }, { w: 1.0, h: 1.55, sill: 0.62 }, { w: 0.95, h: 1.05, sill: 0.6 }][Math.min(3, k)],
    glaze: () => L.SASH6, head: 'gauged', sill: true, doorcase: 'georgian', door: 0, string: false, plinth: true,
    eaves: 'cornice', parapet: 0.3, roofs: [[L.PANTILE, 0.5], [L.SLATE, 1]], pitch: 37, hip: 0.15, overhang: 0.22, dormer: 0.3, quoins: 0,
  },
  victorian: {
    far: 'brick2', wall: L.BRICK2, tints: P.brick2Tints, storeyH: [3.0, 2.8, 2.6], bay: 2.4, reveal: 0.11,
    win: (k) => [{ w: 1.1, h: 1.9, sill: 0.8 }, { w: 1.0, h: 1.7, sill: 0.72 }, { w: 0.95, h: 1.4, sill: 0.68 }][Math.min(2, k)],
    glaze: (t) => (t < 0.7 ? L.SASH2 : L.SASH1), head: 'lintel', sill: true, doorcase: 'victorian', door: 1, string: false, plinth: false,
    eaves: 'plain', parapet: 0, roofs: [[L.SLATE, 0.8], [L.PANTILE, 1]], pitch: 33, hip: 0.05, overhang: 0.32, dormer: 0.12, quoins: 0, bayWindow: 0.45,
  },
  render: {
    far: 'render', wall: L.RENDER, tints: P.renderTints, storeyH: [3.3, 3.2, 2.8, 2.5], bay: 2.5, reveal: 0.14,
    win: (k) => [{ w: 1.05, h: 1.9, sill: 0.8 }, { w: 1.05, h: 1.95, sill: 0.7 }, { w: 1.0, h: 1.5, sill: 0.62 }, { w: 0.95, h: 1.05, sill: 0.6 }][Math.min(3, k)],
    glaze: () => L.SASH6, head: 'architrave', sill: true, doorcase: 'georgian', door: 0, string: true, plinth: true,
    eaves: 'cornice', parapet: 0.45, roofs: [[L.SLATE, 0.7], [L.PANTILE, 1]], pitch: 33, hip: 0.3, overhang: 0.3, dormer: 0.1, quoins: 0,
  },
  civic: {
    far: 'stone', wall: L.ASHLARWALL, tints: P.stoneTints, storeyH: [4.2, 3.9, 3.4, 3.0, 2.8], bay: 2.75, reveal: 0.2,
    win: (k) => [{ w: 1.4, h: 2.6, sill: 0.95 }, { w: 1.35, h: 2.6, sill: 0.75 }, { w: 1.3, h: 2.0, sill: 0.7 }, { w: 1.2, h: 1.5, sill: 0.6 }][Math.min(3, k)],
    glaze: () => L.SASH6, head: 'pediment', sill: true, doorcase: 'civic', door: 0, string: true, plinth: true,
    eaves: 'cornice', parapet: 0.75, roofs: [[L.SLATE, 0.6], [L.LEAD, 1]], pitch: 28, hip: 0.6, overhang: 0.3, dormer: 0, quoins: 0.6,
  },
  modern: {
    far: 'office', wall: L.BUFF, tints: P.stoneTints, storeyH: [3.6, 3.2, 3.2, 3.2, 3.2, 3.2, 3.2], bay: 2.4, reveal: 0.14,
    win: () => ({ w: 1.75, h: 1.55, sill: 0.9 }),
    glaze: () => L.MODERN, head: 'none', sill: true, doorcase: 'modern', door: 3, string: false, plinth: false,
    eaves: 'parapet', parapet: 1, roofs: [[L.SLATE, 1]], pitch: 25, hip: 0, overhang: 0.25, dormer: 0, quoins: 0,
  },
  timber: {
    far: 'timber', wall: L.RENDER, tints: P.renderTints, storeyH: [2.75, 2.55, 2.45], bay: 2.1, reveal: 0.05,
    win: (k) => (k === 0 ? { w: 1.6, h: 1.3, sill: 0.9 } : { w: 1.55, h: 1.1, sill: 0.75 }),
    glaze: () => L.LEADED, head: 'none', sill: false, doorcase: 'plain', door: 2, string: false, plinth: false,
    eaves: 'plain', parapet: 0, roofs: [[L.PLAINTILE, 0.75], [L.PANTILE, 1]], pitch: 50, hip: 0, overhang: 0.38, dormer: 0, quoins: 0, jetty: 0.42,
  },
  outbuilding: {
    far: 'brick', wall: L.BRICK, tints: P.brickTints, storeyH: [2.7], bay: 3, reveal: 0.1,
    win: () => ({ w: 0.9, h: 0.9, sill: 1.1 }),
    glaze: () => L.CASEMENT, head: 'none', sill: true, doorcase: 'plain', door: 2, string: false, plinth: false,
    eaves: 'plain', parapet: 0, roofs: [[L.PANTILE, 0.5], [L.SLATE, 1]], pitch: 25, hip: 0, overhang: 0.2, dormer: 0, quoins: 0, sparse: true,
  },
  church: {
    far: 'church', wall: L.LIMESTONE, tints: P.stoneTints, storeyH: [7.5], bay: 3.6, reveal: 0.3,
    win: () => ({ w: 1.5, h: 4.2, sill: 1.8 }),
    glaze: () => L.LANCET, head: 'none', sill: true, doorcase: 'plain', door: 2, string: true, plinth: true,
    eaves: 'plain', parapet: 0, roofs: [[L.SLATE, 0.5], [L.LEAD, 1]], pitch: 45, hip: 0, overhang: 0.25, dormer: 0, quoins: 0, buttress: true,
  },
  // The Dales: gritstone or limestone farmhouses and cottages with stone surrounds, quoins, coped gables with
  // kneelers, gable-end stacks and stone-slate roofs; and field barns.
  cottage: {
    far: 'cottage', wall: L.DALESLIME, tints: P.dalesTints, storeyH: [2.75, 2.6, 2.5], bay: 2.4, reveal: 0.3,
    win: (k) => (k === 0 ? { w: 1.0, h: 1.25, sill: 0.85 } : { w: 1.0, h: 1.1, sill: 0.62 }),
    glaze: (t) => (t < 0.6 ? L.SASH2 : L.CASEMENT), head: 'surround', sill: true, doorcase: 'stone', door: 2, string: false, plinth: false,
    eaves: 'tight', parapet: 0, roofs: [[L.STONESLATE, 1]], pitch: 33, hip: 0, overhang: 0.12, dormer: 0, quoins: 1, coped: true,
  },
  dalesRender: {
    far: 'render', wall: L.RENDER, tints: P.renderTints, storeyH: [2.8, 2.6, 2.5], bay: 2.4, reveal: 0.3,
    win: (k) => (k === 0 ? { w: 1.05, h: 1.35, sill: 0.85 } : { w: 1.05, h: 1.2, sill: 0.62 }),
    glaze: () => L.SASH6, head: 'surround', sill: true, doorcase: 'stone', door: 0, string: false, plinth: false,
    eaves: 'tight', parapet: 0, roofs: [[L.SLATE, 1]], pitch: 33, hip: 0, overhang: 0.12, dormer: 0, quoins: 1, coped: true,
  },
  barn: {
    far: 'barn', wall: L.DALESLIME, tints: P.dalesTints, storeyH: [5.2], bay: 4, reveal: 0.35,
    win: () => ({ w: 0.5, h: 0.7, sill: 2.6 }),
    glaze: () => L.DARK, head: 'surround', sill: false, doorcase: 'barn', door: 2, string: false, plinth: false,
    eaves: 'tight', parapet: 0, roofs: [[L.STONESLATE, 1]], pitch: 30, hip: 0, overhang: 0.1, dormer: 0, quoins: 1, coped: false, throughStones: true, sparse: true,
  },
};

// ---- Footprints ----------------------------------------------------------------------------------------

function cleanRing(flat) {
  let pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.05) pts.pop();
  pts = pts.filter((p, i) => {
    const q = pts[(i + pts.length - 1) % pts.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.3;
  });
  // Drop vertices on a straight line (OSM often has extra nodes along a wall) and spikes.
  for (let guard = 0; guard < 200 && pts.length > 3; guard++) {
    let removed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (l1 < 1e-6 || l2 < 1e-6) {
        pts.splice(i, 1);
        removed = true;
        break;
      }
      const cr = ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) / (l1 * l2);
      const dt = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (l1 * l2);
      if ((Math.abs(cr) < 0.12 && dt > 0) || dt < -0.97) {
        pts.splice(i, 1);
        removed = true;
        break;
      }
    }
    if (!removed) break;
  }
  if (pts.length < 3) return null;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  if (area < 0) pts.reverse();
  return { pts, area: Math.abs(area) / 2 };
}

/** Principal-axis bounding rectangle: centre, unit long axis, half sizes. */
function obbOf(pts) {
  let mx = 0, mz = 0;
  for (const p of pts) {
    mx += p[0];
    mz += p[1];
  }
  mx /= pts.length;
  mz /= pts.length;
  let cxx = 0, czz = 0, cxz = 0;
  for (const p of pts) {
    const dx = p[0] - mx, dz = p[1] - mz;
    cxx += dx * dx;
    czz += dz * dz;
    cxz += dx * dz;
  }
  const t = 0.5 * Math.atan2(2 * cxz, cxx - czz);
  return rectAlong(pts, Math.cos(t), Math.sin(t));
}

/** Bounding rectangle of the points with sides along (ux, uz): centre, half extents along u (la) and across (lb). */
function rectAlong(pts, ux, uz) {
  const vx = -uz, vz = ux;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of pts) {
    const a = p[0] * ux + p[1] * uz, b = p[0] * vx + p[1] * vz;
    a0 = Math.min(a0, a);
    a1 = Math.max(a1, a);
    b0 = Math.min(b0, b);
    b1 = Math.max(b1, b);
  }
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  return { cx: ux * ca + vx * cb, cz: uz * ca + vz * cb, ux, uz, la: (a1 - a0) / 2, lb: (b1 - b0) / 2 };
}

function makeBuilding(src, i) {
  const ring = cleanRing(src.ring);
  if (!ring) return null;
  const pts = ring.pts;
  const edges = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
    edges.push({ k, ax: a[0], az: a[1], bx: b[0], bz: b[1], len, dx, dz, nx: dz, nz: -dx, covered: [], party: 0, front: 0, neighbour: -1 });
  }
  let cx = 0, cz = 0;
  for (const p of pts) {
    cx += p[0];
    cz += p[1];
  }
  cx /= pts.length;
  cz /= pts.length;
  const obb = obbOf(pts);
  return { i, src, pts, edges, cx, cz, area: ring.area, obb, rectness: ring.area / (4 * obb.la * obb.lb), y: src.y ?? 0, h: src.h ?? 8, k: src.k ?? 'house', name: src.n ?? '', group: i, hash: hash2(Math.round(cx * 3), Math.round(cz * 3), 77) };
}

/** Marks walls shared with a neighbour (coincident, facing the other way) and groups terraces. */
function findPartyWalls(bs) {
  const GS = 10;
  const grid = new Map();
  const keyOf = (x, z) => `${Math.floor(x / GS)},${Math.floor(z / GS)}`;
  for (const b of bs) {
    for (const e of b.edges) {
      const x0 = Math.min(e.ax, e.bx) - 1, x1 = Math.max(e.ax, e.bx) + 1, z0 = Math.min(e.az, e.bz) - 1, z1 = Math.max(e.az, e.bz) + 1;
      for (let gx = Math.floor(x0 / GS); gx <= Math.floor(x1 / GS); gx++) {
        for (let gz = Math.floor(z0 / GS); gz <= Math.floor(z1 / GS); gz++) {
          const k = `${gx},${gz}`;
          let l = grid.get(k);
          if (!l) grid.set(k, (l = []));
          l.push([b, e]);
        }
      }
    }
  }
  const parent = bs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const b of bs) {
    for (const e of b.edges) {
      const seen = new Set();
      const x0 = Math.min(e.ax, e.bx) - 1, x1 = Math.max(e.ax, e.bx) + 1, z0 = Math.min(e.az, e.bz) - 1, z1 = Math.max(e.az, e.bz) + 1;
      for (let gx = Math.floor(x0 / GS); gx <= Math.floor(x1 / GS); gx++) {
        for (let gz = Math.floor(z0 / GS); gz <= Math.floor(z1 / GS); gz++) {
          for (const [ob, f] of grid.get(`${gx},${gz}`) ?? []) {
            if (ob === b || seen.has(f)) continue;
            seen.add(f);
            if (e.dx * f.dx + e.dz * f.dz > -0.95) continue;
            const da = (f.ax - e.ax) * e.nx + (f.az - e.az) * e.nz, db = (f.bx - e.ax) * e.nx + (f.bz - e.az) * e.nz;
            if (Math.abs(da) > 0.9 || Math.abs(db) > 0.9) continue;
            const ta = (f.ax - e.ax) * e.dx + (f.az - e.az) * e.dz, tb = (f.bx - e.ax) * e.dx + (f.bz - e.az) * e.dz;
            const t0 = Math.max(0, Math.min(ta, tb)), t1 = Math.min(e.len, Math.max(ta, tb));
            if (t1 - t0 > 0.3) {
              e.covered.push([t0, t1, ob.i]);
              if (e.neighbour < 0 || t1 - t0 > e.len * 0.5) e.neighbour = ob.i;
            }
          }
        }
      }
      if (e.covered.length) {
        e.covered.sort((a, c) => a[0] - c[0]);
        let tot = 0, end = 0;
        for (const [t0, t1] of e.covered) {
          const s = Math.max(t0, end);
          if (t1 > s) tot += t1 - s;
          end = Math.max(end, t1);
        }
        e.party = tot / e.len;
        if (e.party > 0.5) {
          const o = bs[e.neighbour];
          // Terraces: houses and shops of a similar size join a group (big blocks keep their own style).
          if (o && b.area < 900 && o.area < 900) parent[find(b.i)] = find(o.i);
        }
      }
    }
  }
  for (const b of bs) b.group = find(b.i);
}

/** Road corridors on a grid, for finding which walls face a street. */
function roadIndex(roads) {
  const GS = 16;
  const grid = new Map();
  for (const r of roads) {
    const p = r.p, half = (r.w ?? 6) / 2;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = Math.min(p[i], p[i + 2]) - half - 1, x1 = Math.max(p[i], p[i + 2]) + half + 1;
      const z0 = Math.min(p[i + 1], p[i + 3]) - half - 1, z1 = Math.max(p[i + 1], p[i + 3]) + half + 1;
      const seg = { ax: p[i], az: p[i + 1], bx: p[i + 2], bz: p[i + 3], half, weight: r.weight ?? 1 };
      for (let gx = Math.floor(x0 / GS); gx <= Math.floor(x1 / GS); gx++) {
        for (let gz = Math.floor(z0 / GS); gz <= Math.floor(z1 / GS); gz++) {
          const k = `${gx},${gz}`;
          let l = grid.get(k);
          if (!l) grid.set(k, (l = []));
          l.push(seg);
        }
      }
    }
  }
  return (x, z) => {
    let best = 0;
    for (const s of grid.get(`${Math.floor(x / GS)},${Math.floor(z / GS)}`) ?? []) {
      const vx = s.bx - s.ax, vz = s.bz - s.az;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * vx + (z - s.az) * vz) / (vx * vx + vz * vz || 1)));
      const d = Math.hypot(x - s.ax - vx * t, z - s.az - vz * t);
      if (d < s.half + 0.6 && s.weight > best) best = s.weight;
    }
    return best;
  };
}

/** Scores each wall by the street it faces (0 = none): looks out along the wall's normal for a road. */
function findFronts(bs, roadAt, routeAt) {
  for (const b of bs) {
    for (const e of b.edges) {
      if (e.party > 0.6 || e.len < 2) continue;
      const mx = (e.ax + e.bx) / 2, mz = (e.az + e.bz) / 2;
      for (const t of [1.2, 2.6, 4.5, 7, 10, 14, 19]) {
        const x = mx + e.nx * t, z = mz + e.nz * t;
        const w = Math.max(roadAt ? roadAt(x, z) : 0, routeAt ? routeAt(x, z) : 0);
        if (w > 0) {
          e.front = w * (1 - t / 26);
          break;
        }
      }
    }
    let best = null;
    for (const e of b.edges) if (e.front > 0 && (!best || e.front * Math.min(1, e.len / 6) > best.front * Math.min(1, best.len / 6))) best = e;
    b.main = best;
  }
}

// ---- Styles, heights and roof plans ------------------------------------------------------------------------

function chooseStyle(b, ctx) {
  if (ctx.style) return ctx.style(b);
  const t = b.groupHash;
  const big = b.area > 650 || b.h >= 16 || (b.k === 'commercial' && b.area > 350);
  if (b.k === 'church') return 'church';
  if (b.area < 26 || b.h < 4) return 'outbuilding';
  if (big) return b.inside ? (t < 0.4 ? 'civic' : t < 0.72 ? 'georgian' : 'modern') : t < 0.55 ? 'modern' : t < 0.8 ? 'victorian' : 'civic';
  if (b.inside) {
    if (b.area < 170 && hash2(b.i, 3, 5) < 0.17) return 'timber';
    if (t < 0.48) return 'georgian';
    if (t < 0.66) return 'render';
    if (t < 0.9) return 'victorian';
    return 'civic';
  }
  if (t < 0.55) return 'victorian';
  if (t < 0.8) return 'georgian';
  if (t < 0.92) return 'render';
  return 'modern';
}

function storeyCount(b, st, t) {
  if (st === STYLE.outbuilding) return 1;
  if (st === STYLE.church || st === STYLE.barn) return 1;
  if (Math.abs(b.h - 8) > 0.01 && b.h > 3) {
    // A real height from the map.
    let n = 0, y = 0;
    while (y + st.storeyH[Math.min(n, st.storeyH.length - 1)] * 0.6 < b.h && n < 14) y += st.storeyH[Math.min(n++, st.storeyH.length - 1)];
    return Math.max(1, n);
  }
  if (st === STYLE.georgian) return t < 0.22 ? 2 : t < 0.86 ? 3 : 4;
  if (st === STYLE.victorian) return t < 0.72 ? 2 : 3;
  if (st === STYLE.render) return t < 0.3 ? 2 : t < 0.9 ? 3 : 4;
  if (st === STYLE.civic) return t < 0.5 ? 3 : 4;
  if (st === STYLE.modern) return 3 + Math.floor(t * 3);
  if (st === STYLE.timber) return t < 0.25 ? 2 : 3;
  return 2;
}

function setHeights(b, n) {
  const st = b.st;
  b.storeys = [];
  let y = 0;
  for (let k = 0; k < n; k++) {
    let h = st.storeyH[Math.min(k, st.storeyH.length - 1)];
    if (k === 0 && b.shop) h = Math.max(h, 3.75);
    b.storeys.push({ y0: y, h, k });
    y += h;
  }
  b.eaves = y + (b.st.eaves === 'parapet' ? 0 : 0.25);
}

/** Pitched roof over a rectangle aligned with the main front, a hipped-to-flat roof, or a flat one. */
function planRoof(b, ctx) {
  const st = b.st;
  const t = hash2(b.group, 11, 3);
  const roofLayer = (() => {
    let x = hash2(b.group, 5, 9);
    if (ctx.roofLayer) return ctx.roofLayer(b) ?? st.roofs[0][0];
    if (b.inside && (st === STYLE.georgian || st === STYLE.victorian)) x *= 0.85; // York's old town is mostly pantile
    for (const [layer, p] of st.roofs) if (x <= p) return layer;
    return st.roofs[st.roofs.length - 1][0];
  })();
  b.roofLayer = roofLayer;
  const flat = st.eaves === 'parapet' || b.area > 2600 || b.storeys.length > 6;
  if (flat) {
    b.roof = { type: 'flat' };
    return;
  }
  const pitch = (st.pitch + (t - 0.5) * 6) * DEG;
  if (b.rectness > 0.8 && b.pts.length <= 8) {
    // Ridge parallel to the street for terraces; gable to the street for many timber houses.
    let ux = b.obb.ux, uz = b.obb.uz;
    if (b.main) {
      const gableFront = st.jetty && hash2(b.i, 19, 2) < 0.6;
      ux = gableFront ? b.main.nx : b.main.dx;
      uz = gableFront ? b.main.nz : b.main.dz;
      b.gableFront = gableFront;
    }
    const r = rectAlong(b.pts, ux, uz);
    // Keep the roof span sensible: very deep plans turn the ridge to the long axis.
    if (r.lb > 7.5 && r.la < r.lb) {
      const r2 = rectAlong(b.pts, -uz, ux);
      Object.assign(r, r2);
      b.gableFront = false;
    }
    const ends = [-1, 1].map((sgn) => endKind(b, r, sgn));
    b.roof = { type: 'rect', ...r, pitch, rise: Math.min(r.lb * Math.tan(pitch), 7), ends };
    return;
  }
  b.roof = { type: 'inset', pitch };
}

/** Is the rectangle's end at u = sgn·la a party wall (hidden gable), or exposed (gable or hip)? */
function endKind(b, r, sgn) {
  let party = false, exposed = false;
  for (const e of b.edges) {
    const mx = (e.ax + e.bx) / 2 - r.cx, mz = (e.az + e.bz) / 2 - r.cz;
    const u = mx * r.ux + mz * r.uz;
    if (Math.abs(u - sgn * r.la) > 0.8) continue;
    if (Math.abs(e.dx * r.ux + e.dz * r.uz) > 0.4) continue; // not across the end
    if (e.party > 0.5) party = true;
    else exposed = true;
  }
  if (party && !exposed) return 'party';
  return hash2(b.group, sgn + 7, 13) < b.st.hip ? 'hip' : 'gable';
}

// ---- Facades (near detail) ------------------------------------------------------------------------------

/** Window centres along a wall s ∈ [0, len], avoiding stretches covered by a neighbour. */
function baysFor(len, pitch, margin, blocked) {
  const usable = len - 2 * margin;
  if (usable < pitch * 0.55) return len >= 1.9 && !blocked(len / 2) ? [len / 2] : [];
  const n = Math.max(1, Math.round(usable / pitch));
  const p = usable / n;
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = margin + p * (k + 0.5);
    if (!blocked(s)) out.push(s);
  }
  return out;
}

/** Wall face with rectangular holes: rows between all opening edges, the gaps between openings filled. */
function wallWithHoles(W, sA, sB, h0, h1, holes) {
  const hs = new Set([h0, h1]);
  for (const o of holes) {
    if (o.h1 <= h0 || o.h0 >= h1) continue;
    hs.add(Math.max(h0, o.h0));
    hs.add(Math.min(h1, o.h1));
  }
  const rows = [...hs].sort((a, b) => a - b);
  for (let r = 0; r < rows.length - 1; r++) {
    const ya = rows[r], yb = rows[r + 1];
    if (yb - ya < 1e-4) continue;
    const spans = holes.filter((o) => o.h0 <= ya + 1e-4 && o.h1 >= yb - 1e-4 && o.s1 > sA && o.s0 < sB).map((o) => [Math.max(sA, o.s0), Math.min(sB, o.s1)]).sort((a, b) => a[0] - b[0]);
    let s = sA;
    for (const [a, b] of spans) {
      if (a > s + 1e-4) W.rect(s, a, ya, yb);
      s = Math.max(s, b);
    }
    if (s < sB - 1e-4) W.rect(s, sB, ya, yb);
  }
}

/** The four reveal faces of an opening, depth dr into the wall (wall layer, shaded for depth). */
function reveals(W, s0, s1, h0, h1, dr, tint, { sill = true, head = true } = {}) {
  W.colour(tint, 0.8);
  W.quad([s0, h0, 0], [s0, h0, -dr], [s0, h1, -dr], [s0, h1, 0], [0, h0, dr, h0, dr, h1, 0, h1]);
  W.quad([s1, h0, -dr], [s1, h0, 0], [s1, h1, 0], [s1, h1, -dr], [0, h0, dr, h0, dr, h1, 0, h1]);
  if (head) {
    W.colour(tint, 0.6);
    W.quad([s0, h1, -dr], [s1, h1, -dr], [s1, h1, 0], [s0, h1, 0], [s0, 0, s1, 0, s1, dr, s0, dr]);
  }
  if (sill) {
    W.colour(tint, 0.92);
    W.quad([s0, h0, 0], [s1, h0, 0], [s1, h0, -dr], [s0, h0, -dr], [s0, 0, s1, 0, s1, dr, s0, dr]);
  }
}

/** A quarter of a four-variant glazing layer as uv bounds. */
const quarter = (v) => [(v % 2) * 0.5, v < 2 ? 0.5 : 0];

function glass(W, layer, s0, s1, h0, h1, d, variant, frameCol) {
  W.setLayer(layer).colour(frameCol);
  let u0 = 0, v0 = 0, du = 1, dv = 1;
  if (layer === L.LANCET) {
    u0 = (variant % 4) * 0.25;
    du = 0.25;
  } else if (layer !== L.FAN && layer !== L.ROSE && layer !== L.WESTWIN && layer !== L.EASTWIN && layer !== L.DARK && layer !== L.LOUVRE) {
    [u0, v0] = quarter(variant % 4);
    du = dv = 0.5;
  }
  W.quad([s0, h0, d], [s1, h0, d], [s1, h1, d], [s0, h1, d], [u0, v0, u0 + du, v0, u0 + du, v0 + dv, u0, v0 + dv]);
}

/** Emits a window: reveals, glass (sashes stepped), sill and head. */
function windowAt(W, b, s, w, h0, h, o) {
  const st = b.st;
  const s0 = s - w / 2, s1 = s + w / 2, h1 = h0 + h, dr = st.reveal;
  W.setLayer(st.wall);
  reveals(W, s0, s1, h0, h1, dr, o.tint ?? b.tint);
  const g = o.glaze;
  if (g === L.SASH6 || g === L.SASH2 || g === L.SASH1) {
    // The upper sash sits a few centimetres behind the lower one.
    const hm = (h0 + h1) / 2;
    W.setLayer(g).colour(b.frame);
    const [u0, v0] = quarter(o.variant);
    W.quad([s0, hm, -dr - 0.04], [s1, hm, -dr - 0.04], [s1, h1, -dr - 0.04], [s0, h1, -dr - 0.04], [u0, v0 + 0.25, u0 + 0.5, v0 + 0.25, u0 + 0.5, v0 + 0.5, u0, v0 + 0.5]);
    W.quad([s0, h0, -dr], [s1, h0, -dr], [s1, hm, -dr], [s0, hm, -dr], [u0, v0, u0 + 0.5, v0, u0 + 0.5, v0 + 0.25, u0, v0 + 0.25]);
    // Top of the lower sash's meeting rail, catching the light.
    W.setLayer(L.PAINT).colour(b.frame, 0.95);
    W.quad([s0, hm, -dr], [s1, hm, -dr], [s1, hm, -dr - 0.04], [s0, hm, -dr - 0.04], [s0, 0, s1, 0, s1, 0.04, s0, 0.04]);
    W.colour(b.frame, 0.7);
    W.box(s0 + 0.02, s1 - 0.02, hm - 0.035, hm, -dr - 0.005, -dr + 0.02, 1 | 16);
  } else {
    glass(W, g, s0, s1, h0, h1, -dr, o.variant, b.frame);
  }
  // Sill: stone, projecting, with drip shadow below.
  if (st.sill) {
    W.setLayer(L.ASHLAR).colour(b.trim);
    W.box(s0 - 0.07, s1 + 0.07, h0 - 0.09, h0, -dr + 0.02, 0.07, 1 | 4 | 8 | 16 | 32);
  }
  head(W, b, s0, s1, h1, o);
}

function head(W, b, s0, s1, h1, o) {
  const kind = o.head ?? b.st.head;
  if (kind === 'lintel') {
    W.setLayer(L.ASHLAR).colour(b.trim);
    W.box(s0 - 0.12, s1 + 0.12, h1, h1 + 0.24, 0, 0.03, 1 | 4 | 8 | 16 | 32);
    if (o.keystone) W.box((s0 + s1) / 2 - 0.1, (s0 + s1) / 2 + 0.1, h1 - 0.02, h1 + 0.3, 0, 0.055, 1 | 4 | 8 | 16 | 32);
  } else if (kind === 'surround') {
    // Dales: heavy stone lintel and jambs round the opening.
    W.setLayer(L.ASHLAR).colour(b.trim);
    W.box(s0 - 0.16, s1 + 0.16, h1, h1 + 0.28, 0, 0.025, 1 | 4 | 8 | 16 | 32);
    W.box(s0 - 0.16, s0, o.h0 ?? h1 - 1.2, h1, 0, 0.02, 1 | 8);
    W.box(s1, s1 + 0.16, o.h0 ?? h1 - 1.2, h1, 0, 0.02, 1 | 4);
  } else if (kind === 'architrave' || kind === 'pediment') {
    const h0 = o.h0 ?? h1 - 1.8;
    W.setLayer(L.PAINT).colour(b.st === STYLE.civic ? b.trim : b.archCol);
    if (b.st === STYLE.civic) W.setLayer(L.ASHLAR);
    W.box(s0 - 0.13, s0, h0 - 0.02, h1 + 0.13, 0, 0.04, 1 | 8 | 16);
    W.box(s1, s1 + 0.13, h0 - 0.02, h1 + 0.13, 0, 0.04, 1 | 4 | 16);
    W.box(s0, s1, h1, h1 + 0.13, 0, 0.04, 1 | 32 | 16);
    if (kind === 'pediment' && o.storey === 1) {
      W.box(s0 - 0.2, s1 + 0.2, h1 + 0.13, h1 + 0.24, 0, 0.12, 1 | 4 | 8 | 16 | 32);
      const m = (s0 + s1) / 2, pw = (s1 - s0) / 2 + 0.22, ph = 0.42;
      W.tri([m - pw, h1 + 0.24, 0.1], [m + pw, h1 + 0.24, 0.1], [m, h1 + 0.24 + ph, 0.1], [m - pw, 0, m + pw, 0, m, ph]);
      const sl = Math.hypot(pw, ph);
      W.quad([m, h1 + 0.24 + ph, 0.1], [m + pw, h1 + 0.24, 0.1], [m + pw, h1 + 0.24, 0], [m, h1 + 0.24 + ph, 0], [0, 0, sl, 0, sl, 0.1, 0, 0.1]);
      W.quad([m - pw, h1 + 0.24, 0.1], [m, h1 + 0.24 + ph, 0.1], [m, h1 + 0.24 + ph, 0], [m - pw, h1 + 0.24, 0], [0, 0, sl, 0, sl, 0.1, 0, 0.1]);
    } else if (o.storey === 1 && b.st !== STYLE.civic) {
      // A moulded hood over the first-floor windows.
      W.box(s0 - 0.2, s1 + 0.2, h1 + 0.13, h1 + 0.22, 0, 0.11, 1 | 4 | 8 | 16 | 32);
    }
  }
}

/** Front door with its doorcase, step and fanlight. s is the centre of the door. */
function doorAt(W, b, s, o = {}) {
  const st = b.st;
  const kind = o.kind ?? st.doorcase;
  const w = kind === 'barn' ? 3.2 : kind === 'modern' ? 1.8 : kind === 'civic' ? 1.5 : 1.05;
  const s0 = s - w / 2, s1 = s + w / 2;
  const step = kind === 'barn' || kind === 'modern' ? 0 : 0.16;
  const leaf = kind === 'barn' ? 3.0 : kind === 'civic' ? 2.7 : kind === 'modern' ? 2.4 : kind === 'stone' || kind === 'plain' ? 2.0 : 2.2;
  const light = kind === 'georgian' || kind === 'civic' ? w * 0.48 : kind === 'victorian' ? 0.42 : 0;
  const top = step + leaf + light;
  const dr = kind === 'victorian' ? 0.36 : kind === 'barn' ? 0.3 : kind === 'modern' ? 0.18 : 0.22;
  W.setLayer(st.wall);
  reveals(W, s0, s1, step, top, dr, o.tint ?? b.tint, { sill: false });
  // Floor of the doorway.
  W.setLayer(L.ASHLAR).colour(P.stoneTrim, 0.85);
  W.quad([s0, step, 0], [s1, step, 0], [s1, step, -dr], [s0, step, -dr], [s0, 0, s1, 0, s1, dr, s0, dr]);
  // Leaf.
  const variant = kind === 'barn' ? 2 : kind === 'modern' ? 3 : o.variant ?? st.door;
  W.setLayer(L.DOOR).colour(kind === 'modern' ? P.dark : o.paint ?? b.doorPaint);
  const u0 = variant * 0.25;
  if (kind === 'barn') {
    // A pair of boarded doors.
    W.quad([s0, step, -dr], [s, step, -dr], [s, step + leaf, -dr], [s0, step + leaf, -dr], [u0, 0, u0 + 0.25, 0, u0 + 0.25, 1, u0, 1]);
    W.quad([s, step, -dr], [s1, step, -dr], [s1, step + leaf, -dr], [s, step + leaf, -dr], [u0, 0, u0 + 0.25, 0, u0 + 0.25, 1, u0, 1]);
  } else {
    W.quad([s0, step, -dr], [s1, step, -dr], [s1, step + leaf, -dr], [s0, step + leaf, -dr], [u0, 0, u0 + 0.25, 0, u0 + 0.25, 1, u0, 1]);
  }
  if (light > 0) {
    W.setLayer(L.PAINT).colour(b.frame);
    W.box(s0, s1, step + leaf, step + leaf + 0.06, -dr, -dr + 0.04, 1 | 16 | 32);
    glass(W, kind === 'victorian' ? L.SASH1 : L.FAN, s0, s1, step + leaf + 0.06, top, -dr + 0.01, Math.floor(b.hash * 4), b.frame);
  }
  if (step > 0) {
    W.setLayer(L.ASHLAR).colour(P.stoneTrim, 0.92);
    W.box(s0 - 0.18, s1 + 0.18, 0, step, -0.02, 0.34, 1 | 4 | 8 | 16);
  }
  // Doorcase.
  if (kind === 'georgian' || kind === 'civic') {
    const c = kind === 'civic' ? b.trim : P.white;
    W.setLayer(kind === 'civic' ? L.ASHLAR : L.PAINT).colour(c);
    const pw = kind === 'civic' ? 0.3 : 0.2;
    W.box(s0 - pw - 0.04, s0 - 0.04, step, top + 0.02, 0, 0.1, 1 | 4 | 8);
    W.box(s1 + 0.04, s1 + pw + 0.04, step, top + 0.02, 0, 0.1, 1 | 4 | 8);
    // Capitals.
    W.box(s0 - pw - 0.08, s0, top - 0.12, top + 0.02, 0, 0.13, 1 | 4 | 8 | 32);
    W.box(s1, s1 + pw + 0.08, top - 0.12, top + 0.02, 0, 0.13, 1 | 4 | 8 | 32);
    W.box(s0 - pw - 0.1, s1 + pw + 0.1, top + 0.02, top + 0.3, 0, 0.12, 1 | 4 | 8 | 32);
    W.box(s0 - pw - 0.2, s1 + pw + 0.2, top + 0.3, top + 0.42, 0, 0.24, 1 | 4 | 8 | 16 | 32);
    if (b.hash > 0.45 || kind === 'civic') {
      // Open the tympanum a shade darker than the raking cornice above it.
      const m = s, pw2 = w / 2 + pw + 0.16, ph = 0.4, y = top + 0.42;
      W.colour(kind === 'civic' ? b.trim : P.white, 0.86);
      W.tri([m - pw2, y, 0.13], [m + pw2, y, 0.13], [m, y + ph, 0.13], [m - pw2, 0, m + pw2, 0, m, ph]);
      W.colour(kind === 'civic' ? b.trim : P.white);
      const sl = Math.hypot(pw2, ph);
      W.quad([m, y + ph + 0.06, 0.2], [m + pw2 + 0.06, y - 0.02, 0.2], [m + pw2 + 0.06, y - 0.02, 0], [m, y + ph + 0.06, 0], [0, 0, sl, 0, sl, 0.2, 0, 0.2]);
      W.quad([m - pw2 - 0.06, y - 0.02, 0.2], [m, y + ph + 0.06, 0.2], [m, y + ph + 0.06, 0], [m - pw2 - 0.06, y - 0.02, 0], [0, 0, sl, 0, sl, 0.2, 0, 0.2]);
      W.colour(kind === 'civic' ? b.trim : P.white, 0.7);
      W.quad([m + pw2 + 0.06, y - 0.02, 0.2], [m, y + ph + 0.06, 0.2], [m, y + ph - 0.02, 0.13], [m + pw2 - 0.02, y, 0.13], [0, 0, 1, 0, 1, 0.1, 0, 0.1]);
      W.quad([m, y + ph + 0.06, 0.2], [m - pw2 - 0.06, y - 0.02, 0.2], [m - pw2 + 0.02, y, 0.13], [m, y + ph - 0.02, 0.13], [0, 0, 1, 0, 1, 0.1, 0, 0.1]);
    }
  } else if (kind === 'victorian') {
    W.setLayer(L.ASHLAR).colour(b.trim);
    W.box(s0 - 0.14, s1 + 0.14, top, top + 0.3, 0, 0.04, 1 | 4 | 8 | 16 | 32);
    W.box(s - 0.11, s + 0.11, top - 0.02, top + 0.36, 0, 0.07, 1 | 4 | 8 | 16 | 32);
  } else if (kind === 'stone' || kind === 'barn') {
    W.setLayer(L.ASHLAR).colour(b.trim);
    W.box(s0 - 0.2, s1 + 0.2, top, top + (kind === 'barn' ? 0.4 : 0.32), 0, 0.03, 1 | 4 | 8 | 16 | 32);
    W.box(s0 - 0.2, s0, step, top, 0, 0.025, 1 | 8);
    W.box(s1, s1 + 0.2, step, top, 0, 0.025, 1 | 4);
    if (kind === 'stone' && b.hash > 0.6) {
      // A gabled stone porch hood on brackets.
      W.box(s0 - 0.3, s1 + 0.3, top + 0.32, top + 0.42, 0, 0.5, 1 | 4 | 8 | 16 | 32);
    }
  }
  return { s0: s0 - 0.45, s1: s1 + 0.45, h0: 0, h1: top + 0.6, holeS0: s0, holeS1: s1, top, step };
}

/** A shopfront across s0…s1 of the ground floor: pilasters, fascia with a sign, cornice, stall riser, glass, door. */
function shopfront(W, b, s0, s1, plot = null) {
  const paint = plot?.paint ?? b.shopPaint;
  const signIndex = plot?.sign ?? b.signIndex;
  const top = 3.62, fasciaB = 2.86, fasciaT = 3.46, stall = 0.56;
  // Pilasters with console brackets.
  W.setLayer(L.PAINT).colour(paint);
  W.box(s0, s0 + 0.36, 0, fasciaB, 0, 0.12, 1 | 4 | 8 | 16);
  W.box(s1 - 0.36, s1, 0, fasciaB, 0, 0.12, 1 | 4 | 8 | 16);
  W.box(s0 - 0.02, s0 + 0.42, fasciaB - 0.12, fasciaT + 0.04, 0, 0.27, 1 | 4 | 8 | 32);
  W.box(s1 - 0.42, s1 + 0.02, fasciaB - 0.12, fasciaT + 0.04, 0, 0.27, 1 | 4 | 8 | 32);
  // Fascia board with the shop's name.
  const si = signIndex;
  W.setLayer(si < 8 ? L.SIGNS0 : L.SIGNS1).setColour(1, 1, 1);
  const row = si % 8, v0 = 1 - (row + 1) / 8, v1 = 1 - row / 8;
  const fa = s0 + 0.42, fb = s1 - 0.42;
  W.quad([fa, fasciaB, 0.18], [fb, fasciaB, 0.18], [fb, fasciaT, 0.18], [fa, fasciaT, 0.18], [0.02, v0 + 0.004, 0.98, v0 + 0.004, 0.98, v1 - 0.004, 0.02, v1 - 0.004]);
  W.setLayer(L.PAINT).colour(paint, 0.85);
  W.quad([fa, fasciaB, 0], [fb, fasciaB, 0], [fb, fasciaB, 0.18], [fa, fasciaB, 0.18], [0, 0, 1, 0, 1, 0.2, 0, 0.2]);
  // Cornice over the fascia, with its lead-covered top.
  W.colour(paint);
  W.box(s0 - 0.1, s1 + 0.1, fasciaT, top, 0, 0.32, 1 | 4 | 8 | 32);
  W.setLayer(L.LEAD).setColour(0.8, 0.82, 0.82);
  W.quad([s0 - 0.1, top, 0.32], [s1 + 0.1, top, 0.32], [s1 + 0.1, top + 0.03, 0], [s0 - 0.1, top + 0.03, 0], [s0, 0, s1, 0, s1, 0.3, s0, 0.3]);
  // Door in a recessed lobby at one end, display window across the rest.
  const doorLeft = plot ? plot.mirror !== b.hash < 0.5 : b.hash < 0.5;
  const dw = 1.0, rec = 0.85;
  const d0 = doorLeft ? s0 + 0.36 : s1 - 0.36 - dw, d1 = d0 + dw;
  W.setLayer(b.st.wall === L.RENDER ? L.PAINT : L.PAINT).colour(paint, 0.7);
  // Lobby walls, ceiling and floor.
  W.quad([d0, 0, 0], [d0, 0, -rec], [d0, fasciaB, -rec], [d0, fasciaB, 0], [0, 0, rec, 0, rec, fasciaB, 0, fasciaB]);
  W.quad([d1, 0, -rec], [d1, 0, 0], [d1, fasciaB, 0], [d1, fasciaB, -rec], [0, 0, rec, 0, rec, fasciaB, 0, fasciaB]);
  W.colour(paint, 0.45);
  W.quad([d0, fasciaB, -rec], [d1, fasciaB, -rec], [d1, fasciaB, 0], [d0, fasciaB, 0], [d0, 0, d1, 0, d1, rec, d0, rec]);
  W.setLayer(L.ASHLAR).colour(P.stoneTrim, 0.6);
  W.quad([d0, 0.01, 0], [d1, 0.01, 0], [d1, 0.01, -rec], [d0, 0.01, -rec], [d0, 0, d1, 0, d1, rec, d0, rec]);
  W.setLayer(L.DOOR).colour(paint);
  W.quad([d0, 0.01, -rec], [d1, 0.01, -rec], [d1, 2.3, -rec], [d0, 2.3, -rec], [0.75, 0, 1, 0, 1, 1, 0.75, 1]);
  glass(W, L.SHOP, d0, d1, 2.3, fasciaB, -rec, (signIndex + 1) % 4, paint);
  // Display window over a panelled stall riser.
  const w0 = doorLeft ? d1 : s0 + 0.36, w1 = doorLeft ? s1 - 0.36 : d0;
  if (w1 - w0 > 0.4) {
    W.setLayer(L.PAINT).colour(paint, 0.9);
    W.box(w0, w1, 0, stall, -0.06, 0.06, 1 | 16);
    W.colour(paint, 0.75);
    W.box(w0 + 0.12, w1 - 0.12, 0.12, stall - 0.12, 0.06, 0.075, 1 | 16 | 32 | 4 | 8);
    glass(W, L.SHOP, w0, w1, stall, fasciaB - 0.1, -0.05, signIndex % 4, paint);
    W.setLayer(L.PAINT).colour(paint);
    W.box(w0, w1, fasciaB - 0.1, fasciaB, -0.06, 0.04, 1 | 32);
  }
  return { s0, s1, h0: 0, h1: top };
}

/** A canted bay window on the ground floor (Victorian terraces): three glazed faces under a little lead roof. */
function bayWindow(W, b, s, w, h0, h, tint = null) {
  const st = b.st;
  const proj = 0.62, side = 0.5;
  const s0 = s - w / 2, s1 = s + w / 2;
  const f0 = s0 + side, f1 = s1 - side;
  const h1 = h0 + h;
  W.setLayer(st.wall).colour(tint ?? b.tint, 0.95);
  // Base, with the front and canted sides.
  W.quad([f0, 0, proj], [f1, 0, proj], [f1, h0, proj], [f0, h0, proj], [f0, 0, f1, 0, f1, h0, f0, h0]);
  W.quad([s0, 0, 0], [f0, 0, proj], [f0, h0, proj], [s0, h0, 0], [0, 0, 0.8, 0, 0.8, h0, 0, h0]);
  W.quad([f1, 0, proj], [s1, 0, 0], [s1, h0, 0], [f1, h0, proj], [0, 0, 0.8, 0, 0.8, h0, 0, h0]);
  // Sill ledge.
  W.setLayer(L.ASHLAR).colour(b.trim);
  W.quad([s0 - 0.05, h0, 0], [s1 + 0.05, h0, 0], [f1 + 0.03, h0, proj + 0.06], [f0 - 0.03, h0, proj + 0.06], [s0, 0, s1, 0, s1, 0.6, s0, 0.6]);
  // Glass on three faces, with stone mullions at the corners.
  const g = st.glaze(b.hash);
  const fc = b.frame;
  W.setLayer(g).colour(fc);
  const [u0, v0] = quarter(Math.floor(b.hash * 4));
  W.quad([f0 + 0.08, h0, proj - 0.02], [f1 - 0.08, h0, proj - 0.02], [f1 - 0.08, h1, proj - 0.02], [f0 + 0.08, h1, proj - 0.02], [u0, v0, u0 + 0.5, v0, u0 + 0.5, v0 + 0.5, u0, v0 + 0.5]);
  W.quad([s0 + 0.06, h0, 0.05], [f0 - 0.03, h0, proj - 0.05], [f0 - 0.03, h1, proj - 0.05], [s0 + 0.06, h1, 0.05], [u0, v0, u0 + 0.25, v0, u0 + 0.25, v0 + 0.5, u0, v0 + 0.5]);
  W.quad([f1 + 0.03, h0, proj - 0.05], [s1 - 0.06, h0, 0.05], [s1 - 0.06, h1, 0.05], [f1 + 0.03, h1, proj - 0.05], [u0 + 0.25, v0, u0 + 0.5, v0, u0 + 0.5, v0 + 0.5, u0 + 0.25, v0 + 0.5]);
  W.setLayer(L.ASHLAR).colour(b.trim);
  for (const [sa, da] of [[f0, proj], [f1, proj]]) W.box(sa - 0.07, sa + 0.07, h0, h1, da - 0.12, da + 0.01, 1 | 4 | 8);
  // Entablature and a lead-covered hipped roof.
  W.quad([f0, h1, proj + 0.03], [f1, h1, proj + 0.03], [f1, h1 + 0.3, proj + 0.03], [f0, h1 + 0.3, proj + 0.03], [f0, 0, f1, 0, f1, 0.3, f0, 0.3]);
  W.quad([s0, h1, 0], [f0, h1, proj + 0.03], [f0, h1 + 0.3, proj + 0.03], [s0, h1 + 0.3, 0], [0, 0, 0.8, 0, 0.8, 0.3, 0, 0.3]);
  W.quad([f1, h1, proj + 0.03], [s1, h1, 0], [s1, h1 + 0.3, 0], [f1, h1 + 0.3, proj + 0.03], [0, 0, 0.8, 0, 0.8, 0.3, 0, 0.3]);
  W.setLayer(L.LEAD).setColour(0.85, 0.87, 0.87);
  const rt = h1 + 0.3, rp = h1 + 0.75;
  W.quad([f0, rt, proj + 0.06], [f1, rt, proj + 0.06], [f1 - 0.1, rp, 0], [f0 + 0.1, rp, 0], [f0, 0, f1, 0, f1, 0.8, f0, 0.8]);
  W.tri([s0, rt, 0], [f0, rt, proj + 0.06], [f0 + 0.1, rp, 0], [0, 0, 0.8, 0, 0.4, 0.6]);
  W.tri([f1, rt, proj + 0.06], [s1, rt, 0], [f1 - 0.1, rp, 0], [0, 0, 0.8, 0, 0.4, 0.6]);
  return { s0, s1, h0: h0 - 0.01, h1: h1 + 0.02 };
}

/** Close studding and rails over a storey of a timber-framed wall, leaving the windows clear. */
function studding(W, b, len, y0, h, wins) {
  W.setLayer(L.OAK).colour(b.timber);
  const rail = 0.2;
  W.box(0, len, y0, y0 + rail, 0, 0.035, 1 | 16);
  W.box(0, len, y0 + h - rail, y0 + h, 0, 0.035, 1 | 32);
  const mid = y0 + h * 0.48;
  for (let s = 0.12; s < len - 0.05; s += 0.46) {
    const hit = wins.find((o) => s + 0.08 > o.s0 - 0.05 && s - 0.08 < o.s1 + 0.05);
    if (hit) continue;
    W.box(s - 0.08, s + 0.08, y0 + rail, y0 + h - rail, 0, 0.03, 1 | 4 | 8);
  }
  for (const o of wins) {
    W.box(o.s0 - 0.1, o.s0, y0 + rail, y0 + h - rail, 0, 0.03, 1 | 4 | 8);
    W.box(o.s1, o.s1 + 0.1, y0 + rail, y0 + h - rail, 0, 0.03, 1 | 4 | 8);
    W.box(o.s0 - 0.1, o.s1 + 0.1, o.h1, o.h1 + 0.12, 0, 0.03, 1 | 16 | 32);
    W.box(o.s0 - 0.1, o.s1 + 0.1, o.h0 - 0.12, o.h0, 0, 0.03, 1 | 16 | 32);
  }
  void mid;
}

/** All the near-detail geometry of one wall. */
function nearWall(W, b, e, ctx) {
  const st = b.st;
  const len = e.len, H = b.eaves;
  W.wallFrame(e.ax, e.az, e.bx, e.bz, b.y);
  W.uo = b.hash * 13;
  W.vo = b.hash * 7;
  W.aoH = 2.4;
  W.setLayer(st.wall).colour(b.tint);
  if (e.party > 0.6 || len < 1.3) {
    W.rect(0, len, -b.foot, H);
    W.aoH = 0;
    return;
  }
  // Covered stretches (a neighbour against part of this wall) in s.
  const blocked = (s) => e.covered.some(([t0, t1]) => {
    const a = len - t1, c = len - t0;
    return s > a - 0.9 && s < c + 0.9;
  });
  const front = e.front > 0;
  const main = b.main === e;
  const jetty = st.jetty && front ? st.jetty : 0;
  const sparse = st.sparse || (!front && hash2(b.i, e.k, 21) < 0.5);
  // A long terrace frontage is several houses ("plots"), each with its own door, bays, shop and colour.
  const plots = main && b.plots ? b.plots : [{ s0: 0, s1: len, k: 0, mirror: false, tint: b.tint, door: b.doorPaint, sign: b.signIndex, paint: b.shopPaint }];
  const bays = [];
  for (const p of plots) {
    const pw = p.s1 - p.s0;
    let pb;
    if (st === STYLE.barn) pb = pw > 6 ? [0.25, 0.5, 0.75].map((t) => p.s0 + pw * t) : [p.s0 + pw / 2];
    else if (main && b.plots) {
      const nb = st === STYLE.victorian || st === STYLE.timber || pw < 5.6 ? 2 : 3;
      pb = Array.from({ length: nb }, (_, i) => p.s0 + (pw * (i + 0.5)) / nb);
    } else {
      pb = baysFor(pw, st.bay * (front ? 1 : 1.15), 0.75, (x) => blocked(p.s0 + x)).map((x) => p.s0 + x);
      if (sparse && pb.length > 2) pb = pb.filter((_, i) => i % 2 === 0);
    }
    pb = pb.filter((x) => !blocked(x));
    let di = -1;
    if (main && pb.length && st !== STYLE.barn) {
      if (b.plots) di = p.mirror ? 0 : pb.length - 1; // doors paired either side of each party wall
      else di = pb.length >= 3 && st !== STYLE.victorian ? Math.floor(pb.length / 2) : b.hash < 0.5 ? 0 : pb.length - 1;
    }
    pb.forEach((x, i) => bays.push({ s: x, plot: p, door: i === di }));
  }
  const shopHere = b.shop && front && len > 3.2;
  const bayWindows = st.bayWindow && hash2(b.group, 51, 3) < st.bayWindow;
  const jet = (k) => (jetty ? jetty * k : 0);
  const storeyFrame = (k) => {
    // Jettied upper storeys of timber-framed houses step out over the street.
    W.wallFrame(e.ax + e.nx * jet(k), e.az + e.nz * jet(k), e.bx + e.nx * jet(k), e.bz + e.nz * jet(k), b.y);
  };
  for (const s of b.storeys) {
    const k = s.k;
    storeyFrame(k);
    const sh = [];
    if (k === 0 && shopHere) {
      for (const p of plots) {
        const a = p.s0 + (p.k === 0 ? 0.25 : 0.04), c = p.s1 - (p.k === plots.length - 1 ? 0.25 : 0.04);
        if (c - a > 2.4) sh.push(shopfront(W, b, a, c, p));
      }
    } else if (k === 0 && st === STYLE.barn) {
      if (main || e.len > 6) sh.push(doorAt(W, b, len * (b.hash < 0.5 ? 0.35 : 0.65), { kind: 'barn' }));
    } else {
      bays.forEach((bay, bi) => {
        const sx = bay.s;
        const win = st.win(k, b.storeys.length);
        if (k === 0 && bay.door) {
          const d = doorAt(W, b, sx, { paint: bay.plot.door, tint: bay.plot.tint });
          sh.push({ s0: d.holeS0, s1: d.holeS1, h0: d.step, h1: d.top, door: true });
          return;
        }
        if (st === STYLE.church) {
          // Lancets between buttresses.
          const w = Math.min(win.w, (len / Math.max(1, bays.length)) * 0.45);
          const wh = Math.min(win.h, H - win.sill - 0.8);
          windowAt(W, b, sx, w, win.sill, wh, { glaze: L.LANCET, variant: 0, storey: k, h0: win.sill, tint: bay.plot.tint });
          sh.push({ s0: sx - w / 2, s1: sx + w / 2, h0: win.sill, h1: win.sill + wh });
          return;
        }
        let w = Math.min(win.w, st.bay * 0.62);
        let wh = Math.min(win.h, s.h - win.sill - 0.32);
        if (!front) {
          w *= 0.9;
          wh *= 0.92;
        }
        if (wh < 0.5) return;
        const h0 = s.y0 + win.sill;
        if (k === 0 && bayWindows && front && main) {
          const bw = Math.min(w + 1.0, (bay.plot.s1 - bay.plot.s0) * 0.48);
          if (bw > w + 0.6) {
            sh.push({ ...bayWindow(W, b, sx, bw, h0, wh, bay.plot.tint), isBay: true });
            return;
          }
        }
        const glaze = st.glaze(hash2(b.group, k, 31));
        windowAt(W, b, sx, w, h0, wh, { glaze, variant: Math.floor(hash2(b.i * 7 + bi, k, 41) * 4), storey: k, h0, keystone: st === STYLE.victorian && b.hash > 0.6, tint: bay.plot.tint });
        sh.push({ s0: sx - w / 2, s1: sx + w / 2, h0, h1: h0 + wh });
      });
    }
    // The wall of this storey round its openings, plot by plot.
    const holesK = sh.map((o) => ({ s0: o.holeS0 ?? o.s0, s1: o.holeS1 ?? o.s1, h0: o.h0 ?? s.y0, h1: o.h1 }));
    // Gauged arches are flush inlays: cut from the wall and filled with the rubbed-brick layer.
    const inlays = [];
    if (st.head === 'gauged' && !(k === 0 && shopHere)) {
      for (const o of sh) {
        if (o.door || o.isBay || o.h1 - o.h0 > 3) continue;
        if (o.h1 + 0.3 > s.y0 + s.h) continue;
        inlays.push({ s0: o.s0 - 0.11, s1: o.s1 + 0.11, h0: o.h1, h1: o.h1 + 0.3 });
      }
    }
    const top = k === b.storeys.length - 1 ? H : s.y0 + s.h;
    const bottom = k === 0 ? -b.foot : s.y0;
    for (const p of plots) {
      W.setLayer(st.wall).colour(p.tint);
      wallWithHoles(W, p.s0, p.s1, bottom, top, [...holesK, ...inlays]);
    }
    if (inlays.length) {
      W.setLayer(L.ARCHBRICK);
      for (const o of inlays) {
        const p = plots.find((pp) => o.s0 >= pp.s0 - 0.2 && o.s0 < pp.s1) ?? plots[0];
        W.colour(p.tint);
        W.quad([o.s0, o.h0, 0], [o.s1, o.h0, 0], [o.s1, o.h1, 0], [o.s0, o.h1, 0], [0, 0, 1, 0, 1, 1, 0, 1]);
      }
    }
    if (st.jetty && front && k > 0) {
      // Jetty: soffit, joist ends and the bressumer beam carrying the storey.
      const d0 = -jetty, y = s.y0;
      W.setLayer(L.RENDER).colour(b.tint, 0.55);
      W.quad([0, y, d0], [len, y, d0], [len, y, 0], [0, y, 0], [0, 0, len, 0, len, jetty, 0, jetty]);
      W.setLayer(L.OAK).colour(b.timber);
      for (let sx = 0.2; sx < len - 0.1; sx += 0.42) W.box(sx - 0.06, sx + 0.06, y - 0.14, y, d0, 0.02, 1 | 4 | 8 | 32);
      W.box(-0.02, len + 0.02, y, y + 0.26, -0.02, 0.05, 1 | 4 | 8 | 16 | 32);
    }
    if (st.jetty && (k > 0 || !shopHere)) studding(W, b, len, s.y0 + (k === 0 ? 0 : 0.26), s.h - (k === 0 ? 0 : 0.26), sh);
  }
  storeyFrame(0);
  // Horizontal features.
  if (st.plinth) {
    W.setLayer(L.ASHLAR).colour(b.trim, 0.9);
    const gaps = shopHere ? plots.map((p) => [p.s0, p.s1]) : [];
    plinthRuns(W, len, b.storeys[0], -b.foot, 0.32, 0.035, gaps);
  }
  if (st.string && b.storeys.length > 1) {
    W.setLayer(st === STYLE.render ? L.PAINT : L.ASHLAR).colour(st === STYLE.render ? b.tint : b.trim);
    const y = b.storeys[1].y0;
    W.box(0, len, y - 0.05, y + 0.12, 0, 0.04, 1 | 16 | 32);
  }
  // Eaves: cornice, gutter and downpipes on walls under the roof's eaves (parapets are drawn with the roof).
  if (eavesWall(b, e)) {
    const jt = jet(b.storeys.length - 1);
    const top = H;
    W.wallFrame(e.ax + e.nx * jt, e.az + e.nz * jt, e.bx + e.nx * jt, e.bz + e.nz * jt, b.y);
    if (st.eaves === 'cornice') {
      W.setLayer(L.PAINT).colour(P.white);
      W.box(-0.02, len + 0.02, top - 0.32, top - 0.2, 0, 0.08, 1 | 16 | 32);
      W.box(-0.04, len + 0.04, top - 0.2, top + 0.02, 0, 0.2, 1 | 32);
    } else if (st.eaves === 'plain') {
      // A brick dentil course under the eaves.
      W.setLayer(st.wall).colour(b.tint, 0.95);
      W.box(0, len, top - 0.18, top - 0.08, 0, 0.04, 1 | 32 | 16);
    }
    const ov = b.roof?.type === 'rect' ? 0.3 : 0.2;
    if (st !== STYLE.barn && st !== STYLE.church && len > 2.5) {
      const pipes = [b.hash < 0.5 ? 0.25 : len - 0.25];
      if (main && b.plots) for (const p of b.plots.slice(1)) if (p.k % 2 === 0) pipes.push(p.s0 + (b.hash < 0.5 ? 0.18 : -0.18));
      W.setLayer(L.PAINT).colour(P.iron);
      for (const sp of pipes) {
        W.box(sp - 0.045, sp + 0.045, 0.05, top - 0.3, 0.03, 0.12, 1 | 4 | 8);
        W.box(sp - 0.11, sp + 0.11, top - 0.42, top - 0.2, 0.02, 0.2, 1 | 4 | 8 | 16 | 32);
        W.box(sp - 0.035, sp + 0.035, top - 0.2, top - 0.04, 0.12, ov - 0.04, 1 | 4 | 8);
      }
    }
  }
  W.wallFrame(e.ax, e.az, e.bx, e.bz, b.y);
  if (st.quoins) quoins(W, b, e, len, H);
  if (st.buttress) {
    W.setLayer(st.wall).colour(b.tint, 0.96);
    const xs = bays.map((x) => x.s);
    for (let k = 0; k <= xs.length; k++) {
      const s = k === 0 ? 0.35 : k === xs.length ? len - 0.35 : (xs[k - 1] + xs[k]) / 2;
      W.box(s - 0.35, s + 0.35, -0.3, H * 0.75, 0, 0.6, 1 | 4 | 8);
      W.box(s - 0.3, s + 0.3, H * 0.75, H * 0.9, 0, 0.35, 1 | 4 | 8 | 16);
      W.quad([s - 0.35, H * 0.75, 0.6], [s + 0.35, H * 0.75, 0.6], [s + 0.35, H * 0.75 + 0.25, 0.35], [s - 0.35, H * 0.75 + 0.25, 0.35], [0, 0, 0.7, 0, 0.7, 0.35, 0, 0.35]);
    }
  }
  if (st.throughStones) {
    W.setLayer(L.ASHLAR).colour(b.trim, 0.85);
    for (const y of [1.6, 3.3]) for (let s = 0.6 + (y > 2 ? 0.45 : 0); s < len - 0.4; s += 0.95) W.box(s - 0.13, s + 0.13, y, y + 0.14, 0, 0.16, 1 | 4 | 8 | 16 | 32);
  }
  W.uo = W.vo = 0;
  W.aoH = 0;
  void ctx;
}

/** House plots along a long terrace frontage (the main front), each a little different. */
function planPlots(b) {
  b.plots = null;
  const e = b.main, st = b.st;
  if (!e || e.party > 0.6) return;
  if (st !== STYLE.georgian && st !== STYLE.victorian && st !== STYLE.render && st !== STYLE.timber) return;
  const plotW = st === STYLE.victorian ? 5.0 : st === STYLE.timber ? 4.6 : 6.4;
  if (e.len < plotW * 1.45) return;
  const n = Math.max(2, Math.round(e.len / plotW));
  const w = e.len / n;
  b.plots = [];
  for (let k = 0; k < n; k++) {
    const t = hash2(b.i * 31 + k, 13, 17);
    let tint;
    if (st.wall === L.RENDER) tint = st.tints[Math.floor(t * st.tints.length)];
    else {
      tint = b.tint.clone().multiplyScalar(0.92 + 0.14 * t);
      tint.r *= 1 + (hash2(k, b.i, 3) - 0.5) * 0.06;
    }
    b.plots.push({
      s0: k * w, s1: (k + 1) * w, k, mirror: k % 2 === 1, tint,
      door: P.doorPaints[Math.floor(hash2(b.i, k, 29) * P.doorPaints.length)],
      sign: (b.signIndex + k * 5) % 16, paint: lin(SIGN_PAINTS[(b.signIndex + k * 5) % 16]),
    });
  }
}

function plinthRuns(W, len, g0, y0, y1, d, gaps) {
  let s = 0;
  for (const [a, c] of gaps) {
    if (a > s) W.box(s, a, y0, y1, 0, d, 1 | 16 | 4 | 8);
    s = c;
  }
  if (s < len) W.box(s, len, y0, y1, 0, d, 1 | 16 | 4 | 8);
  void g0;
}

/** Long-and-short stone quoins at the wall's exposed corners. */
function quoins(W, b, e, len, H) {
  const n = b.edges.length;
  const prev = b.edges[(e.k + n - 1) % n], next = b.edges[(e.k + 1) % n];
  W.setLayer(L.ASHLAR).colour(b.trim);
  const ch = b.st === STYLE.civic ? 0.42 : 0.3;
  for (const [end, other] of [[0, next], [1, prev]]) {
    if (other.party > 0.5) continue;
    let k = 0;
    for (let y = -0.2; y < H - 0.1; y += ch, k++) {
      const long = (k + end) % 2 === 0;
      const w = long ? 0.5 : 0.28;
      const y1 = Math.min(H, y + ch - 0.02);
      if (end === 0) W.box(0, w, y, y1, 0, 0.02, 1 | 4 | 16 | 32);
      else W.box(len - w, len, y, y1, 0, 0.02, 1 | 8 | 16 | 32);
    }
  }
}

/** Does this wall carry the eaves of the roof (as opposed to a gable end or a party wall)? */
function eavesWall(b, e) {
  if (e.party > 0.6) return false;
  const r = b.roof;
  if (!r || r.type === 'flat') return false;
  if (r.type === 'inset') return true;
  const along = Math.abs(e.dx * r.ux + e.dz * r.uz);
  return along > 0.7;
}

// ---- Far facades (painted) --------------------------------------------------------------------------------

function farWall(W, b, e) {
  const len = e.len;
  if (len < 0.05) return;
  W.wallFrame(e.ax, e.az, e.bx, e.bz, b.y);
  W.setLayer(FACADE_LAYER[b.st.far]).colour(b.tint);
  W.aoH = 2.4;
  let ua, ub;
  if (len < 2.6 || e.party > 0.6) {
    ua = 0.345;
    ub = 0.345 + Math.min(len, 2.4) / 8;
  } else {
    ua = 0;
    ub = Math.max(1, Math.round(len / 4)) / 2;
  }
  const n = b.storeys.length, H = b.eaves;
  const sh = H / Math.max(1, n);
  const q = (h0, h1, v0, v1) => W.quad([0, h0, 0], [len, h0, 0], [len, h1, 0], [0, h1, 0], [ua, v0, ub, v0, ub, v1, ua, v1]);
  q(-b.foot, sh, 0, 0.25);
  let done = 1;
  while (done < n) {
    const m = Math.min(3, n - done);
    q(sh * done, sh * (done + m), 0.25, 0.25 + 0.25 * m);
    done += m;
  }
  W.aoH = 0;
}

// ---- Roofs ------------------------------------------------------------------------------------------------

function roofRect(A, b, N = null) {
  const r = b.roof, st = b.st;
  const yE = b.y + b.eaves;
  A.frame(r.cx, yE, r.cz, r.ux, r.uz);
  if (N) N.frame(r.cx, yE, r.cz, r.ux, r.uz);
  const tan = Math.tan(r.pitch);
  const rise = r.rise;
  const oe = st.overhang, ov = st.coped ? 0 : st.overhang * 0.7;
  const he = -oe * tan;
  const la = r.la, lb = r.lb;
  const hipL = r.ends[0] === 'hip', hipR = r.ends[1] === 'hip';
  const R = Math.max(0, la - lb);
  const A0 = hipL ? -(la + oe) : -(la + ov), A1 = hipR ? la + oe : la + ov;
  const r0 = hipL ? -R : A0, r1 = hipR ? R : A1;
  const D = lb + oe;
  A.uo = b.hash * 5;
  A.setLayer(b.roofLayer).colour(b.roofTint);
  const sl = Math.hypot(D, rise - he);
  // Slopes.
  A.quad([A0, he, D], [A1, he, D], [r1, rise, 0], [r0, rise, 0], [A0, 0, A1, 0, r1, sl, r0, sl]);
  A.quad([A1, he, -D], [A0, he, -D], [r0, rise, 0], [r1, rise, 0], [-A1, 0, -A0, 0, -r0, sl, -r1, sl]);
  if (hipR) A.tri([A1, he, D], [A1, he, -D], [R, rise, 0], [-D, 0, D, 0, 0, Math.hypot(A1 - R, rise - he)]);
  if (hipL) A.tri([A0, he, -D], [A0, he, D], [-R, rise, 0], [-D, 0, D, 0, 0, Math.hypot(R - A0, rise - he)]);
  // Eaves (near only): fascia and soffit along both sides, and black gutters.
  const fd = 0.16;
  if (N) {
    N.setLayer(L.PAINT).colour(st === STYLE.cottage || st === STYLE.barn ? P.dalesStone : P.white, 0.92);
    for (const sg of [1, -1]) {
      const d = sg * D;
      if (sg > 0) N.quad([A0, he - fd, d], [A1, he - fd, d], [A1, he, d], [A0, he, d], [A0, 0, A1, 0, A1, fd, A0, fd]);
      else N.quad([A1, he - fd, d], [A0, he - fd, d], [A0, he, d], [A1, he, d], [A0, 0, A1, 0, A1, fd, A0, fd]);
      const dw = sg * lb;
      N.colour(P.white, 0.55);
      if (sg > 0) N.quad([A1, he - fd, d], [A0, he - fd, d], [A0, he - fd, dw], [A1, he - fd, dw], [A0, 0, A1, 0, A1, oe, A0, oe]);
      else N.quad([A0, he - fd, d], [A1, he - fd, d], [A1, he - fd, dw], [A0, he - fd, dw], [A0, 0, A1, 0, A1, oe, A0, oe]);
      N.colour(P.white, 0.92);
    }
    N.setLayer(L.PAINT).colour(P.iron);
    if (st !== STYLE.barn) {
      N.box(A0, A1, he - 0.12, he + 0.02, D, D + 0.13, 1 | 16 | 32 | 4 | 8);
      N.box(A0, A1, he - 0.12, he + 0.02, -D - 0.13, -D, 2 | 16 | 32 | 4 | 8);
    }
  }
  // Gable ends: wall triangles, verges (bargeboards or coping with kneelers).
  for (const [sg, end] of [[-1, r.ends[0]], [1, r.ends[1]]]) {
    if (end === 'hip') continue;
    const x = sg * la;
    A.setLayer(st.wall).colour(b.tint);
    A.uo = b.hash * 13;
    if (sg > 0) A.tri([x, 0, lb], [x, 0, -lb], [x, rise, 0], [-lb, 0, lb, 0, 0, rise]);
    else A.tri([x, 0, -lb], [x, 0, lb], [x, rise, 0], [-lb, 0, lb, 0, 0, rise]);
    if (end === 'party') continue;
    const xe = sg * (la + ov);
    if (st.coped) {
      // Raised stone coping along each rake with kneelers at the foot.
      A.setLayer(L.ASHLAR).colour(b.trim, 0.92);
      const cw = 0.42, ch = 0.2;
      for (const side of [1, -1]) {
        const p0 = [x - sg * 0.02, 0, side * (lb + 0.06)], p1 = [x - sg * 0.02, rise, 0];
        const inner = x - sg * cw;
        const q = (pa, pb, pc, pd) => A.quad(pa, pb, pc, pd, [0, 0, 1, 0, 1, 1, 0, 1]);
        const lift = ch;
        // Top surface of the coping.
        const t0 = [p0[0], p0[1] + lift, p0[2]], t1 = [p1[0], p1[1] + lift, p1[2]], t2 = [inner, rise + lift, 0], t3 = [inner, lift, side * (lb + 0.06)];
        if ((side > 0) === (sg > 0)) q(t3, t0, t1, t2);
        else q(t0, t3, t2, t1);
        // Outer face.
        const o0 = [p0[0], p0[1] - 0.05, p0[2]], o1 = [p1[0], p1[1] - 0.05, p1[2]];
        if ((side > 0) === (sg > 0)) q(o1, o0, t0, t1);
        else q(o0, o1, t1, t0);
      }
      // Kneelers.
      for (const side of [1, -1]) {
        const s0 = Math.min(x, x - sg * 0.55), s1 = Math.max(x, x - sg * 0.55);
        A.box(s0 + (sg > 0 ? 0.08 : -0.08), s1 + (sg > 0 ? 0.08 : -0.08), -0.25, 0.32, side > 0 ? lb - 0.4 : -lb - 0.08, side > 0 ? lb + 0.08 : -lb + 0.4);
      }
    } else if (N) {
      // Verge (near only): the slate edge and a bargeboard for timber and Victorian gables.
      const A = N;
      const bh = st === STYLE.timber || st === STYLE.victorian ? 0.3 : 0.14;
      A.setLayer(L.PAINT).colour(st === STYLE.timber ? b.timber : P.white, st === STYLE.timber ? 1 : 0.9);
      for (const side of [1, -1]) {
        const pE = [xe, he, side * D], pR = [xe, rise, 0];
        const sl2 = Math.hypot(D, rise - he);
        if ((side > 0) === (sg > 0)) A.quad([pE[0], pE[1] - bh, pE[2]], [pR[0], pR[1] - bh, 0], pR, pE, [0, 0, sl2, 0, sl2, bh, 0, bh]);
        else A.quad([pR[0], pR[1] - bh, 0], [pE[0], pE[1] - bh, pE[2]], pE, pR, [0, 0, sl2, 0, sl2, bh, 0, bh]);
      }
      // Underside of the verge overhang.
      A.colour(P.white, 0.5);
      for (const side of [1, -1]) {
        const a = [x, 0, side * lb], c = [x, rise - 0.12, 0];
        const a2 = [xe, he - 0.0, side * D], c2 = [xe, rise - 0.12, 0];
        if ((side > 0) === (sg > 0)) A.quad(a, c, c2, a2, [0, 0, 1, 0, 1, 1, 0, 1]);
        else A.quad(c, a, a2, c2, [0, 0, 1, 0, 1, 1, 0, 1]);
      }
    }
  }
  // Ridge tiles (and hip tiles); not worth drawing on buildings only ever seen from afar.
  if (!N) {
    A.uo = 0;
    return;
  }
  const ridgeLayer = b.roofLayer === L.STONESLATE ? L.ASHLAR : b.roofLayer === L.SLATE ? L.PANTILE : b.roofLayer;
  A.setLayer(ridgeLayer);
  if (ridgeLayer === L.ASHLAR) A.colour(P.dalesStone, 0.8);
  else if (b.roofLayer === L.SLATE) A.setColour(0.62, 0.42, 0.36);
  else A.setColour(0.92, 0.92, 0.92);
  const rw = 0.15, rh = 0.11;
  A.quad([r0, rise - 0.03, rw], [r1, rise - 0.03, rw], [r1, rise + rh, 0], [r0, rise + rh, 0], [r0, 0, r1, 0, r1, 0.3, r0, 0.3]);
  A.quad([r1, rise - 0.03, -rw], [r0, rise - 0.03, -rw], [r0, rise + rh, 0], [r1, rise + rh, 0], [r0, 0, r1, 0, r1, 0.3, r0, 0.3]);
  for (const [hip, sg, ex] of [[hipL, -1, A0], [hipR, 1, A1]]) {
    if (!hip) continue;
    for (const side of [1, -1]) {
      const p0 = [ex, he, side * D], p1 = [sg * R, rise, 0];
      // A thin capping strip along the hip line.
      const ax2 = p1[0] - p0[0], az2 = p1[2] - p0[2];
      const l = Math.hypot(ax2, az2) || 1;
      const px = (-az2 / l) * 0.12, pz = (ax2 / l) * 0.12;
      const q0 = [p0[0] + px, p0[1] + 0.02, p0[2] + pz], q1 = [p1[0] + px, p1[1] + 0.02, p1[2] + pz];
      const q2 = [p1[0] - px, p1[1] + 0.02, p1[2] - pz], q3 = [p0[0] - px, p0[1] + 0.02, p0[2] - pz];
      const t0 = [p0[0], p0[1] + 0.1, p0[2]], t1 = [p1[0], p1[1] + 0.1, p1[2]];
      A.tri(q0, q1, t1, [0, 0, 1, 0, 1, 0.2]);
      A.tri(q0, t1, t0, [0, 0, 1, 0.2, 0, 0.2]);
      A.tri(q3, t0, t1, [0, 0, 0, 0.2, 1, 0.2]);
      A.tri(q3, t1, q2, [0, 0, 1, 0.2, 1, 0]);
    }
  }
  A.uo = 0;
}

/** Inward offset of a ring (flat [x,z] points) by d, or null if it folds over. */
function offsetRing(pts, d) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], c = pts[i], nx2 = pts[(i + 1) % n];
    const e1x = c[0] - p[0], e1z = c[1] - p[1], l1 = Math.hypot(e1x, e1z);
    const e2x = nx2[0] - c[0], e2z = nx2[1] - c[1], l2 = Math.hypot(e2x, e2z);
    // Inward normals (left of each edge for a positive-area ring).
    const n1x = -e1z / l1, n1z = e1x / l1, n2x = -e2z / l2, n2z = e2x / l2;
    const k = 1 + n1x * n2x + n1z * n2z;
    if (k < 0.15) return null;
    let mx = ((n1x + n2x) / k) * d, mz = ((n1z + n2z) / k) * d;
    const ml = Math.hypot(mx, mz);
    if (ml > d * 4) return null;
    out.push([c[0] + mx, c[1] + mz]);
  }
  // Each offset edge must keep its direction, and the ring must not cross itself.
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], a2 = out[i], b2 = out[(i + 1) % n];
    if ((b[0] - a[0]) * (b2[0] - a2[0]) + (b[1] - a[1]) * (b2[1] - a2[1]) <= 0) return null;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(out[i], out[(i + 1) % n], out[j], out[(j + 1) % n])) return null;
    }
  }
  return out;
}

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** Slopes rising from every wall (with eaves overhang) to a flat lead top: blocks and awkward plans. */
function roofInset(A, b, N = null) {
  const st = b.st;
  const tan = Math.tan(b.roof.pitch);
  let d = Math.min(4.2, b.obb.lb * 0.75);
  let inner = null;
  for (let t = 0; t < 4 && !inner; t++, d *= 0.6) inner = offsetRing(b.pts, d);
  if (!inner || d < 0.8) {
    roofFlat(A, b);
    return;
  }
  d /= 0.6;
  const oe = Math.min(st.overhang, 0.3);
  const outer = offsetRing(b.pts, -oe) ?? b.pts;
  const yE = b.y + b.eaves;
  const rise = d * tan, he = -oe * tan;
  A.frame(0, yE, 0, 1, 0);
  A.uo = b.hash * 5;
  A.setLayer(b.roofLayer).colour(b.roofTint);
  const n = b.pts.length;
  // In this frame s = x and d = z (u = (1,0) gives n = (0,1)), so local [s, h, d] = [x, y, z].
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = outer[i], c = outer[j], ia = inner[i], ic = inner[j];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const sl = Math.hypot(d + oe, rise - he);
    A.quad([a[0], he, a[1]], [c[0], he, c[1]], [ic[0], rise, ic[1]], [ia[0], rise, ia[1]], [0, 0, len, 0, len - d, sl, d, sl]);
  }
  // Fascia and soffit (near only).
  if (N) {
    N.frame(0, yE, 0, 1, 0);
    N.setLayer(L.PAINT).colour(P.white, 0.9);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = outer[i], c = outer[j];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      N.quad([a[0], he - 0.16, a[1]], [c[0], he - 0.16, c[1]], [c[0], he, c[1]], [a[0], he, a[1]], [0, 0, len, 0, len, 0.16, 0, 0.16]);
      const w = b.pts[i], x = b.pts[j];
      N.colour(P.white, 0.55);
      N.quad([c[0], he - 0.16, c[1]], [a[0], he - 0.16, a[1]], [w[0], he - 0.16, w[1]], [x[0], he - 0.16, x[1]], [0, 0, len, 0, len, 0.3, 0, 0.3]);
      N.colour(P.white, 0.9);
    }
  }
  // Flat lead top.
  A.setLayer(L.LEAD).setColour(0.55, 0.57, 0.57);
  const flat = [];
  for (const p of inner) flat.push(p[0], p[1]);
  A.flat(flat, rise, true);
  b.roofTop = yE + rise;
  if (!N) {
    A.uo = 0;
    return;
  }
  // Hip tiles along the corners.
  const ridgeLayer = b.roofLayer === L.SLATE ? L.PANTILE : b.roofLayer;
  A.setLayer(ridgeLayer);
  if (b.roofLayer === L.SLATE) A.setColour(0.62, 0.42, 0.36);
  else A.setColour(0.9, 0.9, 0.9);
  for (let i = 0; i < n; i++) {
    const p0 = outer[i], p1 = inner[i];
    const ax2 = p1[0] - p0[0], az2 = p1[1] - p0[1], l = Math.hypot(ax2, az2) || 1;
    const px = (-az2 / l) * 0.12, pz = (ax2 / l) * 0.12;
    const q0 = [p0[0] + px, he + 0.02, p0[1] + pz], q1 = [p1[0] + px, rise + 0.02, p1[1] + pz];
    const t0 = [p0[0], he + 0.1, p0[1]], t1 = [p1[0], rise + 0.1, p1[1]];
    const q3 = [p0[0] - px, he + 0.02, p0[1] - pz], q2 = [p1[0] - px, rise + 0.02, p1[1] - pz];
    A.tri(q0, q1, t1, [0, 0, 1, 0, 1, 0.2]);
    A.tri(q0, t1, t0, [0, 0, 1, 0.2, 0, 0.2]);
    A.tri(q3, t0, t1, [0, 0, 0, 0.2, 1, 0.2]);
    A.tri(q3, t1, q2, [0, 0, 1, 0.2, 1, 0]);
  }
  A.uo = 0;
  b.roofTop = yE + rise;
}

/** A flat roof behind a parapet with a coping, and a little rooftop plant. */
function roofFlat(A, b) {
  const yE = b.y + b.eaves;
  const par = b.st.eaves === 'parapet' || b.st === STYLE.civic ? 0.9 : 0.55;
  A.frame(0, yE, 0, 1, 0);
  // Felt on the flat roofs of modern blocks; lead on the older ones.
  A.setLayer(b.st === STYLE.modern ? L.DARK : L.LEAD);
  if (b.st === STYLE.modern) A.setColour(3.2, 3.2, 3.3);
  else A.setColour(0.5, 0.52, 0.52);
  const flat = [];
  for (const p of b.pts) flat.push(p[0], p[1]);
  A.flat(flat, par * 0.3, true);
  parapet(A, b, yE, par);
  // Plant room / lift overrun on big modern roofs.
  if (b.st === STYLE.modern && b.area > 400) {
    A.frame(b.obb.cx, yE, b.obb.cz, b.obb.ux, b.obb.uz);
    A.setLayer(b.st.wall).colour(b.tint, 0.9);
    const w = Math.min(6, b.obb.la * 0.5), dd = Math.min(4, b.obb.lb * 0.5);
    A.box(-w, w, 0, 2.6, -dd, dd, 1 | 2 | 4 | 8 | 16);
  }
  b.roofTop = yE + par;
}

/** Parapet walls round the roof edge (all walls but party walls) with a stone coping. */
function parapet(A, b, yE, par, edges = null) {
  for (const e of edges ?? b.edges) {
    if (e.party > 0.6) continue;
    A.wallFrame(e.ax, e.az, e.bx, e.bz, yE);
    A.uo = b.hash * 13;
    A.setLayer(b.st.wall).colour(b.tint);
    A.rect(0, e.len, 0, par);
    if (b.st === STYLE.civic || b.st === STYLE.render || b.st === STYLE.georgian) {
      // Cornice at the foot of the parapet.
      A.setLayer(b.st === STYLE.render ? L.PAINT : L.ASHLAR).colour(b.st === STYLE.render ? b.tint : b.trim);
      A.box(-0.05, e.len + 0.05, -0.28, -0.1, 0, 0.1, 1 | 32 | 4 | 8);
      A.box(-0.08, e.len + 0.08, -0.1, 0.06, 0, 0.24, 1 | 16 | 32 | 4 | 8);
    }
    A.setLayer(L.ASHLAR).colour(b.st === STYLE.modern ? P.cement : b.trim, 0.95);
    A.box(-0.04, e.len + 0.04, par, par + 0.09, -0.3, 0.05, 1 | 2 | 16 | 4 | 8);
    A.uo = 0;
  }
}

// ---- Chimneys ---------------------------------------------------------------------------------------------

/** A brick stack with oversailing courses and a cement cap, pots on top (instanced elsewhere). */
function stack(A, b, x, z, ux, uz, wl, ws, base, top, pots, layer = null, N = b.nearWriter) {
  A.frame(x, base, z, ux, uz);
  if (N) N.frame(x, base, z, ux, uz);
  const h = top - base;
  A.setLayer(layer ?? (b.st.wall === L.RENDER ? (b.st.far === 'render' && b.inside ? L.BRICK : L.RUBBLE) : b.st.wall));
  if (b.st.wall === L.RENDER && !b.inside) A.setLayer(L.RUBBLE);
  A.colour(b.stackTint ?? b.tint);
  A.uo = b.hash * 3;
  A.box(-wl / 2, wl / 2, 0, h, -ws / 2, ws / 2, 1 | 2 | 4 | 8 | 16);
  if (b.st !== STYLE.cottage && b.st !== STYLE.dalesRender) {
    if (N) {
      N.setLayer(A.layer).colour(b.stackTint ?? b.tint);
      N.uo = A.uo;
      N.box(-wl / 2 - 0.05, wl / 2 + 0.05, h - 0.42, h - 0.33, -ws / 2 - 0.05, ws / 2 + 0.05, 1 | 2 | 4 | 8 | 16 | 32);
      N.box(-wl / 2 - 0.08, wl / 2 + 0.08, h - 0.24, h - 0.14, -ws / 2 - 0.08, ws / 2 + 0.08, 1 | 2 | 4 | 8 | 16 | 32);
      N.uo = 0;
    }
  } else {
    A.setLayer(L.ASHLAR).colour(P.dalesStone);
    A.box(-wl / 2 - 0.07, wl / 2 + 0.07, h - 0.14, h, -ws / 2 - 0.07, ws / 2 + 0.07, 1 | 2 | 4 | 8 | 16 | 32);
  }
  if (N) {
    A.setLayer(L.ASHLAR).colour(P.cement, 0.9);
    A.box(-wl / 2 + 0.03, wl / 2 - 0.03, h, h + 0.07, -ws / 2 + 0.03, ws / 2 - 0.03, 1 | 2 | 4 | 8 | 16);
  }
  A.uo = 0;
  if (pots) {
    const n = Math.max(1, Math.min(8, Math.round(wl / 0.36)));
    const pitch = wl / n;
    const t = hash2(Math.round(x * 5), Math.round(z * 5), 61);
    for (let k = 0; k < n; k++) {
      const s = -wl / 2 + pitch * (k + 0.5);
      pots.push({ x: x + ux * s, y: top + 0.07, z: z + uz * s, s: 0.85 + hash2(k, Math.round(x), 62) * 0.5, tall: t < 0.25 && k % 2 === 0, c: P.potCols[Math.floor(hash2(k, Math.round(z), 63) * P.potCols.length)] });
    }
  }
}

function chimneys(A, b, pots, bs) {
  const st = b.st;
  if (st === STYLE.barn || st === STYLE.church || st === STYLE.modern || st === STYLE.outbuilding) return;
  if (b.noChimney) return;
  const r = b.roof;
  if (!r) return;
  const yE = b.y + b.eaves;
  if (r.type === 'rect') {
    const tan = Math.tan(r.pitch);
    const ridge = yE + r.rise;
    for (const [sg, end] of [[-1, r.ends[0]], [1, r.ends[1]]]) {
      if (end === 'hip') continue;
      // Stacks on party walls are shared: only the house on one side builds it, tall enough for both roofs.
      let top = ridge + 0.95 + b.hash * 0.5;
      if (end === 'party') {
        const e = b.edges.find((ed) => ed.party > 0.5 && Math.abs(((ed.ax + ed.bx) / 2 - r.cx) * r.ux + ((ed.az + ed.bz) / 2 - r.cz) * r.uz - sg * r.la) < 0.9);
        const o = e ? bs[e.neighbour] : null;
        if (o && o.i < b.i && o.roof) continue;
        if (o?.roofTop) top = Math.max(top, o.roofTop + 0.8);
      } else if (hash2(b.i, sg + 3, 71) < (st === STYLE.cottage || st === STYLE.dalesRender ? -1 : 0.35)) continue;
      const x = r.cx + r.ux * sg * (r.la - (end === 'party' ? 0 : 0.32));
      const z = r.cz + r.uz * sg * (r.la - (end === 'party' ? 0 : 0.32));
      const wl = end === 'party' ? 1.3 + b.hash * 0.9 : 0.95 + b.hash * 0.3;
      const ws = end === 'party' ? 0.62 : 0.55;
      const base = ridge - (wl / 2) * tan - 0.15;
      // The stack's long side runs across the ridge (along the party wall).
      stack(A, b, x, z, -r.uz, r.ux, wl, ws, base, top, pots);
    }
    // A long terrace under one roof: a stack astride every party wall between its houses.
    if (b.plots && b.main && Math.abs(b.main.dx * r.ux + b.main.dz * r.uz) > 0.85) {
      const e = b.main;
      for (const p of b.plots.slice(1)) {
        const t = p.s0 / e.len;
        const px = e.bx + (e.ax - e.bx) * t, pz = e.bz + (e.az - e.bz) * t;
        const u = (px - r.cx) * r.ux + (pz - r.cz) * r.uz;
        if (Math.abs(u) > r.la - 0.6) continue;
        const wl = 1.25 + hash2(b.i, p.k, 47) * 0.7;
        stack(A, b, r.cx + r.ux * u, r.cz + r.uz * u, -r.uz, r.ux, wl, 0.6, ridge - (wl / 2) * tan - 0.15, ridge + 0.9 + hash2(p.k, b.i, 48) * 0.45, pots);
      }
    } else if ((r.ends[0] === 'hip' || r.ends[1] === 'hip' || r.la > 9) && st !== STYLE.cottage && st !== STYLE.dalesRender && st !== STYLE.timber) {
      const off = (b.hash - 0.5) * Math.max(0, r.la - r.lb) * 0.8;
      stack(A, b, r.cx + r.ux * off, r.cz + r.uz * off, r.ux, r.uz, 1.1, 0.6, ridge - 0.4, ridge + 1.05, pots);
    }
    if (st === STYLE.timber) {
      // A big brick stack rising beside the steep roof.
      const sg = b.hash < 0.5 ? -1 : 1;
      const x = r.cx + r.ux * sg * r.la * 0.5 + (-r.uz) * r.lb * 0.35, z = r.cz + r.uz * sg * r.la * 0.5 + r.ux * r.lb * 0.35;
      stack(A, b, x, z, r.ux, r.uz, 1.0, 0.7, yE + r.rise * 0.3, ridge + 1.1, pots, L.BRICK);
    }
  } else if (r.type === 'inset' && b.roofTop && st !== STYLE.modern) {
    // A few stacks along the flat top of big blocks.
    const n = Math.min(4, Math.max(1, Math.round(b.obb.la / 8)));
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 0 : (k / (n - 1) - 0.5) * 1.4;
      const x = b.obb.cx + b.obb.ux * t * b.obb.la * 0.6, z = b.obb.cz + b.obb.uz * t * b.obb.la * 0.6;
      stack(A, b, x, z, b.obb.ux, b.obb.uz, 1.4, 0.65, b.roofTop - 0.6, b.roofTop + 1.1, pots);
    }
  }
}

/** Gabled dormers on the front slope of some attics. */
function dormers(Wn, b) {
  const r = b.roof;
  if (!r || r.type !== 'rect' || !b.main || b.gableFront) return;
  if (hash2(b.group, 81, 4) > b.st.dormer) return;
  if (r.rise < 2.2) return;
  const tan = Math.tan(r.pitch);
  // The slope facing the main front.
  const sideSign = Math.sign(b.main.nx * -r.uz + b.main.nz * r.ux) || 1;
  const yE = b.y + b.eaves;
  const n = Math.max(1, Math.round((r.la * 2 - 1.5) / 3.2));
  const w = 1.15, h = 1.25;
  Wn.frame(r.cx, yE, r.cz, r.ux, r.uz);
  for (let k = 0; k < n; k++) {
    const s = -r.la + ((k + 0.5) * (2 * r.la)) / n;
    const dFace = sideSign * (r.lb - 0.55);
    const yFoot = (r.lb - Math.abs(dFace)) * tan; // roof height at the dormer face
    const s0 = s - w / 2 - 0.12, s1 = s + w / 2 + 0.12;
    const yTop = yFoot + h + 0.15;
    const dBack = sideSign * (r.lb - 0.55 - (yTop - yFoot) / tan - 0.1);
    // Front face (cheeks of render), window, little gabled roof.
    const fr = (a, c) => (sideSign > 0 ? [a, c] : [c, a]);
    Wn.setLayer(L.PAINT).colour(P.white, 0.95);
    const q = (p0, p1, p2, p3) => (sideSign > 0 ? Wn.quad(p0, p1, p2, p3, [0, 0, 1, 0, 1, 1, 0, 1]) : Wn.quad(p1, p0, p3, p2, [0, 0, 1, 0, 1, 1, 0, 1]));
    q([s0, yFoot - 0.1, dFace], [s1, yFoot - 0.1, dFace], [s1, yFoot + 0.12, dFace], [s0, yFoot + 0.12, dFace]);
    const g = b.st.glaze(0.2);
    Wn.setLayer(g).colour(b.frame);
    const [u0, v0] = quarter(Math.floor(b.hash * 4));
    const wq = sideSign > 0 ? [[s0 + 0.12, yFoot + 0.12, dFace], [s1 - 0.12, yFoot + 0.12, dFace], [s1 - 0.12, yTop - 0.05, dFace], [s0 + 0.12, yTop - 0.05, dFace]] : [[s1 - 0.12, yFoot + 0.12, dFace], [s0 + 0.12, yFoot + 0.12, dFace], [s0 + 0.12, yTop - 0.05, dFace], [s1 - 0.12, yTop - 0.05, dFace]];
    Wn.quad(wq[0], wq[1], wq[2], wq[3], [u0, v0, u0 + 0.5, v0, u0 + 0.5, v0 + 0.5, u0, v0 + 0.5]);
    Wn.setLayer(L.PAINT).colour(P.white, 0.9);
    q([s0, yTop - 0.05, dFace], [s1, yTop - 0.05, dFace], [s1, yTop + 0.05, dFace], [s0, yTop + 0.05, dFace]);
    // Cheeks.
    for (const sx of [s0, s1]) {
      const outward = sx === s0 ? -1 : 1;
      const p = [[sx, yFoot - 0.1, dFace], [sx, yTop + 0.05, dFace], [sx, yTop + 0.05, dBack], [sx, yFoot - 0.1, dFace]];
      if ((outward > 0) === (sideSign > 0)) Wn.tri(p[0], p[2], p[1], [0, 0, 1, 1, 0, 1]);
      else Wn.tri(p[0], p[1], p[2], [0, 0, 0, 1, 1, 1]);
    }
    // Roof of the dormer.
    Wn.setLayer(b.roofLayer).setColour(1, 1, 1);
    const ym = yTop + 0.05, yr = ym + 0.42;
    const sm = (s0 + s1) / 2;
    const e0 = s0 - 0.1, e1 = s1 + 0.1;
    const dF = dFace + sideSign * 0.12;
    const pa = [[e0, ym - 0.04, dF], [sm, yr, dF], [sm, yr, dBack], [e0, ym - 0.04, dBack]];
    const pb = [[sm, yr, dF], [e1, ym - 0.04, dF], [e1, ym - 0.04, dBack], [sm, yr, dBack]];
    const sl = Math.hypot(sm - e0, yr - ym);
    if (sideSign > 0) {
      Wn.quad(pa[0], pa[1], pa[2], pa[3], [0, 0, sl, 0, sl, 1, 0, 1]);
      Wn.quad(pb[0], pb[1], pb[2], pb[3], [0, 0, sl, 0, sl, 1, 0, 1]);
    } else {
      Wn.quad(pa[1], pa[0], pa[3], pa[2], [0, 0, sl, 0, sl, 1, 0, 1]);
      Wn.quad(pb[1], pb[0], pb[3], pb[2], [0, 0, sl, 0, sl, 1, 0, 1]);
    }
    // Front gable triangle.
    Wn.setLayer(L.PAINT).colour(P.white, 0.9);
    if (sideSign > 0) Wn.tri([s0, ym, dFace], [s1, ym, dFace], [sm, yr - 0.04, dFace], [0, 0, 1, 0, 0.5, 0.4]);
    else Wn.tri([s1, ym, dFace], [s0, ym, dFace], [sm, yr - 0.04, dFace], [0, 0, 1, 0, 0.5, 0.4]);
    void fr;
  }
}

// ---- Assembly ---------------------------------------------------------------------------------------------

function finishStyle(b, ctx) {
  const st = b.st;
  const t = hash2(b.i, 7, 7), t2 = hash2(b.group, 9, 1);
  b.hash2 = hash2(b.i, 17, 23);
  b.tint = b.src.tint ? lin(b.src.tint) : st.tints[Math.floor((st.wall === L.RENDER ? t : t2 * 0.6 + t * 0.4) * st.tints.length) % st.tints.length];
  b.foot = b.src.foot ?? 0.3;
  b.trim = st === STYLE.cottage || st === STYLE.dalesRender || st === STYLE.barn ? P.dalesStone : st === STYLE.civic ? P.yorkStone : P.stoneTrim;
  b.frame = st === STYLE.timber ? P.oak : st === STYLE.modern ? P.dark : st === STYLE.cottage && t > 0.8 ? lin('#3c4a3a') : P.white;
  b.archCol = st === STYLE.render ? b.tint.clone().multiplyScalar(1.04) : P.white;
  b.doorPaint = P.doorPaints[Math.floor(t * 997) % P.doorPaints.length];
  b.timber = t > 0.35 ? P.tar : P.oak;
  // Roofs weather differently house to house: a little darker, mossier or redder.
  b.roofTint = lin(pick(['#ffffff', '#eef0f2', '#e2e2de', '#f6f2ea', '#e8e4dc', '#dcdcd4', '#f4ece4'], t2 * 0.5 + t * 0.5));
  b.stackTint = st.wall === L.BRICK || st.wall === L.BRICK2 ? b.tint : P.brickTints[Math.floor(t * 8) % 8];
  b.signIndex = Math.floor(hash2(b.i, 99, 5) * 16);
  b.shopPaint = lin(SIGN_PAINTS[b.signIndex]);
  void ctx;
}

/**
 * Builds a set of buildings. list: [{ ring: [x,z,...] world footprint, h (m), k (OSM kind), n (name), y (ground),
 * style?, roof?, shop?, chimney? }]. ctx: { q, roads: [{p, w, weight}], routeAt(x,z) → 0…1.2 street weight,
 * inside(x,z) → old town?, detail(b) → near geometry?, style(b) → style name override }.
 * Returns { group, buildings }.
 */
export function buildingSet(list, ctx) {
  const q = ctx.q;
  const t0 = performance.now();
  const mats = materials(q.texDetail ?? 1);
  const t1 = performance.now();
  const bs = [];
  list.forEach((src) => {
    const b = makeBuilding(src, bs.length);
    if (b) bs.push(b);
  });
  findPartyWalls(bs);
  findFronts(bs, ctx.roads?.length ? roadIndex(ctx.roads) : null, ctx.routeAt);
  for (const b of bs) {
    if (!b.src.frontAll) continue;
    // No street data: the walls along the building's length are its fronts (front and back doors).
    const [ax, az] = b.src.axis ?? [b.obb.ux, b.obb.uz];
    let best = null;
    for (const e of b.edges) {
      if (e.party > 0.6 || e.len < 2.5) continue;
      if (Math.abs(e.dx * ax + e.dz * az) > 0.8) e.front = 0.6;
      if (e.front > 0 && (!best || e.len > best.len)) best = e;
    }
    b.main = best;
  }
  for (const b of bs) {
    b.inside = ctx.inside ? ctx.inside(b.cx, b.cz) : false;
    b.groupHash = hash2(b.group, 1, 2);
  }
  // Styles per terrace, from its first house.
  const groupStyle = new Map();
  for (const b of bs) {
    let name = b.src.style;
    if (!name) {
      if (!groupStyle.has(b.group)) groupStyle.set(b.group, chooseStyle(b, ctx));
      name = groupStyle.get(b.group);
      // Big blocks and tiny sheds keep their own style even inside a terrace.
      if (b.area < 26 || b.area > 650 || b.k === 'church') name = chooseStyle(b, ctx);
    }
    b.st = STYLE[name] ?? STYLE.georgian;
    b.styleName = name;
  }
  const groupStoreys = new Map();
  for (const b of bs) {
    const st = b.st;
    b.shop = b.src.shop ?? (!!b.main && st !== STYLE.church && st !== STYLE.outbuilding && st !== STYLE.barn && st !== STYLE.cottage && st !== STYLE.dalesRender
      && (b.k === 'commercial' || (b.inside && hash2(b.i, 31, 7) < 0.42) || (b.main.front > 0.75 && hash2(b.i, 33, 9) < 0.22)) && b.main.len > 3.4 && st !== STYLE.civic);
    if (st === STYLE.modern && b.k !== 'commercial') b.shop = false;
    let n = groupStoreys.get(b.group);
    if (n == null) groupStoreys.set(b.group, (n = storeyCount(b, st, hash2(b.group, 3, 3))));
    if (Math.abs(b.h - 8) > 0.01 && b.h > 3) n = storeyCount(b, st, 0.5);
    else if ((st === STYLE.georgian || st === STYLE.render) && b.inside && hash2(b.i, 5, 5) < 0.18) n = Math.max(2, n + (hash2(b.i, 6, 6) < 0.5 ? -1 : 1));
    if (b.src.storeys) n = b.src.storeys;
    setHeights(b, n);
    finishStyle(b, ctx);
    planRoof(b, ctx);
    planPlots(b);
    if (b.src.chimney === false) b.noChimney = true;
    b.detail = ctx.detail ? ctx.detail(b) : true;
  }
  const R = nearDistance(q);
  // Buildings by the route are in small cells that swap between near detail and painted facades; the rest of
  // the city, only ever seen from a distance, is in big cells (fewer draw calls).
  const cells = new Cells(CELL, TILES);
  const bgCells = new Cells(BG_CELL, TILES);
  const roofW = new Writer(TILES); // a detail building's roof goes into both its near and its far mesh
  const pots = [];
  // Roof tops first, so shared stacks can clear the taller of two neighbouring roofs.
  for (const b of bs) if (b.roof?.type === 'rect') b.roofTop = b.y + b.eaves + b.roof.rise;
  for (const b of bs) {
    const N = b.detail ? cells.writer(b.cx, b.cz, 'near') : null;
    const A = b.detail ? roofW : bgCells.writer(b.cx, b.cz, 'bg');
    if (b.detail) roofW.clear();
    b.nearWriter = N;
    if (b.roof.type === 'rect') roofRect(A, b, N);
    else if (b.roof.type === 'inset') roofInset(A, b, N);
    else roofFlat(A, b);
    chimneys(A, b, pots, bs);
    b.nearWriter = null;
    if (b.detail) {
      for (const e of b.edges) nearWall(N, b, e, ctx);
      dormers(N, b);
      const F = cells.writer(b.cx, b.cz, 'far');
      for (const e of b.edges) farWall(F, b, e);
      N.append(roofW);
      F.append(roofW);
    } else {
      for (const e of b.edges) farWall(A, b, e);
    }
  }
  const group = new THREE.Group();
  const sets = {
    near: { material: mats.surface, shadows: q.shadows, near: R },
    far: { material: mats.surface, shadows: false, far: R },
    bg: { material: mats.surface, shadows: q.shadows },
  };
  cells.build(group, sets);
  bgCells.build(group, sets);
  if (pots.length) group.add(potMesh(pots, q));
  group.userData.buildings = bs.length;
  console.log(`[gp] buildings: ${bs.length}, textures ${Math.round(t1 - t0)} ms, geometry ${Math.round(performance.now() - t1)} ms`);
  return { group, buildings: bs };
}

/** Chimney pots: tapered terracotta cylinders with a rolled rim, instanced in chunks. */
function potMesh(pots, q) {
  const prof = [[0.0, 0], [0.13, 0], [0.12, 0.05], [0.1, 0.42], [0.125, 0.47], [0.125, 0.53], [0.095, 0.55], [0.0, 0.55]].map(([x, y]) => new THREE.Vector2(x, y));
  const geo = new THREE.LatheGeometry(prof, 7);
  geo.deleteAttribute('uv');
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, color: '#ffffff' });
  const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), s = new THREE.Vector3();
  const items = pots.map((p) => {
    s.set(1, p.s * (p.tall ? 1.6 : 1), 1);
    return { matrix: m.clone().compose(new THREE.Vector3(p.x, p.y, p.z), qq, s), colour: p.c };
  });
  return C.chunked(geo, mat, items, { chunk: 260, shadows: false, maxDistance: q.shadows ? 340 : 200 });
}

/**
 * Moves the vertices of a footprint that come within minDist of a road out to minDist (so a house that fronts
 * the pavement keeps its frontage instead of being dropped). nearest(x, z) → {distance, x, z} of the nearest
 * point on the road's centreline. Returns the new ring, or null if any vertex would move more than maxPush or
 * the footprint straddles the road.
 */
export function pushBehind(ring, nearest, minDist, maxPush = 4) {
  const out = ring.slice();
  let moved = 0;
  for (let i = 0; i < out.length; i += 2) {
    const q = nearest(out[i], out[i + 1]);
    if (q.distance >= minDist) continue;
    if (q.distance < 0.2 || minDist - q.distance > maxPush) return null;
    const k = minDist / q.distance;
    out[i] = q.x + (out[i] - q.x) * k;
    out[i + 1] = q.z + (out[i + 1] - q.z) * k;
    moved++;
  }
  if (moved === out.length / 2) return null;
  const c = cleanRing(out);
  return c && c.area > 12 ? out : null;
}

// ---- York ---------------------------------------------------------------------------------------------------

/**
 * York's buildings from map footprints. list: [{ ring, h, k, n }] (world x/z), ctx: { q, y, roads, routeDistance(x,z),
 * roadHalf, inside(x,z), detailRadius }.
 */
export function cityBuildings(list, ctx) {
  const roadHalf = ctx.roadHalf ?? 3.6;
  const detailR = ctx.detailRadius ?? (ctx.q.shadows ? 80 : 50);
  const y0 = ctx.y ?? 0;
  // The bars and wall towers are landmarks with their own builders.
  let ccx = 0, ccz = 0;
  const rr = ctx.routeRing ?? [];
  for (let i = 0; i < rr.length; i += 2) {
    ccx += rr[i];
    ccz += rr[i + 1];
  }
  if (rr.length) {
    ccx /= rr.length / 2;
    ccz /= rr.length / 2;
  }
  const special = new THREE.Group();
  const bars = [];
  const rest = [];
  for (const b of list) {
    if (b.n && isYorkLandmark(b.n)) {
      const isBar = / Bar$/.test(b.n);
      special.add(isBar ? bar(b.ring, b.n, { y0, q: ctx.q, walls: ctx.walls, centre: [ccx, ccz] }) : wallTower(b.ring, b.n, { y0, q: ctx.q }));
      if (isBar) {
        let x = 0, z = 0;
        for (let i = 0; i < b.ring.length; i += 2) {
          x += b.ring[i];
          z += b.ring[i + 1];
        }
        bars.push([x / (b.ring.length / 2), z / (b.ring.length / 2)]);
      }
      continue;
    }
    rest.push({ ...b, y: b.y ?? y0 });
  }
  const res = buildingSet(rest, {
    q: ctx.q,
    roads: ctx.roads,
    inside: ctx.inside,
    routeAt: (x, z) => (ctx.routeDistance(x, z) < roadHalf + 2.9 ? 1.2 : 0),
    detail: (b) => {
      let d = Infinity;
      for (const p of b.pts) d = Math.min(d, ctx.routeDistance(p[0], p[1]));
      return d < detailR;
    },
  });
  res.group.add(special);
  /** Is there a mapped bar within r metres of point p ({x, z})? */
  res.nearBar = (p, r) => bars.some(([x, z]) => Math.hypot(x - p.x, z - p.z) < r);
  return res;
}

// ---- Dales villages (common.buildings items) --------------------------------------------------------------

/**
 * Village buildings from oriented rectangles (the items common.buildings takes): {x, y, z, rot, w (frontage
 * along the street), d (depth), h, kind 'cottage'|'render'|'barn'|..., roof 'stone'|'slate'|'pantile', tint?,
 * chimney?}. Both long sides count as fronts (front and back doors), since the street side is not known here.
 */
export function villageBuildings(items, { shadows = true, q = null } = {}) {
  q = q ?? { shadows, shadowSize: shadows ? 2048 : 0, texDetail: T.getDetail() };
  const list = items.map((b) => {
    const ax = -Math.sin(b.rot), az = -Math.cos(b.rot), bx = -az, bz = ax;
    const la = b.w / 2, lb = b.d / 2;
    let ring = [];
    for (const [u, v] of [[-la, -lb], [la, -lb], [la, lb], [-la, lb]]) ring.push(b.x + ax * u + bx * v, b.z + az * u + bz * v);
    // The true outline when the map has one (L-shaped farmhouses, barns with outshuts).
    if (Array.isArray(b.footprint) && b.footprint.length >= 6) ring = b.footprint;
    const style = b.kind === 'barn' ? 'barn' : b.kind === 'render' ? 'dalesRender' : b.kind === 'cottage' ? 'cottage' : b.kind;
    const storeys = style === 'barn' ? 1 : Math.max(1, Math.min(3, Math.round(b.h / 2.75)));
    return { ring, y: b.y, h: b.h, k: 'house', style: STYLE[style] ? style : 'cottage', storeys, chimney: b.chimney, tint: b.tint, roofKind: b.roof, frontAll: true, axis: [ax, az], foot: 1.2, n: b.name };
  });
  const res = buildingSet(list, {
    q,
    routeAt: null,
    roofLayer: (b) => (b.src.roofKind === 'slate' ? L.SLATE : b.src.roofKind === 'pantile' ? L.PANTILE : L.STONESLATE),
  });
  // Without street data every long wall is a front.
  return res;
}
