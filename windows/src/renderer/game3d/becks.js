// Becks and streams (Malham Beck, Gordale Beck, the outflow of the tarn): from the OpenStreetMap waterways, cut
// into the ground as real channels near the camera (grassy banks, a bed of wet river stones, shallow clear water
// running downhill) and drawn as a flat ribbon of water further off. The terrain is let down under the channels
// in the detailed tiles, the way it is under the road.
import * as THREE from 'three';

const smooth = (t) => t * t * (3 - 2 * t);

export class Becks {
  /**
   * lines: [{p: flat world [x, z, ...] in the direction of flow, w: width (m)}]; opts: {heightAt(x, z), keep(x,
   * z) -> false to leave a stretch out (under the road, down a rock face)}.
   */
  constructor(lines, opts) {
    this.lines = [];
    this.hash = new Map();
    const { heightAt, keep } = opts;
    this.ground = heightAt;
    for (const line of lines) {
      const pts = densify(line.p, 2);
      // Split into runs where the beck is kept.
      let cur = [];
      const flush = () => {
        if (cur.length >= 6) this.addLine(cur, line.w, heightAt);
        cur = [];
      };
      for (let i = 0; i < pts.length; i += 2) {
        if (keep(pts[i], pts[i + 1])) cur.push(pts[i], pts[i + 1]);
        else flush();
      }
      flush();
    }
  }

  addLine(pts, w, heightAt) {
    const n = pts.length / 2;
    const half = Math.max(0.5, Math.min(4, w / 2));
    const depth = Math.min(1.1, 0.45 + half * 0.22); // bank top to water
    const P = [];
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
      let tx = pts[b * 2] - pts[a * 2], tz = pts[b * 2 + 1] - pts[a * 2 + 1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      const x = pts[k * 2], z = pts[k * 2 + 1];
      const nx = -tz, nz = tx; // left of the flow
      const gl = heightAt(x + nx * (half + 1), z + nz * (half + 1)), gr = heightAt(x - nx * (half + 1), z - nz * (half + 1));
      P.push({ x, z, nx, nz, gl, gr, water: Math.min(gl, gr) - depth });
    }
    // Water only runs downhill: levels fall monotonically along the flow, then are eased.
    for (let k = 1; k < n; k++) P[k].water = Math.min(P[k].water, P[k - 1].water + 0.02);
    for (let pass = 0; pass < 2; pass++) for (let k = 1; k < n - 1; k++) P[k].water = (P[k - 1].water + P[k].water * 2 + P[k + 1].water) / 4;
    const idx = this.lines.length;
    this.lines.push({ P, half, depth });
    for (let k = 0; k + 1 < n; k++) {
      const key = `${Math.floor((P[k].x + P[k + 1].x) / 32)},${Math.floor((P[k].z + P[k + 1].z) / 32)}`;
      if (!this.hash.has(key)) this.hash.set(key, []);
      this.hash.get(key).push(idx, k);
    }
  }

  /** Distance from (x, z) to the nearest beck centreline, and that beck's half-width ({d, half}). */
  nearest(x, z, out = {}) {
    let best = Infinity, half = 0;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const l = this.hash.get(`${cx + dx},${cz + dz}`);
      if (!l) continue;
      for (let i = 0; i < l.length; i += 2) {
        const line = this.lines[l[i]], a = line.P[l[i + 1]], b = line.P[l[i + 1] + 1];
        const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
        const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2)) : 0;
        const d = Math.hypot(x - a.x - t * ex, z - a.z - t * ez);
        if (d < best) [best, half] = [d, line.half];
      }
    }
    out.d = best;
    out.half = half;
    return out;
  }

  /** Width of the channel ribbon each side of the centreline. */
  static edge(half) {
    return half + 6;
  }

  /**
   * The becks inside a world rectangle: `near` (a group of banks, bed and water, for the detailed terrain with its
   * vertices let down) and `far` (a flat ribbon of water on the ground), or null.
   */
  buildTile(x0, z0, x1, z1, mats, detailAt) {
    const banks = { pos: [], det: [], idx: [] }, bed = { pos: [], uv: [], idx: [] }, water = { pos: [], uv: [], idx: [] }, flat = { pos: [], uv: [], idx: [] };
    const inside = (p) => p.x >= x0 && p.x < x1 && p.z >= z0 && p.z < z1;
    for (const line of this.lines) {
      const P = line.P;
      for (let k = 0; k < P.length;) {
        while (k < P.length && !inside(P[k])) k++;
        if (k >= P.length) break;
        const a = Math.max(0, k - 1);
        while (k < P.length && inside(P[k])) k++;
        const b = Math.min(P.length - 1, k);
        if (b - a >= 1) this.ribbon(line, a, b, banks, bed, water, flat, detailAt);
      }
    }
    if (!bed.pos.length) return null;
    const geo = (o, attrs) => {
      const g = new THREE.BufferGeometry();
      for (const [name, arr, size] of attrs) g.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
      g.setIndex(o.idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      return g;
    };
    const near = new THREE.Group();
    const bankMesh = new THREE.Mesh(geo(banks, [['position', banks.pos, 3], ['detail', banks.det, 3]]), mats.banks);
    bankMesh.receiveShadow = true;
    const bedMesh = new THREE.Mesh(geo(bed, [['position', bed.pos, 3], ['uv', bed.uv, 2]]), mats.bed);
    bedMesh.receiveShadow = true;
    const waterMesh = new THREE.Mesh(geo(water, [['position', water.pos, 3], ['uv', water.uv, 2]]), mats.water);
    waterMesh.renderOrder = 2;
    near.add(bankMesh, bedMesh, waterMesh);
    const far = new THREE.Mesh(geo(flat, [['position', flat.pos, 3], ['uv', flat.uv, 2]]), mats.far);
    return { near, far };
  }

  ribbon(line, a, b, banks, bed, water, flat, detailAt) {
    const P = line.P, h = line.half;
    const e = Becks.edge(h);
    // Across the channel, left (+) to right (-): outer edge, bank top, bank foot | bed | bank foot, top, edge.
    const bankOffs = [e, h + 2.2, h + 0.9, h + 0.15];
    const bedOffs = [h + 0.25, h * 0.5, 0, -h * 0.5, -(h + 0.25)];
    let along = 0;
    const b0 = banks.pos.length / 3, d0 = bed.pos.length / 3, w0 = water.pos.length / 3, f0 = flat.pos.length / 3;
    const rows = b - a + 1;
    for (let k = a; k <= b; k++) {
      const p = P[k];
      if (k > a) along += Math.hypot(p.x - P[k - 1].x, p.z - P[k - 1].z);
      const g = (side) => (side > 0 ? p.gl : p.gr);
      // Banks, each side: outer edge on the terrain, then down to the water's edge.
      for (const side of [1, -1]) {
        bankOffs.forEach((o, i) => {
          const x = p.x + p.nx * o * side, z = p.z + p.nz * o * side;
          // Outer edge: meet the (undisturbed) ground; inner: fall to the water.
          const top = i === 0 ? null : g(side) - 0.04;
          const y = i === 0 ? null : i === 1 ? top : i === 2 ? top - (top - p.water) * 0.35 : p.water + 0.04;
          banks.pos.push(x, y ?? NaN, z);
          const det = detailAt(x, z);
          banks.det.push(det[0], det[1], Math.max(det[2], 0.5));
        });
      }
      // Bed: below the water, deepest in the middle.
      bedOffs.forEach((o, i) => {
        const x = p.x + p.nx * o, z = p.z + p.nz * o;
        const dip = i === 0 || i === 4 ? 0.02 : i === 2 ? 0.38 : 0.26;
        bed.pos.push(x, p.water - dip, z);
        bed.uv.push(x, z);
      });
      for (const [i, o] of [[0, h + 0.2], [1, -(h + 0.2)]]) {
        water.pos.push(p.x + p.nx * o, p.water, p.z + p.nz * o);
        water.uv.push(i, along);
      }
      for (const [i, o] of [[0, h], [1, -h]]) {
        flat.pos.push(p.x + p.nx * o, Math.min(p.gl, p.gr) - 0.12, p.z + p.nz * o);
        flat.uv.push(i, along);
      }
    }
    // Outer bank edges sit on the ground the caller's heightAt gives.
    for (let r = 0; r < rows; r++) {
      for (let s = 0; s < 2; s++) {
        const v = b0 + r * 8 + s * 4;
        const x = banks.pos[v * 3], z = banks.pos[v * 3 + 2];
        banks.pos[v * 3 + 1] = this.ground(x, z);
      }
    }
    for (let r = 0; r + 1 < rows; r++) {
      // Banks: two strips of three quads each side.
      for (let s = 0; s < 2; s++) {
        for (let i = 0; i < 3; i++) {
          const p = b0 + r * 8 + s * 4 + i, q = p + 8;
          if (s === 0) banks.idx.push(p, q, p + 1, q, q + 1, p + 1);
          else banks.idx.push(p, p + 1, q, q, p + 1, q + 1);
        }
      }
      for (let i = 0; i < 4; i++) {
        const p = d0 + r * 5 + i, q = p + 5;
        bed.idx.push(p, q, p + 1, q, q + 1, p + 1);
      }
      water.idx.push(w0 + r * 2, w0 + r * 2 + 2, w0 + r * 2 + 1, w0 + r * 2 + 2, w0 + r * 2 + 3, w0 + r * 2 + 1);
      flat.idx.push(f0 + r * 2, f0 + r * 2 + 2, f0 + r * 2 + 1, f0 + r * 2 + 2, f0 + r * 2 + 3, f0 + r * 2 + 1);
    }
  }
}

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

export { smooth };
