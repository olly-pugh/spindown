// A heightmap from the map data: {x0, y0, nx, ny, cell, data} where data is base64 little-endian Int16
// decimetres, row by row from the south-west corner, in data coordinates (x east, y north, metres).
// Used by the courses (York's relief under the road) and by the renderer (terrain).

export class HeightGrid {
  constructor(g) {
    Object.assign(this, { x0: g.x0, y0: g.y0, nx: g.nx, ny: g.ny, cell: g.cell });
    const bin = atob(g.data);
    const n = g.nx * g.ny;
    this.h = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
      this.h[i] = ((v << 16) >> 16) / 10;
    }
    this.x1 = this.x0 + (this.nx - 1) * this.cell;
    this.y1 = this.y0 + (this.ny - 1) * this.cell;
  }

  /** Bilinear height at data coords (x east, y north), clamped to the edge. */
  at(x, y) {
    const fx = Math.min(this.nx - 1.001, Math.max(0, (x - this.x0) / this.cell));
    const fy = Math.min(this.ny - 1.001, Math.max(0, (y - this.y0) / this.cell));
    const i = Math.floor(fx), j = Math.floor(fy);
    const u = fx - i, v = fy - j;
    const k = j * this.nx + i, h = this.h;
    return (h[k] * (1 - u) + h[k + 1] * u) * (1 - v) + (h[k + this.nx] * (1 - u) + h[k + this.nx + 1] * u) * v;
  }

  /** 1 well inside, falling to 0 at the edge over `fade` metres. */
  weight(x, y, fade) {
    const d = Math.min(x - this.x0, this.x1 - x, y - this.y0, this.y1 - y);
    const t = Math.min(1, Math.max(0, d / fade));
    return t * t * (3 - 2 * t);
  }
}
