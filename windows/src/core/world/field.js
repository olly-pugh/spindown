// A nearest-road lookup for scenery placement: for any (x, z), the distance to the route centreline and the
// route distance of the nearest point. Built once per world with a two-pass chamfer sweep over a coarse grid
// that stores the nearest route sample index, then refined exactly from the candidates around a query point.

export class RouteField {
  constructor(route, { cell = 20, margin = 2600 } = {}) {
    this.route = route;
    const b = route.bounds();
    this.cell = cell;
    this.x0 = b.minX - margin;
    this.z0 = b.minZ - margin;
    this.nx = Math.ceil((b.maxX - b.minX + 2 * margin) / cell) + 1;
    this.nz = Math.ceil((b.maxZ - b.minZ + 2 * margin) / cell) + 1;
    const n = this.nx * this.nz;
    this.idx = new Int32Array(n).fill(-1);
    this.dist = new Float32Array(n).fill(Infinity);
    const stride = Math.max(1, Math.floor(cell / 4 / route.step));
    for (let i = 0; i < route.count; i += stride) {
      const cx = Math.round((route.xs[i] - this.x0) / cell), cz = Math.round((route.zs[i] - this.z0) / cell);
      if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) continue;
      this.consider(cx, cz, i);
    }
    const sweep = (forward) => {
      const order = forward ? [[-1, 0], [0, -1], [-1, -1], [1, -1]] : [[1, 0], [0, 1], [1, 1], [-1, 1]];
      for (let a = 0; a < this.nz; a++) {
        const z = forward ? a : this.nz - 1 - a;
        for (let b2 = 0; b2 < this.nx; b2++) {
          const x = forward ? b2 : this.nx - 1 - b2;
          for (const [dx, dz] of order) {
            const xx = x + dx, zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= this.nx || zz >= this.nz) continue;
            const cand = this.idx[zz * this.nx + xx];
            if (cand >= 0) this.consider(x, z, cand);
          }
        }
      }
    };
    sweep(true);
    sweep(false);
    sweep(true);
  }

  consider(cx, cz, i) {
    const k = cz * this.nx + cx;
    const x = this.x0 + cx * this.cell, z = this.z0 + cz * this.cell;
    const d = (this.route.xs[i] - x) ** 2 + (this.route.zs[i] - z) ** 2;
    if (d < this.dist[k]) {
      this.dist[k] = d;
      this.idx[k] = i;
    }
  }

  /** {distance, along, side}: side is +1 to the right of the direction of travel, −1 to the left. */
  query(x, z, out = {}) {
    const cx = Math.round((x - this.x0) / this.cell), cz = Math.round((z - this.z0) / this.cell);
    const r = this.route;
    let best = Infinity, bi = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(this.nx - 1, Math.max(0, cx + dx)), zz = Math.min(this.nz - 1, Math.max(0, cz + dz));
        const c = this.idx[zz * this.nx + xx];
        if (c < 0) continue;
        // Refine along the route around the candidate.
        const span = Math.ceil(this.cell / r.step) + 2;
        for (let k = c - span; k <= c + span; k++) {
          const i = ((k % r.count) + r.count) % r.count;
          const d = (r.xs[i] - x) ** 2 + (r.zs[i] - z) ** 2;
          if (d < best) {
            best = d;
            bi = i;
          }
        }
      }
    }
    out.distance = Math.sqrt(best);
    out.along = bi * r.step;
    const j = (bi + 1) % r.count;
    const tx = r.xs[j] - r.xs[bi], tz = r.zs[j] - r.zs[bi];
    // Right of travel: cross(t, p − c) with x/z axes; positive means right (z is south).
    out.side = tx * (z - r.zs[bi]) - tz * (x - r.xs[bi]) > 0 ? 1 : -1;
    return out;
  }
}
