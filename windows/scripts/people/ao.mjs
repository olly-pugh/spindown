// Baked ambient occlusion per vertex: the occluders (body, helmet, shoes) are voxelised into a 1 cm surface grid,
// then from each vertex a fan of rays over the hemisphere around its normal marches through the grid; the
// fraction that escapes is the vertex's openness. Armpits, the underside of the chin and helmet, the inner
// thighs and folds come out darker, which reads as soft, image-based light on the figure.

export class VoxelGrid {
  constructor(min, max, cell = 0.01) {
    this.min = min;
    this.cell = cell;
    this.n = [0, 1, 2].map((a) => Math.ceil((max[a] - min[a]) / cell) + 1);
    this.data = new Uint8Array(this.n[0] * this.n[1] * this.n[2]);
  }
  idx(x, y, z) {
    const i = Math.floor((x - this.min[0]) / this.cell), j = Math.floor((y - this.min[1]) / this.cell), k = Math.floor((z - this.min[2]) / this.cell);
    if (i < 0 || j < 0 || k < 0 || i >= this.n[0] || j >= this.n[1] || k >= this.n[2]) return -1;
    return (k * this.n[1] + j) * this.n[0] + i;
  }
  mark(x, y, z) {
    const i = this.idx(x, y, z);
    if (i >= 0) this.data[i] = 1;
  }
  hit(x, y, z) {
    const i = this.idx(x, y, z);
    return i >= 0 && this.data[i] === 1;
  }
  /** Marks every cell a triangle passes through (by sampling it at under half a cell). */
  addTriangles(pos, index) {
    const step = this.cell * 0.45;
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
      const ab = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
      const ac = Math.hypot(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]);
      const nu = Math.max(1, Math.ceil(ab / step)), nv = Math.max(1, Math.ceil(ac / step));
      for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv - (i * nv) / nu; j++) {
        const u = i / nu, v = j / nv;
        if (u + v > 1) continue;
        const w = 1 - u - v;
        this.mark(pos[a] * w + pos[b] * u + pos[c] * v, pos[a + 1] * w + pos[b + 1] * u + pos[c + 1] * v, pos[a + 2] * w + pos[b + 2] * u + pos[c + 2] * v);
      }
    }
  }
}

/** Fixed, well-spread hemisphere directions (cosine-weighted) around +z, from a Fibonacci spiral. */
function hemisphere(n) {
  const out = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n), th = i * g;
    const x = r * Math.cos(th), y = r * Math.sin(th);
    out.push([x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y))]);
  }
  return out;
}

/**
 * pos/normal: Float arrays (xyz per vertex). Returns Float32Array of openness (0 closed .. 1 open), with a
 * little smoothing over the mesh's edges.
 */
export function bakeAO(grid, pos, normal, index, { rays = 28, maxDist = 0.22, offset = 0.016, strength = 1.0 } = {}) {
  const n = pos.length / 3, dirs = hemisphere(rays), out = new Float32Array(n);
  const step = grid.cell * 0.8;
  for (let v = 0; v < n; v++) {
    const nx = normal[v * 3], ny = normal[v * 3 + 1], nz = normal[v * 3 + 2];
    const nl = Math.hypot(nx, ny, nz) || 1;
    const N = [nx / nl, ny / nl, nz / nl];
    const T = Math.abs(N[1]) < 0.9 ? norm(cross(N, [0, 1, 0])) : norm(cross(N, [1, 0, 0]));
    const Bt = cross(N, T);
    const ox = pos[v * 3] + N[0] * offset, oy = pos[v * 3 + 1] + N[1] * offset, oz = pos[v * 3 + 2] + N[2] * offset;
    let open = 0;
    for (const [a, b, c] of dirs) {
      const dx = T[0] * a + Bt[0] * b + N[0] * c, dy = T[1] * a + Bt[1] * b + N[1] * c, dz = T[2] * a + Bt[2] * b + N[2] * c;
      let blocked = false;
      for (let s = step; s < maxDist; s += step) {
        if (grid.hit(ox + dx * s, oy + dy * s, oz + dz * s)) { blocked = true; break; }
      }
      if (!blocked) open++;
    }
    out[v] = 1 - (1 - open / rays) * strength;
  }
  // Smooth once over edges (removes speckle from the ray pattern).
  const sum = new Float32Array(n), cnt = new Float32Array(n);
  for (let t = 0; t < index.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = index[t + k], b = index[t + (k + 1) % 3];
    sum[a] += out[b]; cnt[a]++;
    sum[b] += out[a]; cnt[b]++;
  }
  const sm = new Float32Array(n);
  for (let v = 0; v < n; v++) sm[v] = cnt[v] ? out[v] * 0.5 + (sum[v] / cnt[v]) * 0.5 : out[v];
  return sm;
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
