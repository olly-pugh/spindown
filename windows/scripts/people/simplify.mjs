// Mesh simplification by quadric error metrics (Garland and Heckbert): repeatedly collapse the edge whose removal
// changes the shape least, moving one end onto the other (half-edge collapse, so every surviving vertex keeps its
// own UV and per-frame data). Vertices on open borders, which include UV seams in an unwelded mesh and garment
// hems, are locked; collapses that would flip a triangle are refused.

class Heap {
  constructor() { this.a = []; }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

/**
 * pos: Float32Array (xyz per vertex), index: triangle indices. Returns {index (new triangles over the same
 * vertices), keep (Uint8Array, 1 for vertices still used)}. target: triangle count to stop at.
 * weld: positions closer than this are treated as one point for border detection (UV seams are not borders).
 */
export function simplify(pos, index, target, { weld = 1e-5, lockBorder = true } = {}) {
  const nv = pos.length / 3;
  const tris = [];
  for (let i = 0; i < index.length; i += 3) tris.push([index[i], index[i + 1], index[i + 2]]);
  // Welded ids: vertices sharing a position (UV seams) share a quadric and adjacency.
  const keyOf = (i) => `${Math.round(pos[i * 3] / weld)},${Math.round(pos[i * 3 + 1] / weld)},${Math.round(pos[i * 3 + 2] / weld)}`;
  const wid = new Int32Array(nv), groups = new Map();
  for (let i = 0; i < nv; i++) {
    const k = keyOf(i);
    if (!groups.has(k)) groups.set(k, groups.size);
    wid[i] = groups.get(k);
  }
  const nw = groups.size;
  // Quadrics per welded vertex.
  const Q = new Float64Array(nw * 10);
  const addQ = (w, a, b, c, d, s = 1) => {
    const q = w * 10;
    Q[q] += a * a * s; Q[q + 1] += a * b * s; Q[q + 2] += a * c * s; Q[q + 3] += a * d * s;
    Q[q + 4] += b * b * s; Q[q + 5] += b * c * s; Q[q + 6] += b * d * s;
    Q[q + 7] += c * c * s; Q[q + 8] += c * d * s; Q[q + 9] += d * d * s;
  };
  const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const triNormal = (t) => {
    const [a, b, c] = t.map(P);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  for (const t of tris) {
    const n = triNormal(t);
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) continue;
    const a = n[0] / l, b = n[1] / l, c = n[2] / l, d = -(a * pos[t[0] * 3] + b * pos[t[0] * 3 + 1] + c * pos[t[0] * 3 + 2]);
    for (const v of t) addQ(wid[v], a, b, c, d, l * 0.5);
  }
  // Borders: edges (welded) used by one triangle only. Lock their vertices.
  const edgeCount = new Map();
  const ek = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const e = ek(wid[t[k]], wid[t[(k + 1) % 3]]);
    edgeCount.set(e, (edgeCount.get(e) ?? 0) + 1);
  }
  const locked = new Uint8Array(nw);
  if (lockBorder) for (const [e, c] of edgeCount) if (c === 1) for (const w of e.split('_')) locked[+w] = 1;
  // Adjacency: welded vertex -> triangles.
  const vt = Array.from({ length: nw }, () => new Set());
  tris.forEach((t, i) => t.forEach((v) => vt[wid[v]].add(i)));
  const alive = new Uint8Array(tris.length).fill(1);
  let liveCount = tris.length;
  // A representative position per welded vertex.
  const wpos = new Float64Array(nw * 3);
  for (let i = 0; i < nv; i++) wpos.set(P(i), wid[i] * 3);
  const err = (wa, wb) => {
    // Cost of moving wa onto wb's position with Q = Qa + Qb.
    const qa = wa * 10, qb = wb * 10;
    const q = (k) => Q[qa + k] + Q[qb + k];
    const x = wpos[wb * 3], y = wpos[wb * 3 + 1], z = wpos[wb * 3 + 2];
    return q(0) * x * x + 2 * q(1) * x * y + 2 * q(2) * x * z + 2 * q(3) * x + q(4) * y * y + 2 * q(5) * y * z + 2 * q(6) * y + q(7) * z * z + 2 * q(8) * z + q(9);
  };
  const version = new Int32Array(nw);
  const heap = new Heap();
  const pushEdges = (w) => {
    const seen = new Set();
    for (const ti of vt[w]) {
      if (!alive[ti]) continue;
      for (const v of tris[ti]) {
        const o = wid[v];
        if (o === w || seen.has(o)) continue;
        seen.add(o);
        if (!locked[w]) heap.push([err(w, o), w, o, version[w], version[o]]);
        if (!locked[o]) heap.push([err(o, w), o, w, version[o], version[w]]);
      }
    }
  };
  for (let w = 0; w < nw; w++) pushEdges(w);
  // Each welded vertex -> one real vertex per UV island; collapse moves real vertices of wa to the real vertex
  // of wb on the same side of any seam: pick the wb vertex sharing a triangle with each wa vertex.
  const remap = new Int32Array(nv);
  for (let i = 0; i < nv; i++) remap[i] = i;
  const find = (i) => {
    while (remap[i] !== i) i = remap[i] = remap[remap[i]];
    return i;
  };
  while (liveCount > target && heap.size) {
    const [, wa, wb, va, vb] = heap.pop();
    if (va !== version[wa] || vb !== version[wb] || locked[wa]) continue;
    // Triangles around wa; those containing wb disappear.
    const around = [...vt[wa]].filter((ti) => alive[ti]);
    if (!around.length) continue;
    const dying = around.filter((ti) => tris[ti].some((v) => wid[find(v)] === wb));
    if (!dying.length) continue;
    // For each real vertex of wa, the real vertex of wb it collapses onto (shared through a dying triangle).
    const target2 = new Map();
    for (const ti of dying) {
      const t = tris[ti].map(find);
      const a = t.find((v) => wid[v] === wa), b = t.find((v) => wid[v] === wb);
      if (a !== undefined && b !== undefined) target2.set(a, b);
    }
    // Every real vertex of wa used by surviving triangles must have a target (no seam tearing).
    let ok = true;
    const moved = [];
    for (const ti of around) {
      if (dying.includes(ti)) continue;
      const t = tris[ti].map(find);
      for (const v of t) if (wid[v] === wa && !target2.has(v)) ok = false;
      if (!ok) break;
      // Flip test: the triangle's normal must not reverse when wa moves to wb.
      const before = triNormal(t);
      const after = triNormal(t.map((v) => (wid[v] === wa ? target2.get(v) : v)));
      const dot = before[0] * after[0] + before[1] * after[1] + before[2] * after[2];
      const lb = Math.hypot(...before), la = Math.hypot(...after);
      if (la < 1e-14 || dot < 0.2 * lb * la) { ok = false; break; }
      moved.push(ti);
    }
    if (!ok) continue;
    for (const [a, b] of target2) remap[a] = b;
    for (const ti of dying) { alive[ti] = 0; liveCount--; }
    for (const ti of moved) {
      tris[ti] = tris[ti].map((v) => find(v));
      vt[wb].add(ti);
    }
    vt[wa].clear();
    for (let k = 0; k < 10; k++) Q[wb * 10 + k] += Q[wa * 10 + k];
    version[wa]++;
    version[wb]++;
    pushEdges(wb);
  }
  const out = [];
  const keep = new Uint8Array(nv);
  tris.forEach((t, i) => {
    if (!alive[i]) return;
    const r = t.map(find);
    if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) return;
    out.push(...r);
    for (const v of r) keep[v] = 1;
  });
  return { index: out, keep };
}

/** Applies a simplification to a mesh object of typed arrays (as from crowd-build's finish), compacting vertices. */
export function compactMesh(mesh, index, keep) {
  const n = mesh.count, map = new Int32Array(n).fill(-1);
  let m = 0;
  for (let i = 0; i < n; i++) if (keep[i]) map[i] = m++;
  const out = { count: m };
  for (const [k, arr] of Object.entries(mesh)) {
    if (k === 'count' || k === 'index' || !ArrayBuffer.isView(arr)) continue;
    const size = arr.length / n;
    const C = arr.constructor, a = new C(m * size);
    for (let i = 0; i < n; i++) if (map[i] >= 0) for (let s = 0; s < size; s++) a[map[i] * size + s] = arr[i * size + s];
    out[k] = a;
  }
  const idx = index.map((i) => map[i]);
  out.index = m > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx);
  return out;
}
